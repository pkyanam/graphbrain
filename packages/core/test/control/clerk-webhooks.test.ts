// Tests for the Clerk webhook handlers (packages/core/src/control/clerk-webhooks.ts).
//
// Webhook payloads are signed with the test `CLERK_WEBHOOK_SECRET` using
// node:crypto HMAC-SHA256 (the same Standard Webhooks scheme Clerk/Svix use),
// so the signature-verification path is exercised end-to-end without a real
// Svix install. No real network and no real Clerk are required.
//
// The dispatch table is exercised with injected `WebhookDeps` mocks — no
// Polygres, no Coolify. This keeps the suite DB-free and deterministic.
//
// Verifies:
//   - verifyWebhookSignature accepts a correctly signed payload.
//   - verifyWebhookSignature rejects tampered payloads, wrong secrets, missing
//     headers, and stale timestamps (replay protection).
//   - organization.created → createTenant(pending) → background provision →
//     encrypt → updateTenant(active + helix creds). Responds 200 immediately.
//   - organization.deleted → backupInstance → deleteInstance → updateTenant(deleted).
//   - organization.updated → updateTenant(name, slug).
//   - api_key.created / api_key.revoked → acknowledged (phase 1 stub).
//   - Unknown event types are acknowledged without error.

import { describe, it, expect, beforeAll } from "bun:test";
import { createHmac } from "node:crypto";
import {
  primeEnv,
  POLYGRES_ENV,
} from "./_helpers.ts";
import {
  verifyWebhookSignature,
  handleClerkWebhook,
} from "../../src/index.ts";
import type {
  WebhookDeps,
  ClerkWebhookEvent,
} from "../../src/index.ts";
import type { Tenant, CreateTenantInput, UpdateTenantPatch } from "../../src/index.ts";

// ─── Env ─────────────────────────────────────────────────────────────────────

primeEnv();

// ─── Signing helper ──────────────────────────────────────────────────────────

/** The test webhook secret (matches POLYGRES_ENV.CLERK_WEBHOOK_SECRET). */
const WEBHOOK_SECRET = POLYGRES_ENV.CLERK_WEBHOOK_SECRET!; // "whsec_test"

/**
 * Sign a raw body with the Svix / Standard Webhooks scheme:
 *   signature = base64(HMAC-SHA256(secretBytes, `${svixId}.${svixTs}.${body}`))
 * The header value is `v1,<signature>`.
 */
function signBody(rawBody: string, svixId: string, svixTs: string, secret: string = WEBHOOK_SECRET): string {
  const keyBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signedContent = `${svixId}.${svixTs}.${rawBody}`;
  const sig = createHmac("sha256", keyBytes).update(signedContent).digest("base64");
  return `v1,${sig}`;
}

/** Build Svix headers for a raw body. */
function svixHeaders(
  rawBody: string,
  svixId = "msg_test_1",
  svixTs?: string,
  secret: string = WEBHOOK_SECRET,
): Record<string, string> {
  const ts = svixTs ?? String(Math.floor(Date.now() / 1000));
  return {
    "svix-id": svixId,
    "svix-timestamp": ts,
    "svix-signature": signBody(rawBody, svixId, ts, secret),
  };
}

/** Serialize a webhook event to a raw JSON body. */
function eventBody(type: string, data: Record<string, unknown>): string {
  const event: ClerkWebhookEvent = { type, data, object: "event" };
  return JSON.stringify(event);
}

// ─── Mock deps ───────────────────────────────────────────────────────────────

/** A recording mock for a single dep function. */
function recorder<T extends (...args: any[]) => any>(): {
  fn: T;
  calls: Parameters<T>[];
} {
  const calls: Parameters<T>[] = [];
  const fn = ((...args: Parameters<T>) => {
    calls.push(args);
  }) as unknown as T;
  return { fn, calls };
}

/** Build a set of mock deps with controllable return values + call recording. */
function mockDeps(overrides?: {
  createTenant?: (data: CreateTenantInput) => Promise<Tenant>;
  provisionHelixForTenant?: (tenant: Tenant, opts?: any) => Promise<any>;
  getTenantByClerkOrg?: (orgId: string) => Promise<Tenant | null>;
  encrypt?: (plaintext: string, key: string) => string;
}): { deps: WebhookDeps; calls: Record<string, any[]> } {
  const calls: Record<string, any[]> = {
    createTenant: [],
    updateTenant: [],
    getTenantByClerkOrg: [],
    provisionHelixForTenant: [],
    backupInstance: [],
    deleteInstance: [],
    encrypt: [],
  };

  const tenants = new Map<string, Tenant>();

  const deps: WebhookDeps = {
    createTenant: overrides?.createTenant ?? (async (data: CreateTenantInput) => {
      calls.createTenant.push([data]);
      const tenant: Tenant = {
        id: `ten_${data.clerkOrgId}`,
        clerkOrgId: data.clerkOrgId,
        name: data.name,
        slug: data.slug,
        helixInstanceUrl: null,
        helixApiKeyEncrypted: null,
        coolifyAppId: null,
        tier: "free",
        status: data.status ?? "pending",
        settings: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      tenants.set(data.clerkOrgId, tenant);
      return tenant;
    }),
    updateTenant: async (id: string, patch: UpdateTenantPatch) => {
      calls.updateTenant.push([id, patch]);
      // Reflect the patch onto the in-memory tenant (for chained handlers).
      for (const t of tenants.values()) {
        if (t.id === id) {
          if (patch.name !== undefined) t.name = patch.name;
          if (patch.slug !== undefined) t.slug = patch.slug;
          if (patch.status !== undefined) t.status = patch.status;
          if (patch.helixInstanceUrl !== undefined) t.helixInstanceUrl = patch.helixInstanceUrl;
          if (patch.helixApiKeyEncrypted !== undefined) t.helixApiKeyEncrypted = patch.helixApiKeyEncrypted;
          if (patch.coolifyAppId !== undefined) t.coolifyAppId = patch.coolifyAppId;
          return t;
        }
      }
      return null;
    },
    getTenantByClerkOrg: overrides?.getTenantByClerkOrg ?? (async (orgId: string) => {
      calls.getTenantByClerkOrg.push([orgId]);
      return tenants.get(orgId) ?? null;
    }),
    provisionHelixForTenant:
      overrides?.provisionHelixForTenant ??
      (async (tenant: Tenant) => {
        calls.provisionHelixForTenant.push([tenant]);
        // Defer resolution to a macrotask so the handler returns 200 BEFORE
        // the background work completes (mirrors real async provisioning).
        await new Promise((r) => setTimeout(r, 0));
        return {
          url: `https://helix-${tenant.slug}.internal`,
          apiKey: "plaintext-helix-key",
          appId: "cool-app-123",
        };
      }),
    backupInstance: async (appId: string) => {
      calls.backupInstance.push([appId]);
    },
    deleteInstance: async (appId: string) => {
      calls.deleteInstance.push([appId]);
    },
    encrypt: overrides?.encrypt ?? ((plaintext: string, key: string) => {
      calls.encrypt.push([plaintext, key]);
      return `enc(${plaintext})`;
    }),
  };
  return { deps, calls };
}

// ─── Tests: signature verification ───────────────────────────────────────────

describe("control/clerk-webhooks — verifyWebhookSignature", () => {
  it("accepts a correctly signed payload and returns the parsed event", () => {
    const body = eventBody("organization.created", { id: "org_1", slug: "acme", name: "Acme" });
    const headers = svixHeaders(body);
    const event = verifyWebhookSignature(body, headers);
    expect(event.type).toBe("organization.created");
    expect((event.data as Record<string, unknown>).id).toBe("org_1");
  });

  it("rejects a tampered body (signature mismatch)", () => {
    const body = eventBody("organization.created", { id: "org_1", slug: "acme", name: "Acme" });
    const headers = svixHeaders(body);
    const tampered = eventBody("organization.created", { id: "org_EVIL", slug: "evil", name: "Evil" });
    expect(() => verifyWebhookSignature(tampered, headers)).toThrow(/no matching signature/);
  });

  it("rejects a wrong signing secret", () => {
    const body = eventBody("organization.created", { id: "org_1", slug: "acme", name: "Acme" });
    // A different valid whsec_ secret (base64 after the prefix) → different key bytes.
    const wrongSecret = "whsec_YW5vdGhlcktleQ==";
    const headers = svixHeaders(body, "msg_1", undefined, wrongSecret);
    expect(() => verifyWebhookSignature(body, headers)).toThrow(/no matching signature/);
  });

  it("rejects when a required Svix header is missing", () => {
    const body = eventBody("organization.created", { id: "org_1", slug: "acme", name: "Acme" });
    const headers = svixHeaders(body);
    delete headers["svix-signature"];
    expect(() => verifyWebhookSignature(body, headers)).toThrow(/missing required Svix header/);
  });

  it("rejects a stale timestamp (replay protection)", () => {
    const body = eventBody("organization.created", { id: "org_1", slug: "acme", name: "Acme" });
    const staleTs = String(Math.floor(Date.now() / 1000) - 600); // 10 min ago
    const headers = svixHeaders(body, "msg_stale", staleTs);
    expect(() => verifyWebhookSignature(body, headers)).toThrow(/stale/);
  });

  it("accepts a space-separated multi-signature header (secret rotation)", () => {
    const body = eventBody("organization.updated", { id: "org_1", slug: "new", name: "New" });
    const ts = String(Math.floor(Date.now() / 1000));
    const goodSig = signBody(body, "msg_rot", ts);
    const badSig = "v1,deadbeef";
    const headers = {
      "svix-id": "msg_rot",
      "svix-timestamp": ts,
      "svix-signature": `${badSig} ${goodSig}`,
    };
    const event = verifyWebhookSignature(body, headers);
    expect(event.type).toBe("organization.updated");
  });

  it("uses an explicit secret argument when provided", () => {
    const body = eventBody("organization.created", { id: "org_1", slug: "acme", name: "Acme" });
    const customSecret = "whsec_custom_test_key";
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = {
      "svix-id": "msg_custom",
      "svix-timestamp": ts,
      "svix-signature": signBody(body, "msg_custom", ts, customSecret),
    };
    const event = verifyWebhookSignature(body, headers, customSecret);
    expect(event.type).toBe("organization.created");
  });
});

// ─── Tests: dispatch table ───────────────────────────────────────────────────

describe("control/clerk-webhooks — handleClerkWebhook dispatch", () => {
  it("organization.created: creates a pending tenant, provisions in background, encrypts + activates", async () => {
    const { deps, calls } = mockDeps();
    const body = eventBody("organization.created", { id: "org_new", slug: "new-co", name: "New Co" });
    const result = await handleClerkWebhook(body, svixHeaders(body), deps);

    // Responds 200 immediately (before provisioning completes).
    expect(result.status).toBe(200);

    // createTenant was called synchronously with status: pending.
    expect(calls.createTenant.length).toBe(1);
    expect(calls.createTenant[0]![0].clerkOrgId).toBe("org_new");
    expect(calls.createTenant[0]![0].slug).toBe("new-co");
    expect(calls.createTenant[0]![0].status).toBe("pending");

    // The success-path (encrypt + activate) has NOT run yet — the webhook
    // responds 200 before background provisioning completes.
    expect(calls.encrypt.length).toBe(0);
    expect(calls.updateTenant.length).toBe(0);

    // Await the background work — the full provision → encrypt → activate path.
    expect(result.background).toBeDefined();
    await result.background;

    // provisionHelixForTenant was called with the created tenant.
    expect(calls.provisionHelixForTenant.length).toBe(1);
    expect(calls.provisionHelixForTenant[0]![0].slug).toBe("new-co");

    // encrypt was called with the plaintext key + the config encryption key.
    expect(calls.encrypt.length).toBe(1);
    expect(calls.encrypt[0]![0]).toBe("plaintext-helix-key");

    // updateTenant was called with the helix creds + status: active.
    expect(calls.updateTenant.length).toBe(1);
    const [id, patch] = calls.updateTenant[0]!;
    expect(id).toBe("ten_org_new");
    expect(patch.helixInstanceUrl).toBe("https://helix-new-co.internal");
    expect(patch.helixApiKeyEncrypted).toBe("enc(plaintext-helix-key)");
    expect(patch.coolifyAppId).toBe("cool-app-123");
    expect(patch.status).toBe("active");
  });

  it("organization.created: provisioning failure does not reject the background promise", async () => {
    const { deps, calls } = mockDeps({
      provisionHelixForTenant: async () => {
        calls.provisionHelixForTenant.push([]);
        throw new Error("provisioning blew up");
      },
    });
    const body = eventBody("organization.created", { id: "org_fail", slug: "fail-co", name: "Fail Co" });
    const result = await handleClerkWebhook(body, svixHeaders(body), deps);
    expect(result.status).toBe(200);
    // The background promise must NOT reject (the route already responded 200).
    await expect(result.background).resolves.toBeUndefined();
    // No success-path updateTenant (encrypt/activate) on failure.
    expect(calls.updateTenant.length).toBe(0);
  });

  it("organization.deleted: backs up, deletes the instance, marks tenant deleted", async () => {
    // Seed a tenant with a coolify app id via a created event first.
    const { deps, calls } = mockDeps();
    const createdBody = eventBody("organization.created", { id: "org_del", slug: "del-co", name: "Del Co" });
    const createdResult = await handleClerkWebhook(createdBody, svixHeaders(createdBody, "msg_del_create"), deps);
    await createdResult.background;
    // Simulate the provision having set the coolify app id on the tenant.
    const tenant = await deps.getTenantByClerkOrg("org_del");
    expect(tenant).not.toBeNull();
    // The mock provision wrote coolifyAppId via updateTenant in the background.
    expect(tenant!.coolifyAppId).toBe("cool-app-123");

    // Now send the deleted event.
    calls.backupInstance = [];
    calls.deleteInstance = [];
    calls.updateTenant = [];
    const delBody = eventBody("organization.deleted", { id: "org_del", slug: "del-co", name: "Del Co" });
    const result = await handleClerkWebhook(delBody, svixHeaders(delBody, "msg_del_delete"), deps);
    expect(result.status).toBe(200);
    expect(result.background).toBeUndefined();

    expect(calls.backupInstance.length).toBe(1);
    expect(calls.backupInstance[0]![0]).toBe("cool-app-123");
    expect(calls.deleteInstance.length).toBe(1);
    expect(calls.deleteInstance[0]![0]).toBe("cool-app-123");
    expect(calls.updateTenant.length).toBe(1);
    expect(calls.updateTenant[0]![1].status).toBe("deleted");
  });

  it("organization.deleted: proceeds to delete even if backup fails (best-effort)", async () => {
    const { deps, calls } = mockDeps({
      provisionHelixForTenant: async (tenant: Tenant) => {
        calls.provisionHelixForTenant.push([tenant]);
        return { url: `https://helix-${tenant.slug}.internal`, apiKey: "k", appId: "app-backup-fail" };
      },
    });
    // Seed tenant.
    const createdBody = eventBody("organization.created", { id: "org_bf", slug: "bf-co", name: "BF Co" });
    await (await handleClerkWebhook(createdBody, svixHeaders(createdBody, "msg_bf_create"), deps)).background;

    // Override backupInstance to throw.
    (deps as any).backupInstance = async () => {
      calls.backupInstance.push([]);
      throw new Error("backup failed");
    };
    calls.deleteInstance = [];
    calls.updateTenant = [];
    const delBody = eventBody("organization.deleted", { id: "org_bf", slug: "bf-co", name: "BF Co" });
    const result = await handleClerkWebhook(delBody, svixHeaders(delBody, "msg_bf_del"), deps);
    expect(result.status).toBe(200);
    // Delete still happened despite the backup failure.
    expect(calls.deleteInstance.length).toBe(1);
    expect(calls.updateTenant.length).toBe(1);
    expect(calls.updateTenant[0]![1].status).toBe("deleted");
  });

  it("organization.deleted: idempotent when no tenant exists for the org", async () => {
    const { deps, calls } = mockDeps();
    const body = eventBody("organization.deleted", { id: "org_ghost", slug: "ghost", name: "Ghost" });
    const result = await handleClerkWebhook(body, svixHeaders(body), deps);
    expect(result.status).toBe(200);
    expect(calls.backupInstance.length).toBe(0);
    expect(calls.deleteInstance.length).toBe(0);
    expect(calls.updateTenant.length).toBe(0);
  });

  it("organization.updated: updates the tenant name + slug", async () => {
    const { deps, calls } = mockDeps();
    // Seed a tenant.
    const createdBody = eventBody("organization.created", { id: "org_upd", slug: "old-slug", name: "Old Name" });
    await (await handleClerkWebhook(createdBody, svixHeaders(createdBody, "msg_upd_create"), deps)).background;

    calls.updateTenant = [];
    const updBody = eventBody("organization.updated", { id: "org_upd", slug: "new-slug", name: "New Name" });
    const result = await handleClerkWebhook(updBody, svixHeaders(updBody, "msg_upd_update"), deps);
    expect(result.status).toBe(200);
    expect(result.background).toBeUndefined();
    expect(calls.updateTenant.length).toBe(1);
    expect(calls.updateTenant[0]![1].name).toBe("New Name");
    expect(calls.updateTenant[0]![1].slug).toBe("new-slug");
  });

  it("organization.updated: idempotent when no tenant exists", async () => {
    const { deps, calls } = mockDeps();
    const body = eventBody("organization.updated", { id: "org_none", slug: "x", name: "X" });
    const result = await handleClerkWebhook(body, svixHeaders(body), deps);
    expect(result.status).toBe(200);
    expect(calls.updateTenant.length).toBe(0);
  });

  it("api_key.created: acknowledged (phase 1 stub, no tenant calls)", async () => {
    const { deps, calls } = mockDeps();
    const body = eventBody("api_key.created", { id: "apikey_1", subject: "org_1" });
    const result = await handleClerkWebhook(body, svixHeaders(body), deps);
    expect(result.status).toBe(200);
    expect(result.background).toBeUndefined();
    expect(calls.createTenant.length).toBe(0);
    expect(calls.updateTenant.length).toBe(0);
  });

  it("api_key.revoked: acknowledged (phase 1 stub)", async () => {
    const { deps, calls } = mockDeps();
    const body = eventBody("api_key.revoked", { id: "apikey_1", subject: "org_1" });
    const result = await handleClerkWebhook(body, svixHeaders(body), deps);
    expect(result.status).toBe(200);
    expect(calls.updateTenant.length).toBe(0);
  });

  it("unknown event type: acknowledged without error", async () => {
    const { deps } = mockDeps();
    const body = eventBody("user.created", { id: "user_1" });
    const result = await handleClerkWebhook(body, svixHeaders(body), deps);
    expect(result.status).toBe(200);
  });

  it("returns 400 on a bad signature (does not throw)", async () => {
    const { deps } = mockDeps();
    const body = eventBody("organization.created", { id: "org_1", slug: "a", name: "A" });
    const headers = svixHeaders(body);
    // Tamper the body after signing.
    const tampered = body.replace("org_1", "org_EVIL");
    const result = await handleClerkWebhook(tampered, headers, deps);
    expect(result.status).toBe(400);
    expect(result.background).toBeUndefined();
  });
});
