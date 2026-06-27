// Shared helpers for the Stage 12 route tests.
//
// Provides mock factories for BrainEngine + DispatchDeps + a stub auth
// middleware that injects a fixed `req.context` (bypassing clerkAuth /
// tenantResolver / contextBuilder). The pattern mirrors
// packages/core/test/operations/_helpers.ts but is self-contained so the
// apps/api tests don't reach across package test directories.
//
// Route tests spin up a REAL Express app via `createApp({ deps, authChain })`
// and hit it with `fetch` against the listening port — supertest-style. This
// exercises the full route → dispatch → response path including the error
// handler + body parsers.

import type { Request, Response, NextFunction } from "express";
import {
  type BrainEngine,
  type SearchOpts,
  type AIGateway,
  type EmbeddingService,
  type DispatchDeps,
  type Tenant,
  type AuthInfo,
  type OperationContext,
  type Page,
  type Chunk,
  type Source,
  type Link,
  type EdgeLabel,
  type VectorSearchHit,
  type TextSearchHit,
  type TraversalNode,
} from "@graphbrain/core";

// ─── Builders ────────────────────────────────────────────────────────────────

export function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: "t_1",
    clerkOrgId: "org_123",
    name: "Acme Corp",
    slug: "acme-corp",
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

export function makeAuth(overrides: Partial<AuthInfo> = {}): AuthInfo {
  return {
    mode: "jwt",
    orgId: "org_123",
    orgSlug: "acme-corp",
    userId: "user_test_123",
    scopes: ["read", "write"],
    allowedSources: [],
    ...overrides,
  };
}

export function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    tenant: makeTenant(),
    auth: makeAuth(),
    remote: true,
    ...overrides,
  };
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
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

// ─── Mock BrainEngine ────────────────────────────────────────────────────────

export interface MockEngineOpts {
  pages?: Map<string, Page>;
  chunksByPage?: Map<string, Chunk[]>;
  sources?: Source[];
  health?: boolean;
}

export function makeMockEngine(opts: MockEngineOpts = {}): BrainEngine {
  const pages = opts.pages ?? new Map<string, Page>();
  const chunksByPage = opts.chunksByPage ?? new Map<string, Chunk[]>();
  const sources = opts.sources ?? [];
  return {
    kind: "helix",
    health: async () => opts.health ?? true,
    close: async () => {},
    getPage: async (slug) => pages.get(slug) ?? null,
    getPageById: async (id) => {
      for (const p of pages.values()) if (p.id === id) return p;
      return null;
    },
    listPages: async (o?: SearchOpts & { offset?: number }) => {
      let list = [...pages.values()];
      if (o?.typeFilter) list = list.filter((p) => p.type === o.typeFilter);
      const offset = o?.offset ?? 0;
      const limit = o?.limit;
      return limit !== undefined ? list.slice(offset, offset + limit) : list.slice(offset);
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
    softDeletePage: async (slug) => {
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
        createdAt: new Date(),
      };
      let slug: string | undefined;
      for (const p of pages.values()) {
        if (p.id === c.pageId) { slug = p.slug; break; }
      }
      if (slug) {
        const list = chunksByPage.get(slug) ?? [];
        list.push(chunk);
        chunksByPage.set(slug, list);
      }
      return chunk;
    },
    getChunksByPage: async (slug) => chunksByPage.get(slug) ?? [],
    getChunkById: async () => null,
    updateChunkEmbedding: async (chunkId, embedding) => ({ id: chunkId, embedding } as Chunk),
    addEdge: async () => ({}) as Link,
    getOutEdges: async () => [] as Link[],
    getInEdges: async () => [] as Link[],
    vectorSearchChunks: async () => [] as VectorSearchHit[],
    textSearchPages: async () => [] as TextSearchHit[],
    textSearchChunks: async () => [] as TextSearchHit[],
    traverse: async () => [] as TraversalNode[],
    addSource: async (s) => {
      const source: Source = {
        id: nextId("src"),
        name: s.name,
        localPath: s.localPath ?? null,
        config: s.config ?? {},
        chunkerVersion: s.chunkerVersion ?? null,
        archived: false,
        createdAt: new Date(),
      };
      sources.push(source);
      return source;
    },
    getSource: async () => null,
    getSourceByName: async () => null,
    listSources: async (o?: { includeArchived?: boolean; limit?: number; offset?: number }) => {
      let list = [...sources];
      if (o?.includeArchived !== true) list = list.filter((s) => !s.archived);
      const offset = o?.offset ?? 0;
      const limit = o?.limit;
      return limit !== undefined ? list.slice(offset, offset + limit) : list.slice(offset);
    },
  } as unknown as BrainEngine;
}

// ─── Mock AIGateway + EmbeddingService ───────────────────────────────────────

export function makeMockGateway(): AIGateway {
  return {
    chat: async (req) => ({
      model: req.model ?? "test:model",
      content: "Synthesized answer [1].",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    }),
    embed: async (req) => ({
      model: "test:embed",
      embeddings: req.inputs.map(() => [0.1, 0.2, 0.3]),
      dimensions: 3,
      usage: { promptTokens: req.inputs.length, completionTokens: 0, totalTokens: req.inputs.length },
    }),
    rerank: async () => ({ model: "test:rerank", results: [] }),
  } as unknown as AIGateway;
}

export function makeMockEmbeddingService(): EmbeddingService {
  return {
    embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
    embedOne: async () => [0.1, 0.2, 0.3],
  } as unknown as EmbeddingService;
}

export function makeDispatchDeps(engine: BrainEngine): DispatchDeps {
  return {
    router: { getEngine: async () => engine },
    gateway: makeMockGateway(),
    embeddingService: makeMockEmbeddingService(),
  };
}

// ─── Stub auth middleware ────────────────────────────────────────────────────

/**
 * Build a stub auth chain that injects a fixed `req.context` (bypassing
 * clerkAuth / tenantResolver / contextBuilder). Pass to `createApp({
 * authChain })`.
 */
export function stubAuthChain(ctx: OperationContext) {
  const inject = (req: Request, _res: Response, next: NextFunction): void => {
    req.context = ctx;
    next();
  };
  return [inject];
}
