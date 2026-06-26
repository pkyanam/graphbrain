// Tests for tenant CRUD (packages/core/src/control/tenants.ts).
//
// Verifies: createTenant, getTenantByClerkOrg, getTenantById, updateTenant
// (partial patch + settings JSONB round-trip), listTenants (with + without
// status filter). Uses the shared advisory lock so concurrent test files
// don't trample the `_graphbrain` schema.
//
// Each test cleans up the rows it inserts so tests within the file are
// order-independent (the schema itself is dropped in afterAll).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  primeEnv,
  polygresReachable,
  withSchemaLock,
  getPool,
  resetPool,
} from "./_helpers.ts";
import {
  runMigrations,
  dropGraphbrainSchema,
  createTenant,
  getTenantByClerkOrg,
  getTenantById,
  updateTenant,
  listTenants,
} from "../../src/index.ts";

primeEnv();
const reachable = await polygresReachable();
const itP = reachable ? it : it.skip;

describe("control/tenants — CRUD", () => {
  if (reachable) {
    beforeAll(async () => {
      primeEnv();
      await withSchemaLock(async () => {
        await dropGraphbrainSchema();
        await runMigrations();
      });
    });

    afterAll(async () => {
      await withSchemaLock(async () => {
        await dropGraphbrainSchema();
      });
      await resetPool();
    });

    beforeEach(async () => {
      // Clean tenant rows between tests so each test starts from an empty table.
      const sql = getPool();
      await sql`DELETE FROM _graphbrain.tenants`;
    });
  }

  itP("createTenant inserts a row with defaults and returns a validated Tenant", async () => {
    const t = await createTenant({
      clerkOrgId: "org_test_1",
      name: "Test Tenant 1",
      slug: "test-tenant-1",
    });
    expect(t.id).toBeTruthy();
    expect(t.clerkOrgId).toBe("org_test_1");
    expect(t.name).toBe("Test Tenant 1");
    expect(t.slug).toBe("test-tenant-1");
    expect(t.tier).toBe("free");
    expect(t.status).toBe("pending");
    expect(t.settings).toEqual({});
    expect(t.helixInstanceUrl).toBeNull();
    expect(t.helixApiKeyEncrypted).toBeNull();
    expect(t.coolifyAppId).toBeNull();
    expect(t.createdAt).toBeInstanceOf(Date);
    expect(t.updatedAt).toBeInstanceOf(Date);
  });

  itP("createTenant accepts explicit tier, status, and settings", async () => {
    const t = await createTenant({
      clerkOrgId: "org_test_2",
      name: "Pro Tenant",
      slug: "pro-tenant",
      tier: "pro",
      status: "active",
      settings: { chatModel: "anthropic:claude-opus-4-7", monthlyCostCapUsd: 100 },
    });
    expect(t.tier).toBe("pro");
    expect(t.status).toBe("active");
    expect(t.settings.chatModel).toBe("anthropic:claude-opus-4-7");
    expect(t.settings.monthlyCostCapUsd).toBe(100);
  });

  itP("getTenantByClerkOrg returns the matching tenant", async () => {
    await createTenant({
      clerkOrgId: "org_lookup",
      name: "Lookup Tenant",
      slug: "lookup-tenant",
    });
    const found = await getTenantByClerkOrg("org_lookup");
    expect(found).not.toBeNull();
    expect(found!.slug).toBe("lookup-tenant");
  });

  itP("getTenantByClerkOrg returns null for an unknown org", async () => {
    const found = await getTenantByClerkOrg("org_does_not_exist");
    expect(found).toBeNull();
  });

  itP("getTenantById returns the matching tenant", async () => {
    const created = await createTenant({
      clerkOrgId: "org_by_id",
      name: "ById Tenant",
      slug: "by-id-tenant",
    });
    const found = await getTenantById(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
  });

  itP("getTenantById returns null for an unknown id", async () => {
    const found = await getTenantById("00000000-0000-0000-0000-000000000000");
    expect(found).toBeNull();
  });

  itP("updateTenant patches only the provided fields and bumps updated_at", async () => {
    const created = await createTenant({
      clerkOrgId: "org_patch",
      name: "Patch Me",
      slug: "patch-me",
    });
    // Sleep briefly so updated_at is distinguishable from created_at.
    await new Promise((r) => setTimeout(r, 50));
    const updated = await updateTenant(created.id, { status: "active", tier: "pro" });
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("active");
    expect(updated!.tier).toBe("pro");
    expect(updated!.name).toBe("Patch Me"); // unchanged
    expect(updated!.slug).toBe("patch-me"); // unchanged
    expect(updated!.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
  });

  itP("updateTenant replaces settings JSONB (no deep-merge)", async () => {
    const created = await createTenant({
      clerkOrgId: "org_settings",
      name: "Settings Tenant",
      slug: "settings-tenant",
      settings: { chatModel: "anthropic:claude-sonnet-4-6", monthlyCostCapUsd: 50 },
    });
    const updated = await updateTenant(created.id, {
      settings: { chatModel: "anthropic:claude-opus-4-7" },
    });
    expect(updated).not.toBeNull();
    expect(updated!.settings.chatModel).toBe("anthropic:claude-opus-4-7");
    // monthlyCostCapUsd was replaced, not merged.
    expect(updated!.settings.monthlyCostCapUsd).toBeUndefined();
  });

  itP("updateTenant with an empty patch returns the current row unchanged", async () => {
    const created = await createTenant({
      clerkOrgId: "org_empty_patch",
      name: "Empty Patch",
      slug: "empty-patch",
    });
    const result = await updateTenant(created.id, {});
    expect(result).not.toBeNull();
    expect(result!.id).toBe(created.id);
    expect(result!.name).toBe("Empty Patch");
  });

  itP("updateTenant returns null for an unknown id", async () => {
    const result = await updateTenant("00000000-0000-0000-0000-000000000000", {
      status: "active",
    });
    expect(result).toBeNull();
  });

  itP("updateTenant can set helix_instance_url + encrypted key (Stage 3 contract)", async () => {
    const created = await createTenant({
      clerkOrgId: "org_helix",
      name: "Helix Tenant",
      slug: "helix-tenant",
    });
    const updated = await updateTenant(created.id, {
      helixInstanceUrl: "https://helix-tenant.internal:8080",
      helixApiKeyEncrypted: "base64(iv:ciphertext:tag)",
      coolifyAppId: "cool-app-123",
      status: "active",
    });
    expect(updated).not.toBeNull();
    expect(updated!.helixInstanceUrl).toBe("https://helix-tenant.internal:8080");
    expect(updated!.helixApiKeyEncrypted).toBe("base64(iv:ciphertext:tag)");
    expect(updated!.coolifyAppId).toBe("cool-app-123");
    expect(updated!.status).toBe("active");
  });

  itP("listTenants returns all tenants ordered by created_at desc", async () => {
    await createTenant({ clerkOrgId: "org_a", name: "A", slug: "a" });
    await new Promise((r) => setTimeout(r, 20));
    await createTenant({ clerkOrgId: "org_b", name: "B", slug: "b" });
    const all = await listTenants();
    expect(all.length).toBe(2);
    // Most recently created first.
    expect(all[0]!.slug).toBe("b");
    expect(all[1]!.slug).toBe("a");
  });

  itP("listTenants filters by status", async () => {
    await createTenant({ clerkOrgId: "org_p1", name: "P1", slug: "p1", status: "pending" });
    await createTenant({ clerkOrgId: "org_a1", name: "A1", slug: "a1", status: "active" });
    const active = await listTenants("active");
    expect(active.length).toBe(1);
    expect(active[0]!.slug).toBe("a1");
    const pending = await listTenants("pending");
    expect(pending.length).toBe(1);
    expect(pending[0]!.slug).toBe("p1");
  });

  itP("createTenant rejects a duplicate clerk_org_id (unique constraint)", async () => {
    await createTenant({ clerkOrgId: "org_dup", name: "First", slug: "first" });
    await expect(
      createTenant({ clerkOrgId: "org_dup", name: "Second", slug: "second" }),
    ).rejects.toThrow();
  });

  itP("createTenant rejects a duplicate slug (unique constraint)", async () => {
    await createTenant({ clerkOrgId: "org_s1", name: "S1", slug: "dup-slug" });
    await expect(
      createTenant({ clerkOrgId: "org_s2", name: "S2", slug: "dup-slug" }),
    ).rejects.toThrow();
  });
});
