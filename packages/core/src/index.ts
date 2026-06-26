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
