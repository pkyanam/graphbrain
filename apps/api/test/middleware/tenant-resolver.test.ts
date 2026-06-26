// Tests for the tenant resolver middleware (apps/api/src/middleware/tenant-resolver.ts),
// the context builder (context.ts), and the error handler (error-handler.ts).
//
// No Polygres, no Coolify, no real network: `TenantResolverDeps` is the
// injection seam — `getTenantByClerkOrg`, `decrypt`, and `getConfig` are
// mocked. The real `encrypt` from @graphbrain/core produces valid ciphertexts
// so the real `decrypt` (injected) round-trips in the happy-path tests.

import { describe, it, expect, beforeEach } from "bun:test";
import { encrypt, decrypt, type Tenant, type Config, type AuthInfo } from "@graphbrain/core";
import {
  tenantResolver,
  resolveTenant,
  resetTenantCache,
  type TenantResolverDeps,
} from "../../src/middleware/tenant-resolver";
import { contextBuilder, DEFAULT_SOURCE_ID } from "../../src/middleware/context";
import {
  errorHandler,
  OperationError,
  statusForError,
  unauthenticated,
  tenantNotFound,
  tenantNotActive,
} from "../../src/middleware/error-handler";
import {
  primeMwEnv,
  MW_ENV,
  TEST_ENCRYPTION_KEY,
  makeReq,
  makeRes,
  runMiddleware,
} from "./_helpers.ts";

// ─── Env ─────────────────────────────────────────────────────────────────────

primeMwEnv();

// ─── Tenant factory ──────────────────────────────────────────────────────────

function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: "t_1",
    clerkOrgId: "org_123",
    name: "Acme Corp",
    slug: "acme-corp",
    helixInstanceUrl: "https://helix.acme.test",
    helixApiKeyEncrypted: encrypt("helix-secret-xyz", TEST_ENCRYPTION_KEY),
    coolifyAppId: "app_1",
    tier: "free",
    status: "active",
    settings: {},
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-02T00:00:00Z"),
    ...overrides,
  };
}

/** A minimal Config stub — `resolveTenant` only reads `encryptionKey`. */
function testConfig(): Config {
  return { encryptionKey: TEST_ENCRYPTION_KEY } as Config;
}

/** Deps wired to the real `decrypt` + a mock tenant store + test config. */
function makeDeps(store: Map<string, Tenant | null>): TenantResolverDeps {
  return {
    getTenantByClerkOrg: async (orgId) => store.get(orgId) ?? null,
    // Use the real decrypt to round-trip the real encrypt-produced ciphertext.
    decrypt,
    getConfig: testConfig,
  };
}

// ─── Tests: resolveTenant core ───────────────────────────────────────────────

describe("middleware/tenant-resolver — resolveTenant", () => {
  beforeEach(() => resetTenantCache());

  it("resolves an active tenant and decrypts HelixDB creds", async () => {
    const store = new Map([["org_123", makeTenant()]]);
    const result = await resolveTenant("org_123", makeDeps(store));

    expect(result.tenant.id).toBe("t_1");
    expect(result.tenant.slug).toBe("acme-corp");
    expect(result.helixCreds.url).toBe("https://helix.acme.test");
    expect(result.helixCreds.apiKey).toBe("helix-secret-xyz");
  });

  it("throws tenant_not_found (403) when no tenant row exists", async () => {
    const store = new Map<string, Tenant | null>();
    await expect(resolveTenant("org_missing", makeDeps(store))).rejects.toMatchObject({
      code: "tenant_not_found",
      status: 403,
    });
  });

  it("throws tenant_not_active (503) when status is pending", async () => {
    const store = new Map([["org_123", makeTenant({ status: "pending" })]]);
    await expect(resolveTenant("org_123", makeDeps(store))).rejects.toMatchObject({
      code: "tenant_not_active",
      status: 503,
      retryAfterSeconds: 5,
    });
  });

  it("throws tenant_not_active (503) when status is suspended", async () => {
    const store = new Map([["org_123", makeTenant({ status: "suspended" })]]);
    await expect(resolveTenant("org_123", makeDeps(store))).rejects.toMatchObject({
      code: "tenant_not_active",
      status: 503,
    });
  });

  it("throws 503 when helixInstanceUrl is null (provisioning incomplete)", async () => {
    const store = new Map([
      ["org_123", makeTenant({ helixInstanceUrl: null })],
    ]);
    await expect(resolveTenant("org_123", makeDeps(store))).rejects.toMatchObject({
      code: "tenant_not_active",
      status: 503,
    });
  });

  it("throws 503 when helixApiKeyEncrypted is null", async () => {
    const store = new Map([
      ["org_123", makeTenant({ helixApiKeyEncrypted: null })],
    ]);
    await expect(resolveTenant("org_123", makeDeps(store))).rejects.toMatchObject({
      code: "tenant_not_active",
      status: 503,
    });
  });

  it("surfaces a decrypt failure as 500 (internal_error)", async () => {
    const store = new Map([["org_123", makeTenant()]]);
    const deps: TenantResolverDeps = {
      ...makeDeps(store),
      decrypt: () => {
        throw new Error("auth tag mismatch");
      },
    };
    await expect(resolveTenant("org_123", deps)).rejects.toMatchObject({
      code: "internal_error",
      status: 500,
    });
  });
});

// ─── Tests: 60s LRU cache ────────────────────────────────────────────────────

describe("middleware/tenant-resolver — 60s LRU cache", () => {
  let calls = 0;

  beforeEach(() => {
    resetTenantCache();
    calls = 0;
  });

  it("caches the tenant row so the second call skips the lookup", async () => {
    const store = new Map([["org_123", makeTenant()]]);
    const deps: TenantResolverDeps = {
      ...makeDeps(store),
      getTenantByClerkOrg: async (orgId) => {
        calls++;
        return store.get(orgId) ?? null;
      },
    };

    await resolveTenant("org_123", deps);
    await resolveTenant("org_123", deps);

    expect(calls).toBe(1);
  });

  it("does not cache a miss (not-found still hits the store each time)", async () => {
    const deps: TenantResolverDeps = {
      ...makeDeps(new Map()),
      getTenantByClerkOrg: async () => {
        calls++;
        return null;
      },
    };

    await expect(resolveTenant("org_missing", deps)).rejects.toThrow();
    await expect(resolveTenant("org_missing", deps)).rejects.toThrow();
    expect(calls).toBe(2);
  });

  it("serves a cached row even after the store is cleared", async () => {
    const store = new Map([["org_123", makeTenant()]]);
    const deps = makeDeps(store);

    await resolveTenant("org_123", deps);
    store.clear();
    const result = await resolveTenant("org_123", deps);

    expect(result.tenant.id).toBe("t_1");
  });
});

// ─── Tests: Express middleware wrapper ───────────────────────────────────────

describe("middleware/tenant-resolver — Express middleware", () => {
  beforeEach(() => resetTenantCache());

  it("attaches req.tenant + req.helixCreds for an active tenant", async () => {
    const store = new Map([["org_123", makeTenant()]]);
    const mw = tenantResolver(makeDeps(store));
    const auth: AuthInfo = {
      mode: "apikey",
      orgId: "org_123",
      orgSlug: "acme-corp",
      scopes: ["read"],
    };
    const req = { ...makeReq(), auth } as never;
    const res = makeRes();

    const err = await runMiddleware(mw, req, res);

    expect(err).toBeNull();
    expect(req.tenant!.id).toBe("t_1");
    expect(req.helixCreds!.apiKey).toBe("helix-secret-xyz");
    expect(req.helixCreds!.url).toBe("https://helix.acme.test");
  });

  it("calls next with a 403 OperationError when the tenant is missing", async () => {
    const mw = tenantResolver(makeDeps(new Map()));
    const auth: AuthInfo = {
      mode: "apikey",
      orgId: "org_missing",
      orgSlug: "x",
      scopes: [],
    };
    const req = { ...makeReq(), auth } as never;
    const res = makeRes();

    const err = await runMiddleware(mw, req, res);

    expect(err).toBeInstanceOf(OperationError);
    expect((err as OperationError).status).toBe(403);
    expect((err as OperationError).code).toBe("tenant_not_found");
  });

  it("calls next with a 503 OperationError when the tenant is not active", async () => {
    const store = new Map([["org_123", makeTenant({ status: "pending" })]]);
    const mw = tenantResolver(makeDeps(store));
    const auth: AuthInfo = {
      mode: "jwt",
      orgId: "org_123",
      orgSlug: "acme-corp",
      scopes: [],
    };
    const req = { ...makeReq(), auth } as never;
    const res = makeRes();

    const err = await runMiddleware(mw, req, res);

    expect(err).toBeInstanceOf(OperationError);
    expect((err as OperationError).status).toBe(503);
  });

  it("calls next with a 401 when req.auth is missing (clerkAuth didn't run)", async () => {
    const mw = tenantResolver(makeDeps(new Map()));
    const req = makeReq(); // no auth
    const res = makeRes();

    const err = await runMiddleware(mw, req, res);

    expect(err).toBeInstanceOf(OperationError);
    expect((err as OperationError).status).toBe(401);
  });
});

// ─── Tests: context builder ──────────────────────────────────────────────────

describe("middleware/context — contextBuilder", () => {
  it("builds req.context with remote:true and the default source id", async () => {
    const tenant = makeTenant();
    const auth: AuthInfo = {
      mode: "jwt",
      orgId: "org_123",
      orgSlug: "acme-corp",
      userId: "user_1",
      scopes: ["read"],
    };
    const req = { ...makeReq(), auth, tenant } as never;
    const res = makeRes();

    const err = await runMiddleware(contextBuilder, req, res);

    expect(err).toBeNull();
    expect(req.context).toBeDefined();
    expect(req.context!.tenant.id).toBe("t_1");
    expect(req.context!.auth.orgId).toBe("org_123");
    // Trust boundary: HTTP callers are ALWAYS remote.
    expect(req.context!.remote).toBe(true);
    expect(req.context!.sourceId).toBe(DEFAULT_SOURCE_ID);
    expect(DEFAULT_SOURCE_ID).toBe("default");
  });

  it("threads req.signal through to ctx.signal when present", async () => {
    const tenant = makeTenant();
    const auth: AuthInfo = {
      mode: "apikey",
      orgId: "org_123",
      orgSlug: "acme-corp",
      scopes: [],
    };
    const ac = new AbortController();
    const req = { ...makeReq(), auth, tenant, signal: ac.signal } as never;
    const res = makeRes();

    await runMiddleware(contextBuilder, req, res);

    expect(req.context!.signal).toBe(ac.signal);
  });

  it("calls next with 401 when req.auth is missing", async () => {
    const tenant = makeTenant();
    const req = { ...makeReq(), tenant } as never; // no auth
    const res = makeRes();

    const err = await runMiddleware(contextBuilder, req, res);

    expect(err).toBeInstanceOf(OperationError);
    expect((err as OperationError).status).toBe(401);
  });

  it("calls next with 401 when req.tenant is missing", async () => {
    const auth: AuthInfo = {
      mode: "apikey",
      orgId: "org_123",
      orgSlug: "acme-corp",
      scopes: [],
    };
    const req = { ...makeReq(), auth } as never; // no tenant
    const res = makeRes();

    const err = await runMiddleware(contextBuilder, req, res);

    expect(err).toBeInstanceOf(OperationError);
    expect((err as OperationError).status).toBe(401);
  });
});

// ─── Tests: error handler ────────────────────────────────────────────────────

describe("middleware/error-handler — errorHandler", () => {
  it("maps OperationError codes to HTTP statuses + emits the unified shape", () => {
    const cases: Array<{ err: OperationError; status: number }> = [
      { err: unauthenticated("no auth"), status: 401 },
      { err: tenantNotFound(), status: 403 },
      { err: new OperationError("permission_denied", "no"), status: 403 },
      { err: new OperationError("page_not_found", "no"), status: 404 },
      { err: new OperationError("invalid_params", "no"), status: 400 },
      { err: new OperationError("rate_limited", "no"), status: 429 },
      { err: new OperationError("tenant_not_active", "no"), status: 503 },
      { err: new OperationError("unknown_code", "no"), status: 500 },
    ];
    for (const { err, status } of cases) {
      expect(statusForError(err)).toBe(status);
    }
  });

  it("an explicit status override wins over the code map", () => {
    const err = new OperationError("weird", "x", { status: 418 });
    expect(statusForError(err)).toBe(418);
  });

  it("emits { error: { code, message, suggestion? } } and sets Retry-After for 503", () => {
    const res = makeRes();
    const err = tenantNotActive("pending", 10);
    errorHandler(err, makeReq(), res, (() => {}) as never);

    expect(res.__captured.status).toBe(503);
    expect(res.__captured.headers["Retry-After"]).toBe("10");
    const body = res.__captured.body as { error: { code: string; message: string; suggestion?: string } };
    expect(body.error.code).toBe("tenant_not_active");
    expect(body.error.message).toMatch(/pending/);
    expect(body.error.suggestion).toBeDefined();
  });

  it("includes suggestion in the body when present", () => {
    const res = makeRes();
    const err = unauthenticated("no header", "provide a Bearer token");
    errorHandler(err, makeReq(), res, (() => {}) as never);

    expect(res.__captured.status).toBe(401);
    const body = res.__captured.body as { error: { code: string; suggestion?: string } };
    expect(body.error.code).toBe("unauthenticated");
    expect(body.error.suggestion).toBe("provide a Bearer token");
  });

  it("maps a non-OperationError to 500 internal_error without leaking the message", () => {
    const res = makeRes();
    // Suppress the console.error the handler logs for unknown errors.
    const orig = console.error;
    console.error = () => {};
    try {
      errorHandler(new Error("DB connection exploded"), makeReq(), res, (() => {}) as never);
    } finally {
      console.error = orig;
    }
    expect(res.__captured.status).toBe(500);
    const body = res.__captured.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).not.toMatch(/DB connection exploded/);
  });
});
