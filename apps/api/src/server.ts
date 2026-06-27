// Server lifecycle (Stage 12) — listen + graceful shutdown.
//
// `startServer(app, opts?)` binds the Express app to `PORT` (env, default
// 3000), wires SIGTERM/SIGINT handlers, and returns a `{ close }` handle for
// testability. Graceful shutdown:
//   1. Stop accepting new connections (`server.close()`).
//   2. Drain in-flight requests (10s timeout — connections that don't finish
//      are force-closed).
//   3. Close the Polygres pool (`resetPool()`).
//   4. Close cached Helix engines (best-effort — `router.clear()` if the
//      router is a TenantRouter).
//   5. Exit (only when the server was started as the process entry point).
//
// The `onClose` hook lets the app pass in its cleanup (router.clear) without
// server.ts depending on the router type directly.

import type { Express } from "express";
import type { Server } from "node:http";
import { resetPool } from "@graphbrain/core";

export interface StartServerOptions {
  /** Port to listen on. Defaults to `process.env.API_PORT` or 3000. */
  port?: number;
  /** Host to bind. Defaults to `0.0.0.0` (all interfaces). */
  host?: string;
  /** Drain timeout in ms (default 10_000). In-flight requests past this are
   *  force-closed. */
  drainTimeoutMs?: number;
  /** Optional cleanup hook run after the pool is closed (e.g. router.clear()). */
  onClose?: () => Promise<void> | void;
  /** When true (default), wire SIGTERM/SIGINT handlers. Tests pass false to
   *  avoid the process exiting mid-suite. */
  installSignalHandlers?: boolean;
  /** Called once the server is listening. */
  onListening?: (addr: { host: string; port: number }) => void;
}

export interface ServerHandle {
  /** The underlying http.Server (for tests that need to inspect connections). */
  server: Server;
  /** The resolved listen port (useful when port 0 was requested). */
  port: number;
  /** The resolved host. */
  host: string;
  /** Manually trigger graceful shutdown (the same path SIGTERM takes). */
  close: () => Promise<void>;
}

/**
 * Start the API server. Returns a handle with a `close()` method for
 * testability. When run as the process entry point, SIGTERM/SIGINT trigger
 * `close()` + `process.exit(0)`.
 */
export function startServer(app: Express, opts: StartServerOptions = {}): ServerHandle {
  const port = opts.port ?? (Number(process.env.API_PORT) || 3000);
  const host = opts.host ?? "0.0.0.0";
  const drainTimeoutMs = opts.drainTimeoutMs ?? 10_000;
  const installSignalHandlers = opts.installSignalHandlers ?? true;

  const server = app.listen(port, host, () => {
    const addr = server.address();
    const actualPort =
      typeof addr === "object" && addr !== null ? addr.port : port;
    opts.onListening?.({ host, port: actualPort });
  });

  let shuttingDown = false;

  async function shutdown(): Promise<void> {
    if (shuttingDown) return; // idempotent
    shuttingDown = true;

    // 1. Stop accepting new connections.
    // 2. Force-close any connection still open after the drain timeout.
    const forceCloseTimer = setTimeout(() => {
      process.stderr.write(
        `[graphbrain-api] drain timeout (${drainTimeoutMs}ms) exceeded — force-closing connections.\n`,
      );
      server.closeAllConnections?.();
    }, drainTimeoutMs);

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    clearTimeout(forceCloseTimer);

    // 3. Close the Polygres pool.
    try {
      await resetPool();
    } catch (err) {
      process.stderr.write(
        `[graphbrain-api] error closing Polygres pool: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }

    // 4. Close cached Helix engines (best-effort).
    if (opts.onClose) {
      try {
        await opts.onClose();
      } catch (err) {
        process.stderr.write(
          `[graphbrain-api] error in onClose hook: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  if (installSignalHandlers) {
    const onSignal = (sig: string) => {
      process.stderr.write(`[graphbrain-api] received ${sig} — shutting down.\n`);
      shutdown()
        .then(() => process.exit(0))
        .catch((err) => {
          process.stderr.write(
            `[graphbrain-api] shutdown error: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exit(1);
        });
    };
    process.on("SIGTERM", () => onSignal("SIGTERM"));
    process.on("SIGINT", () => onSignal("SIGINT"));
  }

  return {
    server,
    port,
    host,
    close: shutdown,
  };
}
