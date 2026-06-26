// Tests for the Clerk Backend API client (packages/core/src/control/clerk.ts).
//
// Clerk's BAPI is mocked by stubbing `globalThis.fetch` with a lightweight
// router (same pattern as coolify.test.ts). No real network and no real Clerk
// are required. Polygres is NOT required either — clerk.ts never touches the
// control-plane DB.
//
// Verifies:
//   - getOrganization sends GET /organizations/{id} with Bearer auth + parses
//     { id, slug, name }.
//   - listOrganizationApiKeys sends GET /api_keys?subject=… and parses the
//     paginated { data } array into ClerkApiKey[].
//   - createApiKey sends POST /api_keys with the right body + returns the secret.
//   - revokeApiKey sends POST /api_keys/{id}/revoke.
//   - verifyApiKey sends POST /api_keys/verify, resolves org slug via a second
//     getOrganization call, and rejects user-scoped keys.
//   - getJwks fetches {issuer}/.well-known/jwks.json (no Bearer header), caches.
//   - All error paths throw on non-2xx Clerk responses.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import {
  primeEnv,
  POLYGRES_ENV,
} from "./_helpers.ts";
import {
  getOrganization,
  listOrganizationApiKeys,
  createApiKey,
  revokeApiKey,
  verifyApiKey,
  getJwks,
  resetJwksCache,
  resetConfig,
  loadConfig,
} from "../../src/index.ts";

// ─── Env ─────────────────────────────────────────────────────────────────────

primeEnv();

const CLERK_ENV: Record<string, string> = {
  ...POLYGRES_ENV,
  CLERK_SECRET_KEY: "sk_test_clerk_secret",
  CLERK_JWT_ISSUER: "https://clerk.acme.test",
  CLERK_API_URL: "https://api.clerk.test/v1",
};

function primeClerkEnv(): void {
  process.env = { ...CLERK_ENV };
  resetConfig();
  loadConfig(CLERK_ENV);
}

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
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
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
        const text = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("control/clerk — getOrganization", () => {
  beforeAll(() => {
    primeClerkEnv();
    installFetchStub();
    onRoute(
      (req) => req.method === "GET" && /\/organizations\/[^/]+$/.test(req.url),
      (req) => {
        const id = req.url.split("/organizations/")[1]!;
        return { status: 200, body: { id, slug: "acme-corp", name: "Acme Corp" } };
      },
    );
  });
  afterAll(() => restoreFetchStub());
  beforeEach(() => {
    _captured = [];
  });

  it("GETs /organizations/{id} with Bearer auth and returns { id, slug, name }", async () => {
    const org = await getOrganization("org_123");
    expect(org.id).toBe("org_123");
    expect(org.slug).toBe("acme-corp");
    expect(org.name).toBe("Acme Corp");

    const req = capturedRequests()[0]!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("https://api.clerk.test/v1/organizations/org_123");
    expect(req.headers.Authorization).toBe("Bearer sk_test_clerk_secret");
    expect(req.headers["Content-Type"]).toBe("application/json");
  });

  it("throws on a non-2xx Clerk response", async () => {
    _routes = [];
    onRoute(
      (req) => req.method === "GET" && /\/organizations\/[^/]+$/.test(req.url),
      () => ({ status: 404, body: { error: "not found" } }),
    );
    await expect(getOrganization("org_missing")).rejects.toThrow(/getOrganization.*404/);
  });

  it("throws when the response is missing id/slug/name", async () => {
    _routes = [];
    onRoute(
      (req) => req.method === "GET" && /\/organizations\/[^/]+$/.test(req.url),
      () => ({ status: 200, body: { id: "org_x" } }),
    );
    await expect(getOrganization("org_x")).rejects.toThrow(/missing id\/slug\/name/);
  });
});

describe("control/clerk — listOrganizationApiKeys", () => {
  beforeAll(() => {
    primeClerkEnv();
    installFetchStub();
    onRoute(
      (req) => req.method === "GET" && req.url.includes("/api_keys?subject="),
      () => ({
        status: 200,
        body: {
          data: [
            { id: "apikey_1", name: "Prod", subject: "org_123", scopes: ["read"], revoked: false, created_at: "t1", updated_at: "t2" },
            { id: "apikey_2", name: "Dev", subject: "org_123", scopes: [], revoked: true, created_at: "t3", updated_at: "t4" },
          ],
          total_count: 2,
        },
      }),
    );
  });
  afterAll(() => restoreFetchStub());
  beforeEach(() => {
    _captured = [];
  });

  it("GETs /api_keys?subject={orgId} and parses the data array", async () => {
    const keys = await listOrganizationApiKeys("org_123");
    expect(keys.length).toBe(2);
    expect(keys[0]!.id).toBe("apikey_1");
    expect(keys[0]!.subject).toBe("org_123");
    expect(keys[0]!.scopes).toEqual(["read"]);
    expect(keys[0]!.revoked).toBe(false);
    expect(keys[1]!.revoked).toBe(true);

    const req = capturedRequests()[0]!;
    expect(req.method).toBe("GET");
    expect(req.url).toContain("/api_keys?subject=org_123");
    expect(req.headers.Authorization).toBe("Bearer sk_test_clerk_secret");
  });

  it("returns an empty array when data is absent", async () => {
    _routes = [];
    onRoute(
      (req) => req.method === "GET" && req.url.includes("/api_keys?subject="),
      () => ({ status: 200, body: {} }),
    );
    const keys = await listOrganizationApiKeys("org_empty");
    expect(keys).toEqual([]);
  });

  it("throws on a non-2xx response", async () => {
    _routes = [];
    onRoute(
      (req) => req.method === "GET" && req.url.includes("/api_keys?subject="),
      () => ({ status: 403, body: { error: "forbidden" } }),
    );
    await expect(listOrganizationApiKeys("org_bad")).rejects.toThrow(/listOrganizationApiKeys.*403/);
  });
});

describe("control/clerk — createApiKey", () => {
  beforeAll(() => {
    primeClerkEnv();
    installFetchStub();
    onRoute(
      (req) => req.method === "POST" && req.url.endsWith("/api_keys"),
      (req) => {
        const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
        return {
          status: 201,
          body: {
            id: "apikey_new",
            name: body.name,
            subject: body.subject,
            scopes: body.scopes ?? [],
            revoked: false,
            created_at: "t1",
            updated_at: "t1",
            secret: "ak_live_secret_xyz",
          },
        };
      },
    );
  });
  afterAll(() => restoreFetchStub());
  beforeEach(() => {
    _captured = [];
  });

  it("POSTs the correct body and returns the key + raw secret", async () => {
    const result = await createApiKey({
      name: "My Key",
      subject: "org_123",
      scopes: ["read", "write"],
      secondsUntilExpiration: 3600,
    });
    expect(result.id).toBe("apikey_new");
    expect(result.name).toBe("My Key");
    expect(result.subject).toBe("org_123");
    expect(result.scopes).toEqual(["read", "write"]);
    expect(result.secret).toBe("ak_live_secret_xyz");

    const req = capturedRequests()[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://api.clerk.test/v1/api_keys");
    const body = JSON.parse(req.body!) as Record<string, unknown>;
    expect(body.name).toBe("My Key");
    expect(body.subject).toBe("org_123");
    expect(body.scopes).toEqual(["read", "write"]);
    expect(body.seconds_until_expiration).toBe(3600);
    expect(req.headers.Authorization).toBe("Bearer sk_test_clerk_secret");
  });

  it("throws on a non-2xx response", async () => {
    _routes = [];
    onRoute(
      (req) => req.method === "POST" && req.url.endsWith("/api_keys"),
      () => ({ status: 400, body: { error: "bad request" } }),
    );
    await expect(createApiKey({ name: "x", subject: "org_1" })).rejects.toThrow(/createApiKey.*400/);
  });
});

describe("control/clerk — revokeApiKey", () => {
  beforeAll(() => {
    primeClerkEnv();
    installFetchStub();
    onRoute(
      (req) => req.method === "POST" && /\/api_keys\/[^/]+\/revoke$/.test(req.url),
      () => ({ status: 200, body: { id: "apikey_1", revoked: true } }),
    );
  });
  afterAll(() => restoreFetchStub());
  beforeEach(() => {
    _captured = [];
  });

  it("POSTs to /api_keys/{keyId}/revoke with Bearer auth", async () => {
    await revokeApiKey("org_123", "apikey_1");
    const req = capturedRequests()[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://api.clerk.test/v1/api_keys/apikey_1/revoke");
    expect(req.headers.Authorization).toBe("Bearer sk_test_clerk_secret");
  });

  it("throws on a non-2xx response", async () => {
    _routes = [];
    onRoute(
      (req) => req.method === "POST" && /\/api_keys\/[^/]+\/revoke$/.test(req.url),
      () => ({ status: 404, body: { error: "not found" } }),
    );
    await expect(revokeApiKey("org_1", "apikey_gone")).rejects.toThrow(/revokeApiKey.*404/);
  });
});

describe("control/clerk — verifyApiKey", () => {
  beforeAll(() => {
    primeClerkEnv();
    installFetchStub();
    // verify endpoint
    onRoute(
      (req) => req.method === "POST" && req.url.endsWith("/api_keys/verify"),
      (req) => {
        const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
        const secret = body.secret as string;
        // "ak_valid" → org-scoped key; "ak_user" → user-scoped key; else invalid.
        if (secret === "ak_valid") {
          return {
            status: 200,
            body: { id: "apikey_1", name: "Agent", subject: "org_123", scopes: ["read"], revoked: false, created_at: "t1", updated_at: "t1" },
          };
        }
        if (secret === "ak_user") {
          return {
            status: 200,
            body: { id: "apikey_2", name: "UserKey", subject: "user_456", scopes: [], revoked: false, created_at: "t1", updated_at: "t1" },
          };
        }
        return { status: 400, body: { error: "invalid api key" } };
      },
    );
    // organization lookup (for slug resolution)
    onRoute(
      (req) => req.method === "GET" && /\/organizations\/[^/]+$/.test(req.url),
      (req) => {
        const id = req.url.split("/organizations/")[1]!;
        return { status: 200, body: { id, slug: "acme-corp", name: "Acme Corp" } };
      },
    );
  });
  afterAll(() => restoreFetchStub());
  beforeEach(() => {
    _captured = [];
  });

  it("verifies a valid org-scoped key and resolves { orgId, orgSlug, scopes, keyId }", async () => {
    const result = await verifyApiKey("ak_valid");
    expect(result.orgId).toBe("org_123");
    expect(result.orgSlug).toBe("acme-corp");
    expect(result.scopes).toEqual(["read"]);
    expect(result.keyId).toBe("apikey_1");

    // Two calls: verify + getOrganization.
    const reqs = capturedRequests();
    expect(reqs.length).toBe(2);
    expect(reqs[0]!.url).toContain("/api_keys/verify");
    expect(reqs[0]!.method).toBe("POST");
    const verifyBody = JSON.parse(reqs[0]!.body!) as Record<string, unknown>;
    expect(verifyBody.secret).toBe("ak_valid");
    expect(reqs[1]!.url).toContain("/organizations/org_123");
  });

  it("rejects a user-scoped API key (Graphbrain requires org keys)", async () => {
    await expect(verifyApiKey("ak_user")).rejects.toThrow(/not organization-scoped/);
  });

  it("throws on an invalid/revoked/expired key (non-2xx verify)", async () => {
    await expect(verifyApiKey("ak_bogus")).rejects.toThrow(/verifyApiKey.*400/);
  });
});

describe("control/clerk — getJwks", () => {
  beforeAll(() => {
    primeClerkEnv();
    resetJwksCache();
    installFetchStub();
    onRoute(
      (req) => req.method === "GET" && req.url.endsWith("/.well-known/jwks.json"),
      () => ({
        status: 200,
        body: {
          keys: [
            { kty: "RSA", kid: "kid1", alg: "RS256", use: "sig", n: "abc", e: "AQAB" },
          ],
        },
      }),
    );
  });
  afterAll(() => {
    restoreFetchStub();
    resetJwksCache();
  });
  beforeEach(() => {
    _captured = [];
    resetJwksCache();
  });
  afterEach(() => {
    resetJwksCache();
  });

  it("fetches {issuer}/.well-known/jwks.json WITHOUT a Bearer header", async () => {
    const jwks = await getJwks();
    expect(jwks.keys.length).toBe(1);
    expect(jwks.keys[0]!.kid).toBe("kid1");

    const req = capturedRequests()[0]!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("https://clerk.acme.test/.well-known/jwks.json");
    // JWKS is a public endpoint — no Authorization header.
    expect(req.headers.Authorization).toBeUndefined();
    expect(req.headers.Accept).toBe("application/json");
  });

  it("caches the JWKS so a second call does not hit the network", async () => {
    await getJwks();
    await getJwks();
    const reqs = capturedRequests().filter((r) => r.url.endsWith("/.well-known/jwks.json"));
    expect(reqs.length).toBe(1);
  });

  it("throws on a non-2xx response", async () => {
    _routes = [];
    onRoute(
      (req) => req.method === "GET" && req.url.endsWith("/.well-known/jwks.json"),
      () => ({ status: 500, body: { error: "boom" } }),
    );
    await expect(getJwks()).rejects.toThrow(/getJwks.*500/);
  });

  it("throws when the response is missing the keys array", async () => {
    _routes = [];
    onRoute(
      (req) => req.method === "GET" && req.url.endsWith("/.well-known/jwks.json"),
      () => ({ status: 200, body: {} }),
    );
    await expect(getJwks()).rejects.toThrow(/missing `keys` array/);
  });
});
