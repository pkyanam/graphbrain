// Tests for the deterministic intent classifier (packages/core/src/search/intent.ts).
//
// Pure-function tests: no DB, no LLM, no async. Verifies the four intent
// categories (entity / temporal / event / general) + the priority order
// (full-context > temporal > event > entity > general) + the
// intentToDetail mapping.

import { describe, it, expect } from "bun:test";
import { classifyIntent, classifyQuery, intentToDetail } from "../../src/search/intent";

describe("classifyIntent", () => {
  describe("temporal queries", () => {
    const cases: [string, string][] = [
      ["when did we last meet", "when"],
      ["what's new with acme", "what's new"],
      ["recent updates from the team", "recent"],
      ["meeting notes from yesterday", "meeting notes"],
      ["give me everything about acme", "full-context"],
      ["full history of stripe", "full history"],
      ["deep dive on the payments project", "deep dive"],
      ["timeline of events", "timeline"],
      ["last week's standups", "last week"],
      ["2026-05-20 meeting", "date pattern"],
    ];
    for (const [q, label] of cases) {
      it(`classifies "${q}" as temporal (${label})`, () => {
        expect(classifyIntent(q)).toBe("temporal");
      });
    }
  });

  describe("event queries", () => {
    const cases: [string, string][] = [
      ["acme announced a new product", "announce"],
      ["stripe launched a new API", "launch"],
      ["acme raised $50M", "raised"],
      ["the IPO was announced", "ipo"],
      ["what happened at the offsite", "happened"],
    ];
    for (const [q, label] of cases) {
      it(`classifies "${q}" as event (${label})`, () => {
        expect(classifyIntent(q)).toBe("event");
      });
    }
  });

  describe("entity queries", () => {
    const cases: [string, string][] = [
      ["who is garry tan", "who is"],
      ["what is acme corp", "what is"],
      ["tell me about alice", "tell me about"],
      ["summarize the payments project", "summarize"],
      ["overview of the engineering team", "overview"],
    ];
    for (const [q, label] of cases) {
      it(`classifies "${q}" as entity (${label})`, () => {
        expect(classifyIntent(q)).toBe("entity");
      });
    }
  });

  describe("general queries", () => {
    const cases: string[] = [
      "payments",
      "acme",
      "how do we handle refunds",
      "best practices for onboarding",
    ];
    for (const q of cases) {
      it(`classifies "${q}" as general`, () => {
        expect(classifyIntent(q)).toBe("general");
      });
    }
  });

  describe("priority order", () => {
    it("full-context beats temporal", () => {
      // "give me everything" → full-context → temporal (not event/entity)
      expect(classifyIntent("give me everything about the announcement")).toBe("temporal");
    });
    it("temporal beats event", () => {
      // "when" → temporal (not event, even though "announced" is present)
      expect(classifyIntent("when was the announcement")).toBe("temporal");
    });
    it("event beats entity", () => {
      // "announced" → event (not entity, even though no entity pattern)
      expect(classifyIntent("the funding announcement")).toBe("event");
    });
  });
});

describe("intentToDetail", () => {
  it("entity → low", () => {
    expect(intentToDetail("entity")).toBe("low");
  });
  it("temporal → high", () => {
    expect(intentToDetail("temporal")).toBe("high");
  });
  it("event → high", () => {
    expect(intentToDetail("event")).toBe("high");
  });
  it("general → undefined", () => {
    expect(intentToDetail("general")).toBeUndefined();
  });
});

describe("classifyQuery", () => {
  it("returns intent + suggestedDetail for temporal", () => {
    const result = classifyQuery("when did we last meet");
    expect(result.intent).toBe("temporal");
    expect(result.suggestedDetail).toBe("high");
  });
  it("returns intent + suggestedDetail for entity", () => {
    const result = classifyQuery("who is alice");
    expect(result.intent).toBe("entity");
    expect(result.suggestedDetail).toBe("low");
  });
  it("returns undefined detail for general", () => {
    const result = classifyQuery("payments");
    expect(result.intent).toBe("general");
    expect(result.suggestedDetail).toBeUndefined();
  });
});
