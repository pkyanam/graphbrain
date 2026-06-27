// Tests for the semantic query cache (packages/core/src/search/query-cache.ts).
//
// Verifies the pure cosineSimilarity + queryHash functions, and the
// SemanticQueryCache fail-open behavior with a mock Sql pool. No real DB.

import { describe, it, expect } from "bun:test";
import {
  cosineSimilarity,
  queryHash,
  SemanticQueryCache,
} from "../../src/search/query-cache";
import type { SearchResult, Page } from "../../src/types";

function makePage(slug: string): Page {
  return {
    id: "1",
    slug,
    type: "entity",
    title: slug,
    compiledTruth: "",
    frontmatter: {},
    pageKind: "markdown",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function makeResult(slug: string): SearchResult {
  return {
    page: makePage(slug),
    chunks: [],
    score: 1.0,
    sources: ["lexical"],
    citations: [],
  };
}

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });
  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
  it("returns 0 for mismatched lengths", () => {
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
  });
  it("returns 0 for zero-norm vectors", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
  it("computes 0.5 for 60-degree angle", () => {
    // cos(60°) = 0.5. Vectors: [1,0] and [0.5, sqrt(3)/2].
    const sim = cosineSimilarity([1, 0], [0.5, Math.sqrt(3) / 2]);
    expect(sim).toBeCloseTo(0.5, 5);
  });
});

describe("queryHash", () => {
  it("is deterministic", () => {
    expect(queryHash("hello")).toBe(queryHash("hello"));
  });
  it("differs for different queries", () => {
    expect(queryHash("hello")).not.toBe(queryHash("world"));
  });
  it("returns a 16-char hex string", () => {
    expect(queryHash("test")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("SemanticQueryCache", () => {
  describe("disabled cache", () => {
    it("returns miss when disabled", async () => {
      const cache = new SemanticQueryCache(null as any, { enabled: false });
      const result = await cache.lookup("t1", [1, 2, 3], "hash1");
      expect(result.hit).toBe(false);
    });
    it("write is a no-op when disabled", async () => {
      const cache = new SemanticQueryCache(null as any, { enabled: false });
      await cache.write("t1", "q", [1, 2, 3], "h", [makeResult("a")]);
      // No throw = pass.
      expect(true).toBe(true);
    });
  });

  describe("with mock pool", () => {
    it("returns miss on DB error (fail-open)", async () => {
      const throwingPool: any = async () => {
        throw new Error("connection refused");
      };
      throwingPool.json = (v: any) => v;
      const cache = new SemanticQueryCache(throwingPool, { enabled: true });
      const result = await cache.lookup("t1", [1, 2, 3], "h");
      expect(result.hit).toBe(false);
    });

    it("returns miss when no rows match", async () => {
      const emptyPool: any = async () => [];
      emptyPool.json = (v: any) => v;
      const cache = new SemanticQueryCache(emptyPool, { enabled: true });
      const result = await cache.lookup("t1", [1, 2, 3], "h");
      expect(result.hit).toBe(false);
    });

    it("returns hit when a candidate exceeds the similarity threshold", async () => {
      const queryEmb = [1, 0, 0];
      const candidateEmb = [0.99, 0.01, 0];
      const rows = [
        {
          id: "1",
          embedding: candidateEmb,
          results: [makeResult("acme")],
          created_at: new Date(),
          ttl_at: new Date(Date.now() + 3600_000),
        },
      ];
      const pool: any = async () => rows;
      pool.json = (v: any) => v;
      const cache = new SemanticQueryCache(pool, { enabled: true, similarityThreshold: 0.9 });
      const result = await cache.lookup("t1", queryEmb, "h");
      expect(result.hit).toBe(true);
      expect(result.results?.length).toBe(1);
    });

    it("returns miss when best candidate is below threshold", async () => {
      const queryEmb = [1, 0, 0];
      const candidateEmb = [0.5, 0.5, 0]; // cos ≈ 0.5
      const rows = [
        {
          id: "1",
          embedding: candidateEmb,
          results: [makeResult("acme")],
          created_at: new Date(),
          ttl_at: new Date(Date.now() + 3600_000),
        },
      ];
      const pool: any = async () => rows;
      pool.json = (v: any) => v;
      const cache = new SemanticQueryCache(pool, { enabled: true, similarityThreshold: 0.9 });
      const result = await cache.lookup("t1", queryEmb, "h");
      expect(result.hit).toBe(false);
    });

    it("write swallows DB errors (fail-open)", async () => {
      const throwingPool: any = async () => {
        throw new Error("write failed");
      };
      throwingPool.json = (v: any) => v;
      const cache = new SemanticQueryCache(throwingPool, { enabled: true });
      await cache.write("t1", "q", [1, 2, 3], "h", [makeResult("a")]);
      expect(true).toBe(true);
    });
  });
});
