// @graphbrain/core — operations registry + dispatcher (Stage 10).
//
// The single `OPERATIONS` map (name → Operation) is the source of truth for
// every Phase 1 operation. The API (Stage 12), CLI (Stage 15), and MCP server
// (Stage 11) all dispatch through `dispatch(name, input, ctx, deps)`.
//
// Trust boundary (critical, ported from GBrain CLAUDE.md):
//   • `ctx.remote` is REQUIRED on OperationContext (Stage 1). Anything not
//     strictly `false` is treated as remote/untrusted (fail-closed).
//   • read ops: any authenticated caller (tenant resolved).
//   • write/admin ops: `ctx.remote === false` (trusted local) OR the caller's
//     `auth.scopes` include the op's scope or higher (explicit auth grant).
//   • localOnly ops: `ctx.remote === false` always — no remote caller can
//     ever invoke them, regardless of scopes.
//
// The dispatcher resolves the per-tenant BrainEngine from `ctx.tenant` via
// the TenantRouter, then hands `{ engine, gateway, embeddingService }` to
// the handler as ResolvedDeps. This keeps OperationContext (Stage 1) as the
// pure trust-boundary carrier — the engine is a per-call resolution, not a
// context field.

import type { Tenant } from "../types";
import type { OperationContext } from "../types";
import type { BrainEngine } from "../engine";
import type { AIGateway } from "../ai/gateway";
import type { EmbeddingService } from "../embedding";
import { OperationError, hasScope } from "./types";
import type { Operation, DispatchDeps, ResolvedDeps, OperationScope } from "./types";

// ─── Operation definitions ───────────────────────────────────────────────────

import { searchOp, queryOp } from "./search";
import {
  getPageOp,
  listPagesOp,
  putPageOp,
  createPageOp,
  addChunkOp,
} from "./pages";
import { listSourcesOp, getSourceOp, addSourceOp } from "./sources";
import { getLinksOp, getBacklinksOp, addLinkOp } from "./links";
import { captureOp } from "./capture";

// ─── OPERATIONS registry ─────────────────────────────────────────────────────

/**
 * The single operation registry: name → Operation. This is the source of
 * truth for the MCP tool list (Stage 11 generates tool defs from it) and the
 * CLI command map (Stage 15). Adding an operation here automatically extends
 * every transport surface.
 */
// The op definitions carry their own concrete input/output generics; the
// registry erases them to `Operation` (Record<string, unknown> → unknown) so
// the dispatcher can hold them in one map. The dispatcher restores the
// concrete types at call time via the op's Zod schema + a cast.
const _ops: Record<string, Operation> = {
  // Search (read)
  search: searchOp as unknown as Operation,
  query: queryOp as unknown as Operation,
  // Pages (read + write)
  get_page: getPageOp as unknown as Operation,
  list_pages: listPagesOp as unknown as Operation,
  put_page: putPageOp as unknown as Operation,
  create_page: createPageOp as unknown as Operation,
  add_chunk: addChunkOp as unknown as Operation,
  // Sources (read + write)
  list_sources: listSourcesOp as unknown as Operation,
  get_source: getSourceOp as unknown as Operation,
  add_source: addSourceOp as unknown as Operation,
  // Links (read + write)
  get_links: getLinksOp as unknown as Operation,
  get_backlinks: getBacklinksOp as unknown as Operation,
  add_link: addLinkOp as unknown as Operation,
  // Capture (write)
  capture: captureOp as unknown as Operation,
};

export const OPERATIONS: ReadonlyMap<string, Operation> = new Map(
  Object.entries(_ops),
);

/** Ordered list of operation names (for deterministic tool-def generation). */
export const OPERATION_NAMES: readonly string[] = Array.from(OPERATIONS.keys());

/** Look up an operation by name. Returns undefined if not found. */
export function getOperation(name: string): Operation | undefined {
  return OPERATIONS.get(name);
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

/**
 * Enforce the trust boundary for an operation against the caller's context.
 * Throws `OperationError('permission_denied')` on violation.
 *
 * Rules:
 *   • read ops: always allowed (the caller authenticated; tenant is resolved).
 *   • write/admin ops: `ctx.remote === false` (trusted local) OR
 *     `hasScope(ctx.auth.scopes, op.scope)` (explicit auth grant).
 *   • localOnly ops: `ctx.remote === false` always — no remote caller,
 *     regardless of scopes.
 */
export function enforceTrustBoundary(
  op: Operation,
  ctx: OperationContext,
): void {
  // localOnly: only trusted local callers, period.
  if (op.localOnly && ctx.remote !== false) {
    throw new OperationError(
      "permission_denied",
      `Operation '${op.name}' is local-only (trusted CLI callers).`,
      {
        suggestion:
          "This operation cannot be invoked over MCP/HTTP. Run it via the local CLI.",
      },
    );
  }

  // write/admin: require trusted local OR explicit auth grant.
  if (op.scope === "write" || op.scope === "admin") {
    if (ctx.remote === false) return; // trusted local
    if (hasScope(ctx.auth.scopes, op.scope as OperationScope)) return; // explicit grant
    throw new OperationError(
      "permission_denied",
      `Operation '${op.name}' requires ${op.scope} scope (remote caller).`,
      {
        suggestion: `Grant the caller '${op.scope}' scope, or run via the local CLI.`,
      },
    );
  }

  // read: no gate.
}

/**
 * Dispatch an operation by name.
 *
 * @param name   The operation name (must be in OPERATIONS).
 * @param input  The raw input (validated against the op's Zod schema if present).
 * @param ctx    The OperationContext (trust boundary + tenant + auth).
 * @param deps   The dispatch deps: TenantRouter + AIGateway + EmbeddingService.
 * @returns      The operation's output.
 * @throws OperationError for unknown ops, permission violations, invalid
 *   params, or handler-thrown OperationErrors. Non-OperationError throws from
 *   handlers propagate as-is (the error-handler middleware in Stage 12 maps
 *   them to 500).
 */
export async function dispatch<I = Record<string, unknown>, O = unknown>(
  name: string,
  input: unknown,
  ctx: OperationContext,
  deps: DispatchDeps,
): Promise<O> {
  const op = OPERATIONS.get(name);
  if (!op) {
    throw new OperationError(
      "unknown_operation",
      `Unknown operation: ${name}`,
      {
        suggestion: `Available operations: ${OPERATION_NAMES.join(", ")}`,
      },
    );
  }

  // Trust boundary.
  enforceTrustBoundary(op, ctx);

  // Input validation (Zod).
  let validated: I;
  if (op.inputSchema) {
    const parsed = op.inputSchema.safeParse(input);
    if (!parsed.success) {
      throw new OperationError(
        "invalid_params",
        `Invalid input for '${name}': ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        {
          suggestion: "Check the parameter types and required fields.",
        },
      );
    }
    validated = parsed.data as I;
  } else {
    validated = input as I;
  }

  // Dry-run short-circuit (handlers that mutate skip their work).
  if (ctx.dryRun) {
    return { dry_run: true, operation: name } as unknown as O;
  }

  // Resolve the per-tenant engine.
  let engine: BrainEngine;
  try {
    engine = await deps.router.getEngine(ctx.tenant);
  } catch (err) {
    throw new OperationError(
      "not_provisioned",
      `Failed to resolve engine for tenant '${ctx.tenant.id}': ${err instanceof Error ? err.message : String(err)}`,
      {
        suggestion:
          "The tenant's HelixDB instance may not be provisioned. Run provisioning first.",
        cause: err,
      },
    );
  }

  const resolvedDeps: ResolvedDeps = {
    engine,
    gateway: deps.gateway,
    embeddingService: deps.embeddingService,
  };

  // Run the handler. The op's input was validated (or passed through) above;
  // the erased Operation type means we cast back to the handler's concrete
  // input here. The output is cast to the caller's expected O.
  return (op.handler as Operation<I, O>["handler"])(validated, ctx, resolvedDeps);
}

// ─── Re-exports ──────────────────────────────────────────────────────────────

export { OperationError } from "./types";
export type {
  Operation,
  OperationScope,
  ErrorCode,
  ResolvedDeps,
  DispatchDeps,
} from "./types";
export { hasScope } from "./types";

// Operation definitions (for per-op testing + direct handler invocation).
export { searchOp, queryOp } from "./search";
export type {
  SearchInput,
  SearchOutput,
  QueryInput,
  QueryOutput,
  QueryCitation,
} from "./search";
export {
  DEFAULT_SYNTHESIS_SYSTEM_PROMPT,
  buildSynthesisMessages,
  extractUsedCitations,
} from "./search";
export {
  getPageOp,
  listPagesOp,
  putPageOp,
  createPageOp,
  addChunkOp,
  chunkContent,
  splitFrontmatter,
  CHUNK_TARGET_CHARS,
  CHUNK_MAX_CHARS,
} from "./pages";
export type {
  GetPageInput,
  GetPageOutput,
  ListPagesInput,
  ListPagesOutput,
  PutPageInput,
  PutPageOutput,
  CreatePageInput,
  CreatePageOutput,
  AddChunkInput,
  AddChunkOutput,
} from "./pages";
export { listSourcesOp, getSourceOp, addSourceOp } from "./sources";
export type {
  ListSourcesInput,
  ListSourcesOutput,
  GetSourceInput,
  GetSourceOutput,
  AddSourceInput,
  AddSourceOutput,
} from "./sources";
export { getLinksOp, getBacklinksOp, addLinkOp } from "./links";
export type {
  GetLinksInput,
  GetLinksOutput,
  GetBacklinksInput,
  GetBacklinksOutput,
  AddLinkInput,
  AddLinkOutput,
} from "./links";
export { captureOp, inferCaptureType, generateCaptureSlug } from "./capture";
export type { CaptureInput, CaptureOutput } from "./capture";
