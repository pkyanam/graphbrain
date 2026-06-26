// Tenant resolver middleware — maps `req.auth.orgId` (set by clerkAuth) to a
// Graphbrain tenant row, decrypts the per-tenant HelixDB API key, and attaches
// `req.tenant` + `req.helixCreds`.
//
// Resolution + decryption happen on every authenticated request, so the tenant
// row is cached in an in-memory LRU (60s TTL) keyed by `clerkOrgId` to avoid a
// Polygres hit per request. The cache holds the Tenant row only (NOT the
// decrypted API key — that is re-derived per request from the cached row, so a
// key rotation that updates the ciphertext is honored on the next TTL expiry
// without holding plaintext in memory longer than necessary).
//
// Failure modes:
//   - No `req.auth`           → 401 (clerkAuth didn't run / failed silently).
//   - Tenant not found        → 403 (Clerk org has no Graphbrain tenant —
//                               provisioning incomplete or webhook missed).
//   - Tenant status !== active → 503 with `Retry-After` (provisioning pending,
//                               suspended, or error).
//   - Decrypt failure         → 500 (misconfigured ENCRYPTION_KEY or corrupted
//                               ciphertext — surfaces as a generic error).
//
// Dependency injection: `TenantResolverDeps` is the seam (mirrors Stage 4's
// `WebhookDeps`). Defaults wire to the real @graphbrain/core modules; tests
// inject mocks to avoid Polygres/Coolify. `getConfig` is injectable too so
// tests can supply a fixed encryption key without touching env.
//
// Config is read lazily INSIDE the middleware (Stage 2 note #1).

import type { Request, Response, NextFunction } from "express";
import {
  getTenantByClerkOrg,
  decrypt,
  getConfig,
  type Tenant,
  type Config,
} from "@graphbrain/core";
import {
  unauthenticated,
  tenantNotFound,
  tenantNotActive,
  OperationError,
} from "./error-handler";
import type { HelixCreds } from "./types";

// ─── Dependency injection seam ───────────────────────────────────────────────

export interface TenantResolverDeps {
  /** Look up a tenant by Clerk org id. Defaults to the real core module. */
  getTenantByClerkOrg?: (orgId: string) => Promise<Tenant | null>;
  /** AES-256-GCM decrypt. Defaults to the real core module. */
  decrypt?: (ciphertext: string, key: string) => string;
  /** Config accessor (for the encryption key). Defaults to `getConfig`. */
  getConfig?: () => Config;
}

const DEFAULT_DEPS: Required<TenantResolverDeps> = {
  getTenantByClerkOrg,
  decrypt,
  getConfig,
};

// ─── In-memory LRU cache (60s TTL) ───────────────────────────────────────────

interface CacheEntry {
  tenant: Tenant;
  expiresAt: number;
}

const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 256;

/** Module-level LRU (Map preserves insertion order in JS). */
let _cache: Map<string, CacheEntry> = new Map();

/** Reset the tenant cache (test helper). */
export function resetTenantCache(): void {
  _cache = new Map();
}

function cacheGet(orgId: string): Tenant | null {
  const entry = _cache.get(orgId);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    _cache.delete(orgId);
    return null;
  }
  // Refresh insertion order (LRU recency).
  _cache.delete(orgId);
  _cache.set(orgId, entry);
  return entry.tenant;
}

function cacheSet(orgId: string, tenant: Tenant): void {
  _cache.set(orgId, { tenant, expiresAt: Date.now() + CACHE_TTL_MS });
  // Evict oldest (first inserted) when over capacity.
  while (_cache.size > CACHE_MAX_ENTRIES) {
    const oldest = _cache.keys().next();
    if (oldest.done) break;
    _cache.delete(oldest.value);
  }
}

// ─── Resolver core (testable, no Express types) ──────────────────────────────

export interface ResolvedTenant {
  tenant: Tenant;
  helixCreds: HelixCreds;
}

/**
 * Resolve a Clerk org id to a tenant + decrypted HelixDB creds. Throws an
 * `OperationError` (403/503/500) on the documented failure modes. Exported so
 * tests can exercise the resolution logic without constructing Express
 * request objects.
 */
export async function resolveTenant(
  orgId: string,
  deps: TenantResolverDeps = {},
): Promise<ResolvedTenant> {
  const d = { ...DEFAULT_DEPS, ...deps } as Required<TenantResolverDeps>;

  const cached = cacheGet(orgId);
  let tenant = cached;
  if (!tenant) {
    tenant = await d.getTenantByClerkOrg(orgId);
    if (!tenant) throw tenantNotFound();
    cacheSet(orgId, tenant);
  }

  if (tenant.status !== "active") throw tenantNotActive(tenant.status);

  if (!tenant.helixInstanceUrl) {
    throw new OperationError(
      "tenant_not_active",
      `Tenant "${tenant.slug}" has no HelixDB instance URL. Provisioning may be incomplete.`,
      { status: 503, retryAfterSeconds: 5 },
    );
  }
  if (!tenant.helixApiKeyEncrypted) {
    throw new OperationError(
      "tenant_not_active",
      `Tenant "${tenant.slug}" has no encrypted HelixDB API key. Provisioning may be incomplete.`,
      { status: 503, retryAfterSeconds: 5 },
    );
  }

  const encryptionKey = d.getConfig().encryptionKey;
  let apiKey: string;
  try {
    apiKey = d.decrypt(tenant.helixApiKeyEncrypted, encryptionKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new OperationError(
      "internal_error",
      `Failed to decrypt HelixDB API key for tenant "${tenant.slug}": ${msg}`,
      { status: 500 },
    );
  }

  return {
    tenant,
    helixCreds: { url: tenant.helixInstanceUrl, apiKey },
  };
}

// ─── Express middleware ──────────────────────────────────────────────────────

/**
 * Express 5 middleware. Requires `req.auth` (set by `clerkAuth`). Resolves the
 * tenant, decrypts HelixDB creds, and sets `req.tenant` + `req.helixCreds`.
 *
 * @param deps — optional dependency injection (tests pass mocks here). In
 *   production this is omitted and the real @graphbrain/core modules are used.
 */
export function tenantResolver(deps: TenantResolverDeps = {}) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    if (!req.auth) {
      next(unauthenticated("tenantResolver requires req.auth — mount clerkAuth first."));
      return;
    }
    try {
      const resolved = await resolveTenant(req.auth.orgId, deps);
      req.tenant = resolved.tenant;
      req.helixCreds = resolved.helixCreds;
      next();
    } catch (err) {
      next(err);
    }
  };
}
