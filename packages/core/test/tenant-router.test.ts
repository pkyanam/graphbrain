// Tests for TenantRouter (packages/core/src/tenant.ts).
//
// Verifies cache hit/miss, LRU eviction, TTL expiry, health-check eviction,
// and invalidate(). No real HelixDB is required — the engine factory is
// overridden to inject stub engines with controllable health() responses.
// The encryption key is overridden so no env priming is needed.
//
// Follows the fetch-stub pattern from test/control/coolify.test.ts for the
// health-check path (the stub engine's health() pings the real fetch, which
// is stubbed to return canned /health responses).

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { encrypt, decrypt } from "../src/control/encryption.ts";
import { TenantRouter } from "../src/tenant.ts";
import type { BrainEngine } from "../src/engine.ts";
import type { Tenant } from "../src/types.ts";

// ─── Test encryption key ─────────────────────────────────────────────────────
// A deterministic 32-byte key (base64) so encrypt/decrypt round-trips in tests
// without priming env. The TenantRouter is constructed with encryptionKey
// override so it never reads getConfig().

const TEST_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

/** Build a tenant row with an encrypted API key for the given URL. */
function makeTenant(id: string, url: string, apiKey = "key-" + id): Tenant {
  return {
    id,
    clerkOrgId: "org_" + id,
    name: id,
    slug: id,
    helixInstanceUrl: url,
    helixApiKeyEncrypted: encrypt(apiKey, TEST_KEY),
    coolifyAppId: null,
    tier: "free",
    status: "active",
    settings: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** A tenant with no provisioned instance (null URL + key). */
function makeUnprovisionedTenant(id: string): Tenant {
  return {
    ...makeTenant(id, "http://unused"),
    helixInstanceUrl: null,
    helixApiKeyEncrypted: null,
  };
}

// ─── Stub engine ─────────────────────────────────────────────────────────────

/** A stub BrainEngine with controllable health() + close() spy counters. */
class StubEngine implements BrainEngine {
  readonly kind = "helix" as const;
  healthCalls = 0;
  closeCalls = 0;
  constructedAt: number;
  url: string;
  apiKey: string;

  constructor(opts: { url: string; apiKey: string }) {
    this.url = opts.url;
    this.apiKey = opts.apiKey;
    this.constructedAt = Date.now();
  }

  async health(): Promise<boolean> {
    this.healthCalls++;
    return this._healthy;
  }

  async close(): Promise<void> {
    this.closeCalls++;
  }

  // The interface methods — not exercised here; stubbed as throwers.
  _throw = (): never => {
    throw new Error("StubEngine does not implement engine methods");
  };
  getPage = (): Promise<never> => Promise.reject(new Error("stub"));
  listPages = (): Promise<never[]> => Promise.resolve([]);
  putPage = (): Promise<never> => Promise.reject(new Error("stub"));
  softDeletePage = (): Promise<void> => Promise.resolve();
  addChunk = (): Promise<never> => Promise.reject(new Error("stub"));
  getChunksByPage = (): Promise<never[]> => Promise.resolve([]);
  updateChunkEmbedding = (): Promise<never> => Promise.reject(new Error("stub"));
  addEdge = (): Promise<never> => Promise.reject(new Error("stub"));
  getOutEdges = (): Promise<never[]> => Promise.resolve([]);
  getInEdges = (): Promise<never[]> => Promise.resolve([]);
  vectorSearchChunks = (): Promise<never[]> => Promise.resolve([]);
  textSearchPages = (): Promise<never[]> => Promise.resolve([]);
  textSearchChunks = (): Promise<never[]> => Promise.resolve([]);
  traverse = (): Promise<never[]> => Promise.resolve([]);
  addSource = (): Promise<never> => Promise.reject(new Error("stub"));
  getSource = (): Promise<null> => Promise.resolve(null);
  getSourceByName = (): Promise<null> => Promise.resolve(null);
  listSources = (): Promise<never[]> => Promise.resolve([]);

  // Controllable health flag.
  _healthy = true;
}

/** Track all constructed stub engines so tests can inspect them. */
let _constructed: StubEngine[] = [];
let _healthOverrides: Map<number, boolean> = new Map(); // by construction index

function makeFactory() {
  let index = 0;
  return (opts: { url: string; apiKey: string }): BrainEngine => {
    const stub = new StubEngine(opts);
    const myIndex = index++;
    stub._healthy = _healthOverrides.get(myIndex) ?? true;
    _constructed.push(stub);
    return stub;
  };
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  _constructed = [];
  _healthOverrides = new Map();
});

afterEach(async () => {
  // Nothing global to clean — each test constructs its own router.
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("TenantRouter — cache hit/miss", () => {
  it("constructs a new engine on cache miss", async () => {
    const router = new TenantRouter({
      encryptionKey: TEST_KEY,
      engineFactory: makeFactory(),
    });
    const tenant = makeTenant("t1", "http://h1:8080");
    const engine = await router.getEngine(tenant);
    expect(engine).toBeInstanceOf(StubEngine);
    expect(_constructed.length).toBe(1);
    expect(_constructed[0]!.url).toBe("http://h1:8080");
    // The decrypted API key is passed through.
    expect(_constructed[0]!.apiKey).toBe("key-t1");
    expect(router.size).toBe(1);
  });

  it("returns the cached engine on a hit (no new construction)", async () => {
    const router = new TenantRouter({
      encryptionKey: TEST_KEY,
      engineFactory: makeFactory(),
    });
    const tenant = makeTenant("t1", "http://h1:8080");
    const e1 = await router.getEngine(tenant);
    const e2 = await router.getEngine(tenant);
    expect(e1).toBe(e2);
    expect(_constructed.length).toBe(1);
    // Health was checked on the second call (before reuse).
    expect((e1 as StubEngine).healthCalls).toBeGreaterThanOrEqual(1);
  });

  it("constructs separate engines for different tenants", async () => {
    const router = new TenantRouter({
      encryptionKey: TEST_KEY,
      engineFactory: makeFactory(),
    });
    const e1 = await router.getEngine(makeTenant("t1", "http://h1:8080"));
    const e2 = await router.getEngine(makeTenant("t2", "http://h2:8080"));
    expect(e1).not.toBe(e2);
    expect(_constructed.length).toBe(2);
    expect(router.size).toBe(2);
  });
});

describe("TenantRouter — health-check eviction", () => {
  it("evicts + reconstructs when the cached engine is unhealthy", async () => {
    const router = new TenantRouter({
      encryptionKey: TEST_KEY,
      engineFactory: makeFactory(),
    });
    const tenant = makeTenant("t1", "http://h1:8080");
    const e1 = (await router.getEngine(tenant)) as StubEngine;
    expect(_constructed.length).toBe(1);

    // Make the cached engine report unhealthy on the next health check.
    e1._healthy = false;

    const e2 = (await router.getEngine(tenant)) as StubEngine;
    expect(e2).not.toBe(e1);
    expect(_constructed.length).toBe(2);
    // The old engine was closed on eviction.
    expect(e1.closeCalls).toBeGreaterThanOrEqual(1);
  });
});

describe("TenantRouter — TTL expiry", () => {
  it("reconstructs after the TTL expires", async () => {
    const router = new TenantRouter({
      ttlMs: 50, // 50ms TTL for fast testing
      encryptionKey: TEST_KEY,
      engineFactory: makeFactory(),
    });
    const tenant = makeTenant("t1", "http://h1:8080");
    const e1 = await router.getEngine(tenant);
    expect(_constructed.length).toBe(1);

    // Wait for the TTL to expire.
    await new Promise((r) => setTimeout(r, 80));

    const e2 = await router.getEngine(tenant);
    expect(e2).not.toBe(e1);
    expect(_constructed.length).toBe(2);
  });

  it("does NOT reconstruct before the TTL expires", async () => {
    const router = new TenantRouter({
      ttlMs: 5_000, // 5s — longer than the test
      encryptionKey: TEST_KEY,
      engineFactory: makeFactory(),
    });
    const tenant = makeTenant("t1", "http://h1:8080");
    const e1 = await router.getEngine(tenant);
    await new Promise((r) => setTimeout(r, 10));
    const e2 = await router.getEngine(tenant);
    expect(e2).toBe(e1);
    expect(_constructed.length).toBe(1);
  });
});

describe("TenantRouter — invalidate", () => {
  it("drops the cached engine so the next getEngine reconstructs", async () => {
    const router = new TenantRouter({
      encryptionKey: TEST_KEY,
      engineFactory: makeFactory(),
    });
    const tenant = makeTenant("t1", "http://h1:8080");
    const e1 = await router.getEngine(tenant);
    expect(router.size).toBe(1);

    await router.invalidate("t1");
    expect(router.size).toBe(0);
    expect((e1 as StubEngine).closeCalls).toBe(1);

    const e2 = await router.getEngine(tenant);
    expect(e2).not.toBe(e1);
    expect(_constructed.length).toBe(2);
  });

  it("invalidate is safe to call when no entry exists", async () => {
    const router = new TenantRouter({
      encryptionKey: TEST_KEY,
      engineFactory: makeFactory(),
    });
    await router.invalidate("never-cached");
    expect(router.size).toBe(0);
  });

  it("invalidate picks up a new URL on the next getEngine (reprovisioning)", async () => {
    const router = new TenantRouter({
      encryptionKey: TEST_KEY,
      engineFactory: makeFactory(),
    });
    const t1 = makeTenant("t1", "http://old:8080");
    await router.getEngine(t1);
    expect(_constructed[0]!.url).toBe("http://old:8080");

    await router.invalidate("t1");

    // The tenant row is updated with a new URL (simulating reprovisioning).
    const t1Updated = makeTenant("t1", "http://new:8080");
    await router.getEngine(t1Updated);
    expect(_constructed[1]!.url).toBe("http://new:8080");
  });
});

describe("TenantRouter — LRU eviction", () => {
  it("evicts the oldest entry when the cap is exceeded", async () => {
    const router = new TenantRouter({
      maxEntries: 2,
      encryptionKey: TEST_KEY,
      engineFactory: makeFactory(),
    });
    await router.getEngine(makeTenant("t1", "http://h1:8080"));
    await router.getEngine(makeTenant("t2", "http://h2:8080"));
    expect(router.size).toBe(2);

    // Adding a third evicts t1 (the oldest).
    await router.getEngine(makeTenant("t3", "http://h3:8080"));
    expect(router.size).toBe(2);

    // t1's engine was closed; t2 + t3 are still cached.
    expect(_constructed[0]!.closeCalls).toBeGreaterThanOrEqual(1);

    // Re-fetching t1 constructs a new engine (it was evicted).
    const e1again = await router.getEngine(makeTenant("t1", "http://h1:8080"));
    expect(_constructed.length).toBe(4); // t1, t2, t3, t1-again
    expect(e1again).not.toBe(_constructed[0]);
  });

  it("LRU touch moves an entry to the end (most-recently-used)", async () => {
    const router = new TenantRouter({
      maxEntries: 2,
      encryptionKey: TEST_KEY,
      engineFactory: makeFactory(),
    });
    await router.getEngine(makeTenant("t1", "http://h1:8080"));
    await router.getEngine(makeTenant("t2", "http://h2:8080"));

    // Touch t1 so it becomes most-recently-used.
    await router.getEngine(makeTenant("t1", "http://h1:8080"));

    // Adding t3 should now evict t2 (the oldest), not t1.
    await router.getEngine(makeTenant("t3", "http://h3:8080"));
    expect(_constructed[1]!.closeCalls).toBeGreaterThanOrEqual(1); // t2 evicted
    expect(_constructed[0]!.closeCalls).toBe(0); // t1 still alive
  });
});

describe("TenantRouter — unprovisioned tenant", () => {
  it("throws when the tenant has no helixInstanceUrl", async () => {
    const router = new TenantRouter({
      encryptionKey: TEST_KEY,
      engineFactory: makeFactory(),
    });
    const tenant = makeUnprovisionedTenant("t1");
    expect(router.getEngine(tenant)).rejects.toThrow(/no provisioned HelixDB instance/);
  });

  it("throws when the tenant has no helixApiKeyEncrypted", async () => {
    const router = new TenantRouter({
      encryptionKey: TEST_KEY,
      engineFactory: makeFactory(),
    });
    const tenant = makeTenant("t1", "http://h1:8080");
    tenant.helixApiKeyEncrypted = null;
    expect(router.getEngine(tenant)).rejects.toThrow(/no provisioned HelixDB instance/);
  });
});

describe("TenantRouter — encryption round-trip", () => {
  it("decrypts the tenant API key with the configured encryption key", async () => {
    const plaintext = "super-secret-key";
    const ciphertext = encrypt(plaintext, TEST_KEY);
    expect(decrypt(ciphertext, TEST_KEY)).toBe(plaintext);

    const router = new TenantRouter({
      encryptionKey: TEST_KEY,
      engineFactory: makeFactory(),
    });
    const tenant: Tenant = {
      ...makeTenant("t1", "http://h1:8080"),
      helixApiKeyEncrypted: ciphertext,
    };
    await router.getEngine(tenant);
    expect(_constructed[0]!.apiKey).toBe(plaintext);
  });

  it("throws on a wrong encryption key (auth-tag mismatch)", async () => {
    const wrongKey = Buffer.from(new Uint8Array(32).fill(99)).toString("base64");
    const router = new TenantRouter({
      encryptionKey: wrongKey,
      engineFactory: makeFactory(),
    });
    const tenant = makeTenant("t1", "http://h1:8080");
    expect(router.getEngine(tenant)).rejects.toThrow();
  });
});

describe("TenantRouter — clear", () => {
  it("drops all cached engines", async () => {
    const router = new TenantRouter({
      encryptionKey: TEST_KEY,
      engineFactory: makeFactory(),
    });
    await router.getEngine(makeTenant("t1", "http://h1:8080"));
    await router.getEngine(makeTenant("t2", "http://h2:8080"));
    expect(router.size).toBe(2);

    await router.clear();
    expect(router.size).toBe(0);
    expect(_constructed[0]!.closeCalls).toBeGreaterThanOrEqual(1);
    expect(_constructed[1]!.closeCalls).toBeGreaterThanOrEqual(1);
  });
});
