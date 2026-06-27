// Graphbrain API — Express 5 app assembly (Stage 12).
//
// Ties together the Stage 5 auth middleware, the Stage 11 MCP HTTP handler,
// the dashboard REST routes, Clerk webhooks, and health/readiness endpoints,
// with graceful shutdown.
//
// Middleware order (critical — from IMPLEMENTATION.md line 670 + Stage 5
// handoff line 327):
//   1. express.raw on /webhooks/*  — raw body for webhook signature verification
//      (BEFORE express.json so the raw bytes are available).
//   2. express.json()              — body parser for the rest.
//   3. health routes               — public, no auth (GET /api/health, /api/ready).
//   4. webhook routes              — public, webhook-secret auth (POST /webhooks/clerk).
//   5. clerkAuth                   — verifies req.auth.
//   6. tenantResolver()            — resolves req.tenant + req.helixCreds.
//   7. contextBuilder              — builds req.context (remote: true).
//   8. authenticated routes        — /mcp, /api/dashboard/*.
//   9. errorHandler (4-arg, last)  — unified error shape.
//
// App-wide singletons (TenantRouter + AIGateway + EmbeddingService) are
// constructed once in `createApp()` and shared across requests via
// `DispatchDeps`. Tests inject mocks via `AppOptions.deps` + `AppOptions.authChain`.

import express from "express";
import type { RequestHandler } from "express";
import {
  TenantRouter,
  AIGateway,
  EmbeddingService,
  OpenRouterProvider,
  getConfig,
  type DispatchDeps,
  type WebhookDeps,
} from "@graphbrain/core";

// Stage 5 middleware (the contract we mount).
import { clerkAuth } from "./middleware/clerk-auth";
import { tenantResolver } from "./middleware/tenant-resolver";
import { contextBuilder } from "./middleware/context";
import { errorHandler } from "./middleware/error-handler";

// Stage 12 routes.
import { healthRouter, type HealthDeps } from "./routes/health";
import { mcpRouter } from "./routes/mcp";
import { dashboardRouter, type DashboardDeps } from "./routes/dashboard";
import { clerkWebhookRouter } from "./routes/webhooks/clerk";

// Re-export Stage 5 middleware so existing imports + Stage 5 tests don't break.
export { clerkAuth, verifyJwt, verifyApiKeyToken, looksLikeJwt } from "./middleware/clerk-auth";
export {
  tenantResolver,
  resolveTenant,
  resetTenantCache,
} from "./middleware/tenant-resolver";
export type { TenantResolverDeps, ResolvedTenant } from "./middleware/tenant-resolver";
export { contextBuilder, DEFAULT_SOURCE_ID } from "./middleware/context";
export {
  errorHandler,
  OperationError,
  statusForError,
  unauthenticated,
  tenantNotFound,
  tenantNotActive,
} from "./middleware/error-handler";
export type { OperationErrorOptions } from "./middleware/error-handler";
export type { HelixCreds } from "./middleware/types";

// Server lifecycle (imported here so the entry-point block can call it, and
// re-exported so consumers can import it from the package root).
import { startServer } from "./server";
export type { ServerHandle, StartServerOptions } from "./server";
export { startServer } from "./server";
export { healthRouter } from "./routes/health";
export type { HealthDeps } from "./routes/health";
export { mcpRouter } from "./routes/mcp";
export { dashboardRouter } from "./routes/dashboard";
export type { DashboardDeps } from "./routes/dashboard";
export { clerkWebhookRouter } from "./routes/webhooks/clerk";

// ─── App options ─────────────────────────────────────────────────────────────

export interface AppOptions {
  /**
   * Override the DispatchDeps (router/gateway/embeddingService) + dashboard
   * control-plane overrides. Tests pass mocks; production omits this and
   * `createApp` constructs the real singletons from config.
   */
  deps?: DashboardDeps;
  /**
   * Override the auth/context middleware chain. When provided, this replaces
   * clerkAuth → tenantResolver → contextBuilder (tests inject a stub that
   * sets a fixed `req.context`). When omitted, the real Stage 5 chain runs.
   */
  authChain?: RequestHandler[];
  /** Webhook handler deps injection (tests). */
  webhookDeps?: WebhookDeps;
  /** Health/readiness deps injection (tests). */
  healthDeps?: HealthDeps;
}

// ─── Singleton construction ──────────────────────────────────────────────────

/**
 * Construct the app-wide singletons from config: TenantRouter + AIGateway +
 * EmbeddingService. Called once at app startup; the returned DispatchDeps is
 * shared across all requests.
 */
export function createDeps(): DispatchDeps & { router: TenantRouter } {
  const config = getConfig();
  const router = new TenantRouter({ encryptionKey: config.encryptionKey });
  const provider = new OpenRouterProvider({ apiKey: config.openrouterApiKey });
  const gateway = new AIGateway({ provider });
  const embeddingService = new EmbeddingService({ gateway });
  return { router, gateway, embeddingService };
}

// ─── App assembly ────────────────────────────────────────────────────────────

/**
 * Create the Express 5 app. Mounts middleware + routes in the documented order.
 *
 * @param opts  Optional overrides for tests (mock deps, stub auth chain).
 */
export function createApp(opts: AppOptions = {}): express.Express {
  const app = express();

  // 1. Raw body for webhooks (BEFORE express.json so the raw bytes survive).
  app.use(
    "/webhooks",
    express.raw({ type: "application/json", limit: "1mb" }),
  );

  // 2. JSON body parser for everything else.
  app.use(express.json({ limit: "2mb" }));

  // 3. Health routes (public, no auth).
  app.use(healthRouter(opts.healthDeps));

  // 4. Webhook routes (public, webhook-secret auth via handleClerkWebhook).
  app.use(clerkWebhookRouter({ webhookDeps: opts.webhookDeps }));

  // 5–7. Auth + tenant + context middleware.
  const authChain =
    opts.authChain ?? [clerkAuth, tenantResolver(), contextBuilder];
  for (const mw of authChain) app.use(mw);

  // 8. Authenticated routes.
  const deps = opts.deps ?? createDeps();
  app.use(mcpRouter(deps));
  app.use(dashboardRouter(deps));

  // 9. Error handler (4-arg, last).
  app.use(errorHandler);

  return app;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

// When run directly (`bun src/index.ts` / `bun --watch src/index.ts`), start
// the server. Importing the module (e.g. in tests) does NOT start it.
if (import.meta.main) {
  const deps = createDeps();
  const app = createApp({ deps });
  // Start the server, wiring graceful shutdown to close the router's cached
  // engines alongside the Polygres pool.
  startServer(app, {
    onClose: () => deps.router.clear(),
  });
}
