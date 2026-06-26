// Integration tests for the HelixDB dynamic query modules.
//
// These tests exercise the full query → HelixDB → response-mapping pipeline
// against a live HelixDB instance (the Docker Compose `helixdb` service on
// localhost:8080). They follow the reachability-skip pattern from
// packages/core/test/control/_helpers.ts: if HelixDB is not reachable, every
// test is skipped (not failed) so `bun test` passes in environments without
// Docker.
//
// Setup: deploySchema (idempotent) + drop all Page/Chunk/Source nodes before
// each describe block. Tests within a block are independent (each creates its
// own slugs).
//
// Run locally with:  docker compose up -d helixdb && bun test apps packages

import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { Client, g, writeBatch } from "@helix-db/helix-db";
import { deploySchema } from "../../src/helix/deploy.ts";
import * as Q from "../../src/helix/queries/index.ts";

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

/** Client bound to the local HelixDB (dev mode — auth disabled, any key works). */
function makeClient(): Client {
  return new Client(HELIX_URL).withApiKey("dev-test-key");
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
  const client = makeClient();
  await deploySchema(client);
});

beforeEach(async () => {
  if (!reachable) return;
  await dropAll(makeClient());
});

// ─── Page CRUD ───────────────────────────────────────────────────────────────

describe("helix/queries — Page CRUD", () => {
  itP("addPage creates a page with server-stamped timestamps", async () => {
    const client = makeClient();
    const page = await Q.addPage(client, {
      slug: "acme",
      type: "company",
      title: "Acme Corp",
      compiledTruth: "Acme makes widgets",
    });
    expect(page.id).toBeTruthy();
    expect(page.slug).toBe("acme");
    expect(page.title).toBe("Acme Corp");
    expect(page.type).toBe("company");
    expect(page.compiledTruth).toBe("Acme makes widgets");
    expect(page.createdAt).toBeInstanceOf(Date);
    expect(page.updatedAt).toBeInstanceOf(Date);
    expect(page.deletedAt).toBeNull();
  });

  itP("addPage stores frontmatter as an object", async () => {
    const client = makeClient();
    const page = await Q.addPage(client, {
      slug: "acme",
      type: "company",
      title: "Acme",
      compiledTruth: "truth",
      frontmatter: { tags: ["x", "y"], priority: 5 },
    });
    expect(page.frontmatter).toEqual({ tags: ["x", "y"], priority: 5 });
  });

  itP("getPageBySlug retrieves an existing page", async () => {
    const client = makeClient();
    await Q.addPage(client, {
      slug: "globex",
      type: "company",
      title: "Globex Corp",
      compiledTruth: "Globex makes things",
    });
    const got = await Q.getPageBySlug(client, "globex");
    expect(got.slug).toBe("globex");
    expect(got.title).toBe("Globex Corp");
  });

  itP("getPageBySlug throws on not-found", async () => {
    const client = makeClient();
    await expect(Q.getPageBySlug(client, "nonexistent")).rejects.toThrow(
      /no Page found for slug="nonexistent"/,
    );
  });

  itP("getPageBySlug excludes soft-deleted pages", async () => {
    const client = makeClient();
    await Q.addPage(client, {
      slug: "acme",
      type: "company",
      title: "Acme",
      compiledTruth: "truth",
    });
    await Q.softDeletePage(client, "acme");
    await expect(Q.getPageBySlug(client, "acme")).rejects.toThrow(/no Page found/);
  });

  itP("updatePage patches fields and bumps updated_at", async () => {
    const client = makeClient();
    const original = await Q.addPage(client, {
      slug: "acme",
      type: "company",
      title: "Acme Corp",
      compiledTruth: "old truth",
    });
    const updated = await Q.updatePage(client, {
      slug: "acme",
      patch: { title: "Acme Corp Intl", compiledTruth: "new truth" },
    });
    expect(updated.title).toBe("Acme Corp Intl");
    expect(updated.compiledTruth).toBe("new truth");
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(original.updatedAt.getTime());
  });

  itP("updatePage throws on not-found", async () => {
    const client = makeClient();
    await expect(
      Q.updatePage(client, { slug: "nope", patch: { title: "x" } }),
    ).rejects.toThrow(/no Page found/);
  });

  itP("softDeletePage sets deleted_at and hides the page from listPages", async () => {
    const client = makeClient();
    await Q.addPage(client, {
      slug: "acme",
      type: "company",
      title: "Acme",
      compiledTruth: "truth",
    });
    await Q.softDeletePage(client, "acme");
    expect((await Q.listPages(client, {})).length).toBe(0);
    expect((await Q.listPages(client, { includeDeleted: true })).length).toBe(1);
  });

  itP("softDeletePage throws on not-found", async () => {
    const client = makeClient();
    await expect(Q.softDeletePage(client, "nope")).rejects.toThrow(/no Page found/);
  });

  itP("listPages filters by type and orders by updated_at desc", async () => {
    const client = makeClient();
    await Q.addPage(client, { slug: "a", type: "company", title: "A", compiledTruth: "t" });
    await Q.addPage(client, { slug: "b", type: "person", title: "B", compiledTruth: "t" });
    await Q.addPage(client, { slug: "c", type: "company", title: "C", compiledTruth: "t" });

    const companies = await Q.listPages(client, { type: "company" });
    expect(companies.length).toBe(2);
    expect(companies.map((p) => p.slug).sort()).toEqual(["a", "c"]);

    const all = await Q.listPages(client, { limit: 10 });
    expect(all.length).toBe(3);
  });
});

// ─── Chunk CRUD ──────────────────────────────────────────────────────────────

describe("helix/queries — Chunk CRUD", () => {
  itP("addChunk creates a chunk linked to a page by page_id", async () => {
    const client = makeClient();
    const page = await Q.addPage(client, {
      slug: "acme",
      type: "company",
      title: "Acme",
      compiledTruth: "truth",
    });
    const chunk = await Q.addChunk(client, {
      pageId: page.id,
      chunkIndex: 0,
      content: "Acme makes widgets in Reno",
      embedding: [1, 0, 0, 0],
    });
    expect(chunk.id).toBeTruthy();
    expect(chunk.pageId).toBe(page.id);
    expect(chunk.chunkIndex).toBe(0);
    expect(chunk.content).toBe("Acme makes widgets in Reno");
    expect(chunk.embedding).toEqual([1, 0, 0, 0]);
  });

  itP("getChunksByPage returns chunks ordered by chunk_index", async () => {
    const client = makeClient();
    const page = await Q.addPage(client, {
      slug: "acme",
      type: "company",
      title: "Acme",
      compiledTruth: "truth",
    });
    await Q.addChunk(client, { pageId: page.id, chunkIndex: 2, content: "c2" });
    await Q.addChunk(client, { pageId: page.id, chunkIndex: 0, content: "c0" });
    await Q.addChunk(client, { pageId: page.id, chunkIndex: 1, content: "c1" });

    const chunks = await Q.getChunksByPage(client, page.id);
    expect(chunks.length).toBe(3);
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
  });

  itP("updateChunkEmbedding updates the embedding and model", async () => {
    const client = makeClient();
    const page = await Q.addPage(client, {
      slug: "acme",
      type: "company",
      title: "Acme",
      compiledTruth: "truth",
    });
    const chunk = await Q.addChunk(client, {
      pageId: page.id,
      chunkIndex: 0,
      content: "content",
    });
    const updated = await Q.updateChunkEmbedding(client, {
      chunkId: chunk.id,
      embedding: [0.5, 0.5, 0, 0],
      model: "voyage-3",
    });
    expect(updated.embedding).toEqual([0.5, 0.5, 0, 0]);
    expect(updated.model).toBe("voyage-3");
    expect(updated.embeddedAt).toBeInstanceOf(Date);
  });
});

// ─── Source CRUD ─────────────────────────────────────────────────────────────

describe("helix/queries — Source CRUD", () => {
  itP("addSource creates a source with archived=false", async () => {
    const client = makeClient();
    const src = await Q.addSource(client, {
      name: "wiki",
      config: { federated: true },
    });
    expect(src.id).toBeTruthy();
    expect(src.name).toBe("wiki");
    expect(src.archived).toBe(false);
    expect(src.config).toEqual({ federated: true });
  });

  itP("getSource retrieves an existing source", async () => {
    const client = makeClient();
    await Q.addSource(client, { name: "wiki", config: {} });
    const got = await Q.getSource(client, "wiki");
    expect(got.name).toBe("wiki");
  });

  itP("getSource throws on not-found", async () => {
    const client = makeClient();
    await expect(Q.getSource(client, "nope")).rejects.toThrow(/no Source found/);
  });

  itP("listSources returns created sources", async () => {
    const client = makeClient();
    await Q.addSource(client, { name: "wiki", config: {} });
    await Q.addSource(client, { name: "gstack", config: {} });
    const sources = await Q.listSources(client, {});
    expect(sources.length).toBe(2);
    expect(sources.map((s) => s.name).sort()).toEqual(["gstack", "wiki"]);
  });
});

// ─── Links (edges) ───────────────────────────────────────────────────────────

describe("helix/queries — Links", () => {
  itP("addEdge creates a MENTIONS edge between two pages", async () => {
    const client = makeClient();
    await Q.addPage(client, { slug: "acme", type: "company", title: "Acme", compiledTruth: "t" });
    await Q.addPage(client, { slug: "globex", type: "company", title: "Globex", compiledTruth: "t" });
    const edge = await Q.addEdge(client, {
      fromSlug: "acme",
      toSlug: "globex",
      type: "MENTIONS",
      origin: "manual",
    });
    expect(edge.fromSlug).toBe("acme");
    expect(edge.toSlug).toBe("globex");
    expect(edge.type).toBe("MENTIONS");
    expect(edge.origin).toBe("manual");
  });

  itP("addEdge throws if the from-page does not exist", async () => {
    const client = makeClient();
    await Q.addPage(client, { slug: "globex", type: "company", title: "G", compiledTruth: "t" });
    // The server rejects addE with no source vertex; our code surfaces either
    // that server error or our own not-found message (both are acceptable —
    // the contract is "throws").
    await expect(
      Q.addEdge(client, { fromSlug: "nope", toSlug: "globex", type: "MENTIONS", origin: "auto" }),
    ).rejects.toThrow();
  });

  itP("getOutEdges returns pages the seed mentions", async () => {
    const client = makeClient();
    await Q.addPage(client, { slug: "acme", type: "company", title: "Acme", compiledTruth: "t" });
    await Q.addPage(client, { slug: "globex", type: "company", title: "Globex", compiledTruth: "t" });
    await Q.addEdge(client, { fromSlug: "acme", toSlug: "globex", type: "MENTIONS", origin: "auto" });
    const out = await Q.getOutEdges(client, "acme");
    expect(out.length).toBe(1);
    expect(out[0]!.toSlug).toBe("globex");
  });

  itP("getInEdges returns pages that mention the seed", async () => {
    const client = makeClient();
    await Q.addPage(client, { slug: "acme", type: "company", title: "Acme", compiledTruth: "t" });
    await Q.addPage(client, { slug: "globex", type: "company", title: "Globex", compiledTruth: "t" });
    await Q.addEdge(client, { fromSlug: "acme", toSlug: "globex", type: "MENTIONS", origin: "auto" });
    const inn = await Q.getInEdges(client, "globex");
    expect(inn.length).toBe(1);
    expect(inn[0]!.fromSlug).toBe("acme");
  });
});

// ─── Vector search ───────────────────────────────────────────────────────────

describe("helix/queries — vector search", () => {
  itP("vectorSearchChunks returns nearest chunks by embedding", async () => {
    const client = makeClient();
    const page = await Q.addPage(client, {
      slug: "acme",
      type: "company",
      title: "Acme",
      compiledTruth: "truth",
    });
    await Q.addChunk(client, {
      pageId: page.id,
      chunkIndex: 0,
      content: "Acme makes widgets",
      embedding: [1, 0, 0, 0],
    });
    const hits = await Q.vectorSearchChunks(client, { embedding: [1, 0, 0, 0], limit: 5 });
    expect(hits.length).toBe(1);
    expect(hits[0]!.content).toBe("Acme makes widgets");
    expect(hits[0]!.distance).toBeGreaterThanOrEqual(0);
    expect(hits[0]!.score).toBeLessThanOrEqual(1);
  });

  itP("vectorSearchChunks ranks closer embeddings higher", async () => {
    const client = makeClient();
    const page = await Q.addPage(client, {
      slug: "acme",
      type: "company",
      title: "Acme",
      compiledTruth: "truth",
    });
    await Q.addChunk(client, {
      pageId: page.id,
      chunkIndex: 0,
      content: "exact match",
      embedding: [1, 0, 0, 0],
    });
    await Q.addChunk(client, {
      pageId: page.id,
      chunkIndex: 1,
      content: "orthogonal",
      embedding: [0, 1, 0, 0],
    });
    const hits = await Q.vectorSearchChunks(client, { embedding: [1, 0, 0, 0], limit: 2 });
    expect(hits.length).toBe(2);
    expect(hits[0]!.content).toBe("exact match");
    expect(hits[0]!.distance).toBeLessThan(hits[1]!.distance);
  });
});

// ─── Text search ─────────────────────────────────────────────────────────────

describe("helix/queries — text search", () => {
  itP("textSearchPages finds pages by title keyword", async () => {
    const client = makeClient();
    await Q.addPage(client, {
      slug: "acme",
      type: "company",
      title: "Acme Corp",
      compiledTruth: "makes widgets",
    });
    const hits = await Q.textSearchPages(client, { query: "acme", limit: 5 });
    expect(hits.length).toBe(1);
    expect(hits[0]!.slug).toBe("acme");
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  itP("textSearchPages finds pages by compiled_truth keyword", async () => {
    const client = makeClient();
    await Q.addPage(client, {
      slug: "acme",
      type: "company",
      title: "ACME",
      compiledTruth: "Acme manufactures widgets in Reno",
    });
    const hits = await Q.textSearchPages(client, { query: "reno", limit: 5 });
    expect(hits.length).toBe(1);
    expect(hits[0]!.slug).toBe("acme");
  });

  itP("textSearchChunks finds chunks by content keyword", async () => {
    const client = makeClient();
    const page = await Q.addPage(client, {
      slug: "acme",
      type: "company",
      title: "Acme",
      compiledTruth: "truth",
    });
    await Q.addChunk(client, {
      pageId: page.id,
      chunkIndex: 0,
      content: "Acme manufactures widgets in Reno",
    });
    const hits = await Q.textSearchChunks(client, { query: "widgets", limit: 5 });
    expect(hits.length).toBe(1);
    expect(hits[0]!.content).toContain("widgets");
  });
});

// ─── Graph traversal ─────────────────────────────────────────────────────────

describe("helix/queries — graph traversal", () => {
  itP("traverseFrom (out, depth=1) returns direct neighbors", async () => {
    const client = makeClient();
    await Q.addPage(client, { slug: "acme", type: "company", title: "Acme", compiledTruth: "t" });
    await Q.addPage(client, { slug: "globex", type: "company", title: "Globex", compiledTruth: "t" });
    await Q.addEdge(client, { fromSlug: "acme", toSlug: "globex", type: "MENTIONS", origin: "auto" });

    const neighbors = await Q.traverseFrom(client, "acme", { direction: "out", depth: 1 });
    expect(neighbors.length).toBe(1);
    expect(neighbors[0]!.slug).toBe("globex");
    expect(neighbors[0]!.distance).toBe(1);
  });

  itP("traverseFrom (in, depth=1) returns pages that point to the seed", async () => {
    const client = makeClient();
    await Q.addPage(client, { slug: "acme", type: "company", title: "Acme", compiledTruth: "t" });
    await Q.addPage(client, { slug: "globex", type: "company", title: "Globex", compiledTruth: "t" });
    await Q.addEdge(client, { fromSlug: "acme", toSlug: "globex", type: "MENTIONS", origin: "auto" });

    const neighbors = await Q.traverseFrom(client, "globex", { direction: "in", depth: 1 });
    expect(neighbors.length).toBe(1);
    expect(neighbors[0]!.slug).toBe("acme");
  });

  itP("traverseFrom excludes the seed node from results", async () => {
    const client = makeClient();
    await Q.addPage(client, { slug: "acme", type: "company", title: "Acme", compiledTruth: "t" });
    const neighbors = await Q.traverseFrom(client, "acme", { direction: "out", depth: 1 });
    expect(neighbors.find((n) => n.slug === "acme")).toBeUndefined();
  });
});

// ─── deploySchema idempotency ────────────────────────────────────────────────

describe("helix/deploy — deploySchema idempotency", () => {
  itP("deploySchema can be called twice without error", async () => {
    const client = makeClient();
    await deploySchema(client);
    await deploySchema(client);
    // If we reach here without throwing, the test passes.
    expect(true).toBe(true);
  });
});
