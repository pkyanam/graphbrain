// @graphbrain/core — tenant CRUD against `_graphbrain.tenants`.
//
// Boundary validation: every row read from the DB is parsed through
// `TenantSchema` (from ../schemas) before being returned, so a corrupted
// or out-of-contract row fails loudly at the boundary instead of leaking
// into operation handlers.
//
// JSONB invariant (Stage 1 note #2 / GBrain CLAUDE.md): the `settings` column
// is JSONB. We pass the raw `TenantSettings` object to postgres.js via
// `sql.json()`, which serializes it natively — NEVER `JSON.stringify` into a
// `::jsonb` cast (postgres.js would double-encode it as a jsonb string scalar).

import postgres from "postgres";
import type { Tenant, TenantSettings, TenantTier, TenantStatus } from "../types";
import { TenantSchema } from "../schemas";
import { getPool, type Sql } from "./db";

// ─── Input shapes ────────────────────────────────────────────────────────────

/** Required + optional fields for creating a tenant. */
export interface CreateTenantInput {
  clerkOrgId: string;
  name: string;
  slug: string;
  tier?: TenantTier;
  status?: TenantStatus;
  settings?: TenantSettings;
  /** Set by Stage 3 once Coolify provisioning completes; null until then. */
  helixInstanceUrl?: string | null;
  helixApiKeyEncrypted?: string | null;
  coolifyAppId?: string | null;
}

/** Patch shape for `updateTenant`. All fields optional; only set fields are updated. */
export interface UpdateTenantPatch {
  name?: string;
  slug?: string;
  tier?: TenantTier;
  status?: TenantStatus;
  settings?: TenantSettings;
  helixInstanceUrl?: string | null;
  helixApiKeyEncrypted?: string | null;
  coolifyAppId?: string | null;
}

/**
 * Cast a TenantSettings object to postgres.js's JSONValue for `sql.json()`.
 * TenantSettings is a known JSON-serializable shape; the cast bridges the
 * interface (no string index signature) and JSONValue (requires one).
 * Returns `any` so it's assignable to the `sql.json()` parameter type.
 */
function asJson(value: TenantSettings): any {
  return value;
}

/** Raw DB row shape (snake_case, as returned by postgres.js). */
interface TenantRow {
  id: string;
  clerk_org_id: string;
  name: string;
  slug: string;
  helix_instance_url: string | null;
  helix_api_key_encrypted: string | null;
  coolify_app_id: string | null;
  tier: TenantTier;
  status: TenantStatus;
  settings: TenantSettings;
  created_at: Date;
  updated_at: Date;
}

/**
 * Convert a snake_case DB row into the camelCase `Tenant` domain type.
 * Parses through `TenantSchema` for boundary validation.
 *
 * The `as Tenant` cast bridges the schema's `.nullish()` (string | null | undefined)
 * output and the hand-written `Tenant` type (string | null) — the schema validates
 * the value, the cast reconciles the nullable-vs-nullish type difference.
 */
function rowToTenant(row: TenantRow): Tenant {
  const tenant: Tenant = {
    id: row.id,
    clerkOrgId: row.clerk_org_id,
    name: row.name,
    slug: row.slug,
    helixInstanceUrl: row.helix_instance_url ?? null,
    helixApiKeyEncrypted: row.helix_api_key_encrypted ?? null,
    coolifyAppId: row.coolify_app_id ?? null,
    tier: row.tier,
    status: row.status,
    settings: row.settings ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return TenantSchema.parse(tenant) as Tenant;
}

/** Cast a postgres.js row list to TenantRow[] (avoids generic-on-template issues). */
function asRows(rows: unknown): TenantRow[] {
  return rows as TenantRow[];
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

/**
 * Insert a new tenant row. `settings` defaults to `{}` if omitted.
 * Returns the created tenant (with server-stamped id + timestamps).
 */
export async function createTenant(data: CreateTenantInput): Promise<Tenant> {
  const sql = getPool();
  const rows = asRows(
    await sql`
      INSERT INTO _graphbrain.tenants
        (clerk_org_id, name, slug, helix_instance_url, helix_api_key_encrypted,
         coolify_app_id, tier, status, settings)
      VALUES
        (${data.clerkOrgId}, ${data.name}, ${data.slug},
         ${data.helixInstanceUrl ?? null}, ${data.helixApiKeyEncrypted ?? null},
         ${data.coolifyAppId ?? null}, ${data.tier ?? "free"},
         ${data.status ?? "pending"},
         ${sql.json(asJson(data.settings ?? ({} as TenantSettings)))})
      RETURNING *
    `,
  );
  if (rows.length === 0) {
    throw new Error(`createTenant: insert returned no rows for slug=${data.slug}`);
  }
  return rowToTenant(rows[0]!);
}

/** Look up a tenant by its Clerk organization id. Returns null if not found. */
export async function getTenantByClerkOrg(orgId: string): Promise<Tenant | null> {
  const sql = getPool();
  const rows = asRows(
    await sql`SELECT * FROM _graphbrain.tenants WHERE clerk_org_id = ${orgId} LIMIT 1`,
  );
  return rows.length > 0 ? rowToTenant(rows[0]!) : null;
}

/** Look up a tenant by its UUID primary key. Returns null if not found. */
export async function getTenantById(id: string): Promise<Tenant | null> {
  const sql = getPool();
  const rows = asRows(
    await sql`SELECT * FROM _graphbrain.tenants WHERE id = ${id} LIMIT 1`,
  );
  return rows.length > 0 ? rowToTenant(rows[0]!) : null;
}

/**
 * Patch a tenant row. Only the fields present in `patch` are updated; the
 * `updated_at` column is bumped automatically. Returns the updated tenant,
 * or null if no row matched `id`.
 *
 * `settings`, when present in the patch, REPLACES the existing JSONB value
 * (no deep-merge at this layer — callers compose the merged object if needed).
 *
 * Implementation note: the dynamic SET clause is built by composing postgres.js
 * fragments — one per `column = value` pair — joined by `sql.unsafe(', ')`
 * raw-text separator fragments. This keeps every value flowing through
 * postgres.js's parameter binding (including `sql.json()` for the JSONB
 * `settings` column) so the RETURNING clause parses jsonb correctly. Using
 * `sql.unsafe` for the whole query breaks jsonb result parsing on the
 * connection, so we avoid that path entirely.
 */
export async function updateTenant(
  id: string,
  patch: UpdateTenantPatch,
): Promise<Tenant | null> {
  // Nothing to update — return the current row so callers get a Tenant back.
  if (
    patch.name === undefined &&
    patch.slug === undefined &&
    patch.tier === undefined &&
    patch.status === undefined &&
    patch.settings === undefined &&
    patch.helixInstanceUrl === undefined &&
    patch.helixApiKeyEncrypted === undefined &&
    patch.coolifyAppId === undefined
  ) {
    return getTenantById(id);
  }

  const sql = getPool();
  // Build one fragment per `column = value` pair. Unset fields are skipped so
  // they aren't clobbered (e.g. helix_api_key_encrypted stays NULL on a
  // status-only patch). `sql.json()` serializes the settings object natively
  // for the JSONB column (never JSON.stringify into ::jsonb — see Stage 1
  // note #2 / GBrain CLAUDE.md JSONB invariant).
  const parts: postgres.Fragment[] = [];
  if (patch.name !== undefined) parts.push(sql`name = ${patch.name}`);
  if (patch.slug !== undefined) parts.push(sql`slug = ${patch.slug}`);
  if (patch.tier !== undefined) parts.push(sql`tier = ${patch.tier}`);
  if (patch.status !== undefined) parts.push(sql`status = ${patch.status}`);
  if (patch.settings !== undefined) parts.push(sql`settings = ${sql.json(asJson(patch.settings))}`);
  if (patch.helixInstanceUrl !== undefined) parts.push(sql`helix_instance_url = ${patch.helixInstanceUrl}`);
  if (patch.helixApiKeyEncrypted !== undefined) parts.push(sql`helix_api_key_encrypted = ${patch.helixApiKeyEncrypted}`);
  if (patch.coolifyAppId !== undefined) parts.push(sql`coolify_app_id = ${patch.coolifyAppId}`);
  // Always bump updated_at (no parameter — `now()` is server-side).
  parts.push(sql`updated_at = now()`);

  // Compose fragments with raw-text `, ` separators. `sql.unsafe(', ')` creates
  // a fragment with literal text and no parameters, so it doesn't become a
  // bind value (which is what happens if you interpolate a plain string).
  const comma = sql.unsafe(", ");
  let setClause = parts[0]!;
  for (let i = 1; i < parts.length; i++) {
    setClause = sql`${setClause}${comma}${parts[i]!}`;
  }

  const rows = asRows(
    await sql`
      UPDATE _graphbrain.tenants SET ${setClause}
      WHERE id = ${id} AND status <> 'deleted'
      RETURNING *
    `,
  );
  return rows.length > 0 ? rowToTenant(rows[0]!) : null;
}

/** List all tenants, optionally filtered by status. Ordered by created_at desc. */
export async function listTenants(status?: TenantStatus): Promise<Tenant[]> {
  const sql: Sql = getPool();
  const rows = status
    ? asRows(
        await sql`
          SELECT * FROM _graphbrain.tenants WHERE status = ${status}
          ORDER BY created_at DESC
        `,
      )
    : asRows(
        await sql`
          SELECT * FROM _graphbrain.tenants ORDER BY created_at DESC
        `,
      );
  return rows.map(rowToTenant);
}
