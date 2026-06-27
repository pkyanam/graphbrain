// @graphbrain/core — hybrid search pipeline orchestrator (Stage 9).
//
// hybridSearch(engine, gateway, query, opts, ctx) is the retrieval primitive
// Stage 10's search + query operations call. It orchestrates the full
// pipeline:
//
//   1. Resolve mode (per-call → tenant.settings → config.defaults → "balanced")
//   2. Resolve the mode bundle + apply per-call/tenant overrides
//   3. Compute knobs_hash (folds mode + embedding column + relational flag)
//   4. Embed the query (embeddingService.embedOne — resolves tenant dimension)
//   5. Cache lookup (Polygres semantic cache; fail-open)
//   6. If cache hit → return cached results + meta
//   7. Classify intent (zero-LLM classifier)
//   8. Expansion (LLM multi-query; tokenmax only)
//   9. Parallel retrieval:
//        - lexical: engine.textSearchPages + engine.textSearchChunks
//        - vector: engine.vectorSearchChunks (with the query embedding)
//        - relational: buildRelationalArm (balanced + tokenmax)
//        - expansion: for each expanded query, textSearchPages + textSearchChunks
//  10. Hydrate hits into SearchResult rows (fetch pages + chunks by id/slug)
//  11. RRF fusion across all streams (RRF_K=60, intent-weighted per list)
//  12. Intent weights (applyExactMatchBoost)
//  13. Graph signals (adjacency + session diversification; balanced + tokenmax)
//  14. Dedup (4-layer pipeline + compiled truth guarantee)
//  15. Rerank (cross-encoder; gated by tenant.settings.rerankerEnabled)
//  16. Token budget enforcement (conservative=4000, balanced=12000, tokenmax=off)
//  17. Cache write (fail-open)
//  18. Return results + HybridSearchMeta
//
// Ported from _reference/gbrain/src/core/search/hybrid.ts. The GBrain
// version is SQL-heavy (a single query fuses BM25 + vector + RRF in
// Postgres). Graphbrain adapts this to call the Stage 7 BrainEngine methods
// (vectorSearchChunks, textSearchPages, textSearchChunks, traverse) in
// parallel via Promise.all, then fuses in TypeScript.
//
// The hybridSearch signature (per IMPLEMENTATION.md):
//   hybridSearch(engine, gateway, query, opts, ctx)
//     engine  — BrainEngine (Stage 7)
//     gateway — AIGateway (Stage 8)
//     query   — the user query string
//     opts    — HybridSearchOpts (extends SearchOpts with per-call overrides)
//     ctx     — OperationContext (Stage 1; carries tenant + trust boundary)

import type { BrainEngine, SearchOpts } from "../engine";
import { clampSearchLimit } from "../engine";
import type { AIGateway } from "../ai/gateway";
import type { EmbeddingService } from "../embedding";
import type {
  SearchResult,
  HybridSearchMeta,
  SearchMode,
  SearchIntent,
  RetrievalStream,
  Citation,
  Chunk,
  Page,
  OperationContext,
} from "../types";
import type { VectorSearchHit, TextSearchHit } from "../helix/queries";
import { classifyQuery } from "./intent";
import {
  weightsForIntent,
  effectiveRrfK,
  applyExactMatchBoost,
  type IntentWeights,
} from "./intent-weights";
import { MODE_BUNDLES, knobsHash, type ModeBundle, type KnobsHashContext } from "./mode";
import { expandQuery } from "./expansion";
import { applyReranker, DEFAULT_RERANK_MODEL } from "./rerank";
import { applyGraphSignals } from "./graph-signals";
import { buildRelationalArm } from "./relational-recall";
import { dedupResults } from "./dedup";
import { enforceTokenBudget } from "./token-budget";
import { SemanticQueryCache, DEFAULT_SIMILARITY_THRESHOLD } from "./query-cache";
import { getPool } from "../control/db";
import { resolveEmbeddingModel } from "../ai/gateway";
import { getConfig } from "../config";

/** RRF fusion constant (PLAN.md step 5g). */
export const RRF_K = 60;
/** Default reranker topNIn (candidates sent to the cross-encoder). */
export const DEFAULT_RERANKER_TOP_N_IN = 30;

/**
 * Per-call hybrid search options. Extends SearchOpts with per-call overrides
 * for the mode-bundle knobs. Resolution: per-call → tenant.settings →
 * MODE_BUNDLES[mode] → MODE_BUNDLES.balanced.
 */
export interface HybridSearchOpts extends SearchOpts {
  /** Per-call reranker override (wins over tenant.settings + mode bundle). */
  rerankerEnabled?: boolean;
  /** Per-call expansion override (wins over mode bundle). */
  expansion?: boolean;
  /** Per-call relational-retrieval override (wins over mode bundle). */
  relationalRetrieval?: boolean;
  /** Per-call token-budget override (wins over mode bundle). */
  tokenBudget?: number;
  /** Disable the query cache for this call (wins over mode bundle). */
  cacheEnabled?: boolean;
  /** Per-call rerank model override (wins over DEFAULT_RERANK_MODEL). */
  rerankModel?: string;
}

export interface HybridSearchResult {
  results: SearchResult[];
  meta: HybridSearchMeta;
}

/**
 * Resolve the effective search mode: per-call opts.mode → tenant.settings
 * .searchMode → config.defaults.searchMode → "balanced".
 */
function resolveMode(ctx: OperationContext, opts: HybridSearchOpts): SearchMode {
  if (opts.mode) return opts.mode;
  if (ctx.tenant.settings.searchMode) return ctx.tenant.settings.searchMode;
  return getConfig().defaults.searchMode ?? "balanced";
}

/**
 * Resolve the effective mode bundle: MODE_BUNDLES[mode] with per-call +
 * tenant.settings overrides applied. Returns the bundle + the resolved mode.
 */
function resolveBundle(
  mode: SearchMode,
  ctx: OperationContext,
  opts: HybridSearchOpts,
): { bundle: ModeBundle; mode: SearchMode } {
  const base = MODE_BUNDLES[mode] ?? MODE_BUNDLES.balanced;
  const bundle: ModeBundle = {
    ...base,
    // Per-call overrides win over the mode bundle.
    ...(opts.rerankerEnabled !== undefined ? { rerankerEnabled: opts.rerankerEnabled } : {}),
    ...(opts.expansion !== undefined ? { expansion: opts.expansion } : {}),
    ...(opts.relationalRetrieval !== undefined ? { relationalRetrieval: opts.relationalRetrieval } : {}),
    ...(opts.tokenBudget !== undefined ? { tokenBudget: opts.tokenBudget } : {}),
    ...(opts.cacheEnabled !== undefined ? { cacheEnabled: opts.cacheEnabled } : {}),
    // tenant.settings.rerankerEnabled wins over the mode bundle (but NOT
    // over a per-call override, which was applied above).
    ...(ctx.tenant.settings.rerankerEnabled !== undefined && opts.rerankerEnabled === undefined
      ? { rerankerEnabled: ctx.tenant.settings.rerankerEnabled }
      : {}),
  };
  return { bundle, mode };
}

/**
 * hybridSearch — the retrieval primitive.
 *
 * @param engine        BrainEngine (Stage 7) bound to the tenant's HelixDB.
 * @param gateway       AIGateway (Stage 8) for chat (expansion) + rerank.
 * @param embeddingService EmbeddingService (Stage 8) for query embedding.
 * @param query         The user query string.
 * @param opts          Per-call overrides (extends SearchOpts).
 * @param ctx           OperationContext (carries tenant + trust boundary).
 * @returns             { results, meta } — the ranked SearchResult[] + metadata.
 */
export async function hybridSearch(
  engine: BrainEngine,
  gateway: AIGateway,
  embeddingService: EmbeddingService,
  query: string,
  opts: HybridSearchOpts,
  ctx: OperationContext,
): Promise<HybridSearchResult> {
  const mode = resolveMode(ctx, opts);
  const { bundle } = resolveBundle(mode, ctx, opts);
  const limit = clampSearchLimit(opts.limit, mode);

  // Resolve the embedding model + column for the knobs_hash context.
  const embeddingModel = resolveEmbeddingModel(getConfig(), ctx.tenant.settings);
  const knobsCtx: KnobsHashContext = {
    embeddingColumn: "embedding", // Phase 1: primary text embedding column
    embeddingModel,
  };
  const khash = knobsHash(bundle, mode, knobsCtx);

  // ─── 4. Embed the query ─────────────────────────────────────────────────
  // embedOne resolves the tenant's configured model + dimension automatically.
  let queryEmbedding: number[] | null = null;
  try {
    queryEmbedding = await embeddingService.embedOne(query, ctx.tenant);
  } catch {
    // Fail-open: if embedding fails, vector search is skipped (lexical still runs).
    queryEmbedding = null;
  }

  // ─── 5. Cache lookup ────────────────────────────────────────────────────
  let cacheStatus: "hit" | "miss" | "disabled" = "disabled";
  let cacheSimilarity: number | undefined;
  let cacheAgeSeconds: number | undefined;
  if (bundle.cacheEnabled && queryEmbedding) {
    try {
      const cache = new SemanticQueryCache(getPool(), {
        enabled: true,
        similarityThreshold: DEFAULT_SIMILARITY_THRESHOLD,
        ttlSeconds: bundle.cacheTtlSeconds,
      });
      const cached = await cache.lookup(ctx.tenant.id, queryEmbedding, khash);
      if (cached.hit) {
        cacheStatus = "hit";
        cacheSimilarity = cached.similarity;
        cacheAgeSeconds = cached.ageSeconds;
        const meta: HybridSearchMeta = {
          vectorEnabled: queryEmbedding !== null,
          detailResolved: null,
          expansionApplied: false,
          cache: { status: "hit", similarity: cacheSimilarity, ageSeconds: cacheAgeSeconds },
        };
        // Stamp ranks on cached results.
        const results = cached.results ?? [];
        for (let i = 0; i < results.length; i++) results[i]!.rank = i;
        return { results, meta };
      }
      cacheStatus = "miss";
    } catch {
      // Fail-open: cache errors don't break search.
      cacheStatus = "miss";
    }
  }

  // ─── 7. Classify intent ─────────────────────────────────────────────────
  const { intent, suggestedDetail } = classifyQuery(query);
  const weights = bundle.intentWeighting ? weightsForIntent(intent) : weightsForIntent("general");

  // ─── 8. Expansion ───────────────────────────────────────────────────────
  let expansionApplied = false;
  let expandedQueries: string[] = [query];
  if (bundle.expansion) {
    try {
      expandedQueries = await expandQuery(query, gateway, ctx.tenant);
      expansionApplied = expandedQueries.length > 1;
    } catch {
      expandedQueries = [query];
      expansionApplied = false;
    }
  }

  // ─── 9. Parallel retrieval ──────────────────────────────────────────────
  // Each stream returns a list of hits keyed by a stable page identifier.
  // We hydrate them into SearchResult rows after fusion.
  const searchLimit = Math.max(limit, 30); // over-fetch for fusion, trim later

  const retrievalStreams: Promise<{ stream: RetrievalStream; hits: StreamHit[] }>[] = [];

  // Lexical: textSearchPages + textSearchChunks (original query only —
  // expansion runs its own lexical calls below).
  retrievalStreams.push(
    runLexical(engine, query, searchLimit, "lexical"),
  );

  // Vector: vectorSearchChunks (with the query embedding).
  if (queryEmbedding) {
    retrievalStreams.push(
      engine.vectorSearchChunks(queryEmbedding, { limit: searchLimit, mode })
        .then((hits) => ({ stream: "vector" as const, hits: hits.map((h) => ({ kind: "vector", hit: h })) })),
    );
  }

  // Relational: buildRelationalArm (balanced + tokenmax).
  if (bundle.relationalRetrieval) {
    retrievalStreams.push(
      buildRelationalArm(engine, query, { depth: bundle.relationalRetrievalDepth, limit: searchLimit })
        .then((results) => ({
          stream: "relational" as const,
          hits: results.map((r) => ({ kind: "relational" as const, result: r })),
        })),
    );
  }

  // Expansion: for each expanded query (skip the original — already ran above),
  // run textSearchPages + textSearchChunks.
  for (const eq of expandedQueries.slice(1)) {
    retrievalStreams.push(runLexical(engine, eq, searchLimit, "expansion"));
  }

  const streamResults = await Promise.all(retrievalStreams);

  // ─── 10. Hydrate hits into SearchResult rows ────────────────────────────
  // Each stream contributes SearchResult rows tagged with its stream name.
  // We hydrate pages + chunks via the engine (getPage/getPageById/getChunkById).
  const hydratedStreams = await Promise.all(
    streamResults.map(({ stream, hits }) => hydrateStream(engine, stream, hits, opts.includeDeleted)),
  );

  // ─── 11. RRF fusion ─────────────────────────────────────────────────────
  // RRF: score = sum over streams of 1 / (k + rank_in_stream). Intent weights
  // adjust the effective k per stream (higher weight → lower k → stronger
  // top-rank contribution).
  const fused = rrfFuse(hydratedStreams, weights, query);

  // ─── 12. Intent weights (exact-match boost) ─────────────────────────────
  if (bundle.intentWeighting) {
    applyExactMatchBoost(fused, query, weights);
    fused.sort((a, b) => b.score - a.score);
  }

  // ─── 13. Graph signals (adjacency + session diversification) ────────────
  // ON for balanced + tokenmax (matches GBrain v0.40.4). Conservative skips.
  if (mode !== "conservative") {
    await applyGraphSignals(fused, engine, { enabled: true });
    fused.sort((a, b) => b.score - a.score);
  }

  // ─── 14. Dedup ──────────────────────────────────────────────────────────
  const deduped = dedupResults(fused);

  // ─── 15. Rerank ─────────────────────────────────────────────────────────
  // Gated by tenant.settings.rerankerEnabled (or per-call override). The
  // gateway's rerank throws if no model is set — we resolve DEFAULT_RERANK_MODEL
  // + the per-call override. Fail-open: any error returns the RRF order.
  let finalResults = deduped;
  if (bundle.rerankerEnabled) {
    finalResults = await applyReranker(query, deduped, {
      enabled: true,
      topNIn: Math.min(DEFAULT_RERANKER_TOP_N_IN, deduped.length),
      topNOut: null,
      model: opts.rerankModel ?? DEFAULT_RERANK_MODEL,
    }, gateway, ctx.tenant);
  }

  // ─── 16. Token budget ───────────────────────────────────────────────────
  const { results: budgeted, meta: budgetMeta } = enforceTokenBudget(
    finalResults,
    bundle.tokenBudget,
  );

  // Trim to the caller's limit (post-budget, post-rerank).
  const trimmed = budgeted.slice(0, limit);
  for (let i = 0; i < trimmed.length; i++) trimmed[i]!.rank = i;

  // ─── 17. Cache write ────────────────────────────────────────────────────
  if (bundle.cacheEnabled && queryEmbedding) {
    try {
      const cache = new SemanticQueryCache(getPool(), {
        enabled: true,
        similarityThreshold: DEFAULT_SIMILARITY_THRESHOLD,
        ttlSeconds: bundle.cacheTtlSeconds,
      });
      await cache.write(ctx.tenant.id, query, queryEmbedding, khash, trimmed);
    } catch {
      // Fail-open: cache write failure must never break search.
    }
  }

  // ─── 18. Build meta + return ────────────────────────────────────────────
  const meta: HybridSearchMeta = {
    vectorEnabled: queryEmbedding !== null,
    detailResolved: suggestedDetail ?? null,
    expansionApplied,
    intent,
    mode,
    embeddingColumn: knobsCtx.embeddingColumn,
    tokenBudget: bundle.tokenBudget !== undefined
      ? { budget: budgetMeta.budget, used: budgetMeta.used, kept: budgetMeta.kept, dropped: budgetMeta.dropped }
      : undefined,
    cache: { status: cacheStatus, similarity: cacheSimilarity, ageSeconds: cacheAgeSeconds },
    relational: bundle.relationalRetrieval
      ? { enabled: true, hops: bundle.relationalRetrievalDepth }
      : { enabled: false },
  };

  return { results: trimmed, meta };
}

// ─── Stream hit union type ───────────────────────────────────────────────────

type StreamHit =
  | { kind: "pageText"; hit: TextSearchHit }
  | { kind: "chunkText"; hit: TextSearchHit }
  | { kind: "vector"; hit: VectorSearchHit }
  | { kind: "relational"; result: SearchResult };

/**
 * Run the lexical arm (textSearchPages + textSearchChunks) for one query,
 * tagging the hits with the given stream name. Returns a combined hit list.
 */
async function runLexical(
  engine: BrainEngine,
  query: string,
  limit: number,
  stream: RetrievalStream,
): Promise<{ stream: RetrievalStream; hits: StreamHit[] }> {
  const [pageHits, chunkHits] = await Promise.all([
    engine.textSearchPages(query, { limit, mode: "tokenmax" }),
    engine.textSearchChunks(query, { limit, mode: "tokenmax" }),
  ]);
  const hits: StreamHit[] = [
    ...pageHits.map((h) => ({ kind: "pageText" as const, hit: h })),
    ...chunkHits.map((h) => ({ kind: "chunkText" as const, hit: h })),
  ];
  return { stream, hits };
}

/**
 * Hydrate a stream's hits into SearchResult rows. Each stream produces
 * SearchResult[] tagged with its stream name (for RRF + citations).
 *
 * Hydration paths:
 *   - pageText: hit has slug → getPage(slug) + getChunksByPage(slug) → pick compiled_truth.
 *   - chunkText: hit has chunk id → getChunkById(id) → pageId → getPageById(pageId).
 *   - vector: hit has pageId + chunkId → getPageById(pageId) + the chunk content is on the hit.
 *   - relational: already a SearchResult (from buildRelationalArm) — pass through.
 */
async function hydrateStream(
  engine: BrainEngine,
  stream: RetrievalStream,
  hits: StreamHit[],
  includeDeleted?: boolean,
): Promise<{ stream: RetrievalStream; results: SearchResult[] }> {
  if (hits.length === 0) return { stream, results: [] };

  // Relational hits are already hydrated SearchResults.
  if (stream === "relational") {
    return {
      stream,
      results: hits.map((h) => (h.kind === "relational" ? h.result : null)).filter((r): r is SearchResult => r !== null),
    };
  }

  // Group hits by page slug (for pageText) or pageId (for chunkText/vector).
  // We hydrate each unique page once, then attach the matching chunks.
  const results = await Promise.all(
    hits.map(async (h): Promise<SearchResult | null> => {
      if (h.kind === "pageText") {
        const page = await engine.getPage(h.hit.slug ?? "", { includeDeleted });
        if (!page) return null;
        const chunks = await engine.getChunksByPage(page.slug);
        // Pick the compiled_truth chunk (or the first chunk) as the evidence.
        const evidence = chunks.find((c) => c.chunkSource === "compiled_truth") ?? chunks[0];
        const citation: Citation = {
          chunkId: evidence?.id ?? null,
          slug: page.slug,
          stream,
          snippet: h.hit.title ?? undefined,
        };
        return {
          page,
          chunks: evidence ? [evidence] : [],
          score: h.hit.score,
          sources: [stream],
          citations: [citation],
        };
      }
      if (h.kind === "chunkText") {
        const chunk = await engine.getChunkById(h.hit.id);
        if (!chunk) return null;
        const page = await engine.getPageById(chunk.pageId, { includeDeleted });
        if (!page) return null;
        const citation: Citation = {
          chunkId: chunk.id,
          slug: page.slug,
          stream,
          snippet: h.hit.content ?? undefined,
        };
        return {
          page,
          chunks: [chunk],
          score: h.hit.score,
          sources: [stream],
          citations: [citation],
        };
      }
      if (h.kind === "vector") {
        const page = await engine.getPageById(h.hit.pageId, { includeDeleted });
        if (!page) return null;
        // The vector hit carries the chunk content + chunkId. Build a partial
        // Chunk for the citation (the full chunk fetch is optional — the
        // content is already on the hit).
        const partialChunk: Chunk = {
          id: h.hit.chunkId,
          pageId: h.hit.pageId,
          chunkIndex: 0,
          content: h.hit.content,
          chunkSource: "compiled_truth", // vector hits don't carry chunkSource; default
          modality: "text",
          embedding: null,
          createdAt: new Date(0),
        };
        const citation: Citation = {
          chunkId: h.hit.chunkId,
          slug: page.slug,
          stream,
          snippet: h.hit.content,
        };
        return {
          page,
          chunks: [partialChunk],
          score: h.hit.score,
          sources: [stream],
          citations: [citation],
        };
      }
      return null;
    }),
  );

  return {
    stream,
    results: results.filter((r): r is SearchResult => r !== null),
  };
}

/**
 * RRF fusion across all hydrated streams. Each stream's results are sorted
 * by score (desc), then RRF score = sum over streams of 1 / (k + rank).
 * Intent weights adjust the effective k per stream type (keyword vs vector).
 *
 * Results from multiple streams that reference the same page are merged:
 * their RRF scores sum, their sources + citations union, and their chunks
 * union (deduped by chunk id).
 */
function rrfFuse(
  hydratedStreams: { stream: RetrievalStream; results: SearchResult[] }[],
  weights: IntentWeights,
  _query: string,
): SearchResult[] {
  // Sort each stream's results by score descending (for rank assignment).
  const ranked = hydratedStreams.map(({ stream, results }) => ({
    stream,
    results: [...results].sort((a, b) => b.score - a.score),
  }));

  // Merge by page slug. RRF score accumulates across streams.
  const byPage = new Map<string, SearchResult>();
  for (const { stream, results } of ranked) {
    // Determine the effective k for this stream (keyword vs vector weighting).
    const isKeyword = stream === "lexical" || stream === "expansion";
    const weight = isKeyword ? weights.keywordWeight : weights.vectorWeight;
    const k = effectiveRrfK(RRF_K, weight);

    for (let rank = 0; rank < results.length; rank++) {
      const r = results[rank]!;
      const rrfScore = 1 / (k + rank);
      const existing = byPage.get(r.page.slug);
      if (existing) {
        // Merge: sum scores, union sources + citations, union chunks.
        existing.score += rrfScore;
        for (const s of r.sources) {
          if (!existing.sources.includes(s)) existing.sources.push(s);
        }
        existing.citations.push(...r.citations);
        // Union chunks (dedup by chunk id; skip null ids).
        const seenChunkIds = new Set(existing.chunks.map((c) => c.id));
        for (const c of r.chunks) {
          if (!seenChunkIds.has(c.id)) {
            existing.chunks.push(c);
            seenChunkIds.add(c.id);
          }
        }
      } else {
        byPage.set(r.page.slug, {
          ...r,
          score: rrfScore,
          sources: [...r.sources],
          citations: [...r.citations],
          chunks: [...r.chunks],
        });
      }
    }
  }

  return [...byPage.values()].sort((a, b) => b.score - a.score);
}
