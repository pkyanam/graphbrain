// @graphbrain/core — shared library barrel export.
//
// Stage 1: core domain types, Zod schemas, and the env-driven config singleton.
// Subsequent stages add the control plane (Stage 2), Coolify integration
// (Stage 3), Clerk (Stage 4), HelixDB engines (Stage 6), and the retrieval
// pipeline (Stage 10). See IMPLEMENTATION.md for the build order.

// Types
export * from "./types";

// Schemas
export * from "./schemas";

// Config
export {
  ConfigSchema,
  loadConfig,
  getConfig,
  resetConfig,
  resolveSetting,
} from "./config";
export type { Config } from "./config";

// Control plane (Stage 2) — Polygres pool, migrations, tenant CRUD.
// All of these are lazy: importing @graphbrain/core does NOT open a DB
// connection or validate env. The pool is created on first `getPool()` call.
export {
  getPool,
  resetPool,
  hasPool,
  connectedUrl,
  isReachable,
  withTransaction,
} from "./control/db";
export type { Sql } from "./control/db";

export {
  runMigrations,
  dropGraphbrainSchema,
  MIGRATIONS,
} from "./control/migrations/index";
export type { Migration } from "./control/migrations/index";

export {
  createTenant,
  getTenantByClerkOrg,
  getTenantById,
  updateTenant,
  listTenants,
} from "./control/tenants";
export type {
  CreateTenantInput,
  UpdateTenantPatch,
} from "./control/tenants";
