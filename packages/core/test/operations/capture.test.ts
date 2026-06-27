// Tests for the capture operation (Stage 10).
//
// Uses mock BrainEngine + mock EmbeddingService. No real DB, no real LLM.
// Verifies:
//   - capture delegates to put_page (chunks + embeds + writes).
//   - inferCaptureType heuristics.
//   - generateCaptureSlug produces a timestamped slug.
//   - capture generates a slug + infers a type + derives a title when omitted.

import { describe, it, expect } from "bun:test";
import { captureOp, inferCaptureType, generateCaptureSlug } from "../../src/operations";
import {
  makeCtx,
  makeResolvedDeps,
  makeMockEngine,
  makeMockEmbeddingService,
} from "./_helpers";

describe("inferCaptureType", () => {
  it("infers 'meeting' for meeting-ish content", () => {
    expect(inferCaptureType("Meeting with Acme on Tuesday")).toBe("meeting");
    expect(inferCaptureType("notes: follow up on the deal")).toBe("meeting");
  });

  it("infers 'conversation' for chat-ish content", () => {
    expect(inferCaptureType("Slack thread about the deploy")).toBe("conversation");
    expect(inferCaptureType("conversation with the team")).toBe("conversation");
  });

  it("infers 'concept' for idea-ish content", () => {
    expect(inferCaptureType("Idea: a better chunker")).toBe("concept");
    expect(inferCaptureType("hypothesis: users want fewer results")).toBe("concept");
  });

  it("defaults to 'note'", () => {
    expect(inferCaptureType("just a random thought")).toBe("note");
    expect(inferCaptureType("bought groceries")).toBe("note");
  });
});

describe("generateCaptureSlug", () => {
  it("produces a notes/ prefixed timestamped slug", () => {
    const slug = generateCaptureSlug(new Date("2026-06-26T12:34:56Z"));
    expect(slug).toMatch(/^notes\/2026-06-26-123456-\d{3}$/);
  });

  it("produces unique slugs on rapid calls (random suffix)", () => {
    const slugs = new Set<string>();
    for (let i = 0; i < 20; i++) slugs.add(generateCaptureSlug());
    // The random suffix (0-999) makes collisions possible but unlikely in 20.
    expect(slugs.size).toBeGreaterThan(15);
  });
});

describe("capture op", () => {
  it("delegates to put_page: chunks, embeds, writes the page", async () => {
    const engine = makeMockEngine();
    const embeddingService = makeMockEmbeddingService([0.1, 0.2]);
    const deps = makeResolvedDeps(engine, { embeddingService });
    const ctx = makeCtx();

    const content = "Meeting with Acme.\n\nDiscussed the Q3 roadmap and the widget launch.";
    const result = await captureOp.handler({ content }, ctx, deps);

    expect(result.page.type).toBe("meeting");
    expect(result.page.title).toBe("Meeting with Acme.");
    expect(result.page.slug).toMatch(/^notes\//);
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.embedded).toBeGreaterThan(0);
  });

  it("uses the provided slug + type + title when given", async () => {
    const engine = makeMockEngine();
    const deps = makeResolvedDeps(engine, {
      embeddingService: makeMockEmbeddingService(null),
    });
    const result = await captureOp.handler(
      { content: "some content", slug: "custom/slug", type: "concept", title: "Custom Title", skipEmbed: true },
      makeCtx(),
      deps,
    );
    expect(result.page.slug).toBe("custom/slug");
    expect(result.page.type).toBe("concept");
    expect(result.page.title).toBe("Custom Title");
  });

  it("derives the title from the first non-frontmatter line", async () => {
    const engine = makeMockEngine();
    const deps = makeResolvedDeps(engine, {
      embeddingService: makeMockEmbeddingService(null),
    });
    const content = "---\ntype: note\n---\n\n# My Heading\n\nBody text.";
    const result = await captureOp.handler(
      { content, slug: "x", skipEmbed: true },
      makeCtx(),
      deps,
    );
    expect(result.page.title).toBe("My Heading");
  });
});
