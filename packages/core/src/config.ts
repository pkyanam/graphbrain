// @graphbrain/core — env-driven config singleton validated with Zod.
//
// Ports GBrain's config resolution pattern (_reference/gbrain/src/core/config.ts)
// and adapts it to Graphbrain's multi-tenant architecture: global defaults
// live here, per-tenant overrides live in `tenants.settings` (TenantSettings,
// defined in ./schemas.ts). The resolution chain at operation time is:
//
//   per-call override → tenant.settings → global config defaults
//
// `loadConfig()` reads `process.env`, validates against `ConfigSchema`, and
// returns a frozen `Config` object. A module-level singleton `config` is
// exported for convenience; tests should call `loadConfig(envOverride)` with
// an explicit env dict to avoid cross-test contamination.

import { z } from "zod";
import type { TenantSettings } from "./types";
import { SearchModeSchema, CRModeSchema } from "./schemas";

// ─── Config schema ───────────────────────────────────────────────────────────

/**
 * Global config shape. Required vars are the operator-provisioned secrets
 * (see IMPLEMENTATION.md "Prerequisites"). Optional vars have sensible
 * defaults for local dev (set by docker-compose).
 */
export const ConfigSchema = z.object({
  // Clerk
  clerkSecretKey: z.string().min(1, "CLERK_SECRET_KEY is required"),
  clerkPublishableKey: z.string().min(1, "CLERK_PUBLISHABLE_KEY is required"),
  clerkJwtIssuer: z.string().min(1, "CLERK_JWT_ISSUER is required"),
  clerkWebhookSecret: z.string().min(1, "CLERK_WEBHOOK_SECRET is required"),
  // Clerk Backend API base URL (BAPI). Distinct from `clerkJwtIssuer` (the
  // Frontend API / JWT issuer used for JWKS). The BAPI is conventionally
  // `https://api.clerk.com/v1`; overridable for self-hosted instances.
  clerkApiUrl: z.string().url("CLERK_API_URL must be a valid URL").default("https://api.clerk.com/v1"),

  // Coolify
  coolifyApiUrl: z.string().url("COOLIFY_API_URL must be a valid URL"),
  coolifyApiToken: z.string().min(1, "COOLIFY_API_TOKEN is required"),
  coolifyServerUuid: z.string().min(1, "COOLIFY_SERVER_UUID is required"),

  // OpenRouter
  openrouterApiKey: z.string().min(1, "OPENROUTER_API_KEY is required"),

  // Encryption (AES-256-GCM, 32 bytes base64)
  encryptionKey: z.string().min(1, "ENCRYPTION_KEY is required"),

  // Polygres (control plane)
  polygresDatabaseUrl: z.string().url("POLYGRES_DATABASE_URL must be a valid URL"),

  // MinIO (object storage)
  minioEndpoint: z.string().url("MINIO_ENDPOINT must be a valid URL"),
  minioAccessKey: z.string().min(1, "MINIO_ACCESS_KEY is required"),
  minioSecretKey: z.string().min(1, "MINIO_SECRET_KEY is required"),

  // HelixDB (local dev instance; per-tenant instances are provisioned via Coolify)
  helixInstanceUrl: z.string().url().optional(),
  helixApiKey: z.string().optional(),

  // ─── Runtime defaults (optional; sensible for local dev) ───
  // `z.preprocess` injects `{}` when absent so the inner per-field `.default()`
  // values fill in — the output type always has a fully-populated `defaults`.
  defaults: z.preprocess(
    (v) => v ?? {},
    z.object({
      chatModel: z.string().default("anthropic:claude-sonnet-4-6"),
      embeddingModel: z.string().default("voyage:voyage-3-large"),
      embeddingDimensions: z.number().int().positive().max(8192).default(1024),
      searchMode: SearchModeSchema.default("balanced"),
      contextualRetrievalMode: CRModeSchema.default("none"),
      rerankerEnabled: z.boolean().default(false),
      /** Global monthly cost cap per tenant (USD). Tenant settings can lower it. */
      tenantMonthlyCostCapUsd: z.number().nonnegative().default(50),
    }),
  ),

  // ─── Operational knobs ───
  /** When true, operations log at debug level + skip cost enforcement (local dev). */
  debug: z.boolean().default(false),
  /** HTTP port for the API server. */
  apiPort: z.number().int().positive().max(65535).default(3000),
});

export type Config = z.infer<typeof ConfigSchema>;

// ─── Env → config field mapping ──────────────────────────────────────────────

/**
 * Map env var names → config field names. Centralized so the mapping is
 * auditable in one place. `loadConfig()` reads env vars via this map.
 */
const ENV_MAP = {
  CLERK_SECRET_KEY: "clerkSecretKey",
  CLERK_PUBLISHABLE_KEY: "clerkPublishableKey",
  CLERK_JWT_ISSUER: "clerkJwtIssuer",
  CLERK_WEBHOOK_SECRET: "clerkWebhookSecret",
  CLERK_API_URL: "clerkApiUrl",
  COOLIFY_API_URL: "coolifyApiUrl",
  COOLIFY_API_TOKEN: "coolifyApiToken",
  COOLIFY_SERVER_UUID: "coolifyServerUuid",
  OPENROUTER_API_KEY: "openrouterApiKey",
  ENCRYPTION_KEY: "encryptionKey",
  POLYGRES_DATABASE_URL: "polygresDatabaseUrl",
  MINIO_ENDPOINT: "minioEndpoint",
  MINIO_ACCESS_KEY: "minioAccessKey",
  MINIO_SECRET_KEY: "minioSecretKey",
  HELIX_INSTANCE_URL: "helixInstanceUrl",
  HELIX_API_KEY: "helixApiKey",
  GRAPHBRAIN_DEBUG: "debug",
  API_PORT: "apiPort",
} as const satisfies Record<string, keyof Omit<Config, "defaults">>;

type EnvVarName = keyof typeof ENV_MAP;

// ─── Loader ──────────────────────────────────────────────────────────────────

/**
 * Read env vars, validate, and return a frozen `Config`.
 *
 * @param env — env source (defaults to `process.env`). Pass an explicit dict
 *   in tests to avoid cross-test contamination.
 * @throws {z.ZodError} with a clear message listing every missing/invalid var.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const raw: Record<string, unknown> = {};

  for (const [envName, fieldName] of Object.entries(ENV_MAP) as [EnvVarName, string][]) {
    const value = env[envName];
    if (value !== undefined && value !== "") {
      // Coerce known numeric / boolean fields.
      if (fieldName === "apiPort") {
        const n = Number(value);
        raw[fieldName] = Number.isFinite(n) ? n : value;
      } else if (fieldName === "debug") {
        raw[fieldName] = value === "true" || value === "1";
      } else {
        raw[fieldName] = value;
      }
    }
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    // Reverse map: config field name → env var name, for actionable errors.
    const fieldToEnv = Object.fromEntries(
      Object.entries(ENV_MAP).map(([envName, field]) => [field, envName]),
    );
    // Flatten the error into a clear, actionable message using ENV var names.
    const issues = parsed.error.issues
      .map((i) => {
        const field = i.path.join(".");
        const envName = fieldToEnv[field] ?? field;
        return `  - ${envName}: ${i.message}`;
      })
      .join("\n");
    throw new Error(
      `Graphbrain config validation failed. Fix these env vars:\n${issues}\n` +
        `See .env.example for the full list.`,
    );
  }
  return Object.freeze(parsed.data);
}

// ─── Singleton ───────────────────────────────────────────────────────────────

/**
 * Module-level config singleton. Lazily loaded on first access so importing
 * `@graphbrain/core` doesn't trigger env validation in environments where the
 * operator hasn't set up `.env` yet (e.g. typecheck, unit tests that don't
 * touch config).
 *
 * Tests that need a fresh config should call `loadConfig(envOverride)` directly
 * rather than mutating this singleton.
 */
let _config: Config | null = null;

/** Lazily-resolved config singleton. Throws if env is invalid. */
export function getConfig(): Config {
  if (_config === null) _config = loadConfig();
  return _config;
}

/** Reset the singleton (test helper). */
export function resetConfig(): void {
  _config = null;
}

// ─── Tenant override resolution ──────────────────────────────────────────────

/**
 * Resolve an effective setting by walking the precedence chain:
 *   per-call override → tenant.settings → global config default.
 *
 * Returns the first non-undefined value, or `undefined` if none of the three
 * layers set it. Use this at the operation boundary so per-tenant overrides
 * transparently win over global defaults.
 */
export function resolveSetting<K extends keyof TenantSettings>(
  config: Config,
  tenantSettings: TenantSettings | undefined,
  perCall: Partial<TenantSettings> | undefined,
  key: K,
): TenantSettings[K] | undefined {
  if (perCall && perCall[key] !== undefined) return perCall[key];
  if (tenantSettings && tenantSettings[key] !== undefined) return tenantSettings[key];
  // Map TenantSettings keys → Config.defaults keys (same names by convention).
  const def = config.defaults as unknown as Record<string, unknown>;
  return def[key as string] as TenantSettings[K] | undefined;
}
