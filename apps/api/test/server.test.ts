// Tests for the server lifecycle (apps/api/src/server.ts).
//
// Starts a real Express app on an ephemeral port, hits /api/health with
// `fetch` to confirm it's serving, then calls `close()` and asserts it
// resolves (graceful shutdown: stop listening, close the pool, run onClose).
// Signal handlers are disabled so the test process isn't killed.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createApp, startServer, type ServerHandle } from "../src/index";
import { primeMwEnv } from "./middleware/_helpers";

primeMwEnv();

describe("server — startServer + graceful shutdown", () => {
  let handle: ServerHandle;
  let port: number;
  let onCloseCalled: boolean;

  beforeAll(async () => {
    onCloseCalled = false;
    const app = createApp({
      authChain: [(_req, _res, next) => next()],
      deps: {
        router: { getEngine: async () => { throw new Error("no engine"); } },
        gateway: {} as never,
        embeddingService: {} as never,
      },
    });
    const started = await new Promise<{ handle: ServerHandle; port: number }>((resolve) => {
      const h = startServer(app, {
        port: 0,
        installSignalHandlers: false,
        onClose: () => {
          onCloseCalled = true;
        },
        onListening: ({ port }) => resolve({ handle: h, port }),
      });
    });
    handle = started.handle;
    port = started.port;
  });

  afterAll(async () => {
    if (handle) await handle.close();
  });

  it("serves /api/health on the listening port", async () => {
    const res = await fetch(`http://localhost:${port}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  it("close() resolves and runs the onClose hook", async () => {
    // Use a fresh server so the suite's afterAll close is separate.
    const app = createApp({
      authChain: [(_req, _res, next) => next()],
      deps: {
        router: { getEngine: async () => { throw new Error("no engine"); } },
        gateway: {} as never,
        embeddingService: {} as never,
      },
    });
    let closed = false;
    const started = await new Promise<{ handle: ServerHandle; port: number }>((resolve) => {
      const h = startServer(app, {
        port: 0,
        installSignalHandlers: false,
        onClose: () => {
          closed = true;
        },
        onListening: ({ port }) => resolve({ handle: h, port }),
      });
    });
    const localPort = started.port;

    // Confirm it's serving before shutdown.
    const res = await fetch(`http://localhost:${localPort}/api/health`);
    expect(res.status).toBe(200);

    await started.handle.close();

    // The onClose hook ran.
    expect(closed).toBe(true);

    // After close, the port no longer accepts connections (fetch rejects).
    let connectFailed = false;
    try {
      await fetch(`http://localhost:${localPort}/api/health`);
    } catch {
      connectFailed = true;
    }
    expect(connectFailed).toBe(true);
  });

  it("close() is idempotent (calling twice does not throw)", async () => {
    await handle.close();
    await expect(handle.close()).resolves.toBeUndefined();
  });
});
