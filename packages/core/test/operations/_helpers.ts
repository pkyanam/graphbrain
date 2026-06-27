// Shared helpers for operations-layer tests (Stage 10).
//
// Provides mock factories for BrainEngine + AIGateway + EmbeddingService +
// TenantRouter, plus ctx/tenant/page/chunk builders. No real DB, no real
// LLM — everything is mocked. The pattern mirrors
// packages/core/test/search/hybrid.test.ts's mock-engine + mock-gateway
// approach so the two test suites stay consistent.
//
// Usage:
//   const { engine, deps, ctx } = makeFixture();
//   const result = await dispatch("get_page", { slug: "acme" }, ctx, deps);

import type { BrainEngine, SearchOpts } from "../../src/engine";
import type { AIGateway } from "../../src/ai/gateway";
import type { EmbeddingService } from "../../src/embedding";
import type {
  SearchResult,
  Page,
  Chunk,
  Source,
  Link,
  Tenant,
  AuthInfo,
  OperationContext,
  HybridSearchMeta,
  VectorSearchHit,
  TextSearchHit,
  TraversalNode,
  EdgeLabel,
} from "../../src/types";
import type { DispatchDeps, ResolvedDeps } from "../../src/operations";
import { OperationError } from "../../src/operations";
import { expect } from "bun:test";

// ─── Error assertion helpers ─────────────────────────────────────────────────

/**
 * Assert that a sync function throws an OperationError with the given code.
 * bun:test's `toThrow(regex)` matches against the error *message*, not the
 * `code` property — so we check the code explicitly here.
 */
export function expectOpError(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error(`Expected OperationError('${code}') but no error was thrown`);
  } catch (e) {
    if (e instanceof OperationError) {
      expect(e.code).toBe(code);
    } else {
      throw e;
    }
  }
}

/**
 * Async version of expectOpError — for handlers that return a Promise.
 */
export async function expectOpErrorAsync(
  fn: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await fn();
    throw new Error(`Expected OperationError('${code}') but no error was thrown`);
  } catch (e) {
    if (e instanceof OperationError) {
      expect(e.code).toBe(code);
    } else {
      throw e;
    }
  }
}

// ─── Builders ────────────────────────────────────────────────────────────────

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

export function makeTenant(overrides?: Partial<Tenant>): Tenant {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    clerkOrgId: "org-1",
    name: "Test Tenant",
    slug: "test-tenant",
    helixInstanceUrl: "https://helix.test",
    helixApiKeyEncrypted: "enc-key",
    coolifyAppId: null,
    tier: "pro",
    status: "active",
    settings: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

export function makeAuth(overrides?: Partial<AuthInfo>): AuthInfo {
  return {
    mode: "apikey",
    orgId: "org-1",
    orgSlug: "org-1",
    userId: null,
    scopes: [],
    allowedSources: [],
    ...overrides,
  };
}

export function makeCtx(overrides?: Partial<OperationContext>): OperationContext {
  return {
    tenant: makeTenant(),
    auth: makeAuth(),
    remote: false,
    ...overrides,
  };
}

export function makePage(slug: string, title?: string, type?: string): Page {
  return {
    id: nextId("page"),
    slug,
    type: type ?? "note",
    title: title ?? slug,
    compiledTruth: "",
    frontmatter: {},
    pageKind: "markdown",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

export function makeChunk(id: string, pageId: string, content: string): Chunk {
  return {
    id,
    pageId,
    chunkIndex: 0,
    content,
    chunkSource: "compiled_truth",
    modality: "text",
    embedding: null,
    createdAt: new Date(0),
  };
}

export function makeSource(name: string): Source {
  return {
    id: nextId("src"),
    name,
    config: {},
    archived: false,
    createdAt: new Date(0),
  };
}

export function makeLink(from: string, to: string, type: string = "MENTIONS"): Link {
  return {
    id: nextId("link"),
    fromSlug: from,
    toSlug: to,
    type: type as EdgeLabel,
    origin: "manual",
    createdAt: new Date(0),
  };
}

// ─── Mock BrainEngine ────────────────────────────────────────────────────────

export interface MockEngineOpts {
  pages?: Map<string, Page>;
  chunksByPage?: Map<string, Chunk[]>;
  chunksById?: Map<string, Chunk>;
  sources?: Source[];
  sourcesByName?: Map<string, Source>;
  outEdges?: Map<string, Link[]>;
  inEdges?: Map<string, Link[]>;
  vectorHits?: VectorSearchHit[];
  textPageHits?: TextSearchHit[];
  textChunkHits?: TextSearchHit[];
  putPageResult?: Page;
  addChunkResult?: Chunk;
  addEdgeResult?: Link;
  addSourceResult?: Source;
  health?: boolean;
}

/**
 * A fully-mocked BrainEngine. Pages are keyed by slug; chunks by id. Write
 * methods (putPage, addChunk, addEdge, addSource) record into the maps so
 * subsequent reads see them — this lets tests assert the write-through
 * behavior of put_page / add_chunk / add_link.
 */
export function makeMockEngine(opts: MockEngineOpts = {}): BrainEngine {
  const pages = opts.pages ?? new Map<string, Page>();
  const chunksByPage = opts.chunksByPage ?? new Map<string, Chunk[]>();
  const chunksById = opts.chunksById ?? new Map<string, Chunk>();
  const sources = opts.sources ?? [];
  const sourcesByName = opts.sourcesByName ?? new Map<string, Source>();
  // Seed sourcesByName from the initial sources array so get_source by name
  // works without an explicit sourcesByName map.
  for (const s of sources) sourcesByName.set(s.name, s);
  const outEdges = opts.outEdges ?? new Map<string, Link[]>();
  const inEdges = opts.inEdges ?? new Map<string, Link[]>();

  return {
    kind: "helix",
    health: async () => opts.health ?? true,
    close: async () => {},

    getPage: async (slug: string, o?: { includeDeleted?: boolean }) => {
      const p = pages.get(slug);
      if (!p) return null;
      if (p.deletedAt && !o?.includeDeleted) return null;
      return p;
    },
    getPageById: async (id: string) => {
      for (const p of pages.values()) if (p.id === id) return p;
      return null;
    },
    listPages: async (o?: SearchOpts & { offset?: number }) => {
      let list = [...pages.values()];
      if (o?.typeFilter) list = list.filter((p) => p.type === o.typeFilter);
      if (o?.includeDeleted !== true) list = list.filter((p) => !p.deletedAt);
      const offset = o?.offset ?? 0;
      const limit = o?.limit;
      list = limit !== undefined ? list.slice(offset, offset + limit) : list.slice(offset);
      return list;
    },
    putPage: async (pageInput) => {
      const existing = pages.get(pageInput.slug);
      const page: Page = {
        id: existing?.id ?? nextId("page"),
        slug: pageInput.slug,
        type: pageInput.type,
        title: pageInput.title,
        compiledTruth: pageInput.compiledTruth,
        frontmatter: pageInput.frontmatter ?? {},
        pageKind: pageInput.pageKind ?? "markdown",
        contentHash: pageInput.contentHash ?? null,
        emotionalWeight: pageInput.emotionalWeight ?? null,
        effectiveDate: pageInput.effectiveDate ?? null,
        effectiveDateSource: pageInput.effectiveDateSource ?? null,
        importFilename: pageInput.importFilename ?? null,
        createdAt: existing?.createdAt ?? new Date(0),
        updatedAt: new Date(),
      };
      pages.set(page.slug, page);
      return page;
    },
    softDeletePage: async (slug: string) => {
      const p = pages.get(slug);
      if (!p) throw new Error(`Page not found: ${slug}`);
      p.deletedAt = new Date();
    },

    addChunk: async (c) => {
      const chunk: Chunk = {
        id: nextId("chunk"),
        pageId: c.pageId,
        chunkIndex: c.chunkIndex,
        content: c.content,
        chunkSource: c.chunkSource ?? "compiled_truth",
        modality: c.modality ?? "text",
        embedding: c.embedding ?? null,
        embeddingVoyage: c.embeddingVoyage ?? null,
        embeddingImage: c.embeddingImage ?? null,
        model: c.model ?? null,
        tokenCount: c.tokenCount ?? null,
        language: c.language ?? null,
        symbolName: c.symbolName ?? null,
        symbolType: c.symbolType ?? null,
        startLine: c.startLine ?? null,
        endLine: c.endLine ?? null,
        createdAt: new Date(),
      };
      // Find the page slug for this pageId to key the chunk maps.
      let slug: string | undefined;
      for (const p of pages.values()) {
        if (p.id === c.pageId) { slug = p.slug; break; }
      }
      if (slug) {
        const list = chunksByPage.get(slug) ?? [];
        list.push(chunk);
        chunksByPage.set(slug, list);
      }
      chunksById.set(chunk.id, chunk);
      return chunk;
    },
    getChunksByPage: async (slug: string) => chunksByPage.get(slug) ?? [],
    getChunkById: async (id: string) => chunksById.get(id) ?? null,
    updateChunkEmbedding: async (chunkId: string, embedding: number[], model?: string | null) => {
      const c = chunksById.get(chunkId);
      if (!c) throw new Error(`Chunk not found: ${chunkId}`);
      c.embedding = embedding;
      if (model !== undefined) c.model = model;
      return c;
    },

    addEdge: async (link) => {
      const from = pages.get(link.fromSlug);
      const to = pages.get(link.toSlug);
      if (!from) throw new Error(`Page not found: ${link.fromSlug}`);
      if (!to) throw new Error(`Page not found: ${link.toSlug}`);
      const edge: Link = {
        id: nextId("link"),
        fromSlug: link.fromSlug,
        toSlug: link.toSlug,
        type: link.type,
        origin: link.origin,
        ...(link.context !== undefined ? { context: link.context } : {}),
        ...(link.originSlug !== undefined ? { originSlug: link.originSlug } : {}),
        ...(link.originField !== undefined ? { originField: link.originField } : {}),
        createdAt: new Date(),
      };
      const out = outEdges.get(link.fromSlug) ?? [];
      out.push(edge);
      outEdges.set(link.fromSlug, out);
      const inE = inEdges.get(link.toSlug) ?? [];
      inE.push(edge);
      inEdges.set(link.toSlug, inE);
      return edge;
    },
    getOutEdges: async (slug: string, edgeTypes?: EdgeLabel[]) => {
      const list = outEdges.get(slug) ?? [];
      return edgeTypes ? list.filter((e) => edgeTypes.includes(e.type)) : list;
    },
    getInEdges: async (slug: string, edgeTypes?: EdgeLabel[]) => {
      const list = inEdges.get(slug) ?? [];
      return edgeTypes ? list.filter((e) => edgeTypes.includes(e.type)) : list;
    },

    vectorSearchChunks: async () => opts.vectorHits ?? [],
    textSearchPages: async () => opts.textPageHits ?? [],
    textSearchChunks: async () => opts.textChunkHits ?? [],
    traverse: async () => [] as TraversalNode[],

    addSource: async (s) => {
      const source: Source = {
        id: nextId("src"),
        name: s.name,
        localPath: s.localPath ?? null,
        config: s.config ?? {},
        chunkerVersion: s.chunkerVersion ?? null,
        archived: false,
        trustFrontmatterOverrides: s.trustFrontmatterOverrides ?? null,
        contextualRetrievalMode: s.contextualRetrievalMode ?? null,
        createdAt: new Date(),
      };
      sources.push(source);
      sourcesByName.set(source.name, source);
      return source;
    },
    getSource: async (id: string) => sources.find((s) => s.id === id) ?? null,
    getSourceByName: async (name: string) => sourcesByName.get(name) ?? null,
    listSources: async (o?: { includeArchived?: boolean; limit?: number; offset?: number }) => {
      let list = [...sources];
      if (o?.includeArchived !== true) list = list.filter((s) => !s.archived);
      const offset = o?.offset ?? 0;
      const limit = o?.limit;
      return limit !== undefined ? list.slice(offset, offset + limit) : list.slice(offset);
    },
  } as BrainEngine;
}

// ─── Mock AIGateway ──────────────────────────────────────────────────────────

export interface MockGatewayOpts {
  chatContent?: string;
  chatModel?: string;
  embedVectors?: number[][];
  rerankResults?: { index: number; relevanceScore: number }[];
}

export function makeMockGateway(opts: MockGatewayOpts = {}): AIGateway {
  return {
    chat: async (req) => ({
      model: opts.chatModel ?? req.model ?? "test:model",
      content: opts.chatContent ?? "Synthesized answer [1].",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    }),
    embed: async (req) => ({
      model: "test:embed",
      embeddings: opts.embedVectors ?? req.inputs.map(() => [0.1, 0.2, 0.3]),
      dimensions: opts.embedVectors?.[0]?.length ?? 3,
      usage: { promptTokens: req.inputs.length, completionTokens: 0, totalTokens: req.inputs.length },
    }),
    rerank: async () => ({
      model: "test:rerank",
      results: opts.rerankResults ?? [],
    }),
  } as unknown as AIGateway;
}

// ─── Mock EmbeddingService ───────────────────────────────────────────────────

export function makeMockEmbeddingService(vec?: number[] | null): EmbeddingService {
  // When vec is null, return null vectors (simulates no embedding provider).
  // When vec is undefined, default to a non-null vector (simulates active provider).
  const fallback = vec === undefined ? [0.1, 0.2, 0.3] : vec;
  return {
    embed: async (texts: string[]) =>
      texts.map(() => (fallback === null ? null : [...fallback])),
    embedOne: async () => (fallback === null ? null : [...fallback]),
  } as unknown as EmbeddingService;
}

// ─── Mock TenantRouter + DispatchDeps ────────────────────────────────────────

/**
 * Build DispatchDeps with a mock router that returns the given engine (no
 * real provisioning / health check). Use this for dispatch-based tests.
 */
export function makeDispatchDeps(engine: BrainEngine, opts?: {
  gateway?: AIGateway;
  embeddingService?: EmbeddingService;
}): DispatchDeps {
  return {
    router: { getEngine: async () => engine },
    gateway: opts?.gateway ?? makeMockGateway(),
    embeddingService: opts?.embeddingService ?? makeMockEmbeddingService(),
  };
}

/**
 * Build ResolvedDeps directly (for per-op handler tests that bypass dispatch).
 */
export function makeResolvedDeps(engine: BrainEngine, opts?: {
  gateway?: AIGateway;
  embeddingService?: EmbeddingService;
}): ResolvedDeps {
  return {
    engine,
    gateway: opts?.gateway ?? makeMockGateway(),
    embeddingService: opts?.embeddingService ?? makeMockEmbeddingService(),
  };
}

/**
 * Build a complete fixture: mock engine (with optional pre-seeded data) +
 * DispatchDeps + ResolvedDeps + a default ctx. Returns all four so tests can
 * choose whether to call dispatch (needs DispatchDeps) or invoke a handler
 * directly (needs ResolvedDeps).
 */
export function makeFixture(engineOpts?: MockEngineOpts, ctxOpts?: Partial<OperationContext>): {
  engine: BrainEngine;
  dispatchDeps: DispatchDeps;
  resolvedDeps: ResolvedDeps;
  ctx: OperationContext;
} {
  const engine = makeMockEngine(engineOpts);
  return {
    engine,
    dispatchDeps: makeDispatchDeps(engine),
    resolvedDeps: makeResolvedDeps(engine),
    ctx: makeCtx(ctxOpts),
  };
}
