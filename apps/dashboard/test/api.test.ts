// API client tests (apps/dashboard/src/lib/api-core.ts).
//
// Mocks fetch (same pattern as apps/api/test/middleware/_helpers.ts's
// installFetchStub) + passes a fixed token getter to `createApiClient` (no
// need to mock @clerk/nextjs/server — the core module is token-injected).
// Asserts:
//   • The client attaches Authorization: Bearer <jwt> on every request.
//   • apiGet parses a 200 JSON response into the typed return.
//   • apiPost sends the JSON body + attaches the JWT.
//   • A 4xx/5xx response throws ApiError with the correct code, message,
//     suggestion, and status.
//   • A tenant_not_active (503) response throws ApiError with code
//     'tenant_not_active' (the onboarding flow branches on this).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import type { TokenGetter } from "../src/lib/api-core";

// Import the core client (client-safe — no server-only imports).
const {
  createApiClient,
  apiGet,
  apiPost,
  ApiError,
} = await import("../src/lib/api-core");

// ─── Fetch stub ──────────────────────────────────────────────────────────────

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface MockRoute {
  match: (req: CapturedRequest) => boolean;
  respond: (req: CapturedRequest) => { status?: number; body?: unknown };
}

let _originalFetch: typeof globalThis.fetch;
let _captured: CapturedRequest[] = [];
let _routes: MockRoute[] = [];

function installFetchStub(): void {
  _originalFetch = globalThis.fetch;
  _captured = [];
  _routes = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders) {
      const entries =
        rawHeaders instanceof Headers
          ? Array.from(rawHeaders.entries())
          : Array.isArray(rawHeaders)
            ? (rawHeaders as [string, string][])
            : Object.entries(rawHeaders as Record<string, string>);
      for (const [k, v] of entries) headers[k] = v;
    }
    const body = init?.body != null ? String(init.body) : undefined;
    const req: CapturedRequest = { url, method, headers, body };
    _captured.push(req);
    for (const route of _routes) {
      if (route.match(req)) {
        const { status = 200, body } = route.respond(req);
        const text =
          body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
        return new Response(text, { status, headers: { "Content-Type": "application/json" } });
      }
    }
    return new Response(JSON.stringify({ error: "no mock route" }), { status: 599 });
  }) as typeof globalThis.fetch;
}

function restoreFetchStub(): void {
  globalThis.fetch = _originalFetch;
}

function onRoute(match: MockRoute["match"], respond: MockRoute["respond"]): void {
  _routes.push({ match, respond });
}

function capturedRequests(): CapturedRequest[] {
  return _captured;
}

// ─── Setup ───────────────────────────────────────────────────────────────────

// Fixed token getter — stands in for Clerk's auth()/useAuth() getToken.
const testTokenGetter: TokenGetter = async () => "test-jwt";
const api = createApiClient(testTokenGetter);

beforeAll(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://api.test";
  installFetchStub();
});

afterAll(() => {
  restoreFetchStub();
});

beforeEach(() => {
  _captured = [];
  _routes = [];
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("api client — JWT attachment", () => {
  it("attaches Authorization: Bearer <jwt> on every GET request", async () => {
    onRoute(
      (r) => r.url.endsWith("/api/dashboard/stats"),
      () => ({ status: 200, body: { pageCount: 0, chunkCount: 0, recentPages: [] } }),
    );

    await api.stats();

    const reqs = capturedRequests();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.headers["Authorization"]).toBe("Bearer test-jwt");
  });

  it("attaches Authorization: Bearer <jwt> on POST requests", async () => {
    onRoute(
      (r) => r.url.endsWith("/api/dashboard/search") && r.method === "POST",
      () => ({ status: 200, body: { results: [], meta: { vectorEnabled: false, detailResolved: null, expansionApplied: false } } }),
    );

    await api.search({ query: "acme" });

    const reqs = capturedRequests();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.headers["Authorization"]).toBe("Bearer test-jwt");
  });
});

describe("api client — apiGet", () => {
  it("parses a 200 JSON response into the typed return", async () => {
    onRoute(
      (r) => r.url.endsWith("/api/dashboard/stats"),
      () => ({
        status: 200,
        body: { pageCount: 5, chunkCount: 12, recentPages: [{ id: "p1", slug: "acme" }] },
      }),
    );

    const result = await apiGet<{ pageCount: number; chunkCount: number }>("/api/dashboard/stats", testTokenGetter);
    expect(result.pageCount).toBe(5);
    expect(result.chunkCount).toBe(12);
  });
});

describe("api client — apiPost", () => {
  it("sends the JSON body + attaches the JWT", async () => {
    onRoute(
      (r) => r.url.endsWith("/api/dashboard/pages") && r.method === "POST",
      (r) => {
        const parsed = JSON.parse(r.body ?? "{}");
        return {
          status: 201,
          body: { page: { id: "p1", slug: parsed.slug }, chunks: [], embedded: 0 },
        };
      },
    );

    const result = await apiPost<{ page: { slug: string } }>("/api/dashboard/pages", {
      slug: "new-page",
      content: "hello",
    }, testTokenGetter);

    expect(result.page.slug).toBe("new-page");

    const reqs = capturedRequests();
    expect(reqs[0]!.method).toBe("POST");
    expect(reqs[0]!.headers["Content-Type"]).toBe("application/json");
    expect(reqs[0]!.headers["Authorization"]).toBe("Bearer test-jwt");
    const body = JSON.parse(reqs[0]!.body!);
    expect(body.slug).toBe("new-page");
    expect(body.content).toBe("hello");
  });
});

describe("api client — error handling", () => {
  it("throws ApiError with the correct code, message, suggestion, and status on a 4xx", async () => {
    onRoute(
      (r) => r.url.endsWith("/api/dashboard/pages/missing"),
      () => ({
        status: 404,
        body: {
          error: {
            code: "page_not_found",
            message: "Page not found: missing",
            suggestion: "Check the slug, or use list_pages to enumerate pages.",
          },
        },
      }),
    );

    try {
      await api.getPage("missing");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.code).toBe("page_not_found");
      expect(e.message).toBe("Page not found: missing");
      expect(e.suggestion).toBe("Check the slug, or use list_pages to enumerate pages.");
      expect(e.status).toBe(404);
    }
  });

  it("throws ApiError with code 'tenant_not_active' on a 503 (onboarding branches on this)", async () => {
    onRoute(
      (r) => r.url.endsWith("/api/dashboard/stats"),
      () => ({
        status: 503,
        body: {
          error: {
            code: "tenant_not_active",
            message: 'Tenant is not active (current status: "pending").',
            suggestion: "Retry after provisioning completes.",
          },
        },
      }),
    );

    try {
      await api.stats();
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.code).toBe("tenant_not_active");
      expect(e.status).toBe(503);
    }
  });

  it("throws ApiError with code 'unauthenticated' on a 401", async () => {
    onRoute(
      (r) => r.url.endsWith("/api/dashboard/settings"),
      () => ({
        status: 401,
        body: { error: { code: "unauthenticated", message: "Missing or invalid token." } },
      }),
    );

    try {
      await api.getSettings();
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.code).toBe("unauthenticated");
      expect(e.status).toBe(401);
    }
  });

  it("throws ApiError with a generic code on a non-JSON error response", async () => {
    onRoute(
      (r) => r.url.endsWith("/api/dashboard/stats"),
      () => ({ status: 500, body: "Internal Server Error" }),
    );

    try {
      await api.stats();
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.status).toBe(500);
      expect(e.code).toBe("internal_error");
    }
  });
});

describe("api client — typed surface", () => {
  it("listPages builds the query string from params", async () => {
    onRoute(
      (r) => r.url.includes("/api/dashboard/pages?"),
      () => ({ status: 200, body: { pages: [], count: 0, offset: 5 } }),
    );

    const result = await api.listPages({ type: "note", limit: 10, offset: 5 });
    expect(result.offset).toBe(5);

    const reqs = capturedRequests();
    expect(reqs[0]!.url).toContain("type=note");
    expect(reqs[0]!.url).toContain("limit=10");
    expect(reqs[0]!.url).toContain("offset=5");
  });

  it("createApiKey posts the name and returns the one-time secret", async () => {
    onRoute(
      (r) => r.url.endsWith("/api/dashboard/api-keys") && r.method === "POST",
      (r) => {
        const parsed = JSON.parse(r.body ?? "{}");
        return {
          status: 201,
          body: { id: "k1", name: parsed.name ?? "key", scopes: ["read", "write"], secret: "sk_live_xyz" },
        };
      },
    );

    const result = await api.createApiKey({ name: "My agent key" });
    expect(result.id).toBe("k1");
    expect(result.secret).toBe("sk_live_xyz");
    expect(result.scopes).toEqual(["read", "write"]);
  });

  it("revokeApiKey sends a DELETE to /api/dashboard/api-keys/:id", async () => {
    onRoute(
      (r) => r.url.endsWith("/api/dashboard/api-keys/k1") && r.method === "DELETE",
      () => ({ status: 200, body: { ok: true } }),
    );

    const result = await api.revokeApiKey("k1");
    expect(result.ok).toBe(true);

    const reqs = capturedRequests();
    expect(reqs[0]!.method).toBe("DELETE");
    expect(reqs[0]!.headers["Authorization"]).toBe("Bearer test-jwt");
  });
});
