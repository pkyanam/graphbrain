// Integration tests for HelixEngine (packages/core/src/helix-engine.ts).
//
// Exercises every BrainEngine method end-to-end against a live HelixDB
// instance (the Docker Compose `helixdb` service on localhost:8080). Follows
// the reachability-skip pattern from test/helix/queries.test.ts: if HelixDB
// is not reachable, every test is skipped (not failed) so `bun test` passes
// in environments without Docker.
//
// Setup: deploySchema (idempotent) + drop all Page/Chunk/Source nodes before
// each describe block. Tests within a block are independent (each creates its
// own slugs).
//
// Run locally with:  docker compose up -d helixdb && bun test apps packages

import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { Client, g, writeBatch } from "@helix-db/helix-db";
import { deploySchema } from "../src/helix/deploy.ts";
import { HelixEngine } from "../src/helix-engine.ts";
import type { BrainEngine } from "../src/engine.ts";

const HELIX_URL = process.env.HELIXDB_URL ?? "http://localhost:8080";

/** Probe whether the local HelixDB instance is reachable. */
async function helixReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${HELIX_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

const reachable = await helixReachable();
const itP = reachable ? it : it.skip;

/** Client for setup/teardown (dropAll). */
function makeClient(): Client {
  return new Client(HELIX_URL).withApiKey("dev-test-key");
}

/** A fresh HelixEngine per test (the engine creates its own client lazily). */
function makeEngine(): HelixEngine {
  return new HelixEngine({ url: HELIX_URL, apiKey: "dev-test-key" });
}

/** Drop all Phase 1 nodes so each test starts from a clean slate. */
async function dropAll(client: Client): Promise<void> {
  for (const label of ["Page", "Chunk", "Source"]) {
    await client
      .query()
      .dynamic(
        writeBatch()
          .varAs("d", g().nWithLabel(label).drop())
          .returning(["d"])
          .toDynamicRequest({ queryName: `drop_${label}` }),
      )
      .send();
  }
}

beforeAll(async () => {
  if (!reachable) return;
  await deploySchema(makeClient());
});

beforeEach(async () => {
  if (!reachable) return;
  await dropAll(makeClient());
});

// ─── Lifecycle ───────────────────────────────────────────────────────────────

describe("HelixEngine — lifecycle", () => {
  itP("health() returns true when the instance is reachable", async () => {
    const engine = makeEngine();
    expect(await engine.health()).toBe(true);
    await engine.close();
  });

  itP("health() returns false for an unreachable URL", async () => {
    const engine = new HelixEngine({ url: "http://localhost:9999", apiKey: "k", healthTimeoutMs: 500 });
    expect(await engine.health()).toBe(false);
    await engine.close();
  });

  itP("close() is safe to call multiple times", async () => {
    const engine = makeEngine();
    await engine.close();
    await engine.close();
    expect(true).toBe(true);
  });

  itP("kind is 'helix'", () => {
    const engine = makeEngine();
    expect(engine.kind).toBe("helix");
  });
});

// ─── Pages ───────────────────────────────────────────────────────────────────

describe("HelixEngine — pages", () => {
  itP("putPage creates a new page (add path)", async () => {
    const engine = makeEngine();
    const page = await engine.putPage({
      slug: "acme",
      type: "company",
      title: "Acme Corp",
      compiledTruth: "Acme makes widgets",
    });
    expect(page.id).toBeTruthy();
    expect(page.slug).toBe("acme");
    expect(page.title).toBe("Acme Corp");
    expect(page.deletedAt).toBeNull();
    await engine.close();
  });

  itP("putPage updates an existing page (update path)", async () => {
    const engine = makeEngine();
    await engine.putPage({ slug: "acme", type: "company", title: "Acme", compiledTruth: "v1" });
    const updated = await engine.putPage({
      slug: "acme",
      type: "company",
      title: "Acme Corp",
      compiledTruth: "v2",
    });
    expect(updated.title).toBe("Acme Corp");
    expect(updated.compiledTruth).toBe("v2");
    await engine.close();
  });

  itP("getPage returns the page by slug", async () => {
    const engine = makeEngine();
    await engine.putPage({ slug: "acme", type: "company", title: "Acme", compiledTruth: "t" });
    const page = await engine.getPage("acme");
    expect(page).not.toBeNull();
    expect(page!.slug).toBe("acme");
    await engine.close();
  });

  itP("getPage returns null when not found", async () => {
    const engine = makeEngine();
    const page = await engine.getPage("nope");
    expect(page).toBeNull();
    await engine.close();
  });

  itP("getPage excludes soft-deleted pages by default", async () => {
    const engine = makeEngine();
    await engine.putPage({ slug: "acme", type: "company", title: "Acme", compiledTruth: "t" });
    await engine.softDeletePage("acme");
    expect(await engine.getPage("acme")).toBeNull();
    await engine.close();
  });

  itP("getPage with includeDeleted returns soft-deleted pages", async () => {
    const engine = makeEngine();
    await engine.putPage({ slug: "acme", type: "company", title: "Acme", compiledTruth: "t" });
    await engine.softDeletePage("acme");
    const page = await engine.getPage("acme", { includeDeleted: true });
    expect(page).not.toBeNull();
    expect(page!.deletedAt).not.toBeNull();
    await engine.close();
  });

  itP("softDeletePage throws when the page is not found", async () => {
    const engine = makeEngine();
    expect(engine.softDeletePage("nope")).rejects.toThrow();
    await engine.close();
  });

  itP("listPages returns created pages", async () => {
    const engine = makeEngine();
    await engine.putPage({ slug: "a", type: "company", title: "A", compiledTruth: "t" });
    await engine.putPage({ slug: "b", type: "person", title: "B", compiledTruth: "t" });
    const pages = await engine.listPages();
    expect(pages.length).toBe(2);
    await engine.close();
  });

  itP("listPages filters by typeFilter", async () => {
    const engine = makeEngine();
    await engine.putPage({ slug: "a", type: "company", title: "A", compiledTruth: "t" });
    await engine.putPage({ slug: "b", type: "person", title: "B", compiledTruth: "t" });
    const pages = await engine.listPages({ typeFilter: "company" });
    expect(pages.length).toBe(1);
    expect(pages[0]!.type).toBe("company");
    await engine.close();
  });
});

// ─── Chunks ──────────────────────────────────────────────────────────────────

describe("HelixEngine — chunks", () => {
  itP("addChunk + getChunksByPage round-trip", async () => {
    const engine = makeEngine();
    const page = await engine.putPage({ slug: "acme", type: "company", title: "Acme", compiledTruth: "t" });
    await engine.addChunk({ pageId: page.id, chunkIndex: 0, content: "chunk 0" });
    await engine.addChunk({ pageId: page.id, chunkIndex: 1, content: "chunk 1" });
    const chunks = await engine.getChunksByPage("acme");
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.chunkIndex).toBe(0);
    expect(chunks[1]!.chunkIndex).toBe(1);
    await engine.close();
  });

  itP("getChunksByPage returns [] for a missing page", async () => {
    const engine = makeEngine();
    const chunks = await engine.getChunksByPage("nope");
    expect(chunks).toEqual([]);
    await engine.close();
  });

  itP("updateChunkEmbedding overwrites the embedding", async () => {
    const engine = makeEngine();
    const page = await engine.putPage({ slug: "acme", type: "company", title: "Acme", compiledTruth: "t" });
    const chunk = await engine.addChunk({ pageId: page.id, chunkIndex: 0, content: "c" });
    const updated = await engine.updateChunkEmbedding(chunk.id, [0.1, 0.2, 0.3, 0.4], "voyage:test");
    expect(updated.embedding).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(updated.model).toBe("voyage:test");
    expect(updated.embeddedAt).not.toBeNull();
    await engine.close();
  });
});

// ─── Edges ───────────────────────────────────────────────────────────────────

describe("HelixEngine — edges", () => {
  itP("addEdge + getOutEdges + getInEdges", async () => {
    const engine = makeEngine();
    await engine.putPage({ slug: "acme", type: "company", title: "Acme", compiledTruth: "t" });
    await engine.putPage({ slug: "globex", type: "company", title: "Globex", compiledTruth: "t" });
    await engine.addEdge({ fromSlug: "acme", toSlug: "globex", type: "MENTIONS", origin: "auto" });

    const out = await engine.getOutEdges("acme");
    expect(out.length).toBe(1);
    expect(out[0]!.toSlug).toBe("globex");

    const inc = await engine.getInEdges("globex");
    expect(inc.length).toBe(1);
    expect(inc[0]!.fromSlug).toBe("acme");
    await engine.close();
  });

  itP("addEdge throws when a page is missing", async () => {
    const engine = makeEngine();
    await engine.putPage({ slug: "acme", type: "company", title: "Acme", compiledTruth: "t" });
    expect(
      engine.addEdge({ fromSlug: "acme", toSlug: "nope", type: "MENTIONS", origin: "auto" }),
    ).rejects.toThrow();
    await engine.close();
  });
});

// ─── Search ──────────────────────────────────────────────────────────────────

describe("HelixEngine — search", () => {
  itP("vectorSearchChunks returns nearest chunks", async () => {
    const engine = makeEngine();
    const page = await engine.putPage({ slug: "acme", type: "company", title: "Acme", compiledTruth: "t" });
    await engine.addChunk({
      pageId: page.id,
      chunkIndex: 0,
      content: "Acme makes widgets",
      embedding: [1, 0, 0, 0],
    });
    const hits = await engine.vectorSearchChunks([1, 0, 0, 0], { limit: 5 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.content).toContain("Acme");
    await engine.close();
  });

  itP("textSearchPages finds pages by title", async () => {
    const engine = makeEngine();
    await engine.putPage({ slug: "acme", type: "company", title: "Acme Widget Corp", compiledTruth: "t" });
    const hits = await engine.textSearchPages("acme widget", { limit: 5 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h) => h.slug === "acme")).toBe(true);
    await engine.close();
  });

  itP("textSearchChunks finds chunks by content", async () => {
    const engine = makeEngine();
    const page = await engine.putPage({ slug: "acme", type: "company", title: "Acme", compiledTruth: "t" });
    await engine.addChunk({ pageId: page.id, chunkIndex: 0, content: "widgets are great" });
    const hits = await engine.textSearchChunks("widgets", { limit: 5 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.content).toContain("widgets");
    await engine.close();
  });

  itP("search respects the mode limit ceiling (conservative=10)", async () => {
    const engine = makeEngine();
    const page = await engine.putPage({ slug: "acme", type: "company", title: "Acme", compiledTruth: "t" });
    for (let i = 0; i < 15; i++) {
      await engine.addChunk({ pageId: page.id, chunkIndex: i, content: `chunk ${i}`, embedding: [1, 0, 0, 0] });
    }
    // conservative mode caps at 10 even though we asked for 50.
    const hits = await engine.vectorSearchChunks([1, 0, 0, 0], { limit: 50, mode: "conservative" });
    expect(hits.length).toBeLessThanOrEqual(10);
    await engine.close();
  });
});

// ─── Graph traversal ─────────────────────────────────────────────────────────

describe("HelixEngine — traverse", () => {
  itP("traverse returns direct neighbors (out, depth=1)", async () => {
    const engine = makeEngine();
    await engine.putPage({ slug: "acme", type: "company", title: "Acme", compiledTruth: "t" });
    await engine.putPage({ slug: "globex", type: "company", title: "Globex", compiledTruth: "t" });
    await engine.addEdge({ fromSlug: "acme", toSlug: "globex", type: "MENTIONS", origin: "auto" });
    const neighbors = await engine.traverse("acme", { direction: "out", depth: 1 });
    expect(neighbors.length).toBe(1);
    expect(neighbors[0]!.slug).toBe("globex");
    await engine.close();
  });
});

// ─── Sources ─────────────────────────────────────────────────────────────────

describe("HelixEngine — sources", () => {
  itP("addSource + getSourceByName + getSource + listSources", async () => {
    const engine = makeEngine();
    const source = await engine.addSource({ name: "wiki", config: { branch: "main" } });
    expect(source.id).toBeTruthy();
    expect(source.name).toBe("wiki");

    const byName = await engine.getSourceByName("wiki");
    expect(byName).not.toBeNull();
    expect(byName!.name).toBe("wiki");

    const byId = await engine.getSource(source.id);
    expect(byId).not.toBeNull();
    expect(byId!.name).toBe("wiki");

    const list = await engine.listSources();
    expect(list.length).toBe(1);
    await engine.close();
  });

  itP("getSourceByName returns null when not found", async () => {
    const engine = makeEngine();
    expect(await engine.getSourceByName("nope")).toBeNull();
    await engine.close();
  });

  itP("getSource returns null for an invalid id", async () => {
    const engine = makeEngine();
    expect(await engine.getSource("not-a-number")).toBeNull();
    await engine.close();
  });
});

// ─── BrainEngine conformance (runtime) ───────────────────────────────────────

describe("HelixEngine — BrainEngine conformance", () => {
  itP("satisfies the BrainEngine interface at runtime", async () => {
    const engine: BrainEngine = makeEngine();
    expect(typeof engine.getPage).toBe("function");
    expect(typeof engine.putPage).toBe("function");
    expect(typeof engine.health).toBe("function");
    expect(typeof engine.close).toBe("function");
    await engine.close();
  });
});
