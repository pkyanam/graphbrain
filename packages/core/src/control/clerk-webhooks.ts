// @graphbrain/core — Clerk webhook event handlers.
//
// Verifies Svix (Standard Webhooks) signatures on incoming Clerk webhooks,
// then dispatches org-lifecycle events to the control plane:
//
//   organization.created → createTenant(pending) → provisionHelixForTenant
//                          → on success updateTenant(active + helix creds).
//                          Provisioning runs in the BACKGROUND so the webhook
//                          responds 200 immediately (Clerk/Svix retry on
//                          slow responses). The returned `background` promise
//                          lets the HTTP route (Stage 12) or tests await it.
//   organization.deleted → backupInstance → deleteInstance → updateTenant(deleted).
//   organization.updated → updateTenant(name, slug).
//   api_key.created      → Phase 1: log only (full oauth store is Stage 2's
//                          `oauth_tokens`; the encrypted ref is recorded later).
//   api_key.revoked      → Phase 1: log only (cache invalidation stubbed).
//
// Signature verification uses node:crypto HMAC-SHA256 per the Standard
// Webhooks spec (Clerk sends `svix-id`, `svix-timestamp`, `svix-signature`).
// The signing secret is `CLERK_WEBHOOK_SECRET` (`whsec_…`); the key bytes are
// the base64-decoded portion after the `whsec_` prefix. Replay protection
// rejects timestamps older than 5 minutes.
//
// Dependencies (tenant CRUD, Coolify, provisioning, encrypt) are injectable
// via `WebhookDeps` so tests can exercise the dispatch table without Polygres
// or real network calls. The defaults wire to the real Stage 2/3 modules.

import { createHmac, timingSafeEqual } from "node:crypto";
import { getConfig } from "../config";
import type { Tenant, TenantStatus } from "../types";
import type { CreateTenantInput, UpdateTenantPatch } from "./tenants";
import type { ProvisionResult, ProvisionOptions } from "./helix-provision";
import { createTenant, updateTenant, getTenantByClerkOrg } from "./tenants";
import { provisionHelixForTenant } from "./helix-provision";
import { backupInstance, deleteInstance } from "./coolify";
import { encrypt } from "./encryption";

// ─── Svix signature verification ─────────────────────────────────────────────

/** Svix / Standard Webhooks header names (Clerk sends these). */
const SVIX_ID_HEADER = "svix-id";
const SVIX_TIMESTAMP_HEADER = "svix-timestamp";
const SVIX_SIGNATURE_HEADER = "svix-signature";

/** Replay-protection window: reject webhooks older than this (seconds). */
const SVIX_REPLAY_TOLERANCE_SECONDS = 5 * 60;

/** A verified Clerk webhook event (the shape Clerk delivers). */
export interface ClerkWebhookEvent {
  type: string;
  data: Record<string, unknown>;
  object: string;
}

/** Header lookup that tolerates plain objects or a Headers instance. */
function getHeader(headers: Record<string, string>, name: string): string | undefined {
  // Case-insensitive lookup (HTTP headers are case-insensitive).
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * Decode the Svix signing secret into its raw key bytes. The secret is in the
 * form `whsec_<base64>`; the key bytes are the base64-decoded payload after
 * the `whsec_` prefix.
 */
function decodeSvixSecret(secret: string): Buffer {
  const stripped = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const buf = Buffer.from(stripped, "base64");
  if (buf.length === 0) {
    throw new Error("verifyWebhookSignature: CLERK_WEBHOOK_SECRET decoded to empty key");
  }
  return buf;
}

/**
 * Verify a Svix (Standard Webhooks) signature on a Clerk webhook payload.
 *
 * @param rawBody   the raw request body (string) — MUST be the unparsed body.
 * @param headers   the webhook request headers (must include svix-id,
 *                  svix-timestamp, svix-signature).
 * @param secret    the `CLERK_WEBHOOK_SECRET` (`whsec_…`). Defaults to
 *                  `getConfig().clerkWebhookSecret` (read lazily).
 * @returns the parsed webhook event on success.
 * @throws if a required header is missing, the timestamp is stale (replay),
 *         or no signature matches (tampering / wrong secret).
 */
export function verifyWebhookSignature(
  rawBody: string,
  headers: Record<string, string>,
  secret?: string,
): ClerkWebhookEvent {
  const svixId = getHeader(headers, SVIX_ID_HEADER);
  const svixTimestamp = getHeader(headers, SVIX_TIMESTAMP_HEADER);
  const svixSignature = getHeader(headers, SVIX_SIGNATURE_HEADER);
  if (!svixId || !svixTimestamp || !svixSignature) {
    throw new Error(
      "verifyWebhookSignature: missing required Svix header(s) " +
        `(need svix-id, svix-timestamp, svix-signature)`,
    );
  }

  // Replay protection: reject timestamps outside the tolerance window.
  const tsSec = Number(svixTimestamp);
  if (!Number.isFinite(tsSec)) {
    throw new Error(`verifyWebhookSignature: svix-timestamp is not a number ("${svixTimestamp}")`);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const age = Math.abs(nowSec - tsSec);
  if (age > SVIX_REPLAY_TOLERANCE_SECONDS) {
    throw new Error(
      `verifyWebhookSignature: webhook timestamp is stale (${age}s old; ` +
        `tolerance ${SVIX_REPLAY_TOLERANCE_SECONDS}s) — possible replay`,
    );
  }

  // Recompute the signature: base64(HMAC-SHA256(secret, `${id}.${ts}.${body}`)).
  const keyBytes = decodeSvixSecret(secret ?? getConfig().clerkWebhookSecret);
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = createHmac("sha256", keyBytes).update(signedContent).digest("base64");

  // The svix-signature header is a space-separated list of `v1,<sig>` pairs
  // (supports secret rotation). Accept any match, constant-time per compare.
  const candidates = svixSignature.split(" ").map((s) => s.replace(/^v1,/, ""));
  const expectedBuf = Buffer.from(expected);
  let matched = false;
  for (const candidate of candidates) {
    const candidateBuf = Buffer.from(candidate);
    if (candidateBuf.length === expectedBuf.length) {
      if (timingSafeEqual(candidateBuf, expectedBuf)) {
        matched = true;
        break;
      }
    }
  }
  if (!matched) {
    throw new Error("verifyWebhookSignature: no matching signature (tampering or wrong secret)");
  }

  const event = JSON.parse(rawBody) as ClerkWebhookEvent;
  if (!event || typeof event.type !== "string") {
    throw new Error("verifyWebhookSignature: parsed payload missing `type`");
  }
  return event;
}

// ─── Dependency injection ────────────────────────────────────────────────────

/**
 * Injectable dependencies for the webhook dispatch. Tests pass mocks to
 * exercise the dispatch table without Polygres or real Coolify/Clerk calls.
 * Defaults wire to the real Stage 2/3 modules.
 */
export interface WebhookDeps {
  createTenant: (data: CreateTenantInput) => Promise<Tenant>;
  updateTenant: (id: string, patch: UpdateTenantPatch) => Promise<Tenant | null>;
  getTenantByClerkOrg: (orgId: string) => Promise<Tenant | null>;
  provisionHelixForTenant: (tenant: Tenant, opts?: ProvisionOptions) => Promise<ProvisionResult>;
  backupInstance: (appId: string) => Promise<void>;
  deleteInstance: (appId: string) => Promise<void>;
  encrypt: (plaintext: string, key: string) => string;
}

/** Build the default deps from the real Stage 2/3 modules. */
function defaultDeps(): WebhookDeps {
  return {
    createTenant,
    updateTenant,
    getTenantByClerkOrg,
    provisionHelixForTenant,
    backupInstance,
    deleteInstance,
    encrypt,
  };
}

// ─── Result shape ────────────────────────────────────────────────────────────

/** Result of `handleClerkWebhook`. */
export interface WebhookResult {
  /** HTTP status to respond with (200 on success, 400 on bad signature). */
  status: number;
  /** Optional response body. */
  body?: unknown;
  /**
   * Background work kicked off by the handler (e.g. HelixDB provisioning on
   * `organization.created`). The HTTP route should respond 200 immediately
   * and NOT await this; tests may await it to assert the full flow. Undefined
   * for events with no background work.
   */
  background?: Promise<void>;
}

// ─── Event payload shapes ────────────────────────────────────────────────────

/** Organization fields carried by organization.* webhook events. */
interface OrgEventData {
  id: string;
  slug: string;
  name: string;
}

/** Coerce the webhook `data` into an OrgEventData, validating required fields. */
function asOrgData(data: unknown): OrgEventData {
  const d = data as Record<string, unknown>;
  if (typeof d.id !== "string" || typeof d.slug !== "string" || typeof d.name !== "string") {
    throw new Error("handleClerkWebhook: organization event missing id/slug/name");
  }
  return { id: d.id, slug: d.slug, name: d.name };
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

/**
 * Handle an incoming Clerk webhook.
 *
 * Verifies the Svix signature, then dispatches to the handler for the event
 * type. `organization.created` responds 200 immediately and provisions the
 * HelixDB instance in the background (the returned `background` promise lets
 * callers/tests await it). All other events are handled synchronously.
 *
 * @param rawBody   the raw (unparsed) webhook body string.
 * @param headers   the webhook request headers.
 * @param deps      optional injected dependencies (tests).
 * @returns `{ status, body, background? }`.
 */
export async function handleClerkWebhook(
  rawBody: string,
  headers: Record<string, string>,
  deps: WebhookDeps = defaultDeps(),
): Promise<WebhookResult> {
  let event: ClerkWebhookEvent;
  try {
    event = verifyWebhookSignature(rawBody, headers);
  } catch (err) {
    return {
      status: 400,
      body: { error: err instanceof Error ? err.message : "signature verification failed" },
    };
  }

  const d = deps;
  switch (event.type) {
    case "organization.created": {
      const org = asOrgData(event.data);
      // 1. Create the tenant row synchronously (status: pending) so the
      //    webhook responds 200 with the row already in place — the dashboard
      //    can poll tenant status while provisioning runs.
      const tenant = await d.createTenant({
        clerkOrgId: org.id,
        name: org.name,
        slug: org.slug,
        status: "pending",
      });
      // 2. Provision HelixDB in the background. On success, encrypt the key
      //    and write the instance creds + status:active. On timeout,
      //    provisionHelixForTenant already marks the tenant status:error.
      const background = provisionTenantBackground(tenant, d);
      return { status: 200, body: { ok: true, tenantId: tenant.id }, background };
    }

    case "organization.deleted": {
      const org = asOrgData(event.data);
      const tenant = await d.getTenantByClerkOrg(org.id);
      if (!tenant) {
        // No tenant row — nothing to deprovision. Idempotent success.
        return { status: 200, body: { ok: true, note: "no tenant for org" } };
      }
      // Snapshot → delete → mark deleted. Best-effort backup: a backup
      // failure should not block deprovision (the data is being deleted
      // anyway), so we swallow backup errors and proceed to delete.
      if (tenant.coolifyAppId) {
        try {
          await d.backupInstance(tenant.coolifyAppId);
        } catch {
          // Best-effort: continue to delete even if the snapshot fails.
        }
        await d.deleteInstance(tenant.coolifyAppId);
      }
      await d.updateTenant(tenant.id, { status: "deleted" as TenantStatus });
      return { status: 200, body: { ok: true, tenantId: tenant.id } };
    }

    case "organization.updated": {
      const org = asOrgData(event.data);
      const tenant = await d.getTenantByClerkOrg(org.id);
      if (!tenant) {
        return { status: 200, body: { ok: true, note: "no tenant for org" } };
      }
      await d.updateTenant(tenant.id, { name: org.name, slug: org.slug });
      return { status: 200, body: { ok: true, tenantId: tenant.id } };
    }

    case "api_key.created":
    case "api_key.revoked":
      // Phase 1: log only. The full encrypted API-key reference store is
      // Stage 2's `oauth_tokens`; cache invalidation is stubbed for now.
      return { status: 200, body: { ok: true, note: `${event.type} acknowledged (phase 1 stub)` } };

    default:
      // Unknown event type — acknowledge so Svix does not retry, but note it.
      return { status: 200, body: { ok: true, note: `unhandled event type: ${event.type}` } };
  }
}

/**
 * Background provisioning for `organization.created`. Provisions the HelixDB
 * instance, then on success encrypts the API key and writes the instance
 * creds + `status: "active"` onto the tenant row. Errors are caught and
 * logged to stderr (the tenant stays `pending` or is marked `error` by
 * `provisionHelixForTenant`'s timeout path) so the background promise never
 * rejects — the HTTP route has already responded 200.
 */
async function provisionTenantBackground(tenant: Tenant, deps: WebhookDeps): Promise<void> {
  try {
    const { url, apiKey, appId } = await deps.provisionHelixForTenant(tenant);
    const encrypted = deps.encrypt(apiKey, getConfig().encryptionKey);
    await deps.updateTenant(tenant.id, {
      helixInstanceUrl: url,
      helixApiKeyEncrypted: encrypted,
      coolifyAppId: appId,
      status: "active",
    });
  } catch (err) {
    // The timeout path inside provisionHelixForTenant already marks the
    // tenant `error`. Log so the operator sees the failure; never reject.
    process.stderr.write(
      `handleClerkWebhook: background provisioning failed for tenant "${tenant.slug}": ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
