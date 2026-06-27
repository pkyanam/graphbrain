// Health + readiness endpoints (Stage 12).
//
//   • GET /api/health — liveness probe. Unauthenticated, no middleware.
//     Always returns 200 `{ status: 'ok' }`. Used by Coolify health checks.
//   • GET /api/ready  — readiness probe. Unauthenticated. Checks Polygres
//     connectivity (isReachable) and, if there are active tenants, that at
//     least one tenant engine is reachable. Returns 200 `{ status: 'ok',
//     checks }` when all checks pass, 503 `{ status: 'unhealthy', checks }`
//     otherwise. Used by Kubernetes readiness gates.
//
// Both are mounted BEFORE the auth middleware chain (public routes). The
// readiness deps are injectable so tests can mock isReachable / listTenants
// without a real Polygres or provisioned engines.

import { Router } from "express";
import type { Tenant } from "@graphbrain/core";

/** Injectable deps for the readiness check. Defaults wire to the real modules. */
export interface HealthDeps {
  /** Probe Polygres connectivity. Defaults to the real `isReachable()`. */
  isReachable?: () => Promise<boolean>;
  /** List tenants (to find an active one to engine-health-check). Defaults to
   *  the real `listTenants()`. */
  listTenants?: () => Promise<Tenant[]>;
  /** Resolve a tenant → engine and health-check it. Defaults to a no-op pass
   *  when no router is available (the ready check degrades to polygres-only). */
  checkEngine?: (tenant: Tenant) => Promise<boolean>;
}

/**
 * Build the health/readiness router. Mount at the app root (the routes are
 * `/api/health` + `/api/ready`).
 */
export function healthRouter(deps: HealthDeps = {}): Router {
  const router = Router();

  router.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/api/ready", async (_req, res) => {
    const checks: Record<string, boolean> = { polygres: false };
    try {
      const polygresOk = deps.isReachable
        ? await deps.isReachable()
        : await (await import("@graphbrain/core")).isReachable();
      checks.polygres = polygresOk;
    } catch {
      checks.polygres = false;
    }

    // Engine check: only meaningful if there are active tenants. On a fresh
    // deploy with no tenants, readiness is driven by polygres alone.
    let engineOk = true;
    try {
      const tenants = deps.listTenants
        ? await deps.listTenants()
        : await (await import("@graphbrain/core")).listTenants();
      const active = tenants.filter(
        (t: Tenant) => t.status === "active" && t.helixInstanceUrl,
      );
      if (active.length > 0) {
        if (deps.checkEngine) {
          engineOk = await deps.checkEngine(active[0]!);
        }
        // When no checkEngine is wired, skip the engine check (degrade to
        // polygres-only readiness) rather than falsely reporting unhealthy.
      }
      checks.engine = engineOk;
    } catch {
      checks.engine = false;
    }

    const ok = checks.polygres && checks.engine;
    res.status(ok ? 200 : 503).json({
      status: ok ? "ok" : "unhealthy",
      checks,
    });
  });

  return router;
}
