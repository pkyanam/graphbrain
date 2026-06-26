// @graphbrain/core — TenantRouter: resolves a tenant to a cached HelixEngine.
//
// Maintains an LRU cache keyed by `tenant.id` with a 5-minute TTL and a
// 100-entry cap. On `getEngine(tenant)`:
//   1. If a cached entry exists and hasn't expired, health-check the engine
//      (fetch `${url}/health` with a 2s timeout). If healthy, return it. If
//      unhealthy, evict + reconstruct.
//   2. If no cached entry (or it expired / was evicted), construct a new
//      `HelixEngine({ url, apiKey })` where apiKey is decrypted from
//      `tenant.helixApiKeyEncrypted` via the Stage 2 encryption helper. Cache
//      it with a fresh expiry, then return it.
//
// `invalidate(tenantId)` drops the cached entry — called when a tenant's
// instance is reprovisioned (new URL / new API key). The next `getEngine`
// call reconstructs from the (updated) tenant row.
//
// The cache is a plain Map (insertion-ordered) — LRU is implemented by
// delete + re-insert on access, and evicting the oldest entry when the cap
// is exceeded. No external LRU dependency needed for Phase 1.

import type { Tenant } from "./types";
import { getConfig } from "./config";
import { decrypt } from "./control/encryption";
import { HelixEngine, type HelixEngineOptions } from "./helix-engine";
import type { BrainEngine } from "./engine";

/** Default cache TTL (5 minutes). */
const DEFAULT_TTL_MS = 5 * 60 * 1_000;
/** Default max cached entries. */
const DEFAULT_MAX_ENTRIES = 100;
/** Default health-check timeout (matches HelixEngine default). */
const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;

/** A cached engine entry. */
interface CacheEntry {
  engine: HelixEngine;
  /** Epoch millis when this entry expires. */
  expiresAt: number;
}

/** Constructor options for TenantRouter. */
export interface TenantRouterOptions {
  /** Cache TTL in ms. Default 300000 (5 min). */
  ttlMs?: number;
  /** Max cached entries. Default 100. */
  maxEntries?: number;
  /** Health-check timeout in ms. Default 2000. */
  healthTimeoutMs?: number;
  /**
   * Optional override for the encryption key (base64). When omitted, the key
   * is read from `getConfig().encryptionKey` at decrypt time. Exposed so
   * tests can inject a known key without priming env.
   */
  encryptionKey?: string;
  /**
   * Optional factory override for constructing engines. When omitted, the
   * default `new HelixEngine(opts)` is used. Exposed so tests can inject
   * a stub engine (e.g. one with a controllable health() response).
   */
  engineFactory?: (opts: HelixEngineOptions) => BrainEngine;
}

/**
 * TenantRouter — resolves a Tenant to a healthy, cached HelixEngine.
 *
 * Usage:
 *   const router = new TenantRouter();
 *   const engine = await router.getEngine(tenant);
 *   const page = await engine.getPage("acme");
 *
 * Call `router.invalidate(tenantId)` when a tenant's instance is reprovisioned
 * so the next `getEngine` call picks up the new URL / API key.
 */
export class TenantRouter {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly healthTimeoutMs: number;
  private readonly encryptionKey: string | undefined;
  private readonly engineFactory: (opts: HelixEngineOptions) => BrainEngine;

  constructor(opts?: TenantRouterOptions) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.healthTimeoutMs = opts?.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.encryptionKey = opts?.encryptionKey;
    this.engineFactory = opts?.engineFactory ?? ((o) => new HelixEngine(o));
  }

  /** Number of entries currently in the cache. */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Resolve a tenant to a healthy HelixEngine. On cache hit (entry present +
   * not expired), health-checks the engine before returning; on miss or
   * failed health check, constructs a fresh engine.
   *
   * @throws if the tenant has no `helixInstanceUrl` or `helixApiKeyEncrypted`
   *   (not yet provisioned), or if the encrypted key cannot be decrypted.
   */
  async getEngine(tenant: Tenant): Promise<BrainEngine> {
    if (!tenant.helixInstanceUrl || !tenant.helixApiKeyEncrypted) {
      throw new Error(
        `TenantRouter: tenant "${tenant.id}" has no provisioned HelixDB instance ` +
          `(helixInstanceUrl or helixApiKeyEncrypted is null).`,
      );
    }

    const now = Date.now();
    const cached = this.cache.get(tenant.id);

    // Cache hit + not expired → health-check before reuse.
    if (cached && cached.expiresAt > now) {
      if (await cached.engine.health()) {
        // LRU touch: delete + re-insert so this entry moves to the end.
        this.cache.delete(tenant.id);
        this.cache.set(tenant.id, cached);
        return cached.engine;
      }
      // Unhealthy — evict + reconstruct.
      await cached.engine.close().catch(() => {});
      this.cache.delete(tenant.id);
    } else if (cached) {
      // Expired — drop it.
      await cached.engine.close().catch(() => {});
      this.cache.delete(tenant.id);
    }

    // Cache miss (or evicted) → construct a fresh engine.
    const apiKey = this.decryptKey(tenant.helixApiKeyEncrypted);
    const engine = this.engineFactory({
      url: tenant.helixInstanceUrl,
      apiKey,
      healthTimeoutMs: this.healthTimeoutMs,
    });

    this.put(tenant.id, engine, now);
    return engine;
  }

  /**
   * Drop the cached engine for a tenant. Call when the tenant's instance is
   * reprovisioned (new URL / new API key). The next `getEngine` call
   * reconstructs from the updated tenant row. Safe to call if no entry exists.
   */
  async invalidate(tenantId: string): Promise<void> {
    const entry = this.cache.get(tenantId);
    if (entry) {
      await entry.engine.close().catch(() => {});
      this.cache.delete(tenantId);
    }
  }

  /** Drop all cached engines. Used on shutdown / test teardown. */
  async clear(): Promise<void> {
    for (const entry of this.cache.values()) {
      await entry.engine.close().catch(() => {});
    }
    this.cache.clear();
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  /** Insert an entry, evicting the oldest if the cap is exceeded. */
  private put(tenantId: string, engine: BrainEngine, now: number): void {
    // Evict oldest if at cap (Map iterates in insertion order).
    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        const oldest = this.cache.get(oldestKey);
        if (oldest) oldest.engine.close().catch(() => {});
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(tenantId, { engine: engine as HelixEngine, expiresAt: now + this.ttlMs });
  }

  /** Decrypt the tenant's HelixDB API key using the configured encryption key. */
  private decryptKey(ciphertext: string): string {
    const key = this.encryptionKey ?? getConfig().encryptionKey;
    return decrypt(ciphertext, key);
  }
}
