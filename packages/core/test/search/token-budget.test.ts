// Tests for token budget enforcement (packages/core/src/search/token-budget.ts).
//
// Pure-function tests: no DB, no LLM. Verifies the greedy top-down budget
// enforcement, the char/4 token estimate, and the edge cases (no budget,
// empty input, first-result-exceeds-budget).

import { describe, it, expect } from "bun:test";
import {
  enforceTokenBudget,
  estimateTokens,
  resultTokens,
} from "../../src/search/token-budget";
import type { SearchResult, Chunk, Page } from "../../src/types";

function makePage(slug: string, title: string): Page {
  return {
    id: "1",
    slug,
    type: "entity",
    title,
    compiledTruth: "",
    frontmatter: {},
    pageKind: "markdown",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function makeChunk(content: string): Chunk {
  return {
    id: "c1",
    pageId: "1",
    chunkIndex: 0,
    content,
    chunkSource: "compiled_truth",
    modality: "text",
    embedding: null,
    createdAt: new Date(0),
  };
}

function makeResult(slug: string, title: string, chunkContent: string): SearchResult {
  return {
    page: makePage(slug, title),
    chunks: [makeChunk(chunkContent)],
    score: 1.0,
    sources: ["lexical"],
    citations: [],
  };
}

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
  it("returns 0 for null/undefined", () => {
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });
  it("returns ceil(len/4) for non-empty", () => {
    expect(estimateTokens("hello world!")).toBe(Math.ceil("hello world!".length / 4));
  });
});

describe("resultTokens", () => {
  it("sums page title + chunk contents", () => {
    const r = makeResult("acme", "Acme Corp", "A company that makes things.");
    const expected = estimateTokens("Acme Corp") + estimateTokens("A company that makes things.");
    expect(resultTokens(r)).toBe(expected);
  });
});

describe("enforceTokenBudget", () => {
  it("returns all results when budget is undefined", () => {
    const results = [makeResult("a", "A", "aaaa"), makeResult("b", "B", "bbbb")];
    const { results: kept, meta } = enforceTokenBudget(results, undefined);
    expect(kept.length).toBe(2);
    expect(meta.dropped).toBe(0);
  });

  it("returns all results when budget is 0", () => {
    const results = [makeResult("a", "A", "aaaa")];
    const { results: kept, meta } = enforceTokenBudget(results, 0);
    expect(kept.length).toBe(1);
    expect(meta.dropped).toBe(0);
  });

  it("returns empty for empty input", () => {
    const { results: kept, meta } = enforceTokenBudget([], 1000);
    expect(kept.length).toBe(0);
    expect(meta.kept).toBe(0);
  });

  it("stops when next result would exceed budget", () => {
    // Each result: title (1 token) + chunk (4 chars = 1 token) = 2 tokens.
    // Budget = 5 → keeps 2 results (4 tokens), drops the 3rd (would be 6).
    const results = [
      makeResult("a", "A", "aaaa"),
      makeResult("b", "B", "bbbb"),
      makeResult("c", "C", "cccc"),
    ];
    const { results: kept, meta } = enforceTokenBudget(results, 5);
    expect(kept.length).toBe(2);
    expect(meta.dropped).toBe(1);
    expect(meta.kept).toBe(2);
  });

  it("returns empty when first result alone exceeds budget", () => {
    const results = [makeResult("a", "A very long title", "very long chunk content here")];
    const { results: kept, meta } = enforceTokenBudget(results, 1);
    expect(kept.length).toBe(0);
    expect(meta.dropped).toBe(1);
  });

  it("preserves input order", () => {
    const results = [
      makeResult("first", "F", "ffff"),
      makeResult("second", "S", "ssss"),
    ];
    const { results: kept } = enforceTokenBudget(results, 1000);
    expect(kept[0]!.page.slug).toBe("first");
    expect(kept[1]!.page.slug).toBe("second");
  });
});
