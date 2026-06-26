// @graphbrain/core — HelixEngine: BrainEngine implementation backed by HelixDB.
//
// Wraps a HelixDB `Client` (from the TS SDK) and delegates each BrainEngine
// method to the corresponding Stage 6 dynamic query module. The engine is
// constructed per-tenant by `TenantRouter` (./tenant.ts) with the tenant's
// HelixDB URL + decrypted API key. The client is created lazily on first use
// so constructing an engine does NOT open a connection.
//
// Not-found behavior (Stage 6 handoff note 2):
//   • Read-side lookups (getPage, getSource, getSourceByName) catch the
//     Stage 6 "no ... found" Error and return null.
//   • Write-side ops (putPage on existing, softDeletePage, addEdge,
//     updateChunkEmbedding) let the Stage 6 errors propagate — they cannot
//     proceed without the target entity.
//
// putPage (upsert, handoff note 3): checks existence via getPageBySlug, then
// branches to addPage (new) or updatePage (existing, all fields as the patch).
// This is a 2-round-trip but keeps the query modules simple.
//
// getChunksByPage(slug) (handoff note 4): resolves slug→pageId via
// getPageBySlug first, then calls the Stage 6 getChunksByPage(client, pageId).
// This is the engine layer's job, not the query module's.

import { Client } from "@helix-db/helix-db";
import type {
  Page,
  PageInput,
  Chunk,
  Source,
  Link,
  EdgeLabel,
} from "./types";
import type { BrainEngine, SearchOpts } from "./engine";
import { clampSearchLimit } from "./engine";
import type {
  TraverseOptions,
  TraversalNode,
  VectorSearchHit,
  TextSearchHit,
} from "./helix/queries";
import {
  addPage,
  getPageBySlug,
  updatePage,
  softDeletePage,
  listPages,
  addChunk,
  getChunksByPage,
  updateChunkEmbedding,
  addSource,
  getSource,
  getSourceById,
  listSources,
  addEdge,
  getOutEdges,
  getInEdges,
  vectorSearchChunks,
  textSearchPages,
  textSearchChunks,
  traverseFrom,
} from "./helix/queries";

/** Constructor options for HelixEngine. */
export interface HelixEngineOptions {
  /** Base URL of the tenant's HelixDB instance (e.g. "http://localhost:8080"). */
  url: string;
  /** Plaintext HelixDB API key (decrypted from tenant.helixApiKeyEncrypted). */
  apiKey: string;
  /**
   * Optional health-check timeout in ms. Default 2000. Exposed so tests can
   * shorten the probe. The TenantRouter reuses this for its health check.
   */
  healthTimeoutMs?: number;
}

/**
 * HelixEngine — BrainEngine implementation backed by a per-tenant HelixDB
 * instance. The SDK Client is created lazily on first use and reused for all
 * subsequent queries. `close()` drops the client reference (the SDK Client has
 * no explicit disconnect — it just dereferences its fetch endpoint).
 */
export class HelixEngine implements BrainEngine {
  readonly kind = "helix" as const;

  private readonly url: string;
  private readonly apiKey: string;
  private readonly healthTimeoutMs: number;
  private _client: Client | null = null;

  constructor(opts: HelixEngineOptions) {
    this.url = opts.url;
    this.apiKey = opts.apiKey;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 2_000;
  }

  /** The lazily-created SDK Client. Exposed for tests + TenantRouter health. */
  get client(): Client {
    if (!this._client) {
      this._client = new Client(this.url).withApiKey(this.apiKey);
    }
    return this._client;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/health`, {
        signal: AbortSignal.timeout(this.healthTimeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    // The SDK Client has no explicit disconnect — it just holds a URL + key.
    // Dropping the reference lets GC reclaim it. Safe to call multiple times.
    this._client = null;
  }

  // ── Pages ──────────────────────────────────────────────────────────────────

  async getPage(slug: string, opts?: { includeDeleted?: boolean }): Promise<Page | null> {
    try {
      return await getPageBySlug(this.client, slug, { includeDeleted: opts?.includeDeleted });
    } catch {
      return null;
    }
  }

  async listPages(opts?: SearchOpts & { offset?: number }): Promise<Page[]> {
    return listPages(this.client, {
      type: opts?.typeFilter,
      limit: opts?.limit,
      offset: opts?.offset,
      includeDeleted: opts?.includeDeleted,
    });
  }

  async putPage(page: PageInput): Promise<Page> {
    // Upsert by slug: check existence, then branch (handoff note 3).
    const existing = await this.getPage(page.slug);
    if (existing) {
      return updatePage(this.client, {
        slug: page.slug,
        patch: {
          title: page.title,
          type: page.type,
          compiledTruth: page.compiledTruth,
          frontmatter: page.frontmatter,
          pageKind: page.pageKind,
          contentHash: page.contentHash,
          emotionalWeight: page.emotionalWeight,
          effectiveDate: page.effectiveDate,
          effectiveDateSource: page.effectiveDateSource,
          importFilename: page.importFilename,
          contextualRetrievalMode: page.contextualRetrievalMode,
        },
      });
    }
    return addPage(this.client, {
      slug: page.slug,
      type: page.type,
      title: page.title,
      compiledTruth: page.compiledTruth,
      frontmatter: page.frontmatter,
      pageKind: page.pageKind,
      contentHash: page.contentHash,
      emotionalWeight: page.emotionalWeight,
      effectiveDate: page.effectiveDate,
      effectiveDateSource: page.effectiveDateSource,
      importFilename: page.importFilename,
      contextualRetrievalMode: page.contextualRetrievalMode,
    });
  }

  async softDeletePage(slug: string): Promise<void> {
    // Stage 6 throws on not-found — let it propagate (write-side).
    await softDeletePage(this.client, slug);
  }

  // ── Chunks ─────────────────────────────────────────────────────────────────

  async addChunk(chunk: {
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
  }): Promise<Chunk> {
    return addChunk(this.client, chunk);
  }

  async getChunksByPage(slug: string): Promise<Chunk[]> {
    // Engine resolves slug → pageId first (handoff note 4).
    const page = await this.getPage(slug);
    if (!page) return [];
    return getChunksByPage(this.client, page.id);
  }

  async updateChunkEmbedding(
    chunkId: string,
    embedding: number[],
    model?: string | null,
  ): Promise<Chunk> {
    // Stage 6 throws on not-found — let it propagate (write-side).
    return updateChunkEmbedding(this.client, { chunkId, embedding, model });
  }

  // ── Edges (links) ──────────────────────────────────────────────────────────

  async addEdge(link: {
    fromSlug: string;
    toSlug: string;
    type: EdgeLabel;
    origin: Link["origin"];
    context?: string;
    originSlug?: string | null;
    originField?: string | null;
  }): Promise<Link> {
    // Stage 6 throws if either page is missing — let it propagate (write-side).
    return addEdge(this.client, link);
  }

  async getOutEdges(slug: string, edgeTypes?: EdgeLabel[]): Promise<Link[]> {
    return getOutEdges(this.client, slug, edgeTypes);
  }

  async getInEdges(slug: string, edgeTypes?: EdgeLabel[]): Promise<Link[]> {
    return getInEdges(this.client, slug, edgeTypes);
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  async vectorSearchChunks(embedding: number[], opts?: SearchOpts): Promise<VectorSearchHit[]> {
    const limit = clampSearchLimit(opts?.limit, opts?.mode);
    return vectorSearchChunks(this.client, { embedding, limit });
  }

  async textSearchPages(query: string, opts?: SearchOpts): Promise<TextSearchHit[]> {
    const limit = clampSearchLimit(opts?.limit, opts?.mode);
    return textSearchPages(this.client, { query, limit });
  }

  async textSearchChunks(query: string, opts?: SearchOpts): Promise<TextSearchHit[]> {
    const limit = clampSearchLimit(opts?.limit, opts?.mode);
    return textSearchChunks(this.client, { query, limit });
  }

  // ── Graph traversal ────────────────────────────────────────────────────────

  async traverse(slug: string, opts?: TraverseOptions): Promise<TraversalNode[]> {
    return traverseFrom(this.client, slug, opts);
  }

  // ── Sources ────────────────────────────────────────────────────────────────

  async addSource(source: {
    name: string;
    localPath?: string | null;
    config?: Record<string, unknown>;
    chunkerVersion?: number | null;
    contextualRetrievalMode?: Source["contextualRetrievalMode"];
    trustFrontmatterOverrides?: boolean | null;
  }): Promise<Source> {
    return addSource(this.client, source);
  }

  async getSource(id: string): Promise<Source | null> {
    // Stage 6's getSourceById returns null on miss (read-side).
    return getSourceById(this.client, id);
  }

  async getSourceByName(name: string): Promise<Source | null> {
    try {
      return await getSource(this.client, name);
    } catch {
      return null;
    }
  }

  async listSources(opts?: {
    includeArchived?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<Source[]> {
    return listSources(this.client, opts ?? {});
  }
}
