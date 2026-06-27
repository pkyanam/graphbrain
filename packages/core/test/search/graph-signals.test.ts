// Tests for graph signals (packages/core/src/search/graph-signals.ts) —
// session prefix detection only. The adjacency + session diversification
// signals require a BrainEngine mock; those are covered by the hybrid
// integration test. The sessionPrefix function is pure + deterministic.

import { describe, it, expect } from "bun:test";
import { sessionPrefix } from "../../src/search/graph-signals";

describe("sessionPrefix", () => {
  describe("session-shaped slugs (returns a prefix)", () => {
    it("detects chat marker + session id", () => {
      expect(sessionPrefix("your-agent/chat/2026-05-20-foo")).toBe("your-agent/chat/2026-05-20-foo");
    });
    it("detects session marker", () => {
      expect(sessionPrefix("daily/session/abc123")).toBe("daily/session/abc123");
    });
    it("detects date anchor without marker", () => {
      expect(sessionPrefix("daily/2026-05-20/journal-entry-1")).toBe("daily/2026-05-20");
    });
    it("detects meetings with date", () => {
      expect(sessionPrefix("meetings/2026-04-03/notes")).toBe("meetings/2026-04-03");
    });
  });

  describe("non-session slugs (returns null)", () => {
    it("returns null for entity directory (people/)", () => {
      expect(sessionPrefix("people/alice")).toBeNull();
    });
    it("returns null for entity directory (companies/)", () => {
      expect(sessionPrefix("companies/acme")).toBeNull();
    });
    it("returns null for topical directory (docs/)", () => {
      expect(sessionPrefix("docs/quickstart")).toBeNull();
    });
    it("returns null for slug without slash", () => {
      expect(sessionPrefix("acme")).toBeNull();
    });
    it("returns null for empty string", () => {
      expect(sessionPrefix("")).toBeNull();
    });
  });
});
