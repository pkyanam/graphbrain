// Tests for the health + readiness endpoints (apps/api/src/routes/health.ts).
//
// Spins up a real Express app via `createApp()` with injected `healthDeps`
// (mocked isReachable / listTenants) so no real Polygres is needed. Hits the
// listening port with `fetch` and asserts the response shape + status.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createApp, startServer, type ServerHandle } from "../../src/index";
import { primeMwEnv } from "../middleware/_helpers";

primeMwEnv();

async function startTestApp(healthDeps: Parameters<typeof createApp>[0]["healthDeps"]) {
  const app = createApp({
    healthDeps,
    // No-op auth chain so the authenticated routes don't 401 the health
    // probes (health is public anyway, but the app still mounts the chain).
    authChain: [(_req, _res, next) => next()],
    deps: {
      router: { getEngine: async () => { throw new Error("no engine"); } },
      gateway: {} as never,
      embeddingService: {} as never,
    },
  });
  return new Promise<{ handle: ServerHandle; port: number }>((resolve) => {
    const handle = startServer(app, {
      port: 0,
      installSignalHandlers: false,
      onListening: ({ port }) => resolve({ handle, port }),
    });
  });
}

describe("routes/health — GET /api/health", () => {
  let handle: ServerHandle;
  let port: number;

  beforeAll(async () => {
    const started = await startTestApp({});
    handle = started.handle;
    port = started.port;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("returns 200 { status: 'ok' } (unauthenticated)", async () => {
    const res = await fetch(`http://localhost:${port}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });
});

describe("routes/health — GET /api/ready", () => {
  let handle: ServerHandle;
  let port: number;

  afterAll(async () => {
    if (handle) await handle.close();
  });

  it("returns 200 when Polygres is reachable (no active tenants)", async () => {
    const started = await startTestApp({
      isReachable: async () => true,
      listTenants: async () => [],
    });
    handle = started.handle;
    port = started.port;

    const res = await fetch(`http://localhost:${port}/api/ready`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.checks.polygres).toBe(true);
    expect(body.checks.engine).toBe(true);
  });

  it("returns 503 when Polygres is NOT reachable", async () => {
    const started = await startTestApp({
      isReachable: async () => false,
      listTenants: async () => [],
    });
    const localHandle = started.handle;
    const localPort = started.port;

    const res = await fetch(`http://localhost:${localPort}/api/ready`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("unhealthy");
    expect(body.checks.polygres).toBe(false);

    await localHandle.close();
  });

  it("returns 503 when an active tenant's engine is unhealthy", async () => {
    const started = await startTestApp({
      isReachable: async () => true,
      listTenants: async () => [
        {
          id: "t1",
          clerkOrgId: "org_1",
          name: "Acme",
          slug: "acme",
          helixInstanceUrl: "https://helix.test",
          helixApiKeyEncrypted: "enc",
          coolifyAppId: null,
          tier: "pro",
          status: "active",
          settings: {},
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      ],
      checkEngine: async () => false,
    });
    const localHandle = started.handle;
    const localPort = started.port;

    const res = await fetch(`http://localhost:${localPort}/api/ready`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("unhealthy");
    expect(body.checks.polygres).toBe(true);
    expect(body.checks.engine).toBe(false);

    await localHandle.close();
  });
});
