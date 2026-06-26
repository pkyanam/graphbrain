// Shared helpers for the Stage 5 middleware tests.
//
// Provides:
//   - A valid env dict + primer (so `getConfig()` works without a real .env).
//   - A `globalThis.fetch` stub router (same pattern as packages/core's
//     control-plane tests — no real network, no real Clerk).
//   - Minimal Express Request/Response/next stubs for driving middleware
//     without spinning up an HTTP server.

import type { Request, Response, NextFunction } from "express";
import { loadConfig, resetConfig } from "@graphbrain/core";

// ─── Env ─────────────────────────────────────────────────────────────────────

/** A deterministic base64 32-byte key (so decrypt works in tests). */
const TEST_KEY_BYTES = Buffer.alloc(32, 0x01);
export const TEST_ENCRYPTION_KEY = TEST_KEY_BYTES.toString("base64");

/**
 * Valid env dict for middleware tests. CLERK_JWT_ISSUER is a stable test
 * issuer; the JWT tests sign tokens with this same issuer.
 */
export const MW_ENV: Record<string, string> = {
  CLERK_SECRET_KEY: "sk_test_clerk_secret",
  CLERK_PUBLISHABLE_KEY: "pk_test_clerk",
  CLERK_JWT_ISSUER: "https://clerk.acme.test",
  CLERK_WEBHOOK_SECRET: "whsec_test",
  CLERK_API_URL: "https://api.clerk.test/v1",
  COOLIFY_API_URL: "https://coolify.acme.test",
  COOLIFY_API_TOKEN: "tok_test",
  COOLIFY_SERVER_UUID: "srv_abc",
  OPENROUTER_API_KEY: "or_test",
  ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
  POLYGRES_DATABASE_URL: "postgres://graphbrain:graphbrain@localhost:5432/graphbrain_control",
  MINIO_ENDPOINT: "http://localhost:9000",
  MINIO_ACCESS_KEY: "graphbrain",
  MINIO_SECRET_KEY: "graphbrain-dev-secret",
};

/** Prime `process.env` + the config singleton with the middleware env dict. */
export function primeMwEnv(env: Record<string, string> = MW_ENV): void {
  process.env = { ...env };
  resetConfig();
  loadConfig(env);
}

// ─── Fetch stub ──────────────────────────────────────────────────────────────

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface MockRoute {
  match: (req: CapturedRequest) => boolean;
  respond: (req: CapturedRequest) => { status?: number; body?: unknown };
}

let _originalFetch: typeof globalThis.fetch;
let _captured: CapturedRequest[] = [];
let _routes: MockRoute[] = [];

export function installFetchStub(): void {
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

export function restoreFetchStub(): void {
  globalThis.fetch = _originalFetch;
}

export function onRoute(match: MockRoute["match"], respond: MockRoute["respond"]): void {
  _routes.push({ match, respond });
}

export function resetRoutes(): void {
  _routes = [];
}

export function resetCaptured(): void {
  _captured = [];
}

export function capturedRequests(): CapturedRequest[] {
  return _captured;
}

// ─── Express stubs ───────────────────────────────────────────────────────────

/** A minimal Express Request stub. `headers` is the only field middleware reads. */
export function makeReq(headers: Record<string, string> = {}): Request {
  return {
    headers,
    // Middleware may read/write these; start undefined.
    auth: undefined,
    tenant: undefined,
    helixCreds: undefined,
    context: undefined,
  } as unknown as Request;
}

/** A minimal Express Response stub capturing status + body + headers. */
export interface CapturedResponse {
  status: number;
  body?: unknown;
  headers: Record<string, string>;
}

export function makeRes(): Response & { __captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 200, headers: {} };
  const res = {
    __captured: captured,
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
      return res;
    },
    getHeader(name: string) {
      return captured.headers[name];
    },
  } as unknown as Response & { __captured: CapturedResponse };
  return res;
}

/**
 * Run an Express middleware against stub req/res and resolve with the error
 * passed to `next` (or null if next was called with no args). Mirrors how
 * Express threads errors to the error handler.
 */
export function runMiddleware(
  mw: (req: Request, res: Response, next: NextFunction) => unknown,
  req: Request,
  res: Response,
): Promise<unknown> {
  return new Promise((resolve) => {
    const next = ((err?: unknown) => resolve(err ?? null)) as NextFunction;
    Promise.resolve(mw(req, res, next)).catch((err) => resolve(err));
  });
}
