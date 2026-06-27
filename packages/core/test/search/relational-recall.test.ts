// Tests for the relational query parser (packages/core/src/search/relational-recall.ts).
//
// Pure-function tests for parseRelationalQuery + slugifySeed. No DB, no LLM.
// Verifies the four archetypes (who_rel, who_at, connects, intro) + the
// precision-first stopword rejection + the type-agnostic traversal for
// connects/intro.

import { describe, it, expect } from "bun:test";
import { parseRelationalQuery, slugifySeed } from "../../src/search/relational-recall";

describe("parseRelationalQuery", () => {
  describe("who_rel (typed-edge)", () => {
    it("detects 'who invested in X'", () => {
      const r = parseRelationalQuery("who invested in acme");
      expect(r).not.toBeNull();
      expect(r!.kind).toBe("who_rel");
      expect(r!.seeds).toEqual(["acme"]);
      expect(r!.linkTypes).toEqual(["INVESTED_IN"]);
      expect(r!.direction).toBe("in");
    });

    it("detects 'who founded X'", () => {
      const r = parseRelationalQuery("who founded acme");
      expect(r).not.toBeNull();
      expect(r!.kind).toBe("who_rel");
      expect(r!.seeds).toEqual(["acme"]);
      expect(r!.linkTypes).toEqual(["FOUNDED"]);
    });

    it("detects 'who works at X'", () => {
      const r = parseRelationalQuery("who works at acme");
      expect(r).not.toBeNull();
      expect(r!.kind).toBe("who_rel");
      expect(r!.linkTypes).toEqual(["WORKS_AT"]);
    });
  });

  describe("connects (two seeds, type-agnostic)", () => {
    it("detects 'what connects A and B'", () => {
      const r = parseRelationalQuery("what connects acme and fund-a");
      expect(r).not.toBeNull();
      expect(r!.kind).toBe("connects");
      expect(r!.seeds).toEqual(["acme", "fund-a"]);
      expect(r!.linkTypes).toBeNull();
      expect(r!.direction).toBe("both");
    });

    it("detects 'what connects A to B'", () => {
      const r = parseRelationalQuery("what connects alice to bob");
      expect(r).not.toBeNull();
      expect(r!.kind).toBe("connects");
      expect(r!.seeds).toEqual(["alice", "bob"]);
    });
  });

  describe("intro (type-agnostic)", () => {
    it("detects 'who introduced me to X'", () => {
      const r = parseRelationalQuery("who introduced me to alice");
      expect(r).not.toBeNull();
      expect(r!.kind).toBe("intro");
      expect(r!.seeds).toEqual(["alice"]);
      expect(r!.linkTypes).toBeNull();
    });

    it("detects 'introduced to X' without 'who'", () => {
      const r = parseRelationalQuery("introduced me to bob");
      expect(r).not.toBeNull();
      expect(r!.kind).toBe("intro");
    });
  });

  describe("non-relational queries", () => {
    it("returns null for a general query", () => {
      expect(parseRelationalQuery("what is acme")).toBeNull();
    });
    it("returns null for a temporal query", () => {
      expect(parseRelationalQuery("when did we last meet")).toBeNull();
    });
    it("returns null for empty input", () => {
      expect(parseRelationalQuery("")).toBeNull();
    });
  });

  describe("precision-first (stopword rejection)", () => {
    it("rejects 'who invested in it'", () => {
      expect(parseRelationalQuery("who invested in it")).toBeNull();
    });
    it("rejects 'who introduced me to someone'", () => {
      expect(parseRelationalQuery("who introduced me to someone")).toBeNull();
    });
  });
});

describe("slugifySeed", () => {
  it("lowercases + hyphenates", () => {
    expect(slugifySeed("Acme Corp")).toBe("acme-corp");
  });
  it("strips quotes", () => {
    expect(slugifySeed("Garry's Fund")).toBe("garrys-fund");
  });
  it("collapses non-alphanumeric to single hyphens", () => {
    expect(slugifySeed("a!@#b")).toBe("a-b");
  });
  it("trims leading/trailing hyphens", () => {
    expect(slugifySeed("--foo--")).toBe("foo");
  });
});
