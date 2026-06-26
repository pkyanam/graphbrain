// @graphbrain/core — HelixDB schema definition for Phase 1 knowledge entities.
//
// Ports the GBrain Postgres schema (_reference/gbrain/src/schema.sql) into
// HelixDB node/edge labels per PLAN.md → "Storage Mapping" (lines ~130–188).
// Phase 1 covers Page, Chunk, Source + the link/chunk/containment edges.
// Phase 2/3 entities (Fact, Take, TimelineEntry, File, CodeSymbol, Tag) are
// omitted here — their labels are declared in TYPED_EDGE_LABELS for forward
// reference but no property maps are defined yet.
//
// ─── Design decisions (confirmed against the HelixDB TS SDK DSL) ─────────────
//
// 1. Node labels are IMPLICIT, not pre-declared.
//    The HelixDB DSL (_reference/helix-db/sdks/typescript/src/dsl.ts) has no
//    "create node label" primitive — labels materialize on the first `addN`
//    write. `deploySchema` therefore only creates INDEXES; the property maps
//    below are documentation + the source of truth for the query modules'
//    `valueMap` projections and the snake_case ↔ camelCase mapping. Stage 7's
//    HelixEngine relies on these maps to know which properties exist.
//
// 2. Property names are SNAKE_CASE (faithful to schema.sql column names).
//    The domain types in ./types.ts use camelCase (compiledTruth, contentHash).
//    The query modules under ./queries/ perform the snake_case ↔ camelCase
//    mapping when reading/writing nodes. Keeping storage snake_case matches
//    the reference schema and makes the PLAN.md storage table authoritative.
//
// 3. Edge labels: DISTINCT labels per type (not a generic edge + type prop).
//    The DSL's `addE(label, to, props)` accepts arbitrary label strings, and
//    `out(label)`/`in(label)`/`both(label)` filter by label. Distinct labels
//    per typed edge (WORKS_AT, FOUNDED, …) give clean traversal filters and
//    match the PLAN.md Edge Types table directly. A generic edge with a `type`
//    property would require a post-traversal filter (the DSL's `edgeHas` works
//    on edges but `out(label)` is the idiomatic primitive). Distinct labels it
//    is. The full typed-edge union is TYPED_EDGE_LABELS (from ./types.ts).
//
// 4. Node ids: the domain types (Page.id, Chunk.id) are `string` (ULID in
//    production). The dev HelixDB image returns NUMERIC `$id` (0, 1, …). The
//    query modules coerce `$id` to `String(...)` on read and store references
//    (Chunk.pageId) as strings, so the engine layer never sees a numeric id.
//    For in-batch node references the modules use `NodeRef.var(...)` (which
//    references an earlier batch variable), never `NodeRef.id(<number>)` with
//    a parsed id — so the numeric/string id gap is confined to the read mapping.
//
// ─── DSL gaps + workarounds (Stage 7 needs to know) ─────────────────────────
//
// GAP-1: No multi-field BM25 index. `IndexSpec.nodeText(label, property)` is
//   per-(label, property). PLAN.md wants BM25 over Chunk.content +
//   Page.compiled_truth + Page.title — that is THREE separate nodeText indexes
//   (one per field), created in indexes.ts. textSearchPages must run a
//   separate textSearchNodes per field and merge client-side (the query module
//   does this; see search-text.ts).
//
// GAP-2: No range-filter combined with text/vector search in one traversal.
//   `vectorSearchNodes` / `textSearchNodes` are terminal starts; you cannot
//   chain a `.where(Predicate.gte("effective_date", …))` after them in a way
//   the engine honors for post-filtering within the same batch step. Stage 7's
//   temporal/recency filters must be applied client-side after fetching, OR
//   via a separate `nWithLabel().where(between(...))` traversal when no
//   semantic search is needed. The nodeRange indexes on Page.effective_date +
//   Page.updated_at accelerate the pure-range path.
//
// GAP-3: No native "soft-delete filter" in vector/text search. Search steps
//   do not accept a `.where(deleted_at IS NULL)` post-filter. The query
//   modules exclude soft-deleted pages by filtering client-side after fetch
//   (deletedAt === null). Stage 7 should keep soft-deleted page count low so
//   this is cheap; a future schema revision may add a tenant-scoped boolean
//   index to push this down.
//
// GAP-4: No partial/conditional index. The DSL's IndexSpec has no
//   `WHERE` clause equivalent. The PLAN.md partial indexes (e.g. only
//   non-null embedding_image) are not expressible; we create the full index
//   instead. Footprint is acceptable for Phase 1 tenant sizes.

import type {
  Chunk,
  ChunkModality,
  ChunkSource,
  CRMode,
  EffectiveDateSource,
  EdgeLabel,
  LinkOrigin,
  Page,
  PageKind,
  Source,
} from "../types";
import { TYPED_EDGE_LABELS } from "../types";

// ─── Node labels ─────────────────────────────────────────────────────────────

/** HelixDB node labels deployed in Phase 1. */
export const NODE_LABELS = ["Page", "Chunk", "Source"] as const;
export type NodeLabel = (typeof NODE_LABELS)[number];

/** Property value kinds the query modules read/write (mirrors the DSL variants). */
export type PropType =
  | "string"
  | "i64"
  | "f32"
  | "f64"
  | "bool"
  | "datetime"
  | "f32array"
  | "object";

/** A node property declaration: storage name + value kind + optionality. */
export interface PropertyDecl {
  /** Storage (snake_case) property name — matches schema.sql column. */
  name: string;
  type: PropType;
  optional?: boolean;
}

// Page node — mirrors `pages` table (schema.sql lines 85–153) + PLAN.md row.
// Server-stamped: created_at, updated_at (set to Expr.datetime() on write).
// Soft-delete: deleted_at (null = visible).
export const PAGE_PROPERTIES: PropertyDecl[] = [
  { name: "slug", type: "string" },
  { name: "type", type: "string" },
  { name: "title", type: "string" },
  { name: "compiled_truth", type: "string" },
  { name: "frontmatter", type: "object" },
  { name: "page_kind", type: "string" },
  { name: "content_hash", type: "string", optional: true },
  { name: "emotional_weight", type: "f32", optional: true },
  { name: "effective_date", type: "datetime", optional: true },
  { name: "effective_date_source", type: "string", optional: true },
  { name: "import_filename", type: "string", optional: true },
  { name: "salience_touched_at", type: "datetime", optional: true },
  { name: "last_retrieved_at", type: "datetime", optional: true },
  { name: "links_extracted_at", type: "datetime", optional: true },
  { name: "contextual_retrieval_mode", type: "string", optional: true },
  { name: "corpus_generation", type: "string", optional: true },
  { name: "generation", type: "i64", optional: true },
  { name: "created_at", type: "datetime" },
  { name: "updated_at", type: "datetime" },
  { name: "deleted_at", type: "datetime", optional: true },
];

// Chunk node — mirrors `content_chunks` table (schema.sql lines 296–329).
// page_id is stored as a STRING (coerced node id) so the engine never handles
// raw numeric ids. embedding is the primary text vector (f32array).
export const CHUNK_PROPERTIES: PropertyDecl[] = [
  { name: "page_id", type: "string" },
  { name: "chunk_index", type: "i64" },
  { name: "content", type: "string" },
  { name: "chunk_source", type: "string" },
  { name: "modality", type: "string" },
  { name: "embedding", type: "f32array", optional: true },
  { name: "embedding_voyage", type: "f32array", optional: true },
  { name: "embedding_image", type: "f32array", optional: true },
  { name: "model", type: "string", optional: true },
  { name: "token_count", type: "i64", optional: true },
  { name: "language", type: "string", optional: true },
  { name: "symbol_name", type: "string", optional: true },
  { name: "symbol_type", type: "string", optional: true },
  { name: "start_line", type: "i64", optional: true },
  { name: "end_line", type: "i64", optional: true },
  { name: "embedded_at", type: "datetime", optional: true },
  { name: "created_at", type: "datetime" },
];

// Source node — mirrors `sources` table (schema.sql lines 26–58).
export const SOURCE_PROPERTIES: PropertyDecl[] = [
  { name: "name", type: "string" },
  { name: "local_path", type: "string", optional: true },
  { name: "last_commit", type: "string", optional: true },
  { name: "last_sync_at", type: "datetime", optional: true },
  { name: "config", type: "object" },
  { name: "chunker_version", type: "i64", optional: true },
  { name: "archived", type: "bool" },
  { name: "archived_at", type: "datetime", optional: true },
  { name: "archive_expires_at", type: "datetime", optional: true },
  { name: "contextual_retrieval_mode", type: "string", optional: true },
  { name: "trust_frontmatter_overrides", type: "bool", optional: true },
  { name: "newest_content_at", type: "datetime", optional: true },
  { name: "created_at", type: "datetime" },
];

/** All Phase 1 node property declarations keyed by label. */
export const NODE_PROPERTY_MAP: Record<NodeLabel, PropertyDecl[]> = {
  Page: PAGE_PROPERTIES,
  Chunk: CHUNK_PROPERTIES,
  Source: SOURCE_PROPERTIES,
};

/** All snake_case property names for a label (used for valueMap projections). */
export function propertyNames(label: NodeLabel): string[] {
  return NODE_PROPERTY_MAP[label].map((p) => p.name);
}

// ─── Edge labels ─────────────────────────────────────────────────────────────

/**
 * Phase 1 edge labels. The full typed-edge union (TYPED_EDGE_LABELS) is
 * re-exported from ./types.ts; the labels below are the ones Stage 6 query
 * modules create/traverse. Stage 7/10 may create additional typed edges
 * (WORKS_AT, FOUNDED, …) via addEdge — they are all valid `addE` labels.
 */
export const EDGE_LABELS = TYPED_EDGE_LABELS;

/** Edges whose `from` is a Page and `to` is a Page (typed + generic links). */
export const PAGE_TO_PAGE_EDGES: EdgeLabel[] = [
  "WORKS_AT",
  "FOUNDED",
  "INVESTED_IN",
  "ATTENDED",
  "ADVISES",
  "MENTIONS",
];

/** Structural edges (non-link). */
export const HAS_CHUNK_EDGE = "HAS_CHUNK" as const;
export const CONTAINS_EDGE = "CONTAINS" as const;

/** Edge property declarations (all Phase 1 edges share the same small set). */
export const EDGE_PROPERTIES: PropertyDecl[] = [
  { name: "origin", type: "string", optional: true },
  { name: "context", type: "string", optional: true },
  { name: "origin_slug", type: "string", optional: true },
  { name: "origin_field", type: "string", optional: true },
  { name: "created_at", type: "datetime", optional: true },
];

// ─── snake_case ↔ camelCase mapping tables ──────────────────────────────────
// The query modules use these to translate between HelixDB storage property
// names (snake_case) and the camelCase domain types in ./types.ts.

const PAGE_FIELD_MAP: Record<keyof Page, string> = {
  id: "$id",
  slug: "slug",
  type: "type",
  title: "title",
  compiledTruth: "compiled_truth",
  frontmatter: "frontmatter",
  pageKind: "page_kind",
  contentHash: "content_hash",
  emotionalWeight: "emotional_weight",
  effectiveDate: "effective_date",
  effectiveDateSource: "effective_date_source",
  importFilename: "import_filename",
  salienceTouchedAt: "salience_touched_at",
  lastRetrievedAt: "last_retrieved_at",
  linksExtractedAt: "links_extracted_at",
  contextualRetrievalMode: "contextual_retrieval_mode",
  corpusGeneration: "corpus_generation",
  generation: "generation",
  deletedAt: "deleted_at",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

const CHUNK_FIELD_MAP: Record<keyof Chunk, string> = {
  id: "$id",
  pageId: "page_id",
  chunkIndex: "chunk_index",
  content: "content",
  chunkSource: "chunk_source",
  modality: "modality",
  embedding: "embedding",
  embeddingVoyage: "embedding_voyage",
  embeddingImage: "embedding_image",
  model: "model",
  tokenCount: "token_count",
  language: "language",
  symbolName: "symbol_name",
  symbolType: "symbol_type",
  startLine: "start_line",
  endLine: "end_line",
  embeddedAt: "embedded_at",
  createdAt: "created_at",
};

const SOURCE_FIELD_MAP: Record<keyof Source, string> = {
  id: "$id",
  name: "name",
  localPath: "local_path",
  lastCommit: "last_commit",
  lastSyncAt: "last_sync_at",
  config: "config",
  chunkerVersion: "chunker_version",
  archived: "archived",
  archivedAt: "archived_at",
  archiveExpiresAt: "archive_expires_at",
  contextualRetrievalMode: "contextual_retrieval_mode",
  trustFrontmatterOverrides: "trust_frontmatter_overrides",
  newestContentAt: "newest_content_at",
  createdAt: "created_at",
};

/** Reverse map: snake_case storage name → camelCase domain field. */
function reverseMap(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [camel, snake] of Object.entries(map)) out[snake] = camel;
  return out;
}

export const PAGE_SNAKE_TO_CAMEL = reverseMap(PAGE_FIELD_MAP);
export const CHUNK_SNAKE_TO_CAMEL = reverseMap(CHUNK_FIELD_MAP);
export const SOURCE_SNAKE_TO_CAMEL = reverseMap(SOURCE_FIELD_MAP);

export { PAGE_FIELD_MAP, CHUNK_FIELD_MAP, SOURCE_FIELD_MAP };

// Re-export the domain enums the query modules use for property coercion.
export type {
  Page,
  Chunk,
  Source,
  PageKind,
  ChunkModality,
  ChunkSource,
  CRMode,
  EffectiveDateSource,
  EdgeLabel,
  LinkOrigin,
};
