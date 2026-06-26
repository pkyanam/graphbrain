// Migration 003 — `_graphbrain.query_cache`.
//
// Semantic cache for hybrid search results. Keyed by
// (tenant_id, query_hash, knobs_hash) so a tokenmax write can't be served to
// a conservative read (GBrain "Cache-key contamination" invariant, ported).
// `results` is JSONB — pass raw objects to postgres.js, never
// `JSON.stringify` into `::jsonb` (Stage 1 note #2 / GBrain CLAUDE.md).
//
// Idempotent: every statement uses IF NOT EXISTS.

export const MIGRATION_003_NAME = "query_cache_table";
export const MIGRATION_003_VERSION = 3;

export const MIGRATION_003_SQL = /* sql */ `
  CREATE SCHEMA IF NOT EXISTS _graphbrain;

  CREATE TABLE IF NOT EXISTS _graphbrain.query_cache (
    id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID         NOT NULL REFERENCES _graphbrain.tenants(id) ON DELETE CASCADE,
    query_hash   TEXT         NOT NULL,
    knobs_hash   TEXT         NOT NULL,
    results      JSONB        NOT NULL DEFAULT '[]'::jsonb,
    hits         INTEGER      NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    ttl_at       TIMESTAMPTZ
  );

  -- The lookup filter is WHERE tenant_id = $ AND query_hash = $ AND knobs_hash = $.
  -- A composite index serves it directly; the partial WHERE ttl_at IS NULL OR
  -- ttl_at > now() predicate would help eviction but complicates writes, so we
  -- keep the index covering all rows and let Stage 10's cache layer filter TTL.
  CREATE INDEX IF NOT EXISTS idx_query_cache_tenant_query_knobs
    ON _graphbrain.query_cache (tenant_id, query_hash, knobs_hash);

  CREATE INDEX IF NOT EXISTS idx_query_cache_ttl
    ON _graphbrain.query_cache (ttl_at)
    WHERE ttl_at IS NOT NULL;
`;
