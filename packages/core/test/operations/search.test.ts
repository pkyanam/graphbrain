// Tests for the search + query operations (Stage 10).
//
// Uses mock BrainEngine + mock AIGateway + mock EmbeddingService. No real DB,
// no real LLM. Verifies:
//   - search op: thin wrapper over hybridSearch → returns { results, meta }.
//   - query op: hybridSearch → LLM synthesis → answer + citations + meta.
//   - query op: citations are pruned to those referenced in the answer.
//   - query op: synthesis failure throws OperationError('synthesis_failed').
//   - buildSynthesisMessages formats passages with [N] markers.
//   - extractUsedCitations parses [N] markers.

import { describe, it, expect, beforeAll } from "bun:test";
import {
  searchOp,
  queryOp,
  buildSynthesisMessages,
  extractUsedCitations,
  DEFAULT_SYNTHESIS_SYSTEM_PROMPT,
} from "../../src/operations";
import { loadConfig, resetConfig } from "../../src/index.ts";
import { POLYGRES_ENV } from "../control/_helpers.ts";
import type { SearchResult, Page, Chunk, Citation } from "../../src/types";
import {
  makeCtx,
  makeResolvedDeps,
  makeMockEngine,
  makeMockGateway,
  makeMockEmbeddingService,
  makePage,
  makeChunk,
  expectOpErrorAsync,
} from "./_helpers";

// ─── Config priming ──────────────────────────────────────────────────────────

beforeAll(() => {
  process.env = { ...POLYGRES_ENV };
  resetConfig();
  loadConfig(POLYGRES_ENV);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSearchResult(
  slug: string,
  title: string,
  snippet: string,
  score: number = 1,
): SearchResult {
  const page = makePage(slug, title);
  const chunk = makeChunk(`c-${slug}`, page.id, snippet);
  const citation: Citation = {
    chunkId: chunk.id,
    slug,
    stream: "lexical",
    snippet,
  };
  return {
    page,
    chunks: [chunk],
    score,
    sources: ["lexical"],
    citations: [citation],
  };
}

// ─── search op ───────────────────────────────────────────────────────────────

describe("search op", () => {
  it("returns { results, meta } from hybridSearch", async () => {
    const pageAcme = makePage("acme", "Acme Corp");
    const engine = makeMockEngine({
      pages: new Map([["acme", pageAcme]]),
      chunksByPage: new Map([["acme", [makeChunk("c1", pageAcme.id, "Acme content")]]]),
      textPageHits: [
        { id: pageAcme.id, score: 5.0, slug: "acme", title: "Acme Corp", content: null, field: "title" },
      ],
    });
    const deps = makeResolvedDeps(engine, {
      embeddingService: makeMockEmbeddingService(null),
    });
    const ctx = makeCtx();

    const result = await searchOp.handler(
      { query: "acme", cacheEnabled: false },
      ctx,
      deps,
    );

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]!.page.slug).toBe("acme");
    expect(result.meta.vectorEnabled).toBe(false);
  });

  it("passes per-call knobs through to hybridSearch", async () => {
    const engine = makeMockEngine({});
    const deps = makeResolvedDeps(engine, {
      embeddingService: makeMockEmbeddingService(null),
    });
    const ctx = makeCtx();

    const { meta } = await searchOp.handler(
      { query: "test", mode: "conservative", cacheEnabled: false, tokenBudget: 10 },
      ctx,
      deps,
    );

    expect(meta.mode).toBe("conservative");
  });
});

// ─── query op ────────────────────────────────────────────────────────────────

describe("query op", () => {
  it("synthesizes an answer with citations from search results", async () => {
    const pageAcme = makePage("acme", "Acme Corp");
    const pageStripe = makePage("stripe", "Stripe Inc");
    const engine = makeMockEngine({
      pages: new Map([
        ["acme", pageAcme],
        ["stripe", pageStripe],
      ]),
      chunksByPage: new Map([
        ["acme", [makeChunk("c1", pageAcme.id, "Acme makes widgets")]],
        ["stripe", [makeChunk("c2", pageStripe.id, "Stripe processes payments")]],
      ]),
      textPageHits: [
        { id: pageAcme.id, score: 5.0, slug: "acme", title: "Acme Corp", content: null, field: "title" },
        { id: pageStripe.id, score: 4.0, slug: "stripe", title: "Stripe Inc", content: null, field: "title" },
      ],
    });
    const gateway = makeMockGateway({
      chatContent: "Acme makes widgets [1]. Stripe processes payments [2].",
      chatModel: "anthropic:claude-test",
    });
    const deps = makeResolvedDeps(engine, {
      gateway,
      embeddingService: makeMockEmbeddingService(null),
    });
    const ctx = makeCtx();

    const result = await queryOp.handler({ query: "what do these companies do?" }, ctx, deps);

    expect(result.answer).toContain("[1]");
    expect(result.answer).toContain("[2]");
    expect(result.citations.length).toBe(2);
    expect(result.citations[0]!.slug).toBe("acme");
    expect(result.citations[1]!.slug).toBe("stripe");
    expect(result.citations[0]!.index).toBe(1);
    expect(result.citations[1]!.index).toBe(2);
    expect(result.model).toBe("anthropic:claude-test");
    expect(result.results.length).toBe(2);
    expect(result.meta.vectorEnabled).toBe(false);
  });

  it("prunes citations to only those referenced in the answer", async () => {
    const engine = makeMockEngine({});
    const deps = makeResolvedDeps(engine, {
      gateway: makeMockGateway({ chatContent: "Only Acme [1] is relevant." }),
      embeddingService: makeMockEmbeddingService(null),
    });
    const ctx = makeCtx();

    // Build a result set with 3 results but the answer only cites [1].
    const results: SearchResult[] = [
      makeSearchResult("acme", "Acme", "Acme content"),
      makeSearchResult("stripe", "Stripe", "Stripe content"),
      makeSearchResult("plaid", "Plaid", "Plaid content"),
    ];

    // We can't easily inject results into the query op (it calls hybridSearch
    // internally), so we test the pruning logic directly via the helper.
    const used = extractUsedCitations("Only Acme [1] is relevant.");
    expect(used.has(1)).toBe(true);
    expect(used.has(2)).toBe(false);
    expect(used.has(3)).toBe(false);

    // And verify the citations array would be pruned correctly.
    const { citations } = buildSynthesisMessages("q", results, DEFAULT_SYNTHESIS_SYSTEM_PROMPT);
    const pruned = citations.filter((c) => used.has(c.index));
    expect(pruned.length).toBe(1);
    expect(pruned[0]!.slug).toBe("acme");
  });

  it("throws synthesis_failed when the gateway chat throws", async () => {
    const engine = makeMockEngine({});
    const gateway = makeMockGateway({});
    // Override chat to throw.
    (gateway as unknown as { chat: () => Promise<never> }).chat = async () => {
      throw new Error("LLM unavailable");
    };
    const deps = makeResolvedDeps(engine, {
      gateway,
      embeddingService: makeMockEmbeddingService(null),
    });
    const ctx = makeCtx();

    await expectOpErrorAsync(
      () => queryOp.handler({ query: "test" }, ctx, deps),
      "synthesis_failed",
    );
  });

  it("returns empty citations when no results are retrieved", async () => {
    const engine = makeMockEngine({});
    const deps = makeResolvedDeps(engine, {
      gateway: makeMockGateway({ chatContent: "I don't have enough context." }),
      embeddingService: makeMockEmbeddingService(null),
    });
    const ctx = makeCtx();

    const result = await queryOp.handler({ query: "test" }, ctx, deps);
    expect(result.results.length).toBe(0);
    expect(result.citations.length).toBe(0);
    expect(result.answer).toContain("I don't have enough context.");
  });
});

// ─── buildSynthesisMessages ──────────────────────────────────────────────────

describe("buildSynthesisMessages", () => {
  it("formats passages with [N] markers and slug — title", () => {
    const results = [
      makeSearchResult("acme", "Acme Corp", "Acme makes widgets"),
      makeSearchResult("stripe", "Stripe Inc", "Stripe processes payments"),
    ];
    const { messages, citations } = buildSynthesisMessages(
      "what do they do?",
      results,
      "system prompt",
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toBe("system prompt");
    expect(messages[1]!.role).toBe("user");
    expect(messages[1]!.content).toContain("[1] acme — Acme Corp");
    expect(messages[1]!.content).toContain("Acme makes widgets");
    expect(messages[1]!.content).toContain("[2] stripe — Stripe Inc");
    expect(messages[1]!.content).toContain("Question: what do they do?");

    expect(citations).toHaveLength(2);
    expect(citations[0]).toEqual({
      index: 1,
      slug: "acme",
      title: "Acme Corp",
      snippet: "Acme makes widgets",
      stream: "lexical",
    });
  });

  it("handles empty results (no context passages)", () => {
    const { messages, citations } = buildSynthesisMessages(
      "q",
      [],
      "system",
    );
    expect(messages[1]!.content).toContain("No context passages");
    expect(citations).toHaveLength(0);
  });
});

// ─── extractUsedCitations ────────────────────────────────────────────────────

describe("extractUsedCitations", () => {
  it("extracts [N] markers from the answer text", () => {
    expect([...extractUsedCitations("answer [1] and [3] and [1] again")].sort()).toEqual([1, 3]);
  });

  it("returns empty set when no markers are present", () => {
    expect(extractUsedCitations("no citations here").size).toBe(0);
  });

  it("does not match non-citation brackets like [word]", () => {
    expect(extractUsedCitations("see [note] and [1]").size).toBe(1);
  });
});
