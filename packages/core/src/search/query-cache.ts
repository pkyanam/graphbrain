// @graphbrain/core — Polygres-backed semantic query cache (Stage 9).
//
// Caches hybridSearch results keyed by query embedding similarity. On each
// lookup the cache fetches candidate rows by (tenant_id, knobs_hash), then
// computes cosine similarity in TypeScript between the incoming query
// embedding and each candidate's stored embedding. If the closest cached
// query is within the similarity threshold (default >= 0.92), we return
// the stored results instantly — no keyword search, no vector search, no
// LLM expansion, no RRF, no dedup. Otherwise we report a miss and let the
// caller run the real search.
//
// Storage: the `query_cache` table (migration 003 + 004). The embedding is
// stored as a JSONB array of numbers (the control-plane Polygres does NOT
// have pgvector — vector indexes live in the per-tenant HelixDB instances).
// Per-row TTL (default 3600 seconds). Stale rows are skipped at read time.
//
// knobs_hash isolation (GBrain v9→v10 invariant): the lookup filters by
// (tenant_id, knobs_hash) so a tokenmax write (expansion=on, limit=50)
// can't be served to a conservative read (no expansion, limit=10), and a
// relational-on write can't be served to a relational-off lookup. The
// knobs_hash is computed by ./mode.ts → knobsHash() and folds mode +
// embedding column + relational flag + contextual retrieval + cache knobs.
//
// Fail-open: the cache is OPTIONAL. Any DB error (table missing, connection
// error, malformed JSON) returns a miss — search reliability beats cache
// hits, matching GBrain's posture. The cache MUST NOT throw.
//
// Ported from _reference/gbrain/src/core/search/query-cache.ts. Adapted to
// Graphbrain's multi-tenant Polygres (GBrain is single-tenant PGLite/
// Postgres with pgvector). The cosine-similarity probe is in TypeScript
// (GBrain used pgvector's HNSW index) because the control plane has no
// pgvector.

import { createHash } from "node:crypto";
import type { Sql } from "../control/db";
import type { SearchResult, HybridSearchMeta } from "../types";

/** Default cosine similarity threshold for cache hits. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.92;
/** Default TTL for cache entries, in seconds. */
export const DEFAULT_TTL_SECONDS = 3600;

export interface CacheLookupResult {
  hit: boolean;
  results?: SearchResult[];
  meta?: HybridSearchMeta;
  /** Cosine similarity of the matched cached query (0..1). Only set on hit. */
  similarity?: number;
  /** Age of the cached entry in seconds. Only set on hit. */
  ageSeconds?: number;
}

export interface QueryCacheConfig {
  enabled?: boolean;
  similarityThreshold?: number;
  ttlSeconds?: number;
}

interface CacheRow {
  id: string;
  embedding: number[] | null;
  results: SearchResult[];
  created_at: Date;
  ttl_at: Date | null;
}

function clampThreshold(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return DEFAULT_SIMILARITY_THRESHOLD;
  return Math.min(1, Math.max(0, v));
}

function clampTtl(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v) || v <= 0) return DEFAULT_TTL_SECONDS;
  return Math.floor(v);
}

/**
 * Deterministic query hash (SHA-256, first 16 hex chars). Used as the
 * `query_hash` column for the exact-match dedup path (re-caching the exact
 * same query+knobs bumps the row instead of inserting a duplicate).
 */
export function queryHash(queryText: string): string {
  return createHash("sha256").update(queryText).digest("hex").slice(0, 16);
}

/**
 * Cosine similarity between two vectors. Returns 0 for empty/mismatched-
 * length vectors (defensive — a cache row with a corrupt embedding is
 * treated as non-matching).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Semantic query cache backed by the Polygres `query_cache` table.
 *
 * Construct once at app startup (or per-request — it's stateless aside from
 * the pool reference). The cache is OPTIONAL and fail-open: every method
 * swallows DB errors and returns a miss/no-op. Search reliability beats
 * cache hits.
 */
export class SemanticQueryCache {
  private readonly pool: Sql;
  private readonly similarityThreshold: number;
  private readonly ttlSeconds: number;
  private readonly enabled: boolean;

  constructor(pool: Sql, config?: QueryCacheConfig) {
    this.pool = pool;
    this.enabled = config?.enabled ?? true;
    this.similarityThreshold = clampThreshold(config?.similarityThreshold);
    this.ttlSeconds = clampTtl(config?.ttlSeconds);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Look up a cached result set by query embedding similarity. Returns a
   * miss (hit=false) when:
   *   - cache is disabled,
   *   - embedding is null/empty,
   *   - the table doesn't exist (pre-migration brain),
   *   - no candidate row is within the similarity threshold,
   *   - any DB error occurs (fail-open).
   *
   * Never throws.
   */
  async lookup(
    tenantId: string,
    queryEmbedding: number[] | null,
    knobsHash: string,
  ): Promise<CacheLookupResult> {
    if (!this.enabled || !queryEmbedding || queryEmbedding.length === 0) {
      return { hit: false };
    }

    let rows: CacheRow[];
    try {
      rows = await this.pool<CacheRow[]>`
        SELECT id, embedding, results, created_at, ttl_at
        FROM _graphbrain.query_cache
        WHERE tenant_id = ${tenantId}::uuid
          AND knobs_hash = ${knobsHash}
          AND (ttl_at IS NULL OR ttl_at > now())
      `;
    } catch {
      // Fail-open: table missing, connection error, etc. → miss.
      return { hit: false };
    }

    if (rows.length === 0) return { hit: false };

    // Scan candidates for the closest embedding (in-memory cosine). The
    // per-tenant row count for a given knobs_hash is small (bounded by TTL
    // + write rate), so this scan is cheap.
    let best: { row: CacheRow; sim: number } | null = null;
    for (const row of rows) {
      const emb = row.embedding;
      if (!Array.isArray(emb) || emb.length === 0) continue;
      const sim = cosineSimilarity(queryEmbedding, emb);
      if (!best || sim > best.sim) {
        best = { row, sim };
      }
    }

    if (!best || best.sim < this.similarityThreshold) {
      return { hit: false };
    }

    const ageSeconds = Math.floor((Date.now() - best.row.created_at.getTime()) / 1000);
    return {
      hit: true,
      results: best.row.results,
      similarity: best.sim,
      ageSeconds,
    };
  }

  /**
   * Write a result set to the cache. UPSERT by (tenant_id, query_hash,
   * knobs_hash): re-caching the exact same query+knobs bumps the row's
   * hits + created_at + embedding + results rather than inserting a
   * duplicate.
   *
   * Fail-open: any DB error is swallowed (the cache is best-effort). Never
   * throws.
   */
  async write(
    tenantId: string,
    queryText: string,
    queryEmbedding: number[] | null,
    knobsHash: string,
    results: SearchResult[],
  ): Promise<void> {
    if (!this.enabled) return;
    const qhash = queryHash(queryText);
    const ttlAt = new Date(Date.now() + this.ttlSeconds * 1000);

    try {
      // UPSERT: on conflict (tenant_id, query_hash, knobs_hash), bump hits
      // + refresh embedding/results/created_at/ttl. The unique index from
      // migration 003 (idx_query_cache_tenant_query_knobs) covers
      // (tenant_id, query_hash, knobs_hash) — but it's a non-unique index,
      // so we can't use ON CONFLICT. Instead, delete-then-insert for the
      // exact-match path. The semantic path (lookup by knobs_hash only) is
      // unaffected by duplicates.
      await this.pool`
        DELETE FROM _graphbrain.query_cache
        WHERE tenant_id = ${tenantId}::uuid
          AND query_hash = ${qhash}
          AND knobs_hash = ${knobsHash}
      `;
      // Use sql.json() for JSONB columns (never JSON.stringify into ::jsonb —
      // postgres.js double-encodes it; see control/db.ts invariant).
      const embeddingJson = queryEmbedding ? this.pool.json(queryEmbedding as any) : null;
      const resultsJson = this.pool.json(results as any);
      await this.pool`
        INSERT INTO _graphbrain.query_cache
          (tenant_id, query_hash, knobs_hash, embedding, results, hits, ttl_at)
        VALUES
          (${tenantId}::uuid, ${qhash}, ${knobsHash},
           ${embeddingJson},
           ${resultsJson},
           0, ${ttlAt})
      `;
    } catch {
      // Fail-open: cache write failure must never break search.
    }
  }
}
