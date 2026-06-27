// Tests for the page CRUD operations (Stage 10).
//
// Uses mock BrainEngine + mock EmbeddingService. No real DB, no real LLM.
// Verifies:
//   - get_page: returns page + chunks + edges; throws page_not_found on miss.
//   - list_pages: filters by type + pagination.
//   - put_page: chunks content, embeds, writes page + chunks.
//   - create_page: upserts a bare page.
//   - add_chunk: appends a chunk with auto-index + optional embedding.
//   - chunkContent: paragraph splitting + hard-split oversized.
//   - splitFrontmatter: YAML frontmatter extraction.

import { describe, it, expect } from "bun:test";
import {
  getPageOp,
  listPagesOp,
  putPageOp,
  createPageOp,
  addChunkOp,
  chunkContent,
  splitFrontmatter,
  CHUNK_TARGET_CHARS,
  CHUNK_MAX_CHARS,
} from "../../src/operations";
import {
  makeCtx,
  makeResolvedDeps,
  makeMockEngine,
  makeMockEmbeddingService,
  makePage,
  makeChunk,
  makeLink,
  expectOpError,
  expectOpErrorAsync,
} from "./_helpers";

// ─── chunkContent ────────────────────────────────────────────────────────────

describe("chunkContent", () => {
  it("splits on paragraph boundaries", () => {
    const content = "Para one.\n\nPara two.\n\nPara three.";
    // Use a tiny target so each paragraph becomes its own chunk.
    const chunks = chunkContent(content, { targetChars: 5, maxChars: 200 });
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe("Para one.");
    expect(chunks[1]).toBe("Para two.");
    expect(chunks[2]).toBe("Para three.");
  });

  it("combines short paragraphs up to the target", () => {
    const content = "a\n\nb\n\nc\n\nd";
    const chunks = chunkContent(content, { targetChars: 5, maxChars: 100 });
    // "a\n\nb" (3 chars) + "c" → 5 chars at target, then "d".
    // Actually: a(1) → a+b = 1+2+1=4 < 5 → a+b+c = 4+2+1=7 > 5 → flush "a\n\nb", start "c", +d
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]).toBe("a\n\nb");
  });

  it("hard-splits oversized paragraphs at maxChars", () => {
    const long = "x".repeat(CHUNK_MAX_CHARS + 50);
    const content = `Intro.\n\n${long}\n\nOutro.`;
    const chunks = chunkContent(content, { targetChars: 100, maxChars: CHUNK_MAX_CHARS });
    // Intro, then the long para split into 2 (maxChars + 50), then Outro.
    expect(chunks[0]).toBe("Intro.");
    expect(chunks[1]!.length).toBe(CHUNK_MAX_CHARS);
    expect(chunks[2]!.length).toBe(50);
    expect(chunks[3]).toBe("Outro.");
  });

  it("returns [] for empty content", () => {
    expect(chunkContent("")).toEqual([]);
    expect(chunkContent("   \n\n  ")).toEqual([]);
  });
});

// ─── splitFrontmatter ────────────────────────────────────────────────────────

describe("splitFrontmatter", () => {
  it("extracts YAML frontmatter and returns the body", () => {
    const content = "---\ntitle: My Page\ntype: note\n---\n\nBody text here.";
    const { frontmatter, body } = splitFrontmatter(content);
    expect(frontmatter.title).toBe("My Page");
    expect(frontmatter.type).toBe("note");
    expect(body).toBe("Body text here.");
  });

  it("returns empty frontmatter when no fence is present", () => {
    const { frontmatter, body } = splitFrontmatter("just body");
    expect(frontmatter).toEqual({});
    expect(body).toBe("just body");
  });

  it("strips surrounding quotes from values", () => {
    const { frontmatter } = splitFrontmatter('---\ntitle: "Quoted Title"\n---\nbody');
    expect(frontmatter.title).toBe("Quoted Title");
  });
});

// ─── get_page ────────────────────────────────────────────────────────────────

describe("get_page op", () => {
  it("returns the page + chunks + edges", async () => {
    const page = makePage("acme", "Acme Corp");
    const chunk = makeChunk("c1", page.id, "content");
    const link = makeLink("acme", "stripe", "MENTIONS");
    const engine = makeMockEngine({
      pages: new Map([["acme", page]]),
      chunksByPage: new Map([["acme", [chunk]]]),
      outEdges: new Map([["acme", [link]]]),
      inEdges: new Map([["stripe", [link]]]),
    });
    const deps = makeResolvedDeps(engine);
    const result = await getPageOp.handler({ slug: "acme" }, makeCtx(), deps);

    expect(result.page.slug).toBe("acme");
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]!.id).toBe("c1");
    expect(result.outEdges).toHaveLength(1);
    expect(result.outEdges[0]!.toSlug).toBe("stripe");
    expect(result.inEdges).toHaveLength(0);
  });

  it("can omit chunks and edges", async () => {
    const page = makePage("acme");
    const engine = makeMockEngine({ pages: new Map([["acme", page]]) });
    const deps = makeResolvedDeps(engine);
    const result = await getPageOp.handler(
      { slug: "acme", includeChunks: false, includeEdges: false },
      makeCtx(),
      deps,
    );
    expect(result.page.slug).toBe("acme");
    expect(result.chunks).toEqual([]);
    expect(result.outEdges).toEqual([]);
  });

  it("throws page_not_found when the page doesn't exist", async () => {
    const engine = makeMockEngine({});
    const deps = makeResolvedDeps(engine);
    await expectOpErrorAsync(
      () => getPageOp.handler({ slug: "missing" }, makeCtx(), deps),
      "page_not_found",
    );
  });

  it("hides soft-deleted pages by default, surfaces with includeDeleted", async () => {
    const page = makePage("acme");
    page.deletedAt = new Date();
    const engine = makeMockEngine({ pages: new Map([["acme", page]]) });
    const deps = makeResolvedDeps(engine);

    await expectOpErrorAsync(
      () => getPageOp.handler({ slug: "acme" }, makeCtx(), deps),
      "page_not_found",
    );
    const result = await getPageOp.handler(
      { slug: "acme", includeDeleted: true },
      makeCtx(),
      deps,
    );
    expect(result.page.slug).toBe("acme");
  });
});

// ─── list_pages ──────────────────────────────────────────────────────────────

describe("list_pages op", () => {
  it("lists pages with type filter + pagination", async () => {
    const pages = new Map<string, ReturnType<typeof makePage>>();
    for (let i = 0; i < 5; i++) {
      const p = makePage(`p-${i}`, `Title ${i}`, i < 3 ? "note" : "concept");
      pages.set(p.slug, p);
    }
    const engine = makeMockEngine({ pages });
    const deps = makeResolvedDeps(engine);

    const all = await listPagesOp.handler({}, makeCtx(), deps);
    expect(all.count).toBe(5);

    const notes = await listPagesOp.handler({ type: "note" }, makeCtx(), deps);
    expect(notes.count).toBe(3);
    expect(notes.pages.every((p) => p.type === "note")).toBe(true);

    const paged = await listPagesOp.handler({ limit: 2, offset: 1 }, makeCtx(), deps);
    expect(paged.count).toBe(2);
    expect(paged.offset).toBe(1);
  });
});

// ─── put_page ────────────────────────────────────────────────────────────────

describe("put_page op", () => {
  it("chunks, embeds, and writes the page + chunks", async () => {
    const engine = makeMockEngine();
    const embeddingService = makeMockEmbeddingService([0.1, 0.2, 0.3]);
    const deps = makeResolvedDeps(engine, { embeddingService });
    const ctx = makeCtx();

    const content = "---\ntitle: Test Page\ntype: note\n---\n\nFirst paragraph.\n\nSecond paragraph.";
    // Use a tiny chunk target so the two paragraphs become separate chunks.
    const result = await putPageOp.handler(
      { slug: "test", content, chunkTargetChars: 5 },
      ctx,
      deps,
    );

    expect(result.page.slug).toBe("test");
    expect(result.page.title).toBe("Test Page");
    expect(result.page.type).toBe("note");
    expect(result.page.compiledTruth).toContain("Test Page");
    expect(result.chunks.length).toBe(2);
    expect(result.embedded).toBe(2);
    // Each chunk should have an embedding.
    expect(result.chunks[0]!.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(result.chunks[1]!.embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it("defaults type to 'note' and title to slug when not in frontmatter", async () => {
    const engine = makeMockEngine();
    const deps = makeResolvedDeps(engine, {
      embeddingService: makeMockEmbeddingService(null),
    });
    const result = await putPageOp.handler(
      { slug: "my-page", content: "Just some content.", skipEmbed: true },
      makeCtx(),
      deps,
    );
    expect(result.page.type).toBe("note");
    expect(result.page.title).toBe("my-page");
  });

  it("skipEmbed writes chunks without embeddings", async () => {
    const engine = makeMockEngine();
    const deps = makeResolvedDeps(engine, {
      embeddingService: makeMockEmbeddingService([0.1, 0.2, 0.3]),
    });
    const result = await putPageOp.handler(
      { slug: "x", content: "para one.\n\npara two.", skipEmbed: true },
      makeCtx(),
      deps,
    );
    expect(result.embedded).toBe(0);
    expect(result.chunks[0]!.embedding).toBeNull();
  });

  it("throws embedding_failed when the embedding service throws", async () => {
    const engine = makeMockEngine();
    const embeddingService = makeMockEmbeddingService(null);
    (embeddingService as unknown as { embed: () => Promise<never> }).embed = async () => {
      throw new Error("embed failed");
    };
    const deps = makeResolvedDeps(engine, { embeddingService });

    await expectOpErrorAsync(
      () => putPageOp.handler({ slug: "x", content: "content" }, makeCtx(), deps),
      "embedding_failed",
    );
  });

  it("upserts (updates existing page by slug)", async () => {
    const existing = makePage("acme", "Old Title");
    const engine = makeMockEngine({ pages: new Map([["acme", existing]]) });
    const deps = makeResolvedDeps(engine, {
      embeddingService: makeMockEmbeddingService(null),
    });
    const result = await putPageOp.handler(
      { slug: "acme", content: "New content.", title: "New Title", skipEmbed: true },
      makeCtx(),
      deps,
    );
    expect(result.page.id).toBe(existing.id); // same id
    expect(result.page.title).toBe("New Title");
  });
});

// ─── create_page ─────────────────────────────────────────────────────────────

describe("create_page op", () => {
  it("creates a bare page from PageInput (no chunking)", async () => {
    const engine = makeMockEngine();
    const deps = makeResolvedDeps(engine);
    const result = await createPageOp.handler(
      {
        slug: "acme",
        type: "company",
        title: "Acme Corp",
        compiledTruth: "Acme makes widgets.",
      },
      makeCtx(),
      deps,
    );
    expect(result.page.slug).toBe("acme");
    expect(result.page.type).toBe("company");
    expect(result.page.title).toBe("Acme Corp");
    expect(result.page.compiledTruth).toBe("Acme makes widgets.");
  });
});

// ─── add_chunk ───────────────────────────────────────────────────────────────

describe("add_chunk op", () => {
  it("appends a chunk with auto-indexed chunkIndex", async () => {
    const page = makePage("acme");
    const existing = makeChunk("c0", page.id, "first");
    const engine = makeMockEngine({
      pages: new Map([["acme", page]]),
      chunksByPage: new Map([["acme", [existing]]]),
    });
    const deps = makeResolvedDeps(engine);
    const result = await addChunkOp.handler(
      { slug: "acme", content: "second" },
      makeCtx(),
      deps,
    );
    expect(result.chunk.chunkIndex).toBe(1);
    expect(result.chunk.content).toBe("second");
    expect(result.chunk.embedding).toBeNull();
  });

  it("embeds the chunk when embed: true", async () => {
    const page = makePage("acme");
    const engine = makeMockEngine({ pages: new Map([["acme", page]]) });
    const deps = makeResolvedDeps(engine, {
      embeddingService: makeMockEmbeddingService([0.5, 0.6]),
    });
    const result = await addChunkOp.handler(
      { slug: "acme", content: "content", embed: true },
      makeCtx(),
      deps,
    );
    expect(result.chunk.embedding).toEqual([0.5, 0.6]);
  });

  it("uses an explicit embedding when provided", async () => {
    const page = makePage("acme");
    const engine = makeMockEngine({ pages: new Map([["acme", page]]) });
    const deps = makeResolvedDeps(engine);
    const result = await addChunkOp.handler(
      { slug: "acme", content: "content", embedding: [1, 2, 3] },
      makeCtx(),
      deps,
    );
    expect(result.chunk.embedding).toEqual([1, 2, 3]);
  });

  it("throws page_not_found when the page doesn't exist", async () => {
    const engine = makeMockEngine({});
    const deps = makeResolvedDeps(engine);
    await expectOpErrorAsync(
      () => addChunkOp.handler({ slug: "missing", content: "x" }, makeCtx(), deps),
      "page_not_found",
    );
  });
});
