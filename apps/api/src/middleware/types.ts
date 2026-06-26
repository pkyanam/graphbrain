// Express Request augmentation for Graphbrain's auth + tenant pipeline.
//
// Stage 5 middleware (clerk-auth → tenant-resolver → context) populates these
// fields on `req` in order. Downstream route handlers (Stage 12) read
// `req.context` (a fully populated OperationContext) and `req.helixCreds`
// (the decrypted per-tenant HelixDB API key + URL).
//
// The augmentation targets `express-serve-static-core` (the type surface that
// Express 5 re-exports), so it applies to every `Request` across the app.
// All fields are optional — public routes (health, webhooks) never set them,
// and the auth/resolver middleware themselves read earlier fields.

import type { AuthInfo, Tenant, OperationContext } from "@graphbrain/core";

/**
 * Decrypted HelixDB credentials for the resolved tenant. Attached by
 * `tenantResolver` after decrypting `tenant.helixApiKeyEncrypted`. Stage 6's
 * HelixEngine + Stage 11's MCP dispatch consume this to open a per-tenant
 * HelixDB client.
 */
export interface HelixCreds {
  /** HelixDB instance base URL (e.g. `https://helix-<tenant>.belweave.ai`). */
  url: string;
  /** Decrypted HelixDB API key (plaintext — never log this). */
  apiKey: string;
}

declare module "express-serve-static-core" {
  interface Request {
    /** Set by `clerkAuth` — the verified calling principal (JWT or API key). */
    auth?: AuthInfo;
    /** Set by `tenantResolver` — the resolved Graphbrain tenant row. */
    tenant?: Tenant;
    /** Set by `tenantResolver` — decrypted HelixDB creds for the tenant. */
    helixCreds?: HelixCreds;
    /** Set by `contextBuilder` — fully populated OperationContext for handlers. */
    context?: OperationContext;
  }
}

export {};
