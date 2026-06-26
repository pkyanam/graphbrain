// Context builder middleware — assembles a fully populated `OperationContext`
// on `req.context` from the auth + tenant fields set by the upstream
// middleware.
//
// Trust boundary (critical, ported from GBrain CLAUDE.md / PLAN.md):
//   HTTP callers are ALWAYS `remote: true`. The MCP/HTTP transport is
//   untrusted; only the local CLI admin path (Stage 12 internal admin routes,
//   if any) may set `remote: false`. Fail-closed: anything not strictly
//   `false` is treated as remote/untrusted. This middleware hard-codes
//   `remote: true` — there is no override at this layer.
//
// `sourceId` defaults to `"default"` for Phase 1 (single-source per tenant).
// Phase 2 introduces federated reads via `auth.allowedSources`; the seam is
// preserved on `OperationContext.sourceId`.
//
// `signal` is taken from `req` if Express has attached one (Express 5 does not
// wire an AbortSignal by default; route handlers may set `req.signal` for
// cooperative cancellation — e.g. tied to the response close event in Stage 12).

import type { Request, Response, NextFunction } from "express";
import type { OperationContext } from "@graphbrain/core";
import { unauthenticated } from "./error-handler";

/** Phase 1 default source id (single brain per tenant). */
const DEFAULT_SOURCE_ID = "default";

/**
 * Express 5 middleware. Requires `req.auth` + `req.tenant` (set by clerkAuth +
 * tenantResolver). Builds `req.context` (OperationContext) and calls `next()`.
 *
 * On missing prerequisites → 401 (the upstream middleware should have already
 * responded, but this guards against misordered mounting).
 */
export function contextBuilder(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth || !req.tenant) {
    next(
      unauthenticated(
        "contextBuilder requires req.auth + req.tenant — mount clerkAuth and tenantResolver first.",
      ),
    );
    return;
  }

  const ctx: OperationContext = {
    tenant: req.tenant,
    auth: req.auth,
    // HTTP callers are always untrusted (fail-closed trust boundary).
    remote: true,
    sourceId: DEFAULT_SOURCE_ID,
    // Optional AbortSignal — route handlers may set `req.signal` (e.g. tied to
    // the response close event). Undefined is fine; handlers must null-check.
    signal: (req as Request & { signal?: AbortSignal }).signal,
  };

  req.context = ctx;
  next();
}

export { DEFAULT_SOURCE_ID };
