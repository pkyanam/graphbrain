// Unified error infrastructure for the Graphbrain API.
//
// `OperationError` is the single error class threaded through operation
// handlers (Stage 10) and the auth/tenant middleware (Stage 5). It carries a
// stable `code` (machine-readable), a human `message`, an optional `suggestion`
// (remediation hint surfaced to the caller), and an optional explicit HTTP
// `status` override. The `errorHandler` Express middleware maps `code` → HTTP
// status and emits the unified response shape:
//
//   { error: { code, message, suggestion? } }
//
// Status mapping (code → HTTP):
//   unauthenticated      → 401   (missing/invalid auth — from clerkAuth)
//   tenant_not_found     → 403   (Clerk org has no Graphbrain tenant)
//   permission_denied    → 403   (scope/ACL denial — from operations)
//   page_not_found       → 404
//   invalid_params       → 400
//   rate_limited         → 429
//   tenant_not_active    → 503   (provisioning incomplete — Retry-After set)
//   <else>               → 500
//
// An explicit `status` on the error wins over the code map (escape hatch for
// one-off statuses that don't have a dedicated code).

import type { Request, Response, NextFunction } from "express";

// ─── OperationError ──────────────────────────────────────────────────────────

export interface OperationErrorOptions {
  /** Explicit HTTP status override (wins over the code → status map). */
  status?: number;
  /** Remediation hint surfaced to the caller as `error.suggestion`. */
  suggestion?: string;
  /** Optional `Retry-After` header value (seconds) — set for 503/429. */
  retryAfterSeconds?: number;
  cause?: unknown;
}

/**
 * The error class used by operation handlers (Stage 10) and the auth/tenant
 * middleware (Stage 5). Throwing `new OperationError("code", "msg")` from any
 * handler/middleware routes through `errorHandler` into the unified response
 * shape with the correct HTTP status.
 */
export class OperationError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly suggestion?: string;
  readonly retryAfterSeconds?: number;

  constructor(code: string, message: string, options?: OperationErrorOptions) {
    super(message);
    this.name = "OperationError";
    this.code = code;
    this.status = options?.status;
    this.suggestion = options?.suggestion;
    this.retryAfterSeconds = options?.retryAfterSeconds;
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

// ─── Status mapping ──────────────────────────────────────────────────────────

/** code → HTTP status. An explicit `error.status` wins over this map. */
const CODE_TO_STATUS: Record<string, number> = {
  unauthenticated: 401,
  tenant_not_found: 403,
  permission_denied: 403,
  page_not_found: 404,
  invalid_params: 400,
  rate_limited: 429,
  tenant_not_active: 503,
};

/** Resolve the HTTP status for an OperationError (explicit status wins). */
export function statusForError(err: OperationError): number {
  if (typeof err.status === "number") return err.status;
  return CODE_TO_STATUS[err.code] ?? 500;
}

// ─── Convenience constructors (used by the auth/resolver middleware) ─────────

/** 401 — missing or invalid auth credentials. */
export function unauthenticated(message: string, suggestion?: string): OperationError {
  return new OperationError("unauthenticated", message, { status: 401, suggestion });
}

/** 403 — Clerk org exists but no Graphbrain tenant (provisioning incomplete). */
export function tenantNotFound(): OperationError {
  return new OperationError(
    "tenant_not_found",
    "No Graphbrain tenant found for this organization. Provisioning may be incomplete or a Clerk webhook was missed.",
    {
      status: 403,
      suggestion: "Contact your Graphbrain operator or retry after organization provisioning completes.",
    },
  );
}

/** 503 — tenant exists but is not active (pending/error/suspended). */
export function tenantNotActive(status: string, retryAfterSeconds = 5): OperationError {
  return new OperationError(
    "tenant_not_active",
    `Tenant is not active (current status: "${status}"). Service unavailable until provisioning completes.`,
    {
      status: 503,
      retryAfterSeconds,
      suggestion: "Retry after provisioning completes. If this persists, contact your Graphbrain operator.",
    },
  );
}

// ─── Express error-handling middleware ───────────────────────────────────────

/**
 * Express error-handling middleware (the 4-arg signature). Catches errors
 * thrown or `next(err)`'d from route handlers and upstream middleware
 * (clerkAuth, tenantResolver). Emits the unified error shape:
 *
 *   { error: { code, message, suggestion? } }
 *
 * OperationError → mapped status + code. Non-OperationError → 500 with a
 * generic `internal_error` code (the original message is NOT leaked to the
 * client; it is logged via `console.error` for the operator).
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // Express requires the 4th param for error middleware recognition; keep it.
  _next: NextFunction,
): void {
  if (err instanceof OperationError) {
    const status = statusForError(err);
    if (typeof err.retryAfterSeconds === "number") {
      res.setHeader("Retry-After", String(err.retryAfterSeconds));
    }
    const body: { error: { code: string; message: string; suggestion?: string } } = {
      error: { code: err.code, message: err.message },
    };
    if (err.suggestion) body.error.suggestion = err.suggestion;
    res.status(status).json(body);
    return;
  }

  // Unknown error — never leak internals to the client.
  const message = err instanceof Error ? err.message : String(err);
  console.error("[graphbrain-api] unhandled error:", message);
  if (err instanceof Error && err.stack) console.error(err.stack);
  res.status(500).json({
    error: { code: "internal_error", message: "Internal server error." },
  });
}
