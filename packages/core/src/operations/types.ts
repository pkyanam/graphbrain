// @graphbrain/core — operations layer types (Stage 10).
//
// The contract-first operation definitions: every Phase 1 operation carries a
// name, description, scope ('read'|'write'|'admin'), optional `localOnly`, an
// optional Zod `inputSchema`, and a `handler`. The single `OPERATIONS` map
// (./index.ts) is the source of truth that the API (Stage 12), CLI (Stage 15),
// and MCP server (Stage 11) dispatch against.
//
// Ported from _reference/gbrain/src/core/operations.ts (Operation shape,
// OperationError, ErrorCode open union, scope/localOnly flags, dispatch
// pattern) and adapted to Graphbrain's multi-tenant architecture:
//   • The engine is NOT on OperationContext — it is resolved per-call from
//     `ctx.tenant` via TenantRouter by the dispatcher, then handed to the
//     handler as part of `ResolvedDeps`. This keeps OperationContext (Stage 1)
//     as the pure trust-boundary carrier.
//   • `OperationContext` is reused as-is from Stage 1 (./types.ts). The
//     `remote` trust boundary (fail-closed: anything not strictly `false` is
//     untrusted) gates write/admin ops in the dispatcher.
//   • Input validation uses Zod schemas (Stage 1) rather than GBrain's
//     hand-rolled ParamDef registry — the `inputSchema` field is optional but
//     recommended for every op.

import type { ZodType } from "zod";
import type { BrainEngine } from "../engine";
import type { AIGateway } from "../ai/gateway";
import type { EmbeddingService } from "../embedding";
import type { OperationContext } from "../types";

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Open union of operation error codes. The named codes cover the Phase 1
 * failure modes; the `(string & {})` tail keeps the union TS-forward-
 * compatible so future stages can add codes without breaking consumers
 * (same pattern as GBrain + the Anthropic/OpenAI API conventions).
 */
export type ErrorCode =
  | "unknown_operation"
  | "page_not_found"
  | "source_not_found"
  | "invalid_params"
  | "embedding_failed"
  | "synthesis_failed"
  | "permission_denied"
  | "not_provisioned"
  | "storage_error"
  | "database_error"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {});

/**
 * OperationError — the canonical error thrown by operation handlers and the
 * dispatcher. Carries a stable `code` (for HTTP status mapping in Stage 12's
 * error-handler middleware), a human-readable `message`, and optional
 * `suggestion` + `docs` fields (ported from GBrain) that the CLI/MCP surfaces
 * can relay to the caller.
 */
export class OperationError extends Error {
  readonly code: ErrorCode;
  readonly suggestion?: string;
  readonly docs?: string;

  constructor(
    code: ErrorCode,
    message: string,
    opts?: { suggestion?: string; docs?: string; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "OperationError";
    this.code = code;
    this.suggestion = opts?.suggestion;
    this.docs = opts?.docs;
  }

  toJSON(): {
    error: ErrorCode;
    message: string;
    suggestion?: string;
    docs?: string;
  } {
    return {
      error: this.code,
      message: this.message,
      ...(this.suggestion !== undefined ? { suggestion: this.suggestion } : {}),
      ...(this.docs !== undefined ? { docs: this.docs } : {}),
    };
  }
}

// ─── Operation definition ────────────────────────────────────────────────────

/**
 * Capability scope required to invoke an operation. The dispatcher enforces:
 *   • read  — any authenticated caller (tenant resolved).
 *   • write — `ctx.remote === false` (trusted local) OR the caller's
 *             `auth.scopes` include `write`/`admin` (explicit auth grant).
 *   • admin — `ctx.remote === false` OR `auth.scopes` includes `admin`.
 *
 * `localOnly` ops are stricter: they require `ctx.remote === false` regardless
 * of scope — no remote caller can ever invoke them.
 */
export type OperationScope = "read" | "write" | "admin";

/**
 * The resolved dependencies the dispatcher hands to every handler. The engine
 * is resolved from `ctx.tenant` via the TenantRouter; the gateway +
 * embeddingService are constructed once at app startup and shared across
 * tenants (per-tenant model routing happens inside them).
 */
export interface ResolvedDeps {
  /** The per-tenant BrainEngine, resolved from ctx.tenant by the dispatcher. */
  engine: BrainEngine;
  /** The AIGateway (Stage 8) — chat (query synthesis) + rerank. */
  gateway: AIGateway;
  /** The EmbeddingService (Stage 8) — chunk embedding for put_page. */
  embeddingService: EmbeddingService;
}

/**
 * Dependencies the dispatcher itself needs (passed by the app/transport at
 * dispatch time). The router resolves the per-tenant engine; the gateway +
 * embeddingService are the app-wide singletons handed to handlers.
 */
export interface DispatchDeps {
  /** TenantRouter — resolves ctx.tenant → a healthy BrainEngine. */
  router: {
    getEngine(tenant: import("../types").Tenant): Promise<BrainEngine>;
  };
  gateway: AIGateway;
  embeddingService: EmbeddingService;
}

/**
 * A single operation definition. Generic over the validated input shape `I`
 * and the output shape `O`; the registry stores these as `Operation` (erased
 * generics) and the dispatcher casts at call time.
 */
export interface Operation<
  I = Record<string, unknown>,
  O = unknown,
> {
  /** Stable operation name (the dispatch key + MCP tool name). */
  readonly name: string;
  /** Human-readable description (becomes the MCP tool description). */
  readonly description: string;
  /** Capability scope — gates who can call this op. */
  readonly scope: OperationScope;
  /** When true, only trusted local callers (ctx.remote === false) may invoke. */
  readonly localOnly?: boolean;
  /**
   * Optional Zod schema for the input. When present, the dispatcher parses
   * the raw input before the handler runs; parse failures throw
   * `OperationError('invalid_params')`. When absent, the raw input is passed
   * through unchanged (handlers that validate inline can omit this).
   */
  readonly inputSchema?: ZodType<I>;
  /**
   * The handler. Receives the validated input, the OperationContext (trust
   * boundary + tenant + auth), and the resolved deps (engine + gateway +
   * embeddingService). Returns the operation output or throws
   * `OperationError`.
   */
  readonly handler: (
    input: I,
    ctx: OperationContext,
    deps: ResolvedDeps,
  ) => Promise<O>;
}

// ─── Scope helpers ───────────────────────────────────────────────────────────

/**
 * Check whether the caller's auth scopes satisfy the required scope.
 * Hierarchy: `admin` implies `write` implies `read`.
 */
export function hasScope(
  scopes: readonly string[],
  required: OperationScope,
): boolean {
  if (scopes.includes("admin")) return true;
  if (required === "admin") return false;
  if (scopes.includes("write")) return true;
  if (required === "write") return false;
  // read: any scope (read/write/admin) satisfies, and an empty scope list
  // is treated as read-allowed (the caller authenticated; read is the floor).
  return true;
}
