// Migration 004 — add `embedding` column to `_graphbrain.query_cache`.
//
// Stage 9's semantic query cache (packages/core/src/search/query-cache.ts)
// needs the query embedding stored alongside each cached result set so a
// lookup can compute cosine similarity against the incoming query embedding
// (PLAN.md step 5b: "Cache hit requires knobs_hash match + embedding cosine
// similarity < 0.92 threshold"). Migration 003 created the table without
// the embedding column; this migration adds it.
//
// Storage choice: JSONB array of numbers (not pgvector). The control-plane
// Polygres is a vanilla Postgres instance shared across tenants; it does
// NOT have the pgvector extension (vector indexes live in the per-tenant
// HelixDB instances). Cosine similarity is computed in TypeScript after
// fetching candidate rows keyed by (tenant_id, knobs_hash). The per-tenant
// row count for a given knobs_hash is small (bounded by cache TTL + write
// rate), so the in-memory scan is cheap.
//
// Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.

export const MIGRATION_004_NAME = "query_cache_embedding_column";
export const MIGRATION_004_VERSION = 4;

export const MIGRATION_004_SQL = /* sql */ `
  CREATE SCHEMA IF NOT EXISTS _graphbrain;

  ALTER TABLE _graphbrain.query_cache
    ADD COLUMN IF NOT EXISTS embedding JSONB;

  -- The semantic lookup filters by (tenant_id, knobs_hash) then scans
  -- candidate rows in TypeScript for cosine similarity. A composite index
  -- serves the filter directly. (The migration 003 index on
  -- (tenant_id, query_hash, knobs_hash) is kept for the exact-match path;
  -- this index optimizes the semantic-scan path that drops query_hash.)
  CREATE INDEX IF NOT EXISTS idx_query_cache_tenant_knobs
    ON _graphbrain.query_cache (tenant_id, knobs_hash);
`;
