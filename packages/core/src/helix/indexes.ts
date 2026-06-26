// @graphbrain/core — HelixDB index specifications for Phase 1.
//
// Mirrors PLAN.md → "Indexes" (lines ~170–188), filtered to Phase 1 entities
// (Page, Chunk, Source). Phase 2/3 indexes (Fact.visibility, Take.who, the
// synthetic Page embedding, embedding_voyage, embedding_image) are omitted.
//
// Index creation uses the DSL's `IndexSpec` + `createIndexIfNotExists`, which
// emits `CreateIndex { if_not_exists: true }` — idempotent. deploySchema sends
// these as write batches; re-running deploySchema is a no-op (verified against
// the local Docker Compose HelixDB: re-create returns HTTP 200 with empty ids).
//
// See schema.ts → "DSL gaps" for the multi-field BM25 + range-filter caveats.

import { IndexSpec } from "@helix-db/helix-db";
import type { IndexSpec as IndexSpecType } from "@helix-db/helix-db";

// ─── Vector indexes (ANN) ────────────────────────────────────────────────────

/** Primary text embedding on Chunk (PLAN.md: m=16, ef_construction=128). */
export const CHUNK_EMBEDDING_VECTOR_INDEX = IndexSpec.nodeVector("Chunk", "embedding");

// Phase 2/3 vector indexes (declared here for forward reference; NOT deployed
// in Phase 1 — deploySchema only creates CHUNK_EMBEDDING_VECTOR_INDEX):
//   Chunk.embedding_voyage, Chunk.embedding_image, Page synthetic embedding.

// ─── Text indexes (BM25) ─────────────────────────────────────────────────────
// One nodeText index per field — the DSL has no multi-field BM25 (GAP-1 in
// schema.ts). textSearchPages runs a search per field and merges client-side.

export const CHUNK_CONTENT_TEXT_INDEX = IndexSpec.nodeText("Chunk", "content");
export const PAGE_COMPILED_TRUTH_TEXT_INDEX = IndexSpec.nodeText("Page", "compiled_truth");
export const PAGE_TITLE_TEXT_INDEX = IndexSpec.nodeText("Page", "title");

// ─── Equality indexes (exact lookup) ─────────────────────────────────────────

export const PAGE_SLUG_EQUALITY_INDEX = IndexSpec.nodeEquality("Page", "slug");
export const PAGE_TYPE_EQUALITY_INDEX = IndexSpec.nodeEquality("Page", "type");

// ─── Range indexes (temporal / recency) ──────────────────────────────────────

export const PAGE_EFFECTIVE_DATE_RANGE_INDEX = IndexSpec.nodeRange("Page", "effective_date");
export const PAGE_UPDATED_AT_RANGE_INDEX = IndexSpec.nodeRange("Page", "updated_at");

// ─── Deployed index set (Phase 1) ────────────────────────────────────────────

/**
 * The full set of indexes deploySchema creates on a fresh tenant instance.
 * Order: vector → text → equality → range (matches PLAN.md index table order).
 */
export const DEPLOYED_INDEXES: IndexSpecType[] = [
  CHUNK_EMBEDDING_VECTOR_INDEX,
  CHUNK_CONTENT_TEXT_INDEX,
  PAGE_COMPILED_TRUTH_TEXT_INDEX,
  PAGE_TITLE_TEXT_INDEX,
  PAGE_SLUG_EQUALITY_INDEX,
  PAGE_TYPE_EQUALITY_INDEX,
  PAGE_EFFECTIVE_DATE_RANGE_INDEX,
  PAGE_UPDATED_AT_RANGE_INDEX,
];
