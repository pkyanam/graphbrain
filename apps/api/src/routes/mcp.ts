// MCP HTTP route (Stage 12) — mounts the Stage 11 MCP HTTP handler.
//
//   • POST /mcp        — the MCP streamable-HTTP endpoint (JSON-RPC).
//   • GET  /mcp/tools  — plain JSON tool-list probe (no JSON-RPC envelope).
//
// Both require `req.context` (set by the Stage 5 clerkAuth → tenantResolver →
// contextBuilder chain). The handler is mounted behind the auth middleware;
// if `req.context` is missing the handler responds 401 (fail-closed).
//
// The handler owns its own response shape (JSON-RPC envelopes / MCP
// ToolResult with isError). MCP errors are NOT routed through the Express
// errorHandler — the MCP transport has its own error surface.

import { Router } from "express";
import { createMcpHttpHandler } from "@graphbrain/core";
import type { DispatchDeps } from "@graphbrain/core";

/**
 * Build the MCP router. Mount behind the auth + context middleware.
 *
 * @param deps  The app-wide DispatchDeps (router + gateway + embeddingService).
 */
export function mcpRouter(deps: DispatchDeps): Router {
  const router = Router();
  const handler = createMcpHttpHandler(deps);
  // POST /mcp — JSON-RPC initialize / tools/list / tools/call.
  router.post("/mcp", handler);
  // GET /mcp/tools — plain JSON tool-list probe.
  router.get("/mcp/tools", handler);
  return router;
}
