// Tests for the Coolify HTTP client (packages/core/src/control/coolify.ts) and
// the HelixDB provisioning orchestrator (packages/core/src/control/helix-provision.ts).
//
// Coolify is mocked by stubbing `globalThis.fetch` with a lightweight router
// that inspects the URL + method and returns canned `Response` objects. No
// real network and no real Coolify are required. Polygres is NOT required
// either — `provisionHelixForTenant` only touches the DB on the timeout path,
// and that call is best-effort (wrapped in try/catch), so a missing DB does
// not mask the timeout throw.
//
// Verifies:
//   - provisionHelixInstance sends the correct POST body (server_uuid, name,
//     ports_exposes, docker_compose with substitutions) and parses the response.
//   - buildHelixComposeYaml substitutes every placeholder and produces valid YAML.
//   - start/stop/delete/backup hit the correct endpoints with Bearer auth.
//   - getInstanceStatus maps Coolify status strings onto the four-state lifecycle.
//   - provisionHelixForTenant polls /health, returns on 200, and throws on timeout.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { parse as parseYaml } from "yaml";
import {
  primeEnv,
  POLYGRES_ENV,
} from "./_helpers.ts";
import {
  provisionHelixInstance,
  startInstance,
  stopInstance,
  deleteInstance,
  backupInstance,
  getInstanceStatus,
  buildHelixComposeYaml,
  provisionHelixForTenant,
  resetConfig,
  loadConfig,
} from "../../src/index.ts";
import type { Tenant } from "../../src/index.ts";

// ─── Env ─────────────────────────────────────────────────────────────────────

primeEnv();

const COOLIFY_ENV: Record<string, string> = {
  ...POLYGRES_ENV,
  // Distinct MinIO creds so we can assert they land in the compose YAML.
  MINIO_ENDPOINT: "https://storage.internal:9000",
  MINIO_ACCESS_KEY: "minio-access-test",
  MINIO_SECRET_KEY: "minio-secret-test",
};

function primeCoolifyEnv(): void {
  process.env = { ...COOLIFY_ENV };
  resetConfig();
  loadConfig(COOLIFY_ENV);
}

// ─── Fetch stub ──────────────────────────────────────────────────────────────

/** Captured request for assertions. */
interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A handler entry in the mock router. */
interface MockRoute {
  match: (req: CapturedRequest) => boolean;
  respond: (req: CapturedRequest) => {
    status?: number;
    body?: unknown;
  };
}

let _originalFetch: typeof globalThis.fetch;
let _captured: CapturedRequest[] = [];
let _routes: MockRoute[] = [];
let _healthResponses: number[] = []; // status codes returned in order for /health
let _defaultStatus: number = 200;

/** Install the fetch stub. Call in beforeAll. */
function installFetchStub(): void {
  _originalFetch = globalThis.fetch;
  _captured = [];
  _routes = [];
  _healthResponses = [];
  _defaultStatus = 200;
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
            ? rawHeaders as [string, string][]
            : Object.entries(rawHeaders as Record<string, string>);
      for (const [k, v] of entries) headers[k] = v;
    }
    const body = init?.body != null ? String(init.body) : undefined;
    const req: CapturedRequest = { url, method, headers, body };
    _captured.push(req);

    // /health polling endpoint (used by provisionHelixForTenant).
    if (url.endsWith("/health")) {
      const status = _healthResponses.length > 0 ? _healthResponses.shift()! : _defaultStatus;
      return new Response(null, { status });
    }

    for (const route of _routes) {
      if (route.match(req)) {
        const { status = 200, body } = route.respond(req);
        const text = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
        return new Response(text, {
          status,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ error: "no mock route" }), { status: 599 });
  }) as typeof globalThis.fetch;
}

/** Restore the real fetch. Call in afterAll. */
function restoreFetchStub(): void {
  globalThis.fetch = _originalFetch;
}

/** Register a mock route. */
function onRoute(match: MockRoute["match"], respond: MockRoute["respond"]): void {
  _routes.push({ match, respond });
}

/** Queue /health responses (consumed in order). */
function queueHealth(statuses: number[]): void {
  _healthResponses = statuses;
}

/** All requests captured since the last reset. */
function capturedRequests(): CapturedRequest[] {
  return _captured;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("control/coolify — buildHelixComposeYaml", () => {
  beforeAll(() => {
    primeCoolifyEnv();
  });

  it("substitutes tenant slug, api key, and MinIO creds from config", () => {
    const yaml = buildHelixComposeYaml("acme-corp", "hex-api-key-123");
    expect(yaml).toContain("HELIX_API_KEY=\"hex-api-key-123\"");
    expect(yaml).toContain("HELIX_S3_BUCKET=helix-acme-corp");
    expect(yaml).toContain("HELIX_S3_ENDPOINT=\"https://storage.internal:9000\"");
    expect(yaml).toContain("HELIX_S3_ACCESS_KEY=\"minio-access-test\"");
    expect(yaml).toContain("HELIX_S3_SECRET_KEY=\"minio-secret-test\"");
    expect(yaml).toContain("helix-acme-corp-data:/data");
    expect(yaml).toContain("volumes:\n  helix-acme-corp-data:");
  });

  it("leaves no unsubstituted placeholder", () => {
    const yaml = buildHelixComposeYaml("tenant-x", "key-x");
    expect(yaml).not.toMatch(/<[a-z-]+>/);
  });

  it("produces YAML that parses with the expected services.helixdb shape", () => {
    const yaml = buildHelixComposeYaml("parse-check", "k");
    const parsed = parseYaml(yaml) as Record<string, unknown>;
    expect(parsed.services).toBeDefined();
    const services = parsed.services as Record<string, unknown>;
    expect(services.helixdb).toBeDefined();
    const helixdb = services.helixdb as Record<string, unknown>;
    expect(helixdb.image).toBe("ghcr.io/helixdb/enterprise-dev:latest");
    const env = helixdb.environment as string[];
    expect(env.some((e) => e.includes("HELIX_API_KEY=\"k\""))).toBe(true);
  });
});

describe("control/coolify — provisionHelixInstance", () => {
  beforeAll(() => {
    primeCoolifyEnv();
    installFetchStub();
    onRoute(
      (req) => req.method === "POST" && req.url.endsWith("/api/v1/applications"),
      () => ({
        status: 201,
        body: { uuid: "app-uuid-123", fqdn: "https://helix-acme-corp.internal" },
      }),
    );
  });
  afterAll(() => {
    restoreFetchStub();
  });
  beforeEach(() => {
    _captured = [];
  });

  it("POSTs the correct body and returns { appId, url, apiKey }", async () => {
    const result = await provisionHelixInstance("acme-corp", "the-api-key");
    expect(result.appId).toBe("app-uuid-123");
    expect(result.url).toBe("https://helix-acme-corp.internal");
    expect(result.apiKey).toBe("the-api-key");

    const req = capturedRequests()[0]!;
    expect(req.method).toBe("POST");
    expect(req.headers.Authorization).toBe("Bearer tok_test");
    expect(req.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(req.body!) as Record<string, unknown>;
    expect(body.server_uuid).toBe("srv_abc");
    expect(body.name).toBe("helix-acme-corp");
    expect(body.ports_exposes).toBe("8080");
    const compose = body.docker_compose as string;
    expect(compose).toContain("HELIX_API_KEY=\"the-api-key\"");
    expect(compose).toContain("helix-acme-corp-data:/data");
  });

  it("falls back to the internal routing convention when no fqdn is returned", async () => {
    // Override the route for this test to omit fqdn.
    _routes = [];
    onRoute(
      (req) => req.method === "POST" && req.url.endsWith("/api/v1/applications"),
      () => ({ status: 201, body: { uuid: "app-no-fqdn" } }),
    );
    const result = await provisionHelixInstance("no-fqdn-tenant", "k");
    expect(result.appId).toBe("app-no-fqdn");
    expect(result.url).toBe("https://helix-no-fqdn-tenant.internal");
  });

  it("throws on a non-2xx Coolify response", async () => {
    _routes = [];
    onRoute(
      (req) => req.method === "POST" && req.url.endsWith("/api/v1/applications"),
      () => ({ status: 500, body: { error: "boom" } }),
    );
    await expect(provisionHelixInstance("err-tenant", "k")).rejects.toThrow(
      /provisionHelixInstance.*500/,
    );
  });
});

describe("control/coolify — lifecycle endpoints", () => {
  beforeAll(() => {
    primeCoolifyEnv();
    installFetchStub();
  });
  afterAll(() => {
    restoreFetchStub();
  });
  beforeEach(() => {
    _captured = [];
    _routes = [];
    onRoute(
      (req) => req.method === "GET" && /\/api\/v1\/applications\/[^/]+$/.test(req.url),
      (req) => {
        const status = req.url.endsWith("/app-running") ? "running" : "stopped";
        return { status: 200, body: { uuid: "x", status } };
      },
    );
    onRoute(
      (req) => req.method === "POST" && /\/api\/v1\/applications\/[^/]+\/(start|stop|backup)$/.test(req.url),
      () => ({ status: 200, body: {} }),
    );
    onRoute(
      (req) => req.method === "DELETE" && /\/api\/v1\/applications\/[^/]+$/.test(req.url),
      () => ({ status: 200, body: {} }),
    );
  });

  it("startInstance POSTs to /start with Bearer auth", async () => {
    await startInstance("app-1");
    const req = capturedRequests()[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toContain("/api/v1/applications/app-1/start");
    expect(req.headers.Authorization).toBe("Bearer tok_test");
  });

  it("stopInstance POSTs to /stop", async () => {
    await stopInstance("app-2");
    const req = capturedRequests()[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toContain("/api/v1/applications/app-2/stop");
  });

  it("backupInstance POSTs to /backup", async () => {
    await backupInstance("app-3");
    const req = capturedRequests()[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toContain("/api/v1/applications/app-3/backup");
  });

  it("deleteInstance DELETEs the application (idempotent on 404)", async () => {
    await deleteInstance("app-4");
    const req = capturedRequests()[0]!;
    expect(req.method).toBe("DELETE");
    expect(req.url).toContain("/api/v1/applications/app-4");
  });

  it("deleteInstance treats 404 as success", async () => {
    _routes = [];
    onRoute(
      (req) => req.method === "DELETE" && /\/api\/v1\/applications\/[^/]+$/.test(req.url),
      () => ({ status: 404, body: { error: "not found" } }),
    );
    await expect(deleteInstance("gone-app")).resolves.toBeUndefined();
  });

  it("getInstanceStatus maps Coolify statuses onto the four-state lifecycle", async () => {
    expect(await getInstanceStatus("app-running")).toBe("running");
    expect(await getInstanceStatus("app-stopped")).toBe("stopped");
  });

  it("lifecycle actions throw on non-2xx", async () => {
    _routes = [];
    onRoute(
      (req) => req.method === "POST" && req.url.includes("/start"),
      () => ({ status: 500, body: { error: "nope" } }),
    );
    await expect(startInstance("app-bad")).rejects.toThrow(/startInstance.*500/);
  });
});

describe("control/coolify — status mapping", () => {
  beforeAll(() => {
    primeCoolifyEnv();
    installFetchStub();
  });
  afterAll(() => {
    restoreFetchStub();
  });

  const cases: Array<[string, "running" | "stopped" | "pending" | "error"]> = [
    ["running", "running"],
    ["online", "running"],
    ["healthy", "running"],
    ["stopped", "stopped"],
    ["exited", "stopped"],
    ["paused", "stopped"],
    ["starting", "pending"],
    ["deploying", "pending"],
    ["restarting", "pending"],
    ["creating", "pending"],
    ["building", "pending"],
    ["some-unknown-status", "error"],
  ];

  for (const [coolifyStatus, expected] of cases) {
    it(`maps Coolify status "${coolifyStatus}" → "${expected}"`, async () => {
      _routes = [];
      onRoute(
        (req) => req.method === "GET" && /\/api\/v1\/applications\/[^/]+$/.test(req.url),
        () => ({ status: 200, body: { uuid: "x", status: coolifyStatus } }),
      );
      expect(await getInstanceStatus("app-x")).toBe(expected);
    });
  }
});

describe("control/helix-provision — provisionHelixForTenant", () => {
  beforeAll(() => {
    primeCoolifyEnv();
    installFetchStub();
    onRoute(
      (req) => req.method === "POST" && req.url.endsWith("/api/v1/applications"),
      () => ({
        status: 201,
        body: { uuid: "provision-app-1", fqdn: "https://helix-test.internal" },
      }),
    );
    // Stage 6 wiring: provisionHelixForTenant now calls deploySchema(client)
    // after the /health poll passes, which POSTs a dynamic query to /v1/query.
    // Mock it as a successful empty write-batch response (one var per index).
    onRoute(
      (req) => req.method === "POST" && req.url.endsWith("/v1/query"),
      () => ({ status: 200, body: {} }),
    );
  });
  afterAll(() => {
    restoreFetchStub();
  });
  beforeEach(() => {
    _captured = [];
    _healthResponses = [];
  });

  /** Minimal Tenant satisfying the fields provisionHelixForTenant reads. */
  function makeTenant(slug: string): Tenant {
    return {
      id: "00000000-0000-0000-0000-000000000000",
      clerkOrgId: "org_test",
      name: "Test",
      slug,
      helixInstanceUrl: null,
      helixApiKeyEncrypted: null,
      coolifyAppId: null,
      tier: "free",
      status: "pending",
      settings: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Tenant;
  }

  it("provisions, polls /health, and returns { url, apiKey, appId } on 200", async () => {
    // First two health polls return 503 (still starting), third returns 200.
    queueHealth([503, 503, 200]);
    const result = await provisionHelixForTenant(makeTenant("test"), {
      pollIntervalMs: 5,
      timeoutMs: 5_000,
    });
    expect(result.url).toBe("https://helix-test.internal");
    expect(result.appId).toBe("provision-app-1");
    expect(result.apiKey).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex
    // At least three health polls happened.
    const healthCalls = capturedRequests().filter((r) => r.url.endsWith("/health"));
    expect(healthCalls.length).toBeGreaterThanOrEqual(3);
  });

  it("returns on the first healthy poll (no unnecessary waiting)", async () => {
    queueHealth([200]);
    const result = await provisionHelixForTenant(makeTenant("fast"), {
      pollIntervalMs: 5,
      timeoutMs: 5_000,
    });
    expect(result.url).toBe("https://helix-test.internal");
    const healthCalls = capturedRequests().filter((r) => r.url.endsWith("/health"));
    expect(healthCalls.length).toBe(1);
  });

  it("throws when the instance does not become healthy within the timeout", async () => {
    // Always return 503 — never healthy.
    queueHealth([]);
    _defaultStatus = 503;
    try {
      await expect(
        provisionHelixForTenant(makeTenant("timeout-tenant"), {
          pollIntervalMs: 5,
          timeoutMs: 30,
        }),
      ).rejects.toThrow(/did not become healthy/);
    } finally {
      _defaultStatus = 200;
    }
  });
});
