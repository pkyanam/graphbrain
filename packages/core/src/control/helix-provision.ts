// @graphbrain/core — HelixDB provisioning orchestration.
//
// `provisionHelixForTenant(tenant)` is the single entry point Stage 4 (Clerk
// webhooks) calls on `organization.created`. It:
//   1. Generates a per-tenant HelixDB API key (32 random bytes, hex).
//   2. Provisions the container via Coolify (`provisionHelixInstance`).
//   3. Polls the instance `/health` endpoint until it returns 200 (or the
//      timeout elapses).
//   4. On success, returns `{ url, apiKey, appId }`. The CALLER (Stage 4
//      webhook) is responsible for encrypting the key and writing
//      `{ helixInstanceUrl, helixApiKeyEncrypted: encrypt(apiKey, key),
//         coolifyAppId, status: "active" }` onto the tenant row via
//      `updateTenant`. Keeping the success-path write in the caller lets the
//      webhook own the transaction boundary and the encryption key.
//   5. On timeout, best-effort marks the tenant `status: "error"` via
//      `updateTenant` and throws. The `updateTenant` call is wrapped in a
//      try/catch so a control-plane DB failure cannot mask the original
//      timeout error (the operator still sees the provisioning failure).
//
// The poll interval and timeout are overridable via `ProvisionOptions` so
// tests can exercise the polling loop quickly without waiting 120s.

import { randomBytes } from "node:crypto";
import type { Tenant } from "../types";
import { provisionHelixInstance } from "./coolify";
import { updateTenant } from "./tenants";

/** Result of a successful provisioning flow. */
export interface ProvisionResult {
  /** Reachable URL for the HelixDB instance (write onto `tenants.helix_instance_url`). */
  url: string;
  /** Plaintext HelixDB API key (caller encrypts before storing). */
  apiKey: string;
  /** Coolify application uuid (write onto `tenants.coolify_app_id`). */
  appId: string;
}

/** Tunable knobs for the health-poll loop (defaults match the production SLA). */
export interface ProvisionOptions {
  /** Delay between `/health` polls. Default 2000ms. */
  pollIntervalMs?: number;
  /** Max total time to wait for the instance to become healthy. Default 120000ms. */
  timeoutMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Provision a ready HelixDB instance for a tenant.
 *
 * @throws if the instance does not become healthy within the timeout. On
 *   timeout, the tenant row is best-effort marked `status: "error"`.
 */
export async function provisionHelixForTenant(
  tenant: Tenant,
  opts: ProvisionOptions = {},
): Promise<ProvisionResult> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // 1. Generate the per-tenant HelixDB API key (plaintext; caller encrypts).
  const apiKey = randomBytes(32).toString("hex");

  // 2. Provision the container via Coolify.
  const { appId, url } = await provisionHelixInstance(tenant.slug, apiKey);

  // 3. Poll `/health` until 200 or the deadline.
  const deadline = Date.now() + timeoutMs;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`, { method: "GET" });
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      // Network not ready yet (DNS / connection refused during startup).
      // Keep polling until the deadline.
    }
    await sleep(pollIntervalMs);
  }

  // 4. On timeout, best-effort mark the tenant errored, then throw.
  if (!healthy) {
    try {
      await updateTenant(tenant.id, { status: "error" });
    } catch {
      // Best-effort: don't let a control-plane DB failure mask the timeout.
    }
    throw new Error(
      `provisionHelixForTenant: HelixDB instance for tenant "${tenant.slug}" ` +
        `did not become healthy within ${timeoutMs}ms (url=${url})`,
    );
  }

  // 5. Success — caller writes url + encrypted key + appId onto the tenant.
  return { url, apiKey, appId };
}

/** Promise-based sleep (avoids pulling in a timer helper elsewhere). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
