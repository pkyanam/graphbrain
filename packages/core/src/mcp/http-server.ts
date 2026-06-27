// @graphbrain/core — MCP HTTP transport (Stage 11).
//
// The remote-agent transport: an Express request handler for `POST /mcp`
// that speaks the MCP "streamable HTTP" protocol. Stage 12 mounts this at
// `/mcp` behind Stage 5's `clerkAuth` + `tenantResolver` + `contextBuilder`
// middleware, which populate `req.auth` + `req.context` (the
// OperationContext with `remote: true` hard-coded by contextBuilder).
//
// Ported from _reference/gbrain/src/mcp/http-transport.ts:
//   • The Express mounting pattern + the JSON-RPC method dispatch
//     (initialize / notifications/initialized / tools/list / tools/call).
//   • The `dispatchToolCall` → response envelope wiring.
//
// NOT ported from GBrain (Phase 1 keeps the HTTP transport minimal):
//   • Rate-limiting (per-IP pre-auth + per-token post-auth) — Stage 12's API
//     gateway layer can add this; the core MCP handler stays rate-limit-free
//     so it is testable in isolation.
//   • Admin SSE feed + `mcp_request_log` — GBrain-specific observability.
//   • Per-token source resolution + `takesHoldersAllowList` — GBrain's
//     legacy bearer-token model. Graphbrain uses Clerk JWT / API key auth
//     (Stage 4/5), which populates `req.auth` + `req.context`.
//
// Transport spec choice: the MCP "streamable HTTP" spec
// (modelcontextprotocol.io/spec — "Streamable HTTP") supports both SSE
// streaming and direct HTTP responses. Phase 1 implements the simplest
// correct version: **stateless direct HTTP responses** (no SSE, no session
// id, no `Mcp-Session-Id` header). Each `POST /mcp` carries one JSON-RPC
// request and gets one `application/json` JSON-RPC response. This is the
// "stateless mode" the spec explicitly blesses
// (`sessionIdGenerator: undefined`). SSE streaming + sessions are a Phase 2
// concern (tool-call progress, long-running captures). Documented here so
// Stage 12 knows the contract.
//
// Trust boundary: the handler uses `req.context` (set by Stage 5's
// contextBuilder, which hard-codes `remote: true`) as the OperationContext.
// `req.auth` (set by clerkAuth from the Clerk JWT or API key) carries the
// caller's scopes. The MCP layer does NOT override `remote` or `auth` — it
// passes `req.context` through to `handleMcpCall` unchanged.

import type { Request, Response, NextFunction } from "express";
import type { DispatchDeps } from "../operations";
import type { OperationContext } from "../types";
import { generateToolDefs } from "./tool-defs";
import { handleMcpCall } from "./dispatch";

/** The MCP server name advertised in `initialize` responses. */
const MCP_HTTP_SERVER_NAME = "graphbrain";
/** The MCP server version advertised in `initialize` responses. */
const MCP_HTTP_SERVER_VERSION = "0.0.0";
/** The MCP protocol version this transport speaks. */
const MCP_PROTOCOL_VERSION = "2025-03-26";

/**
 * Express Request augmented with the Stage 5 middleware fields. Stage 5's
 * `contextBuilder` sets `req.context` (the OperationContext); `clerkAuth`
 * sets `req.auth`. We only read `req.context` here — the auth fields are
 * already folded into `req.context.auth` by contextBuilder.
 */
export interface McpExpressRequest extends Request {
  context?: OperationContext;
}

/** A JSON-RPC 2.0 envelope (request or response). */
interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown> | unknown[];
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Create the MCP HTTP Express handler. Stage 12 mounts this at `POST /mcp`
 * (and `GET /mcp/tools` for a plain tool-list probe) behind the Stage 5
 * auth + context middleware.
 *
 * The handler is stateless: each request is dispatched independently. The
 * `deps` (router + gateway + embeddingService) are shared across requests
 * (app-wide singletons constructed at app startup).
 *
 * @param deps  The DispatchDeps (router + gateway + embeddingService).
 * @returns     An Express request handler `(req, res, next) => void`.
 */
export function createMcpHttpHandler(deps: DispatchDeps) {
  return async (req: McpExpressRequest, res: Response, _next: NextFunction): Promise<void> => {
    // GET /mcp/tools — plain JSON tool-list probe (no JSON-RPC envelope).
    // Useful for dashboard / discovery clients that just want the tool list
    // without speaking JSON-RPC. The POST `tools/list` method is the
    // spec-blessed path; this GET is a convenience alias.
    if (req.method === "GET" && req.path.endsWith("/tools")) {
      res.json({ tools: generateToolDefs(false) });
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    // The OperationContext is built by Stage 5's contextBuilder middleware
    // (remote: true hard-coded) + clerkAuth (auth.scopes from the Clerk JWT
    // or API key). If it is missing, the auth middleware did not run —
    // fail-closed.
    const ctx = req.context;
    if (!ctx) {
      res.status(401).json({ error: "unauthorized", message: "Missing OperationContext (auth middleware did not run)." });
      return;
    }

    let body: JsonRpcRequest;
    try {
      body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as JsonRpcRequest;
    } catch (e) {
      res.status(400).json({ error: "parse_error", message: e instanceof Error ? e.message : "invalid JSON" });
      return;
    }

    const { method, id } = body;
    const params = (body.params ?? {}) as Record<string, unknown>;

    // initialize — negotiate protocol version + advertise capabilities.
    if (method === "initialize") {
      const response: JsonRpcResponse = {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverInfo: { name: MCP_HTTP_SERVER_NAME, version: MCP_HTTP_SERVER_VERSION },
          capabilities: { tools: {} },
        },
      };
      res.json(response);
      return;
    }

    // notifications/initialized — acknowledge with 204 (no response body for
    // notifications, per JSON-RPC: notifications have no `id`).
    if (method === "notifications/initialized") {
      res.status(204).end();
      return;
    }

    // tools/list — emit the non-localOnly tool defs (remote callers never
    // see localOnly tools).
    if (method === "tools/list") {
      const response: JsonRpcResponse = {
        jsonrpc: "2.0",
        id,
        result: { tools: generateToolDefs(false) },
      };
      res.json(response);
      return;
    }

    // tools/call — dispatch through handleMcpCall with the Stage 5 context.
    if (method === "tools/call") {
      const toolName = (params.name as string | undefined) ?? "unknown";
      const args = params.arguments;
      const result = await handleMcpCall(toolName, args, ctx, deps);
      const response: JsonRpcResponse = {
        jsonrpc: "2.0",
        id,
        result,
      };
      res.json(response);
      return;
    }

    res.status(400).json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unknown method: ${method ?? "unknown"}` },
    });
  };
}
