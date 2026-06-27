// Tests for mode bundles + knobs hash (packages/core/src/search/mode.ts).
//
// Pure-function tests: no DB, no LLM. Verifies the three mode bundles have
// the expected knob values, the knobs_hash is deterministic + isolates
// modes + embedding columns, and KNOBS_HASH_VERSION is pinned.

import { describe, it, expect } from "bun:test";
import { MODE_BUNDLES, KNOBS_HASH_VERSION, knobsHash } from "../../src/search/mode";

describe("MODE_BUNDLES", () => {
  it("has exactly three modes", () => {
    expect(Object.keys(MODE_BUNDLES).sort()).toEqual(["balanced", "conservative", "tokenmax"]);
  });

  it("conservative: tight budget, no expansion, no relational", () => {
    const b = MODE_BUNDLES.conservative;
    expect(b.tokenBudget).toBe(4000);
    expect(b.expansion).toBe(false);
    expect(b.relationalRetrieval).toBe(false);
    expect(b.searchLimit).toBe(10);
    expect(b.cacheEnabled).toBe(true);
    expect(b.contextualRetrieval).toBe("none");
  });

  it("balanced: medium budget, no expansion, relational ON", () => {
    const b = MODE_BUNDLES.balanced;
    expect(b.tokenBudget).toBe(12000);
    expect(b.expansion).toBe(false);
    expect(b.relationalRetrieval).toBe(true);
    expect(b.searchLimit).toBe(25);
    expect(b.contextualRetrieval).toBe("title");
  });

  it("tokenmax: no budget cap, expansion ON, relational ON", () => {
    const b = MODE_BUNDLES.tokenmax;
    expect(b.tokenBudget).toBeUndefined();
    expect(b.expansion).toBe(true);
    expect(b.relationalRetrieval).toBe(true);
    expect(b.searchLimit).toBe(50);
    expect(b.contextualRetrieval).toBe("per_chunk_synopsis");
  });

  it("all modes have cache enabled with 0.92 threshold", () => {
    for (const mode of Object.keys(MODE_BUNDLES) as (keyof typeof MODE_BUNDLES)[]) {
      const b = MODE_BUNDLES[mode];
      expect(b.cacheEnabled).toBe(true);
      expect(b.cacheSimilarityThreshold).toBe(0.92);
    }
  });
});

describe("KNOBS_HASH_VERSION", () => {
  it("is pinned to 1 (Stage 9 initial)", () => {
    expect(KNOBS_HASH_VERSION).toBe(1);
  });
});

describe("knobsHash", () => {
  it("is deterministic for the same inputs", () => {
    const h1 = knobsHash(MODE_BUNDLES.balanced, "balanced");
    const h2 = knobsHash(MODE_BUNDLES.balanced, "balanced");
    expect(h1).toBe(h2);
  });

  it("differs across modes", () => {
    const conservative = knobsHash(MODE_BUNDLES.conservative, "conservative");
    const balanced = knobsHash(MODE_BUNDLES.balanced, "balanced");
    const tokenmax = knobsHash(MODE_BUNDLES.tokenmax, "tokenmax");
    expect(conservative).not.toBe(balanced);
    expect(balanced).not.toBe(tokenmax);
    expect(conservative).not.toBe(tokenmax);
  });

  it("differs across embedding columns (GBrain v9→v10 invariant)", () => {
    const h1 = knobsHash(MODE_BUNDLES.balanced, "balanced", { embeddingColumn: "embedding" });
    const h2 = knobsHash(MODE_BUNDLES.balanced, "balanced", { embeddingColumn: "embeddingVoyage" });
    expect(h1).not.toBe(h2);
  });

  it("differs across embedding models", () => {
    const h1 = knobsHash(MODE_BUNDLES.balanced, "balanced", { embeddingModel: "voyage:voyage-3-large" });
    const h2 = knobsHash(MODE_BUNDLES.balanced, "balanced", { embeddingModel: "openai:text-embedding-3-large" });
    expect(h1).not.toBe(h2);
  });

  it("returns a 16-char hex string", () => {
    const h = knobsHash(MODE_BUNDLES.balanced, "balanced");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});
