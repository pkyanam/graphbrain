// @graphbrain/core — page CRUD operations (Stage 10).
//
// The page-facing operations that delegate to BrainEngine (Stage 7):
//   • `get_page`    — fetch a page by slug + its chunks + edges. Read scope.
//   • `list_pages`  — list pages with filters + pagination. Read scope.
//   • `put_page`    — create/update a page from markdown content: chunk,
//                     embed, write Page + Chunks + auto-extracted edges.
//                     Write scope. (The primary ingestion op.)
//   • `create_page` — create a bare page from a PageInput (no chunking /
//                     embedding). Write scope. (Lower-level than put_page.)
//   • `add_chunk`   — add a single chunk (with optional embedding) to an
//                     existing page. Write scope.
//
// Ported from _reference/gbrain/src/core/operations.ts (get_page, list_pages,
// put_page) and adapted to Graphbrain's multi-tenant model:
//   • No source_id axis (Phase 1: single brain per tenant).
//   • put_page uses a simple fixed-size paragraph chunker for Phase 1
//     (GBrain's tree-sitter chunker is Phase 2/3).
//   • compiled_truth is a stub (title + first paragraph) for Phase 1; full
//     synthesis is Phase 3.
//   • Auto-link extraction is deferred to a follow-up stage (the
//     link-extraction module is listed in IMPLEMENTATION.md but is not
//     required for the core CRUD loop — put_page writes the page + chunks
//     without extracting edges in Phase 1; add_link is the manual edge path).

import { z } from "zod";
import type { Page, Chunk, Link, PageInput, PageType, PageKind } from "../types";
import { PageInputSchema } from "../schemas";
import { OperationError } from "./types";
import type { Operation, ResolvedDeps } from "./types";
import type { OperationContext } from "../types";

// ─── Chunker (Phase 1: simple fixed-size paragraph splitter) ─────────────────

/** Target chunk size in characters (Phase 1). ~250 tokens at 4 chars/token. */
export const CHUNK_TARGET_CHARS = 1000;
/** Hard cap on a single chunk (Phase 1). Splits mid-paragraph if exceeded. */
export const CHUNK_MAX_CHARS = 2000;

/**
 * Split markdown content into chunks on paragraph boundaries. Each chunk is
 * ≤ `maxChars`; paragraphs longer than `maxChars` are hard-split. Empty
 * chunks are discarded. Phase 1 chunker — GBrain's tree-sitter code chunker
 * is Phase 2/3.
 */
export function chunkContent(
  content: string,
  opts: { targetChars?: number; maxChars?: number } = {},
): string[] {
  const target = opts.targetChars ?? CHUNK_TARGET_CHARS;
  const max = opts.maxChars ?? CHUNK_MAX_CHARS;
  if (!content || content.trim().length === 0) return [];

  const paragraphs = content.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (trimmed.length === 0) continue;

    // Hard-split oversized paragraphs.
    if (trimmed.length > max) {
      // Flush the current buffer first.
      if (current.trim().length > 0) {
        chunks.push(current.trim());
        current = "";
      }
      for (let i = 0; i < trimmed.length; i += max) {
        chunks.push(trimmed.slice(i, i + max).trim());
      }
      continue;
    }

    // If adding this paragraph would exceed the target, flush + start fresh.
    if (current.length > 0 && current.length + trimmed.length + 2 > target) {
      chunks.push(current.trim());
      current = trimmed;
    } else {
      current = current.length > 0 ? `${current}\n\n${trimmed}` : trimmed;
    }
  }
  if (current.trim().length > 0) chunks.push(current.trim());
  return chunks;
}

// ─── get_page ────────────────────────────────────────────────────────────────

export const GetPageInputSchema = z.object({
  slug: z.string().min(1),
  includeDeleted: z.boolean().optional(),
  includeChunks: z.boolean().optional(),
  includeEdges: z.boolean().optional(),
});

export type GetPageInput = z.infer<typeof GetPageInputSchema>;

export interface GetPageOutput {
  page: Page;
  chunks: Chunk[];
  outEdges: Link[];
  inEdges: Link[];
}

/**
 * `get_page` — fetch a page by slug, optionally with its chunks + edges.
 * Read scope. Throws `page_not_found` if the page doesn't exist (or is
 * soft-deleted and `includeDeleted` is not set).
 */
export const getPageOp: Operation<GetPageInput, GetPageOutput> = {
  name: "get_page",
  description:
    "Read a page by slug. Optionally include chunks, outgoing edges, and " +
    "incoming edges. Soft-deleted pages are hidden by default; pass " +
    "include_deleted: true to surface them.",
  scope: "read",
  inputSchema: GetPageInputSchema,
  handler: async (input, _ctx, deps) => {
    const page = await deps.engine.getPage(input.slug, {
      includeDeleted: input.includeDeleted,
    });
    if (!page) {
      throw new OperationError("page_not_found", `Page not found: ${input.slug}`, {
        suggestion: "Check the slug, or use list_pages to enumerate pages.",
      });
    }
    const includeChunks = input.includeChunks !== false;
    const includeEdges = input.includeEdges !== false;
    const [chunks, outEdges, inEdges] = await Promise.all([
      includeChunks ? deps.engine.getChunksByPage(input.slug) : Promise.resolve([]),
      includeEdges ? deps.engine.getOutEdges(input.slug) : Promise.resolve([]),
      includeEdges ? deps.engine.getInEdges(input.slug) : Promise.resolve([]),
    ]);
    return { page, chunks, outEdges, inEdges };
  },
};

// ─── list_pages ──────────────────────────────────────────────────────────────

export const ListPagesInputSchema = z.object({
  type: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
  offset: z.number().int().nonnegative().optional(),
  includeDeleted: z.boolean().optional(),
});

export type ListPagesInput = z.infer<typeof ListPagesInputSchema>;

export interface ListPagesOutput {
  pages: Page[];
  count: number;
  offset: number;
}

/**
 * `list_pages` — list pages with optional type filter + pagination. Read
 * scope. Not clamped (bulk read) — the engine's listPages respects the
 * limit/offset directly.
 */
export const listPagesOp: Operation<ListPagesInput, ListPagesOutput> = {
  name: "list_pages",
  description:
    "List pages in the tenant's brain, optionally filtered by type. " +
    "Supports limit/offset pagination. Not clamped (bulk read).",
  scope: "read",
  inputSchema: ListPagesInputSchema,
  handler: async (input, _ctx, deps) => {
    const pages = await deps.engine.listPages({
      typeFilter: input.type as PageType | undefined,
      limit: input.limit,
      offset: input.offset,
      includeDeleted: input.includeDeleted,
    });
    return {
      pages,
      count: pages.length,
      offset: input.offset ?? 0,
    };
  },
};

// ─── create_page ─────────────────────────────────────────────────────────────

export const CreatePageInputSchema = PageInputSchema;

export type CreatePageInput = z.infer<typeof CreatePageInputSchema>;

export interface CreatePageOutput {
  page: Page;
}

/**
 * `create_page` — create or update a bare page from a PageInput (no chunking
 * or embedding). Write scope. This is the lower-level primitive `put_page`
 * builds on; callers that manage their own chunking/embedding use this
 * directly. Delegates to `engine.putPage` (upsert by slug).
 */
export const createPageOp: Operation<CreatePageInput, CreatePageOutput> = {
  name: "create_page",
  description:
    "Create or update a bare page (upsert by slug) from a PageInput. Does " +
    "NOT chunk or embed — use put_page for full ingestion, or add_chunk to " +
    "attach chunks with embeddings after creating the page.",
  scope: "write",
  inputSchema: CreatePageInputSchema,
  handler: async (input, _ctx, deps) => {
    const pageInput: PageInput = {
      slug: input.slug,
      type: input.type as PageType,
      title: input.title,
      compiledTruth: input.compiledTruth,
      frontmatter: input.frontmatter,
      pageKind: input.pageKind as PageKind | undefined,
      contentHash: input.contentHash,
      emotionalWeight: input.emotionalWeight,
      effectiveDate: input.effectiveDate,
      effectiveDateSource: input.effectiveDateSource,
      importFilename: input.importFilename,
      contextualRetrievalMode: input.contextualRetrievalMode,
    };
    const page = await deps.engine.putPage(pageInput);
    return { page };
  },
};

// ─── put_page ────────────────────────────────────────────────────────────────

export const PutPageInputSchema = z.object({
  slug: z.string().min(1),
  /** Full markdown content (with optional YAML frontmatter). */
  content: z.string().min(1),
  /** Page type (defaults to "note" if not inferable from frontmatter). */
  type: z.string().optional(),
  /** Page title (defaults to the slug if not in frontmatter). */
  title: z.string().optional(),
  /** Page kind (defaults to "markdown"). */
  pageKind: z.enum(["markdown", "code", "image"]).optional(),
  /** Override the compiled_truth stub (Phase 1: defaults to title + first paragraph). */
  compiledTruth: z.string().optional(),
  /** Frontmatter overrides (parsed from YAML frontmatter if present in content). */
  frontmatter: z.record(z.string(), z.unknown()).optional(),
  /** Skip chunk embedding (write chunks without vectors). */
  skipEmbed: z.boolean().optional(),
  /** Chunker target size override (chars). */
  chunkTargetChars: z.number().int().positive().optional(),
});

export type PutPageInput = z.infer<typeof PutPageInputSchema>;

export interface PutPageOutput {
  page: Page;
  chunks: Chunk[];
  embedded: number;
}

/**
 * Extract a simple YAML-like frontmatter block from the top of markdown
 * content. Returns `{ frontmatter, body }`. Phase 1: minimal parsing —
 * reads `key: value` lines between `---` fences. Full frontmatter inference
 * is Phase 3.
 */
export function splitFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!fmMatch) return { frontmatter: {}, body: content };
  const fmBlock = fmMatch[1]!;
  const body = content.slice(fmMatch[0].length);
  const frontmatter: Record<string, unknown> = {};
  for (const line of fmBlock.split("\n")) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    let val: unknown = rawVal!.trim();
    // Strip surrounding quotes.
    if (typeof val === "string" && val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    }
    frontmatter[key!] = val;
  }
  return { frontmatter, body };
}

/**
 * `put_page` — the primary ingestion op. Write scope.
 *
 * Pipeline:
 *   1. Parse frontmatter from the markdown content.
 *   2. Chunk the body (Phase 1: fixed-size paragraph splitter).
 *   3. Embed the chunks via embeddingService (unless skipEmbed).
 *   4. Write the Page (upsert by slug) via engine.putPage.
 *   5. Write each Chunk via engine.addChunk (with its embedding).
 *   6. Return { page, chunks, embedded }.
 *
 * Phase 1 stubs: compiled_truth = title + first paragraph; no auto-link
 * extraction (use add_link for manual edges). Full synthesis + link
 * extraction are Phase 3.
 */
export const putPageOp: Operation<PutPageInput, PutPageOutput> = {
  name: "put_page",
  description:
    "Create/update a page from markdown content. Chunks the body, embeds " +
    "the chunks, and writes the Page + Chunks. The primary ingestion op. " +
    "Phase 1: compiled_truth is a stub (title + first paragraph); auto-link " +
    "extraction is deferred (use add_link for manual edges).",
  scope: "write",
  inputSchema: PutPageInputSchema,
  handler: async (input, ctx, deps) => {
    const { frontmatter: parsedFm, body } = splitFrontmatter(input.content);
    const frontmatter = { ...parsedFm, ...(input.frontmatter ?? {}) };
    const title = input.title ?? (typeof frontmatter.title === "string" ? frontmatter.title : input.slug);
    const type = (input.type ?? (typeof frontmatter.type === "string" ? frontmatter.type : "note")) as PageType;
    const pageKind = (input.pageKind ?? "markdown") as PageKind;

    // Chunk the body.
    const chunkTexts = chunkContent(body, { targetChars: input.chunkTargetChars });

    // compiled_truth stub: title + first paragraph (or first chunk).
    const firstPara = chunkTexts[0] ?? "";
    const compiledTruth = input.compiledTruth ?? (firstPara ? `${title}\n\n${firstPara}` : title);

    // Write the page (upsert by slug).
    const page = await deps.engine.putPage({
      slug: input.slug,
      type,
      title,
      compiledTruth,
      frontmatter,
      pageKind,
    });

    // Embed the chunks (unless skipped).
    let embeddings: number[][] = [];
    let embedded = 0;
    if (!input.skipEmbed && chunkTexts.length > 0) {
      try {
        embeddings = await deps.embeddingService.embed(chunkTexts, ctx.tenant);
        embedded = embeddings.length;
      } catch (err) {
        throw new OperationError(
          "embedding_failed",
          `Chunk embedding failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }

    // Write each chunk.
    const chunks: Chunk[] = [];
    for (let i = 0; i < chunkTexts.length; i++) {
      const chunk = await deps.engine.addChunk({
        pageId: page.id,
        chunkIndex: i,
        content: chunkTexts[i]!,
        chunkSource: "compiled_truth",
        modality: "text",
        embedding: embeddings[i] ?? null,
      });
      chunks.push(chunk);
    }

    return { page, chunks, embedded };
  },
};

// ─── add_chunk ───────────────────────────────────────────────────────────────

export const AddChunkInputSchema = z.object({
  slug: z.string().min(1),
  content: z.string().min(1),
  chunkSource: z.enum(["compiled_truth", "timeline", "fenced_code", "image_asset"]).optional(),
  modality: z.enum(["text", "image"]).optional(),
  /** Optional pre-computed embedding vector (skip embedding service). */
  embedding: z.array(z.number()).optional(),
  /** Embed the chunk via the embedding service (ignored if `embedding` is provided). */
  embed: z.boolean().optional(),
  language: z.string().optional(),
  symbolName: z.string().optional(),
  symbolType: z.string().optional(),
  startLine: z.number().int().nonnegative().optional(),
  endLine: z.number().int().nonnegative().optional(),
});

export type AddChunkInput = z.infer<typeof AddChunkInputSchema>;

export interface AddChunkOutput {
  chunk: Chunk;
}

/**
 * `add_chunk` — add a single chunk to an existing page (looked up by slug).
 * Write scope. The chunk index is auto-assigned (appended after the page's
 * existing chunks). If `embedding` is provided it's used directly; else if
 * `embed` is true the chunk is embedded via the embedding service; else the
 * chunk is written without an embedding.
 */
export const addChunkOp: Operation<AddChunkInput, AddChunkOutput> = {
  name: "add_chunk",
  description:
    "Add a single chunk to an existing page (by slug). The chunk index is " +
    "auto-assigned. Pass an explicit embedding vector, or set embed: true to " +
    "embed via the embedding service. Otherwise the chunk is written without " +
    "an embedding.",
  scope: "write",
  inputSchema: AddChunkInputSchema,
  handler: async (input, ctx, deps) => {
    const page = await deps.engine.getPage(input.slug);
    if (!page) {
      throw new OperationError("page_not_found", `Page not found: ${input.slug}`);
    }
    const existingChunks = await deps.engine.getChunksByPage(input.slug);
    const chunkIndex = existingChunks.length;

    let embedding: number[] | null = null;
    if (input.embedding) {
      embedding = input.embedding;
    } else if (input.embed === true) {
      try {
        const vectors = await deps.embeddingService.embed([input.content], ctx.tenant);
        embedding = vectors[0] ?? null;
      } catch (err) {
        throw new OperationError(
          "embedding_failed",
          `Chunk embedding failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }

    const chunk = await deps.engine.addChunk({
      pageId: page.id,
      chunkIndex,
      content: input.content,
      chunkSource: input.chunkSource ?? "compiled_truth",
      modality: input.modality ?? "text",
      embedding,
      language: input.language,
      symbolName: input.symbolName,
      symbolType: input.symbolType,
      startLine: input.startLine,
      endLine: input.endLine,
    });
    return { chunk };
  },
};
