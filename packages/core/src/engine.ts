// @graphbrain/core — BrainEngine interface + SearchOpts + clampSearchLimit.
//
// The engine abstraction Stage 10's operations call through. Phase 1 ships one
// implementation: `HelixEngine` (./helix-engine.ts), which delegates to the
// Stage 6 dynamic query modules against a per-tenant HelixDB instance. A
// future Polygres-backed engine would implement the same interface — that is
// the seam this file defines.
//
// Ported from _reference/gbrain/src/core/engine.ts (interface shape +
// clampSearchLimit) and adapted to Graphbrain's multi-tenant HelixDB model:
//   • ids are strings throughout (HelixDB node ids; see schema.ts design note 4).
//   • No `sourceId` axis — each tenant has exactly one brain (Phase 1).
//   • Not-found behavior: read-side methods (getPage, getSource) return null;
//     write-side methods (putPage, softDeletePage, addEdge, updateChunkEmbedding)
//     throw. See Stage 6 handoff note 2.
//
// SearchOpts + clampSearchLimit follow the CLAUDE.md "Search Mode" table:
//   conservative → limit 10, balanced → 25, tokenmax → 50.

import type {
  Page,
  PageInput,
  Chunk,
  Source,
  Link,
  EdgeLabel,
  SearchMode,
  PageType,
} from "./types";
import type {
  TraverseDirection,
  TraverseOptions,
  TraversalNode,
  VectorSearchHit,
  TextSearchHit,
} from "./helix/queries";

// ─── SearchOpts ──────────────────────────────────────────────────────────────

/**
 * Per-call search options. `mode` resolves the default `limit` via
 * `clampSearchLimit` (conservative=10, balanced=25, tokenmax=50); an explicit
 * `limit` wins over the mode default but is still capped at the mode ceiling.
 */
export interface SearchOpts {
  /** Max results. When omitted, the mode default is used. */
  limit?: number;
  /** Search mode bundle (resolves the default limit + downstream retrieval
   *  knobs in Stage 9). Defaults to "balanced" per the resolution chain. */
  mode?: SearchMode;
  /** Filter results to a single page type. */
  typeFilter?: PageType;
  /** Include soft-deleted pages in results. Default false. */
  includeDeleted?: boolean;
}

/** Per-mode default + ceiling limits (CLAUDE.md "Search Mode" table). */
export const MODE_SEARCH_LIMITS: Record<SearchMode, number> = {
  conservative: 10,
  balanced: 25,
  tokenmax: 50,
};

/** Absolute cap regardless of mode (mirrors GBrain MAX_SEARCH_LIMIT). */
export const MAX_SEARCH_LIMIT = 100;

/**
 * Clamp a user-provided search limit to a safe range, falling back to the
 * mode default when the caller omits it (or passes an invalid value).
 *
 * Resolution (matches the CLAUDE.md resolution chain):
 *   explicit valid limit → min(limit, modeCeiling)
 *   omitted / invalid    → modeCeiling (conservative=10, balanced=25, tokenmax=50)
 *
 * The mode ceiling is also the default — there is no separate "default < cap"
 * split here because the mode bundle IS the default. An explicit limit above
 * the mode ceiling is clamped down so a caller can't accidentally pull 100
 * rows in conservative mode; callers that genuinely want more should switch
 * mode or use `listPages` (which is not clamped — it's a bulk read, not a
 * search).
 */
export function clampSearchLimit(
  limit: number | undefined,
  mode: SearchMode = "balanced",
): number {
  const modeCeiling = MODE_SEARCH_LIMITS[mode] ?? MODE_SEARCH_LIMITS.balanced;
  if (limit === undefined || limit === null || !Number.isFinite(limit) || Number.isNaN(limit)) {
    return modeCeiling;
  }
  if (limit <= 0) return modeCeiling;
  return Math.min(Math.floor(limit), modeCeiling, MAX_SEARCH_LIMIT);
}

// ─── BrainEngine interface ───────────────────────────────────────────────────

/**
 * The knowledge-graph engine contract. Every method operates against the
 * tenant's isolated HelixDB instance (the engine is constructed per-tenant by
 * `TenantRouter`). Methods are tenant-scoped by construction — there is no
 * `tenantId` parameter because the engine IS bound to one tenant.
 *
 * **Not-found behavior** (Stage 6 handoff note 2):
 *   • Read-side lookups (`getPage`, `getSource`) return `null` on miss.
 *   • Write-side ops (`putPage` on existing, `softDeletePage`, `addEdge`,
 *     `updateChunkEmbedding`) throw on miss — they cannot proceed without the
 *     target entity.
 *
 * **Id contract**: all ids (`Page.id`, `Chunk.id`, `Source.id`, `chunkId`
 * args) are strings. The HelixEngine coerces HelixDB's numeric `$id` to
 * string on read (see _shared.ts coerceId).
 */
export interface BrainEngine {
  /** Discriminator: lets consumers branch on engine kind without instanceof. */
  readonly kind: "helix" | "postgres";

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Probe whether the backing store is reachable. Used by TenantRouter's
   * health check before reusing a cached engine. Returns true on a 200 from
   * the store's health endpoint.
   */
  health(): Promise<boolean>;
  /** Release the underlying client / connection pool. Safe to call multiple times. */
  close(): Promise<void>;

  // ── Pages ──────────────────────────────────────────────────────────────────

  /** Fetch a page by slug. Returns null if not found (or soft-deleted, unless
   *  `opts.includeDeleted` is set). */
  getPage(slug: string, opts?: { includeDeleted?: boolean }): Promise<Page | null>;
  /** Fetch a page by node id. Returns null if not found. Used by Stage 9's
   *  hybrid search to hydrate vector-search hits (which return pageId). */
  getPageById(id: string, opts?: { includeDeleted?: boolean }): Promise<Page | null>;
  /** List pages, optionally filtered by type. Not clamped (bulk read). */
  listPages(opts?: SearchOpts & { offset?: number }): Promise<Page[]>;
  /** Insert or update a page (upsert by slug). Checks existence first, then
   *  branches to add vs update. Throws on write failure. */
  putPage(page: PageInput): Promise<Page>;
  /** Soft-delete a page by slug (sets deleted_at). Throws if not found. */
  softDeletePage(slug: string): Promise<void>;

  // ── Chunks ─────────────────────────────────────────────────────────────────

  /** Add a chunk to a page (pageId resolved by the caller from Page.id). */
  addChunk(chunk: {
    pageId: string;
    chunkIndex: number;
    content: string;
    chunkSource?: Chunk["chunkSource"];
    modality?: Chunk["modality"];
    embedding?: number[] | null;
    embeddingVoyage?: number[] | null;
    embeddingImage?: number[] | null;
    model?: string | null;
    tokenCount?: number | null;
    language?: string | null;
    symbolName?: string | null;
    symbolType?: string | null;
    startLine?: number | null;
    endLine?: number | null;
  }): Promise<Chunk>;
  /** List chunks for a page, resolved by slug. Returns [] if the page has no
   *  chunks (or the page itself is missing — caller should getPage first if
   *  it needs to distinguish). */
  getChunksByPage(slug: string): Promise<Chunk[]>;
  /** Fetch a chunk by node id. Returns null if not found. Used by Stage 9's
   *  hybrid search to hydrate text-search chunk hits (which return chunk id). */
  getChunkById(id: string): Promise<Chunk | null>;
  /** Overwrite a chunk's embedding vector. Throws if the chunk id is not found. */
  updateChunkEmbedding(chunkId: string, embedding: number[], model?: string | null): Promise<Chunk>;

  // ── Edges (links) ──────────────────────────────────────────────────────────

  /** Add a typed or generic edge between two pages (looked up by slug). Throws
   *  if either page is missing. */
  addEdge(link: {
    fromSlug: string;
    toSlug: string;
    type: EdgeLabel;
    origin: Link["origin"];
    context?: string;
    originSlug?: string | null;
    originField?: string | null;
  }): Promise<Link>;
  /** Outgoing edges from a page (by slug). Optionally filtered by edge label. */
  getOutEdges(slug: string, edgeTypes?: EdgeLabel[]): Promise<Link[]>;
  /** Incoming edges to a page (by slug). Optionally filtered by edge label. */
  getInEdges(slug: string, edgeTypes?: EdgeLabel[]): Promise<Link[]>;

  // ── Search ─────────────────────────────────────────────────────────────────

  /** Vector search over Chunk.embedding. `limit` is clamped via clampSearchLimit. */
  vectorSearchChunks(embedding: number[], opts?: SearchOpts): Promise<VectorSearchHit[]>;
  /** BM25 text search over Page.title + Page.compiled_truth. */
  textSearchPages(query: string, opts?: SearchOpts): Promise<TextSearchHit[]>;
  /** BM25 text search over Chunk.content. */
  textSearchChunks(query: string, opts?: SearchOpts): Promise<TextSearchHit[]>;

  // ── Graph traversal ────────────────────────────────────────────────────────

  /** Walk the typed-edge graph from a seed page (by slug). */
  traverse(slug: string, opts?: TraverseOptions): Promise<TraversalNode[]>;

  // ── Sources ────────────────────────────────────────────────────────────────

  /** Add a source (repo / folder / feed) to the tenant's brain. */
  addSource(source: {
    name: string;
    localPath?: string | null;
    config?: Record<string, unknown>;
    chunkerVersion?: number | null;
    contextualRetrievalMode?: Source["contextualRetrievalMode"];
    trustFrontmatterOverrides?: boolean | null;
  }): Promise<Source>;
  /** Fetch a source by id. Stage 6's getSource takes a name; the engine
   *  resolves id→source via a getById traversal. Returns null if not found. */
  getSource(id: string): Promise<Source | null>;
  /** Fetch a source by name (the natural key in Stage 6). Returns null if not found. */
  getSourceByName(name: string): Promise<Source | null>;
  /** List sources in the tenant's brain. */
  listSources(opts?: { includeArchived?: boolean; limit?: number; offset?: number }): Promise<Source[]>;
}

// Re-export the traversal types so consumers can import them from the engine
// entry point without reaching into ./helix/queries.
export type {
  TraverseDirection,
  TraverseOptions,
  TraversalNode,
  VectorSearchHit,
  TextSearchHit,
};
