// Tests for the Polygres connection pool (packages/core/src/control/db.ts).
//
// Verifies: lazy singleton creation, `withTransaction` commit + rollback
// semantics, `isReachable` probe, `resetPool` teardown. Skips cleanly when
// Polygres is unreachable.
//
// This file does NOT need migrations (it tests the pool itself, using
// throwaway tables under the `_graphbrain` schema), but it still acquires the
// shared advisory lock so it doesn't race with migrations/tenants test files
// that drop the schema.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  primeEnv,
  polygresReachable,
  withSchemaLock,
  getPool,
  resetPool,
} from "./_helpers.ts";
import {
  hasPool,
  withTransaction,
  isReachable,
  runMigrations,
  dropGraphbrainSchema,
} from "../../src/index.ts";

primeEnv();
const reachable = await polygresReachable();
const itP = reachable ? it : it.skip;

describe("control/db — pool singleton", () => {
  if (reachable) {
    // Acquire lock + ensure schema exists once for the whole file.
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

  itP("getPool() lazily creates a singleton", () => {
    // The beforeAll may have already created the pool via runMigrations.
    // Reset first so we observe the lazy creation cleanly.
    expect(hasPool()).toBe(true);
    const pool = getPool();
    expect(getPool()).toBe(pool);
  });

  itP("isReachable() resolves true against the Docker Compose Polygres", async () => {
    const ok = await isReachable();
    expect(ok).toBe(true);
  });
});

describe("control/db — withTransaction", () => {
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

  itP("commits when fn returns normally", async () => {
    const sql = getPool();
    await withTransaction(async (tx) => {
      await tx`CREATE TABLE IF NOT EXISTS _graphbrain._dbtest_tx (id int)`;
      await tx`INSERT INTO _graphbrain._dbtest_tx (id) VALUES (1)`;
    });
    const rows = await sql<{ id: number }[]>`SELECT id FROM _graphbrain._dbtest_tx`;
    expect(rows.map((r) => r.id)).toContain(1);
    await sql`DROP TABLE IF EXISTS _graphbrain._dbtest_tx`;
  });

  itP("rolls back when fn throws", async () => {
    const sql = getPool();
    await sql`CREATE TABLE IF NOT EXISTS _graphbrain._dbtest_rb (id int)`;
    await expect(
      withTransaction(async (tx) => {
        await tx`DELETE FROM _graphbrain._dbtest_rb`;
        await tx`INSERT INTO _graphbrain._dbtest_rb (id) VALUES (42)`;
        throw new Error("intentional rollback");
      }),
    ).rejects.toThrow("intentional rollback");
    const rows = await sql<{ id: number }[]>`SELECT id FROM _graphbrain._dbtest_rb`;
    expect(rows.length).toBe(0);
    await sql`DROP TABLE IF EXISTS _graphbrain._dbtest_rb`;
  });
});

describe("control/db — resetPool", () => {
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

  itP("resetPool() tears down the singleton so the next getPool() re-creates", async () => {
    const pool = getPool();
    expect(hasPool()).toBe(true);
    await resetPool();
    expect(hasPool()).toBe(false);
    const pool2 = getPool();
    expect(pool2).not.toBe(pool);
  });
});
