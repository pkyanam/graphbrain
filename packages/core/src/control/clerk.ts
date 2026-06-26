// @graphbrain/core — Clerk Backend API client.
//
// Wraps the Clerk Backend API (BAPI, base `https://api.clerk.com/v1` by
// default — overridable via `CLERK_API_URL`) for organization + API-key
// management and JWT verification support. All BAPI requests carry
// `Authorization: Bearer ${CLERK_SECRET_KEY}`.
//
// Config is read lazily INSIDE each function (via `getConfig()`), not at
// module top level, so importing `@graphbrain/core` does not require a valid
// `.env` (Stage 2 note #1). The BAPI base URL comes from
// `getConfig().clerkApiUrl`; the JWKS URL is derived from
// `getConfig().clerkJwtIssuer` (the Frontend API / JWT issuer).
//
// Endpoint shapes are per the Clerk Backend API reference:
//   - GET  /organizations/{organization_id}          → Organization
//   - GET  /api_keys?subject={orgId}                 → { data: APIKey[], total_count }
//   - POST /api_keys                                  → APIKey (create)
//   - POST /api_keys/{apiKeyId}/revoke                → APIKey (revoke)
//   - POST /api_keys/verify                           → APIKey (verify a secret)
//   - GET  {clerkJwtIssuer}/.well-known/jwks.json     → JWKS (cached in-memory)

import { getConfig } from "../config";

// ─── Response shapes ─────────────────────────────────────────────────────────

/** Clerk Organization (subset — the fields Graphbrain uses). */
export interface ClerkOrganization {
  id: string;
  slug: string;
  name: string;
}

/** Clerk API key metadata (never the raw secret — Clerk does not return it). */
export interface ClerkApiKey {
  id: string;
  name: string;
  /** The user or organization id the key is scoped to (`org_…` / `user_…`). */
  subject: string;
  scopes: string[];
  revoked: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Result of verifying an API key secret against Clerk. */
export interface VerifiedApiKey {
  /** Clerk organization id (`subject` from the verified API key). */
  orgId: string;
  /** Organization slug (resolved via a follow-up `getOrganization` call). */
  orgSlug: string;
  /** Scopes granted to the key. */
  scopes: string[];
  /** The Clerk API key id. */
  keyId: string;
}

/** JSON Web Key Set (raw Clerk JWKS response). */
export interface Jwks {
  keys: Array<{
    kty: string;
    kid: string;
    alg: string;
    use: string;
    n?: string;
    e?: string;
    crv?: string;
    x?: string;
    y?: string;
    [k: string]: unknown;
  }>;
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

/** Clerk BAPI base URL with any trailing slashes stripped. */
function clerkBase(): string {
  return getConfig().clerkApiUrl.replace(/\/+$/, "");
}

/** Standard auth + JSON headers for every Clerk BAPI request. */
function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getConfig().clerkSecretKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/**
 * Issue a request against the Clerk Backend API. Merges auth headers with any
 * caller-supplied headers (caller headers win on conflict).
 */
async function clerkFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = `${clerkBase()}${path}`;
  const headers: Record<string, string> = { ...authHeaders() };
  if (init.headers) {
    const incoming = init.headers as Record<string, string>;
    for (const [k, v] of Object.entries(incoming)) headers[k] = v;
  }
  return fetch(url, { ...init, headers });
}

/** Read the response body as text, never throwing (for error messages). */
async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** Coerce an unknown Clerk API key row into the typed shape (fail-closed). */
function rowToApiKey(raw: unknown): ClerkApiKey {
  const r = raw as Record<string, unknown>;
  const id = r.id;
  const subject = r.subject;
  if (typeof id !== "string" || typeof subject !== "string") {
    throw new Error("clerk: API key response missing id or subject");
  }
  const scopes = Array.isArray(r.scopes) ? (r.scopes as string[]) : [];
  return {
    id,
    name: typeof r.name === "string" ? r.name : "",
    subject,
    scopes,
    revoked: r.revoked === true,
    createdAt: typeof r.created_at === "string" ? r.created_at : "",
    updatedAt: typeof r.updated_at === "string" ? r.updated_at : "",
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Retrieve a Clerk organization by id (or slug). Returns `{ id, slug, name }`.
 *
 * @throws if the organization does not exist or Clerk returns a non-2xx.
 */
export async function getOrganization(orgIdOrSlug: string): Promise<ClerkOrganization> {
  const res = await clerkFetch(`/organizations/${encodeURIComponent(orgIdOrSlug)}`, {
    method: "GET",
  });
  if (!res.ok) {
    throw new Error(
      `getOrganization: Clerk GET /organizations/${orgIdOrSlug} failed (${res.status}): ${await safeText(res)}`,
    );
  }
  const json = (await res.json()) as Record<string, unknown>;
  const id = json.id;
  const slug = json.slug;
  const name = json.name;
  if (typeof id !== "string" || typeof slug !== "string" || typeof name !== "string") {
    throw new Error(
      `getOrganization: Clerk response missing id/slug/name for "${orgIdOrSlug}"`,
    );
  }
  return { id, slug, name };
}

/**
 * List API keys scoped to an organization. Returns metadata only (Clerk never
 * returns the raw secret after creation). The BAPI endpoint is
 * `GET /api_keys?subject={orgId}`.
 */
export async function listOrganizationApiKeys(orgId: string): Promise<ClerkApiKey[]> {
  const res = await clerkFetch(
    `/api_keys?subject=${encodeURIComponent(orgId)}&limit=100`,
    { method: "GET" },
  );
  if (!res.ok) {
    throw new Error(
      `listOrganizationApiKeys: Clerk GET /api_keys failed (${res.status}): ${await safeText(res)}`,
    );
  }
  const json = (await res.json()) as Record<string, unknown>;
  const data = Array.isArray(json.data) ? json.data : [];
  return data.map(rowToApiKey);
}

/** Options for creating an organization-scoped API key. */
export interface CreateApiKeyInput {
  name: string;
  /** Organization id (`org_…`) the key is scoped to. */
  subject: string;
  description?: string;
  scopes?: string[];
  /** Lifetime in seconds (optional). */
  secondsUntilExpiration?: number;
}

/**
 * Create a new Clerk API key scoped to an organization. Returns the created
 * key metadata PLUS the raw secret (only returned once, at creation time).
 */
export async function createApiKey(input: CreateApiKeyInput): Promise<ClerkApiKey & { secret: string | null }> {
  const body: Record<string, unknown> = {
    name: input.name,
    subject: input.subject,
  };
  if (input.description !== undefined) body.description = input.description;
  if (input.scopes !== undefined) body.scopes = input.scopes;
  if (input.secondsUntilExpiration !== undefined) body.seconds_until_expiration = input.secondsUntilExpiration;
  const res = await clerkFetch("/api_keys", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `createApiKey: Clerk POST /api_keys failed (${res.status}): ${await safeText(res)}`,
    );
  }
  const json = (await res.json()) as Record<string, unknown>;
  const key = rowToApiKey(json);
  // The raw secret is only present in the create response (`secret` field).
  const secret = typeof json.secret === "string" ? json.secret : null;
  return { ...key, secret };
}

/**
 * Revoke an API key by id. The `orgId` is accepted for call-site symmetry but
 * the BAPI revoke endpoint is keyed solely by `keyId` (`POST /api_keys/{keyId}/revoke`).
 */
export async function revokeApiKey(orgId: string, keyId: string): Promise<void> {
  void orgId; // BAPI revoke is keyed by keyId alone; kept for signature clarity.
  const res = await clerkFetch(`/api_keys/${encodeURIComponent(keyId)}/revoke`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(
      `revokeApiKey: Clerk POST /api_keys/${keyId}/revoke failed (${res.status}): ${await safeText(res)}`,
    );
  }
}

/**
 * Verify an API key secret against Clerk. Returns `{ orgId, orgSlug, scopes,
 * keyId }`. The `orgId` comes from the verified key's `subject`; the
 * `orgSlug` is resolved via a follow-up `getOrganization` call (Stage 5's
 * auth middleware needs both for `AuthInfo`).
 *
 * @throws if the secret is invalid/revoked/expired, or if the key is not
 *   scoped to an organization (Graphbrain requires org-scoped API keys).
 */
export async function verifyApiKey(secret: string): Promise<VerifiedApiKey> {
  const res = await clerkFetch("/api_keys/verify", {
    method: "POST",
    body: JSON.stringify({ secret }),
  });
  if (!res.ok) {
    throw new Error(
      `verifyApiKey: Clerk POST /api_keys/verify failed (${res.status}): ${await safeText(res)}`,
    );
  }
  const json = (await res.json()) as Record<string, unknown>;
  const key = rowToApiKey(json);
  // Graphbrain only accepts organization-scoped API keys (MCP agents auth per
  // PLAN.md "Auth flows"). A user-scoped key is rejected here.
  if (!key.subject.startsWith("org_")) {
    throw new Error(
      `verifyApiKey: API key subject "${key.subject}" is not organization-scoped ` +
        `(Graphbrain requires org API keys for MCP agent auth).`,
    );
  }
  // Resolve the org slug via a second BAPI call. Stage 5 caches the tenant row
  // (which carries the slug) so this double-call only happens on cache miss.
  const org = await getOrganization(key.subject);
  return {
    orgId: key.subject,
    orgSlug: org.slug,
    scopes: key.scopes,
    keyId: key.id,
  };
}

// ─── JWKS (JWT verification support) ─────────────────────────────────────────

/** In-memory JWKS cache (Stage 5 reads this for JWT signature verification). */
let _jwksCache: { url: string; jwks: Jwks; fetchedAt: number } | null = null;
/** JWKS cache TTL — Clerk keys rotate infrequently; 10 min is a safe bound. */
const JWKS_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Fetch Clerk's JWKS (public keys for JWT verification). The endpoint is the
 * Frontend API / JWT issuer URL (`getConfig().clerkJwtIssuer`) with
 * `/.well-known/jwks.json` appended. Cached in-memory for 10 minutes so
 * Stage 5's per-request JWT verification does not hit Clerk on every call.
 */
export async function getJwks(): Promise<Jwks> {
  const issuer = getConfig().clerkJwtIssuer.replace(/\/+$/, "");
  const url = `${issuer}/.well-known/jwks.json`;
  const cached = _jwksCache;
  if (cached && cached.url === url && Date.now() - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cached.jwks;
  }
  // JWKS is a public endpoint — no Authorization header (the issuer URL is the
  // auth boundary). Fetching it with the BAPI secret would 401 on some setups.
  const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(
      `getJwks: GET ${url} failed (${res.status}): ${await safeText(res)}`,
    );
  }
  const jwks = (await res.json()) as Jwks;
  if (!jwks || !Array.isArray(jwks.keys)) {
    throw new Error("getJwks: Clerk JWKS response missing `keys` array");
  }
  _jwksCache = { url, jwks, fetchedAt: Date.now() };
  return jwks;
}

/** Reset the JWKS cache (test helper). */
export function resetJwksCache(): void {
  _jwksCache = null;
}
