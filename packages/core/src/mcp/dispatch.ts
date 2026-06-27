// @graphbrain/core — MCP tool-call dispatch (Stage 11).
//
// The single seam between an MCP tool-call request (stdio or HTTP) and the
// Stage 10 operations dispatcher. Both transports call `handleMcpCall` with
// the tool name + raw args + the OperationContext (already built by the
// transport with the correct `remote` + `auth` + `tenant`) and the
// DispatchDeps (router + gateway + embeddingService). The result is wrapped
// as an MCP `ToolResult` (`{ content: [{ type: 'text', text }], isError? }`).
//
// Ported from _reference/gbrain/src/mcp/dispatch.ts:
//   • The `ToolResult` interface + the error-to-JSON serialization pattern
//     (every error response is JSON-parseable — lines 270-282 of GBrain).
//   • The "wrap unknown throws as internal_error without leaking the raw
//     message" posture (same as the API error-handler middleware in Stage 12).
//
// NOT ported from GBrain:
//   • `validateParams` — our dispatcher uses Zod, not GBrain's hand-rolled
//     ParamDef validator.
//   • `takesHoldersAllowList`, `sourceId`, `metaHook`, `summarizeMcpParams` —
//     GBrain-specific (PGLite brain-hot-memory, per-token source resolution).
//     Graphbrain's OperationContext (Stage 1) carries tenant + auth + remote;
//     the transport builds it, the dispatcher consumes it.
//
// Trust boundary: the OperationContext is built by the transport. The stdio
// server sets `remote: true` (MCP stdio is untrusted — matches GBrain
// _reference/gbrain/src/mcp/server.ts line 44). The HTTP server uses
// `req.context` from Stage 5's contextBuilder (which hard-codes
// `remote: true`). `handleMcpCall` does NOT override `remote` or `auth` — it
// passes the ctx through to `operations.dispatch` unchanged.

import { dispatch, OperationError } from "../operations";
import type { DispatchDeps } from "../operations";
import type { OperationContext } from "../types";

/**
 * An MCP tool-call result. Matches the `ToolResult` / `CallToolResult` shape
 * from the MCP spec: `content` is an array of content blocks (we always emit
 * a single `text` block with a JSON-stringified payload), and `isError`
 * flags an error response (the content still carries a JSON error body so
 * every response is JSON-parseable — same posture as GBrain).
 */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/**
 * Handle a single MCP `tools/call` request.
 *
 * Maps the tool name 1:1 to an operation name (Phase 1), calls
 * `operations.dispatch(toolName, args, ctx, deps)`, and wraps the output as
 * an MCP `ToolResult`.
 *
 * @param toolName  The MCP tool name (== operation name).
 * @param args      The raw `arguments` object from the MCP request. May be
 *                  undefined / null (the dispatcher + Zod handle validation).
 * @param ctx       The OperationContext (built by the transport with the
 *                  correct `remote` + `auth` + `tenant`). Passed through
 *                  unchanged — `handleMcpCall` does NOT override trust fields.
 * @param deps      The DispatchDeps (router + gateway + embeddingService).
 * @returns         A `ToolResult`. On success: `content` is the
 *                  JSON-stringified op output, `isError` is false/absent.
 *                  On `OperationError`: `content` is the error's `toJSON()`,
 *                  `isError` is true. On any other throw: `content` is
 *                  `{ error: 'internal_error', message: 'Internal error.' }`,
 *                  `isError` is true (the raw message is NOT leaked to MCP
 *                  callers — same posture as the API error-handler).
 */
export async function handleMcpCall(
  toolName: string,
  args: unknown,
  ctx: OperationContext,
  deps: DispatchDeps,
): Promise<ToolResult> {
  try {
    const result = await dispatch(toolName, args ?? {}, ctx, deps);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (e: unknown) {
    if (e instanceof OperationError) {
      return {
        content: [{ type: "text", text: JSON.stringify(e.toJSON(), null, 2) }],
        isError: true,
      };
    }
    // Non-OperationError throws — wrap in the same JSON shape so every error
    // response is JSON-parseable. Do NOT leak the raw error message to MCP
    // callers (the API error-handler middleware in Stage 12 has the same
    // posture). The raw error is logged server-side by the transport.
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { error: "internal_error", message: "Internal error." },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
}
