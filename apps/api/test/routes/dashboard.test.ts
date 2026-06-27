// Tests for the dashboard REST endpoints (apps/api/src/routes/dashboard.ts).
//
// Spins up a real Express app via `createApp({ deps, authChain })` with a
// stub auth middleware that injects a fixed `req.context` (bypassing
// clerkAuth / tenantResolver / contextBuilder) + mock DispatchDeps (mock
// engine + gateway + embeddingService). Hits the listening port with `fetch`
// and asserts each endpoint's response shape + status.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  createApp,
  startServer,
  type ServerHandle,
  type DashboardDeps,
} from "../../src/index";
import { primeMwEnv } from "../middleware/_helpers";
import {
  makeCtx,
  makeMockEngine,
  makeDispatchDeps,
  makePage,
  makeChunk,
  makeSource,
  stubAuthChain,
} from "./_helpers";
import type { Tenant } from "@graphbrain/core";

primeMwEnv();

// ─── Fixture ─────────────────────────────────────────────────────────────────

const ctx = makeCtx({
  remote: true,
  auth: { mode: "jwt", orgId: "org_123", orgSlug: "acme-corp", userId: "u1", scopes: ["read", "write"], allowedSources: [] },
});

let handle: ServerHandle;
let port: number;
let baseUrl: string;

// Shared mutable engine state (seeded per-suite; tests can inspect).
const pages = new Map<string, ReturnType<typeof makePage>>();
const chunksByPage = new Map<string, ReturnType<typeof makeChunk>[]>();
const sources = [makeSource("default")];
const revokedKeyIds = new Set<string>();

beforeAll(async () => {
  const engine = makeMockEngine({ pages, chunksByPage, sources });
  const deps: DashboardDeps = {
    ...makeDispatchDeps(engine),
    updateTenant: async (id, patch) => {
      const t = ctx.tenant;
      if (patch.settings) (ctx.tenant as Tenant).settings = patch.settings;
      return { ...t, id, settings: ctx.tenant.settings };
    },
    createApiKey: async (input) => ({
      id: "apikey_new",
      name: input.name,
      subject: input.subject,
      scopes: input.scopes ?? [],
      revoked: false,
      createdAt: "t1",
      updatedAt: "t1",
      secret: "sk_live_newkey",
    }),
    listApiKeys: async (orgId) => [
      {
        id: "apikey_existing",
        name: "Existing key",
        subject: orgId,
        scopes: ["read", "write"],
        revoked: false,
        createdAt: "t0",
        updatedAt: "t0",
      },
    ],
    revokeApiKey: async (_orgId, keyId) => {
      revokedKeyIds.add(keyId);
    },
  };
  const app = createApp({ deps, authChain: stubAuthChain(ctx) });
  const started = await new Promise<{ handle: ServerHandle; port: number }>((resolve) => {
    const h = startServer(app, {
      port: 0,
      installSignalHandlers: false,
      onListening: ({ port }) => resolve({ handle: h, port }),
    });
  });
  handle = started.handle;
  port = started.port;
  baseUrl = `http://localhost:${port}`;
});

afterAll(async () => {
  await handle.close();
});

beforeEach(() => {
  pages.clear();
  chunksByPage.clear();
  sources.length = 0;
  sources.push(makeSource("default"));
  revokedKeyIds.clear();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("routes/dashboard — GET /api/dashboard/stats", () => {
  it("returns 200 with page/chunk counts + recent pages", async () => {
    const p1 = makePage("acme", "Acme", "company");
    pages.set("acme", p1);
    chunksByPage.set("acme", [makeChunk("c1", p1.id, "chunk text")]);

    const res = await fetch(`${baseUrl}/api/dashboard/stats`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pageCount).toBe(1);
    expect(body.chunkCount).toBe(1);
    expect(Array.isArray(body.recentPages)).toBe(true);
    expect(body.recentPages).toHaveLength(1);
    expect(body.recentPages[0].slug).toBe("acme");
  });

  it("returns 200 with zero counts on an empty brain", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/stats`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pageCount).toBe(0);
    expect(body.chunkCount).toBe(0);
    expect(body.recentPages).toEqual([]);
  });
});

describe("routes/dashboard — POST /api/dashboard/search", () => {
  it("dispatches 'search' and returns 200 with results + meta", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "acme" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("results");
    expect(body).toHaveProperty("meta");
    expect(Array.isArray(body.results)).toBe(true);
  });
});

describe("routes/dashboard — GET /api/dashboard/pages", () => {
  it("dispatches 'list_pages' and returns 200 with pages + count", async () => {
    pages.set("p1", makePage("p1", "Page 1"));
    pages.set("p2", makePage("p2", "Page 2"));

    const res = await fetch(`${baseUrl}/api/dashboard/pages`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.pages).toHaveLength(2);
    expect(body.offset).toBe(0);
  });

  it("supports limit + offset query params", async () => {
    pages.set("p1", makePage("p1"));
    pages.set("p2", makePage("p2"));
    pages.set("p3", makePage("p3"));

    const res = await fetch(`${baseUrl}/api/dashboard/pages?limit=2&offset=1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);
  });
});

describe("routes/dashboard — POST /api/dashboard/pages", () => {
  it("dispatches 'put_page' and returns 201 with page + chunks", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "new-page", content: "Some content here." }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.page.slug).toBe("new-page");
    expect(Array.isArray(body.chunks)).toBe(true);
    expect(typeof body.embedded).toBe("number");
  });
});

describe("routes/dashboard — GET /api/dashboard/pages/:slug", () => {
  it("dispatches 'get_page' and returns 200 with page + chunks + edges", async () => {
    const p = makePage("acme", "Acme", "company");
    pages.set("acme", p);
    chunksByPage.set("acme", [makeChunk("c1", p.id, "chunk text")]);

    const res = await fetch(`${baseUrl}/api/dashboard/pages/acme`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.page.slug).toBe("acme");
    expect(Array.isArray(body.chunks)).toBe(true);
    expect(body.chunks).toHaveLength(1);
    expect(Array.isArray(body.outEdges)).toBe(true);
    expect(Array.isArray(body.inEdges)).toBe(true);
  });

  it("returns 404 with page_not_found when the page does not exist", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/pages/missing`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("page_not_found");
  });
});

describe("routes/dashboard — GET /api/dashboard/sources", () => {
  it("dispatches 'list_sources' and returns 200 with sources + count", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/sources`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.sources[0].name).toBe("default");
  });
});

describe("routes/dashboard — GET /api/dashboard/settings", () => {
  it("returns the tenant's current settings", async () => {
    (ctx.tenant as Tenant).settings = { chatModel: "anthropic:claude-sonnet-4-6" };
    const res = await fetch(`${baseUrl}/api/dashboard/settings`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.chatModel).toBe("anthropic:claude-sonnet-4-6");
  });
});

describe("routes/dashboard — PUT /api/dashboard/settings", () => {
  it("merges + persists settings and returns the updated settings", async () => {
    (ctx.tenant as Tenant).settings = { chatModel: "anthropic:claude-sonnet-4-6" };
    const res = await fetch(`${baseUrl}/api/dashboard/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ searchMode: "conservative" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.chatModel).toBe("anthropic:claude-sonnet-4-6");
    expect(body.settings.searchMode).toBe("conservative");
    // The merged settings were persisted onto ctx.tenant via the mock.
    expect((ctx.tenant as Tenant).settings.searchMode).toBe("conservative");
  });
});

describe("routes/dashboard — POST /api/dashboard/api-keys", () => {
  it("issues a Clerk API key and returns 201 with the secret", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "My agent key" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe("apikey_new");
    expect(body.name).toBe("My agent key");
    expect(body.scopes).toEqual(["read", "write"]);
    expect(body.secret).toBe("sk_live_newkey");
  });
});

describe("routes/dashboard — GET /api/dashboard/api-keys", () => {
  it("lists existing API keys for the org (metadata only, no secrets)", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/api-keys`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].id).toBe("apikey_existing");
    expect(body.keys[0].name).toBe("Existing key");
    // Metadata only — Clerk never returns the raw secret after creation.
    expect(body.keys[0]).not.toHaveProperty("secret");
  });
});

describe("routes/dashboard — DELETE /api/dashboard/api-keys/:id", () => {
  it("revokes an API key by id and returns 200 { ok: true }", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/api-keys/apikey_existing`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(revokedKeyIds.has("apikey_existing")).toBe(true);
  });
});

describe("routes/dashboard — Phase 2 stubs (501)", () => {
  it("GET /api/dashboard/jobs → 501", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/jobs`);
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error.code).toBe("not_implemented");
  });

  it("POST /api/dashboard/sources/sync → 501", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/sources/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(501);
  });

  it("GET /api/dashboard/billing → 501", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/billing`);
    expect(res.status).toBe(501);
  });
});

describe("routes/dashboard — core OperationError → api OperationError mapping", () => {
  it("maps a core OperationError to the unified error shape (not a 500)", async () => {
    // dispatch('search', {}) throws a CORE OperationError (invalid_params).
    // Without the toApiError adapter, errorHandler would not recognize it
    // (different class) and return a generic 500. A 400 here proves the
    // adapter converted core → api so statusForError() mapped the code.
    const res = await fetch(`${baseUrl}/api/dashboard/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_params");
    expect(body.error.message).toMatch(/search/i);
  });
});
