// Tests for the migration runner (packages/core/src/control/migrations/index.ts).
//
// Verifies: runMigrations() creates the tracking table + all Phase 1 tables,
// is idempotent (running twice applies nothing the second time and produces
// no duplicate tracking rows), and the expected tables/indexes exist.
//
// Uses the shared advisory lock so concurrent test files don't trample the
// `_graphbrain` schema. The schema is dropped + recreated in beforeAll and
// dropped again in afterAll.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
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
  MIGRATIONS,
} from "../../src/index.ts";

primeEnv();
const reachable = await polygresReachable();
const itP = reachable ? it : it.skip;

describe("control/migrations — runMigrations", () => {
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
  }

  itP("applies all Phase 1 migrations on a fresh DB (beforeAll already ran them)", async () => {
    // beforeAll ran runMigrations once. Re-run and assert nothing new applies.
    const applied = await runMigrations();
    expect(applied).toEqual([]);
  });

  itP("records all migrations in the tracking table", async () => {
    const sql = getPool();
    const rows = await sql<{ version: number; name: string }[]>`
      SELECT version, name FROM _graphbrain.migrations ORDER BY version ASC
    `;
    expect(rows.map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(rows.map((r) => r.name)).toEqual(MIGRATIONS.map((m) => m.name));
  });

  itP("is idempotent — re-running adds no new tracking rows", async () => {
    const sql = getPool();
    const before = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM _graphbrain.migrations
    `;
    const beforeCount = before[0]?.count ?? 0;

    const applied = await runMigrations();
    expect(applied).toEqual([]);

    const after = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM _graphbrain.migrations
    `;
    const afterCount = after[0]?.count ?? 0;
    expect(afterCount).toBe(beforeCount);
    expect(afterCount).toBe(MIGRATIONS.length);
  });

  itP("creates the expected Phase 1 tables", async () => {
    const sql = getPool();
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = '_graphbrain'
      ORDER BY table_name
    `;
    const names = tables.map((r) => r.table_name);
    expect(names).toContain("tenants");
    expect(names).toContain("oauth_clients");
    expect(names).toContain("oauth_tokens");
    expect(names).toContain("query_cache");
    expect(names).toContain("migrations");
  });

  itP("creates the query_cache composite index on (tenant_id, query_hash, knobs_hash)", async () => {
    const sql = getPool();
    const indexes = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = '_graphbrain' AND tablename = 'query_cache'
    `;
    const names = indexes.map((r) => r.indexname);
    expect(names).toContain("idx_query_cache_tenant_query_knobs");
  });

  itP("creates the tenants indexes on clerk_org_id and slug", async () => {
    const sql = getPool();
    const indexes = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = '_graphbrain' AND tablename = 'tenants'
    `;
    const names = indexes.map((r) => r.indexname);
    expect(names).toContain("idx_tenants_clerk_org_id");
    expect(names).toContain("idx_tenants_slug");
  });
});
