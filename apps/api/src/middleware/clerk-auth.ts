// Clerk auth middleware — verifies Clerk JWTs (browser sessions) and Clerk
// API keys (MCP agents) and attaches `req.auth` (AuthInfo).
//
// Two auth modes, detected by the `Authorization: Bearer <token>` header:
//   1. JWT (session)  — token has 3 dot-separated base64url segments
//                       (header.payload.signature). Verified against Clerk's
//                       JWKS via `jose.jwtVerify` + `getJwks()` from
//                       @graphbrain/core (cached 10min, fetched without a
//                       Bearer header — Stage 4 note #2). Extracts `org_id`,
//                       `org_slug`, and `sub` (userId) claims.
//   2. API key (agent) — token is NOT JWT-shaped. Verified via
//                       `verifyApiKey(token)` from @graphbrain/core (Stage 4),
//                       which calls Clerk's BAPI and rejects user-scoped keys.
//                       Returns { orgId, orgSlug, scopes, keyId }.
//
// Missing/invalid → 401 via the unified error shape (error-handler.ts).
//
// Config is read lazily INSIDE the middleware (via `getConfig()`), not at
// module top level, so importing this module does not require a valid `.env`
// (Stage 2 note #1).

import type { Request, Response, NextFunction } from "express";
import { jwtVerify, createLocalJWKSet } from "jose";
import {
  getJwks,
  verifyApiKey,
  getConfig,
  type AuthInfo,
  type Jwks,
} from "@graphbrain/core";
import { unauthenticated } from "./error-handler";

// ─── JWT vs API-key detection ────────────────────────────────────────────────

/**
 * A JWT is three base64url segments separated by dots (`header.payload.sig`).
 * Clerk API keys are not JWT-shaped (no dots / different prefix). This is the
 * standard, robust discriminator — it never misclassifies a real Clerk API key
 * as a JWT (Clerk keys contain no dots) and only misclassifies a malformed JWT
 * as an API key (which then fails verifyApiKey with a clear 401).
 */
function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

// ─── JWKS → jose key resolver ────────────────────────────────────────────────

/**
 * Build a jose verifying key from a raw JWKS object. `createLocalJWKSet`
 * returns a function that resolves `kid` → CryptoKey for `jwtVerify`. We
 * rebuild it per JWT verification only when the JWKS cache refreshes (the
 * cache is held in @graphbrain/core; `getJwks()` returns the cached object on
 * hits, so this is cheap on the hot path — jose's local JWK set does its own
 * internal caching of parsed keys).
 */
function joseKeyFromJwks(jwks: Jwks) {
  return createLocalJWKSet(jwks as unknown as Parameters<typeof createLocalJWKSet>[0]);
}

// ─── JWT verification ────────────────────────────────────────────────────────

/** Clerk JWT custom claims (per the Belweave JWT template — PLAN.md line 341). */
interface ClerkJwtClaims {
  org_id?: string;
  org_slug?: string;
  sub?: string;
  scopes?: string[];
  [k: string]: unknown;
}

/**
 * Verify a Clerk session JWT against the cached JWKS and extract auth claims.
 * Throws an `OperationError` (unauthenticated) on any verification failure
 * (bad signature, expired, missing org_id, JWKS fetch failure).
 */
async function verifyJwt(token: string): Promise<AuthInfo> {
  let jwks: Jwks;
  try {
    jwks = await getJwks();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw unauthenticated(`Failed to fetch Clerk JWKS: ${msg}`);
  }

  let payload: ClerkJwtClaims;
  try {
    const issuer = getConfig().clerkJwtIssuer;
    const { payload: p } = await jwtVerify(token, joseKeyFromJwks(jwks), {
      issuer,
    });
    payload = p as ClerkJwtClaims;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw unauthenticated(`Invalid or expired session JWT: ${msg}`);
  }

  const orgId = payload.org_id;
  if (typeof orgId !== "string" || !orgId.startsWith("org_")) {
    throw unauthenticated(
      "Session JWT is missing a valid `org_id` claim. Ensure the Clerk JWT template includes org_id.",
    );
  }
  const orgSlug = typeof payload.org_slug === "string" ? payload.org_slug : "";
  const userId = typeof payload.sub === "string" ? payload.sub : null;
  const scopes = Array.isArray(payload.scopes) ? (payload.scopes as string[]) : [];

  return { mode: "jwt", orgId, orgSlug, userId, scopes };
}

// ─── API-key verification ────────────────────────────────────────────────────

/**
 * Verify a Clerk API key via @graphbrain/core's `verifyApiKey` (Stage 4).
 * Throws an `OperationError` (unauthenticated) on any failure (invalid,
 * revoked, user-scoped, network error).
 */
async function verifyApiKeyToken(token: string): Promise<AuthInfo> {
  let verified;
  try {
    verified = await verifyApiKey(token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw unauthenticated(`Invalid or revoked API key: ${msg}`);
  }
  return {
    mode: "apikey",
    orgId: verified.orgId,
    orgSlug: verified.orgSlug,
    scopes: verified.scopes,
  };
}

// ─── Middleware ──────────────────────────────────────────────────────────────

/**
 * Express 5 middleware. Reads `Authorization: Bearer <token>`, classifies it
 * as JWT or API key, verifies it, and sets `req.auth`. On failure calls
 * `next(err)` with an `OperationError` (401) — the error-handler emits the
 * unified shape.
 *
 * Routes that should be public (health, webhooks) simply do not mount this
 * middleware.
 */
export async function clerkAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    next(unauthenticated("Missing `Authorization: Bearer <token>` header."));
    return;
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    next(unauthenticated("Empty bearer token in `Authorization` header."));
    return;
  }

  try {
    req.auth = looksLikeJwt(token) ? await verifyJwt(token) : await verifyApiKeyToken(token);
    next();
  } catch (err) {
    next(err);
  }
}

// Exported for tests / Stage 12 route composition that wants the helpers.
export { verifyJwt, verifyApiKeyToken, looksLikeJwt };
