// Tests for the Clerk webhook route (apps/api/src/routes/webhooks/clerk.ts).
//
// Spins up a real Express app via `createApp()` with injected `webhookDeps`
// (mocked handleClerkWebhook deps — no Polygres / Coolify). Webhook payloads
// are signed with the test `CLERK_WEBHOOK_SECRET` (from MW_ENV) using
// node:crypto HMAC-SHA256 (the Standard Webhooks scheme), so the signature-
// verification path runs end-to-end without a real Svix install.
//
// Webhook best practice: the route responds 200 ALWAYS — even on a bad
// signature (logged, not retried). These tests assert that contract.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createHmac } from "node:crypto";
import { createApp, startServer, type ServerHandle } from "../../src/index";
import { primeMwEnv, MW_ENV } from "../middleware/_helpers";
import type { WebhookDeps, Tenant, CreateTenantInput, UpdateTenantPatch } from "@graphbrain/core";

primeMwEnv();

const WEBHOOK_SECRET = MW_ENV.CLERK_WEBHOOK_SECRET!; // "whsec_test"

// ─── Signing helper (mirrors packages/core/test/control/clerk-webhooks.test.ts) ─

function signBody(rawBody: string, svixId: string, svixTs: string, secret: string = WEBHOOK_SECRET): string {
  const keyBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signedContent = `${svixId}.${svixTs}.${rawBody}`;
  const sig = createHmac("sha256", keyBytes).update(signedContent).digest("base64");
  return `v1,${sig}`;
}

function svixHeaders(rawBody: string, svixId = "msg_test_1", svixTs?: string): Record<string, string> {
  const ts = svixTs ?? String(Math.floor(Date.now() / 1000));
  return {
    "svix-id": svixId,
    "svix-timestamp": ts,
    "svix-signature": signBody(rawBody, svixId, ts),
  };
}

function eventBody(type: string, data: Record<string, unknown>): string {
  return JSON.stringify({ type, data, object: "event" });
}

// ─── Mock webhook deps ───────────────────────────────────────────────────────

const createdTenants: Tenant[] = [];
let updatedPatches: { id: string; patch: UpdateTenantPatch }[] = [];

function mockWebhookDeps(): WebhookDeps {
  createdTenants.length = 0;
  updatedPatches = [];
  return {
    createTenant: async (data: CreateTenantInput) => ({
      id: "t_new",
      clerkOrgId: data.clerkOrgId,
      name: data.name,
      slug: data.slug,
      helixInstanceUrl: null,
      helixApiKeyEncrypted: null,
      coolifyAppId: null,
      tier: "free",
      status: data.status ?? "pending",
      settings: {},
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }),
    updateTenant: async (id, patch) => {
      updatedPatches.push({ id, patch });
      return {
        id,
        clerkOrgId: "org_new",
        name: "New Org",
        slug: "new-org",
        helixInstanceUrl: null,
        helixApiKeyEncrypted: null,
        coolifyAppId: null,
        tier: "free",
        status: "active",
        settings: {},
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
    },
    getTenantByClerkOrg: async () => null,
    provisionHelixForTenant: async (tenant) => ({
      url: "https://helix.new.test",
      apiKey: "new-key",
      appId: "app_new",
      tenant,
    }),
    backupInstance: async () => {},
    deleteInstance: async () => {},
    encrypt: (plaintext) => `enc_${plaintext}`,
  };
}

// ─── Fixture ─────────────────────────────────────────────────────────────────

let handle: ServerHandle;
let port: number;
let baseUrl: string;
let webhookDeps: WebhookDeps;

beforeAll(async () => {
  webhookDeps = mockWebhookDeps();
  const app = createApp({
    webhookDeps,
    // No-op auth chain (webhooks are public; the chain is mounted but never
    // reached because the webhook route is before the auth middleware).
    authChain: [(_req, _res, next) => next()],
    deps: {
      router: { getEngine: async () => { throw new Error("no engine"); } },
      gateway: {} as never,
      embeddingService: {} as never,
    },
  });
  const started = await new Promise<{ handle: ServerHandle; port: number }>((resolve) => {
    const h = startServer(app, {
      port: 0,
      installSignalHandlers: false,
      onListening: ({ port }) => resolve({ handle: h, port }),
    });
  });
  handle = started.handle;
  port = started.port;
  baseUrl = `http://localhost:${port}`;
});

afterAll(async () => {
  await handle.close();
});

beforeEach(() => {
  createdTenants.length = 0;
  updatedPatches = [];
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("routes/webhooks — POST /webhooks/clerk", () => {
  it("accepts a signed organization.created event → 200 + creates tenant", async () => {
    const body = eventBody("organization.created", {
      id: "org_new",
      slug: "new-org",
      name: "New Org",
    });
    const res = await fetch(`${baseUrl}/webhooks/clerk`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...svixHeaders(body) },
      body,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.tenantId).toBe("t_new");
  });

  it("accepts a signed organization.updated event → 200 + updates tenant", async () => {
    const body = eventBody("organization.updated", {
      id: "org_new",
      slug: "renamed-org",
      name: "Renamed Org",
    });
    const res = await fetch(`${baseUrl}/webhooks/clerk`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...svixHeaders(body, "msg_upd_1") },
      body,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  it("returns 200 on a bad signature (webhook best practice — no Clerk retry)", async () => {
    const body = eventBody("organization.created", {
      id: "org_bad",
      slug: "bad",
      name: "Bad",
    });
    const headers = svixHeaders(body, "msg_bad_1");
    // Tamper with the signature.
    headers["svix-signature"] = "v1,invalidbase64signature==";
    const res = await fetch(`${baseUrl}/webhooks/clerk`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
    // Webhook best practice: always 200 so Svix does not retry. The bad
    // signature is logged to stderr; the body carries the error.
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.error).toMatch(/signature/i);
  });

  it("returns 200 on an unknown event type (acknowledged, no retry)", async () => {
    const body = eventBody("some.future.event", { id: "org_x" });
    const res = await fetch(`${baseUrl}/webhooks/clerk`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...svixHeaders(body, "msg_unk_1") },
      body,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  it("returns 200 on api_key.created (phase 1 stub)", async () => {
    const body = eventBody("api_key.created", { id: "ak_1" });
    const res = await fetch(`${baseUrl}/webhooks/clerk`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...svixHeaders(body, "msg_ak_1") },
      body,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });
});
