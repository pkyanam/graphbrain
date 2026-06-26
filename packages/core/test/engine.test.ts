// Type-level + unit tests for the BrainEngine interface + clampSearchLimit.
//
// The conformance check is a compile-time assertion that HelixEngine satisfies
// BrainEngine. The runtime tests cover clampSearchLimit's mode-aware clamping
// (the CLAUDE.md "Search Mode" table: conservative=10, balanced=25, tokenmax=50).

import { describe, it, expect } from "bun:test";
import {
  clampSearchLimit,
  MAX_SEARCH_LIMIT,
  MODE_SEARCH_LIMITS,
  HelixEngine,
} from "../src/index.ts";
import type { BrainEngine, SearchOpts } from "../src/index.ts";

// ─── Compile-time conformance ────────────────────────────────────────────────
// HelixEngine MUST satisfy BrainEngine. This line is a type-level assertion —
// if HelixEngine drifts from the interface, `bun run typecheck` fails. The
// variable is intentionally unused; its sole purpose is the type check.
const _conformance: BrainEngine = new HelixEngine({
  url: "http://localhost:8080",
  apiKey: "dev-test-key",
});
void _conformance;

// ─── clampSearchLimit ────────────────────────────────────────────────────────

describe("engine — clampSearchLimit", () => {
  it("returns the mode default when limit is omitted", () => {
    expect(clampSearchLimit(undefined, "conservative")).toBe(10);
    expect(clampSearchLimit(undefined, "balanced")).toBe(25);
    expect(clampSearchLimit(undefined, "tokenmax")).toBe(50);
  });

  it("defaults to balanced mode when mode is omitted", () => {
    expect(clampSearchLimit(undefined)).toBe(25);
  });

  it("clamps an explicit limit down to the mode ceiling", () => {
    expect(clampSearchLimit(100, "conservative")).toBe(10);
    expect(clampSearchLimit(100, "balanced")).toBe(25);
    expect(clampSearchLimit(100, "tokenmax")).toBe(50);
  });

  it("preserves an explicit limit below the mode ceiling", () => {
    expect(clampSearchLimit(5, "conservative")).toBe(5);
    expect(clampSearchLimit(5, "balanced")).toBe(5);
    expect(clampSearchLimit(30, "tokenmax")).toBe(30);
  });

  it("floors fractional limits", () => {
    expect(clampSearchLimit(7.9, "balanced")).toBe(7);
  });

  it("falls back to the mode default for invalid limits", () => {
    expect(clampSearchLimit(0, "balanced")).toBe(25);
    expect(clampSearchLimit(-1, "balanced")).toBe(25);
    expect(clampSearchLimit(NaN, "balanced")).toBe(25);
    expect(clampSearchLimit(Infinity, "balanced")).toBe(25);
    expect(clampSearchLimit(null as unknown as undefined, "balanced")).toBe(25);
  });

  it("MODE_SEARCH_LIMITS matches the CLAUDE.md Search Mode table", () => {
    expect(MODE_SEARCH_LIMITS.conservative).toBe(10);
    expect(MODE_SEARCH_LIMITS.balanced).toBe(25);
    expect(MODE_SEARCH_LIMITS.tokenmax).toBe(50);
  });

  it("MAX_SEARCH_LIMIT is 100", () => {
    expect(MAX_SEARCH_LIMIT).toBe(100);
  });
});

// ─── SearchOpts type-level smoke ─────────────────────────────────────────────

describe("engine — SearchOpts type", () => {
  it("accepts all documented fields", () => {
    const opts: SearchOpts = {
      limit: 10,
      mode: "conservative",
      typeFilter: "company",
      includeDeleted: false,
    };
    expect(opts.limit).toBe(10);
    expect(opts.mode).toBe("conservative");
  });

  it("allows a minimal (all-optional) opts", () => {
    const opts: SearchOpts = {};
    expect(opts.limit).toBeUndefined();
  });
});
