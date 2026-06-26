// Tests for the Clerk auth middleware (apps/api/src/middleware/clerk-auth.ts).
//
// Strategy: stub `globalThis.fetch` (same pattern as packages/core's
// control-plane tests) so `getJwks()` and `verifyApiKey()` run against a fake
// Clerk. For the JWT path, a real RSA key pair is generated with `jose` and a
// real signed JWT is produced, so `jose.jwtVerify` performs genuine signature
// verification — invalid/expired paths are exercised by tampering or expiring
// the token. No real network, no real Clerk, no Polygres.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { resetJwksCache } from "@graphbrain/core";
import { clerkAuth, looksLikeJwt } from "../../src/middleware/clerk-auth";
import { OperationError } from "../../src/middleware/error-handler";
import {
  primeMwEnv,
  MW_ENV,
  installFetchStub,
  restoreFetchStub,
  onRoute,
  resetRoutes,
  resetCaptured,
  capturedRequests,
  makeReq,
  makeRes,
  runMiddleware,
} from "./_helpers.ts";

// ─── Env ─────────────────────────────────────────────────────────────────────

primeMwEnv();
const ISSUER = MW_ENV.CLERK_JWT_ISSUER!;

// ─── JWT key material (generated once per suite) ─────────────────────────────

let _keyPair: { publicKey: CryptoKey; privateKey: CryptoKey };
let _jwk: { kid: string; kty: string; alg: string; use: string; n: string; e: string };

beforeAll(async () => {
  _keyPair = await generateKeyPair("RS256");
  const pubJwk = await exportJWK(_keyPair.publicKey);
  _jwk = {
    kid: "test-kid-1",
    kty: pubJwk.kty as string,
    alg: "RS256",
    use: "sig",
    n: pubJwk.n as string,
    e: pubJwk.e as string,
  };
});

// ─── JWT helpers ─────────────────────────────────────────────────────────────

interface SignOpts {
  orgId?: string;
  orgSlug?: string;
  sub?: string;
  scopes?: string[];
  issuer?: string;
  expired?: boolean;
  /** Override the signing key (use a different key to simulate a bad signature). */
  signWith?: CryptoKey;
}

async function signJwt(opts: SignOpts = {}): Promise<string> {
  const claims: Record<string, unknown> = {};
  if (opts.orgId !== undefined) claims.org_id = opts.orgId;
  if (opts.orgSlug !== undefined) claims.org_slug = opts.orgSlug;
  if (opts.scopes !== undefined) claims.scopes = opts.scopes;

  let builder = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: _jwk.kid })
    .setIssuer(opts.issuer ?? ISSUER)
    .setSubject(opts.sub ?? "user_test_123")
    .setIssuedAt();

  if (opts.expired) {
    builder = builder.setExpirationTime("0 seconds ago");
  } else {
    builder = builder.setExpirationTime("2 hours from now");
  }

  return builder.sign(opts.signWith ?? _keyPair.privateKey);
}

// ─── Fetch stub routes ───────────────────────────────────────────────────────

function installJwksRoute(): void {
  onRoute(
    (req) => req.method === "GET" && req.url.endsWith("/.well-known/jwks.json"),
    () => ({ status: 200, body: { keys: [_jwk] } }),
  );
}

function installApiKeyRoutes(): void {
  onRoute(
    (req) => req.method === "POST" && req.url.endsWith("/api_keys/verify"),
    (req) => {
      const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
      const secret = body.secret as string;
      if (secret === "ak_valid") {
        return {
          status: 200,
          body: {
            id: "apikey_1",
            name: "Agent",
            subject: "org_123",
            scopes: ["read", "write"],
            revoked: false,
            created_at: "t1",
            updated_at: "t1",
          },
        };
      }
      if (secret === "ak_user") {
        return {
          status: 200,
          body: {
            id: "apikey_2",
            name: "UserKey",
            subject: "user_456",
            scopes: [],
            revoked: false,
            created_at: "t1",
            updated_at: "t1",
          },
        };
      }
      return { status: 400, body: { error: "invalid api key" } };
    },
  );
  onRoute(
    (req) => req.method === "GET" && /\/organizations\/[^/]+$/.test(req.url),
    (req) => {
      const id = req.url.split("/organizations/")[1]!;
      return { status: 200, body: { id, slug: "acme-corp", name: "Acme Corp" } };
    },
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("middleware/clerk-auth — looksLikeJwt", () => {
  it("classifies 3-segment tokens as JWT", () => {
    expect(looksLikeJwt("aaa.bbb.ccc")).toBe(true);
  });
  it("classifies non-JWT tokens as API keys", () => {
    expect(looksLikeJwt("sk_live_abc123")).toBe(false);
    expect(looksLikeJwt("ak_xyz")).toBe(false);
    expect(looksLikeJwt("a.b")).toBe(false);
  });
});

describe("middleware/clerk-auth — JWT mode", () => {
  beforeAll(() => {
    primeMwEnv();
    installFetchStub();
    installJwksRoute();
  });
  afterAll(() => {
    restoreFetchStub();
    resetJwksCache();
  });
  beforeEach(() => {
    resetCaptured();
    resetJwksCache();
  });
  afterEach(() => {
    resetJwksCache();
  });

  it("verifies a valid signed JWT and sets req.auth (jwt mode)", async () => {
    const token = await signJwt({ orgId: "org_123", orgSlug: "acme-corp", scopes: ["read"] });
    const req = makeReq({ authorization: `Bearer ${token}` });
    const res = makeRes();

    const err = await runMiddleware(clerkAuth, req, res);

    expect(err).toBeNull();
    expect(req.auth).toBeDefined();
    expect(req.auth!.mode).toBe("jwt");
    expect(req.auth!.orgId).toBe("org_123");
    expect(req.auth!.orgSlug).toBe("acme-corp");
    expect(req.auth!.userId).toBe("user_test_123");
    expect(req.auth!.scopes).toEqual(["read"]);

    // JWKS was fetched without a Bearer header (public endpoint).
    const jwksReq = capturedRequests().find((r) =>
      r.url.endsWith("/.well-known/jwks.json"),
    )!;
    expect(jwksReq.headers.Authorization).toBeUndefined();
  });

  it("defaults orgSlug to '' and scopes to [] when claims are absent", async () => {
    const token = await signJwt({ orgId: "org_456" });
    const req = makeReq({ authorization: `Bearer ${token}` });
    const res = makeRes();

    const err = await runMiddleware(clerkAuth, req, res);

    expect(err).toBeNull();
    expect(req.auth!.orgId).toBe("org_456");
    expect(req.auth!.orgSlug).toBe("");
    expect(req.auth!.scopes).toEqual([]);
  });

  it("rejects a JWT signed with a different key (bad signature) → 401", async () => {
    const otherPair = await generateKeyPair("RS256");
    const token = await signJwt({ orgId: "org_123", signWith: otherPair.privateKey });
    const req = makeReq({ authorization: `Bearer ${token}` });
    const res = makeRes();

    const err = await runMiddleware(clerkAuth, req, res);

    expect(err).toBeInstanceOf(OperationError);
    expect((err as OperationError).status).toBe(401);
    expect((err as OperationError).code).toBe("unauthenticated");
  });

  it("rejects an expired JWT → 401", async () => {
    const token = await signJwt({ orgId: "org_123", expired: true });
    const req = makeReq({ authorization: `Bearer ${token}` });
    const res = makeRes();

    const err = await runMiddleware(clerkAuth, req, res);

    expect(err).toBeInstanceOf(OperationError);
    expect((err as OperationError).status).toBe(401);
  });

  it("rejects a JWT with the wrong issuer → 401", async () => {
    const token = await signJwt({ orgId: "org_123", issuer: "https://wrong.issuer.test" });
    const req = makeReq({ authorization: `Bearer ${token}` });
    const res = makeRes();

    const err = await runMiddleware(clerkAuth, req, res);

    expect(err).toBeInstanceOf(OperationError);
    expect((err as OperationError).status).toBe(401);
  });

  it("rejects a JWT missing the org_id claim → 401", async () => {
    const token = await signJwt({ orgId: undefined });
    const req = makeReq({ authorization: `Bearer ${token}` });
    const res = makeRes();

    const err = await runMiddleware(clerkAuth, req, res);

    expect(err).toBeInstanceOf(OperationError);
    expect((err as OperationError).status).toBe(401);
    expect((err as OperationError).message).toMatch(/org_id/);
  });

  it("rejects a JWT whose org_id is not org-scoped → 401", async () => {
    const token = await signJwt({ orgId: "not_an_org" });
    const req = makeReq({ authorization: `Bearer ${token}` });
    const res = makeRes();

    const err = await runMiddleware(clerkAuth, req, res);

    expect(err).toBeInstanceOf(OperationError);
    expect((err as OperationError).status).toBe(401);
  });

  it("surfaces a JWKS fetch failure as 401", async () => {
    resetRoutes();
    onRoute(
      (req) => req.method === "GET" && req.url.endsWith("/.well-known/jwks.json"),
      () => ({ status: 500, body: { error: "boom" } }),
    );
    const token = await signJwt({ orgId: "org_123" });
    const req = makeReq({ authorization: `Bearer ${token}` });
    const res = makeRes();

    const err = await runMiddleware(clerkAuth, req, res);

    expect(err).toBeInstanceOf(OperationError);
    expect((err as OperationError).status).toBe(401);
    expect((err as OperationError).message).toMatch(/JWKS/);
    // Restore the good route for subsequent tests.
    resetRoutes();
    installJwksRoute();
  });
});

describe("middleware/clerk-auth — API key mode", () => {
  beforeAll(() => {
    primeMwEnv();
    installFetchStub();
    installApiKeyRoutes();
  });
  afterAll(() => {
    restoreFetchStub();
    resetJwksCache();
  });
  beforeEach(() => {
    resetCaptured();
  });

  it("verifies a valid org-scoped API key and sets req.auth (apikey mode)", async () => {
    const req = makeReq({ authorization: "Bearer ak_valid" });
    const res = makeRes();

    const err = await runMiddleware(clerkAuth, req, res);

    expect(err).toBeNull();
    expect(req.auth).toBeDefined();
    expect(req.auth!.mode).toBe("apikey");
    expect(req.auth!.orgId).toBe("org_123");
    expect(req.auth!.orgSlug).toBe("acme-corp");
    expect(req.auth!.scopes).toEqual(["read", "write"]);
    expect(req.auth!.userId).toBeUndefined();
  });

  it("rejects a user-scoped API key → 401", async () => {
    const req = makeReq({ authorization: "Bearer ak_user" });
    const res = makeRes();

    const err = await runMiddleware(clerkAuth, req, res);

    expect(err).toBeInstanceOf(OperationError);
    expect((err as OperationError).status).toBe(401);
  });

  it("rejects an invalid API key → 401", async () => {
    const req = makeReq({ authorization: "Bearer ak_bogus" });
    const res = makeRes();

    const err = await runMiddleware(clerkAuth, req, res);

    expect(err).toBeInstanceOf(OperationError);
    expect((err as OperationError).status).toBe(401);
  });
});

describe("middleware/clerk-auth — missing / malformed header", () => {
  beforeAll(() => {
    primeMwEnv();
    installFetchStub();
  });
  afterAll(() => restoreFetchStub());

  it("rejects when the Authorization header is absent → 401", async () => {
    const req = makeReq({});
    const res = makeRes();
    const err = await runMiddleware(clerkAuth, req, res);
    expect(err).toBeInstanceOf(OperationError);
    expect((err as OperationError).status).toBe(401);
  });

  it("rejects when the Authorization header is not Bearer → 401", async () => {
    const req = makeReq({ authorization: "Basic abc123" });
    const res = makeRes();
    const err = await runMiddleware(clerkAuth, req, res);
    expect(err).toBeInstanceOf(OperationError);
    expect((err as OperationError).status).toBe(401);
  });

  it("rejects an empty bearer token → 401", async () => {
    const req = makeReq({ authorization: "Bearer " });
    const res = makeRes();
    const err = await runMiddleware(clerkAuth, req, res);
    expect(err).toBeInstanceOf(OperationError);
    expect((err as OperationError).status).toBe(401);
  });
});
