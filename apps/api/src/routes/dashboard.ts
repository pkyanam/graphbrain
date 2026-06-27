// Dashboard REST API (Stage 12) — the browser-session (Clerk JWT) endpoints.
//
// All endpoints require `req.context` (set by the Stage 5 clerkAuth →
// tenantResolver → contextBuilder chain). The routes call `operations.dispatch`
// for the ops that map to the registry, and call engine methods directly for
// stats. Settings + API-key management hit the Stage 2/4 control plane.
//
// Endpoint table (PLAN.md lines 486–496):
//   GET    /api/dashboard/stats        — page/chunk counts + recent pages.
//   POST   /api/dashboard/search       — dispatch('search', body).
//   GET    /api/dashboard/pages        — dispatch('list_pages', query).
//   POST   /api/dashboard/pages        — dispatch('put_page', body).
//   GET    /api/dashboard/pages/:slug  — dispatch('get_page', { slug }).
//   GET    /api/dashboard/sources      — dispatch('list_sources', query).
//   GET    /api/dashboard/settings     — return tenant.settings.
//   PUT    /api/dashboard/settings     — merge + persist tenant.settings.
//   POST   /api/dashboard/api-keys     — issue a Clerk API key for the org.
//   GET    /api/dashboard/api-keys     — list org API keys (metadata only).
//   DELETE /api/dashboard/api-keys/:id — revoke an API key by id.
//   GET    /api/dashboard/jobs         — Phase 2 stub (501).
//   POST   /api/dashboard/sources/sync — Phase 2 stub (501).
//   GET    /api/dashboard/billing      — Phase 2 stub (501).
//
// Two OperationError classes (critical gotcha):
//   • core OperationError (from operations.dispatch) — has .code, .message,
//     .suggestion, NO .status.
//   • api OperationError (from the error-handler middleware) — has .code,
//     .message, .suggestion, .status.
// `dispatch()` throws the CORE class. The api errorHandler only recognizes
// the API class (instanceof check), so a core OperationError would fall
// through to a generic 500. `toApiError()` converts core → api so the
// errorHandler maps the code → HTTP status correctly.

import { Router, type Request, type Response, type NextFunction, type RequestHandler } from "express";
import {
  dispatch,
  OperationError as CoreOperationError,
  type DispatchDeps,
  type Tenant,
  type TenantSettings,
  type UpdateTenantPatch,
  type CreateApiKeyInput,
  type ClerkApiKey,
} from "@graphbrain/core";
import { OperationError } from "../middleware/error-handler";

// ─── Dependency injection ────────────────────────────────────────────────────

export interface DashboardDeps extends DispatchDeps {
  /** Update a tenant row. Defaults to the real `updateTenant` (lazy import). */
  updateTenant?: (id: string, patch: UpdateTenantPatch) => Promise<Tenant | null>;
  /** Issue a Clerk API key for an org. Defaults to the real `createApiKey`. */
  createApiKey?: (input: CreateApiKeyInput) => Promise<ClerkApiKey & { secret: string | null }>;
  /** List API keys for an org. Defaults to the real `listOrganizationApiKeys`. */
  listApiKeys?: (orgId: string) => Promise<ClerkApiKey[]>;
  /** Revoke an API key by id. Defaults to the real `revokeApiKey`. */
  revokeApiKey?: (orgId: string, keyId: string) => Promise<void>;
}

// ─── Error adapter ───────────────────────────────────────────────────────────

/**
 * Convert a core `OperationError` (thrown by `dispatch`) into the API
 * `OperationError` so the errorHandler middleware maps `.code` → HTTP status.
 * Non-OperationError throws pass through unchanged (errorHandler → 500).
 */
function toApiError(err: unknown): unknown {
  if (err instanceof CoreOperationError) {
    return new OperationError(err.code, err.message, {
      suggestion: err.suggestion,
      cause: err,
    });
  }
  return err;
}

/**
 * Wrap an async route handler so thrown errors are converted + forwarded to
 * the error middleware via `next(err)`. Without this, an async throw would
 * become an unhandled rejection (Express 5 does not catch them by default).
 */
function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => next(toApiError(err)));
  };
}

// ─── Router ──────────────────────────────────────────────────────────────────

/**
 * Build the dashboard router. Mount behind the auth + context middleware
 * (every handler reads `req.context`).
 *
 * @param deps  DispatchDeps + control-plane overrides (tests inject mocks).
 */
export function dashboardRouter(deps: DashboardDeps): Router {
  const router = Router();

  // GET /api/dashboard/stats — page count, chunk count, recent pages.
  router.get(
    "/api/dashboard/stats",
    asyncHandler(async (req, res) => {
      const ctx = req.context!;
      const engine = await deps.router.getEngine(ctx.tenant);
      const pages = await engine.listPages({ limit: 10 });
      // Chunk count: sum of chunks across the recent pages. Phase 1 stats —
      // a full COUNT(*) over chunks is a Phase 2 addition (HelixDB has no
      // cheap COUNT; we approximate from the recent-pages slice).
      let chunkCount = 0;
      for (const p of pages) {
        const chunks = await engine.getChunksByPage(p.slug);
        chunkCount += chunks.length;
      }
      res.json({
        pageCount: pages.length,
        chunkCount,
        recentPages: pages,
      });
    }),
  );

  // POST /api/dashboard/search — dispatch('search', body).
  router.post(
    "/api/dashboard/search",
    asyncHandler(async (req, res) => {
      const ctx = req.context!;
      const result = await dispatch("search", req.body ?? {}, ctx, deps);
      res.json(result);
    }),
  );

  // GET /api/dashboard/pages — dispatch('list_pages', query).
  router.get(
    "/api/dashboard/pages",
    asyncHandler(async (req, res) => {
      const ctx = req.context!;
      // Coerce query-string params to the shapes the Zod schema expects.
      const input: Record<string, unknown> = {};
      if (typeof req.query.type === "string") input.type = req.query.type;
      if (req.query.limit !== undefined) input.limit = Number(req.query.limit);
      if (req.query.offset !== undefined) input.offset = Number(req.query.offset);
      if (req.query.includeDeleted === "true") input.includeDeleted = true;
      const result = await dispatch("list_pages", input, ctx, deps);
      res.json(result);
    }),
  );

  // POST /api/dashboard/pages — dispatch('put_page', body).
  router.post(
    "/api/dashboard/pages",
    asyncHandler(async (req, res) => {
      const ctx = req.context!;
      const result = await dispatch("put_page", req.body ?? {}, ctx, deps);
      res.status(201).json(result);
    }),
  );

  // GET /api/dashboard/pages/:slug — dispatch('get_page', { slug }).
  // Returns { page, chunks, outEdges, inEdges }. 404 on page_not_found.
  router.get(
    "/api/dashboard/pages/:slug",
    asyncHandler(async (req, res) => {
      const ctx = req.context!;
      const result = await dispatch("get_page", { slug: req.params.slug }, ctx, deps);
      res.json(result);
    }),
  );

  // GET /api/dashboard/sources — dispatch('list_sources', query).
  router.get(
    "/api/dashboard/sources",
    asyncHandler(async (req, res) => {
      const ctx = req.context!;
      const input: Record<string, unknown> = {};
      if (req.query.includeArchived === "true") input.includeArchived = true;
      if (req.query.limit !== undefined) input.limit = Number(req.query.limit);
      if (req.query.offset !== undefined) input.offset = Number(req.query.offset);
      const result = await dispatch("list_sources", input, ctx, deps);
      res.json(result);
    }),
  );

  // GET /api/dashboard/settings — return the tenant's current settings.
  router.get("/api/dashboard/settings", (req, res) => {
    res.json({ settings: req.context!.tenant.settings });
  });

  // PUT /api/dashboard/settings — merge + persist settings.
  router.put(
    "/api/dashboard/settings",
    asyncHandler(async (req, res) => {
      const ctx = req.context!;
      const current: TenantSettings = ctx.tenant.settings ?? {};
      const incoming = (req.body ?? {}) as Partial<TenantSettings>;
      const merged: TenantSettings = { ...current, ...incoming };
      const updateTenantFn =
        deps.updateTenant ?? (await import("@graphbrain/core")).updateTenant;
      const updated = await updateTenantFn(ctx.tenant.id, { settings: merged });
      res.json({ settings: updated?.settings ?? merged });
    }),
  );

  // POST /api/dashboard/api-keys — issue a Clerk API key for the org.
  router.post(
    "/api/dashboard/api-keys",
    asyncHandler(async (req, res) => {
      const ctx = req.context!;
      const body = (req.body ?? {}) as { name?: string };
      const createApiKeyFn =
        deps.createApiKey ?? (await import("@graphbrain/core")).createApiKey;
      const key = await createApiKeyFn({
        name: body.name ?? "Graphbrain dashboard key",
        subject: ctx.auth.orgId,
        scopes: ["read", "write"],
      });
      // The raw secret is only returned once — Clerk does not store plaintext.
      res.status(201).json({
        id: key.id,
        name: key.name,
        scopes: key.scopes,
        // `secret` is null if Clerk did not return it (should not happen on
        // create, but we surface it rather than inventing a value).
        secret: key.secret,
      });
    }),
  );

  // GET /api/dashboard/api-keys — list existing API keys for the org.
  // Returns metadata only (Clerk never returns the raw secret after creation).
  router.get(
    "/api/dashboard/api-keys",
    asyncHandler(async (req, res) => {
      const ctx = req.context!;
      const listApiKeysFn =
        deps.listApiKeys ?? (await import("@graphbrain/core")).listOrganizationApiKeys;
      const keys = await listApiKeysFn(ctx.auth.orgId);
      res.json({ keys });
    }),
  );

  // DELETE /api/dashboard/api-keys/:id — revoke an API key by id.
  router.delete(
    "/api/dashboard/api-keys/:id",
    asyncHandler(async (req, res) => {
      const ctx = req.context!;
      const revokeApiKeyFn =
        deps.revokeApiKey ?? (await import("@graphbrain/core")).revokeApiKey;
      await revokeApiKeyFn(ctx.auth.orgId, String(req.params.id));
      res.json({ ok: true });
    }),
  );

  // ─── Phase 2 stubs ────────────────────────────────────────────────────────
  // The underlying systems (job queue, source sync, billing) are not built in
  // Phase 1. Return 501 so the dashboard can gate these UI sections.

  router.get("/api/dashboard/jobs", (_req, res) => {
    res.status(501).json({
      error: { code: "not_implemented", message: "Jobs API is Phase 2." },
    });
  });

  router.post("/api/dashboard/sources/sync", (_req, res) => {
    res.status(501).json({
      error: { code: "not_implemented", message: "Source sync is Phase 2." },
    });
  });

  router.get("/api/dashboard/billing", (_req, res) => {
    res.status(501).json({
      error: { code: "not_implemented", message: "Billing API is Phase 2." },
    });
  });

  return router;
}
