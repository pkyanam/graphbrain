// @graphbrain/core — MCP stdio server (Stage 11).
//
// The local-agent transport: a stdio MCP server that exposes the Phase 1
// operations as tools over the JSON-RPC stdio transport. Stage 15's CLI
// `serve` command constructs the Tenant + DispatchDeps and calls
// `startMcpServer(deps, { tenant })`.
//
// Ported from _reference/gbrain/src/mcp/server.ts:
//   • The Server + StdioServerTransport setup + the ListTools / CallTool
//     request handlers (lines 18-58).
//   • The shutdown logic (lines 95-122): stdin EOF / SIGTERM / SIGINT /
//     SIGHUP / transport.onclose all trigger a single guarded shutdown that
//     closes the engine + exits.
//   • The MCP_STDIO=1 half-close guard (lines 113-117): when MCP_STDIO=1,
//     do NOT treat stdin end/close as a shutdown trigger — some MCP clients
//     (OpenClaw's bundle-mcp layer, others) pipe the JSON-RPC handshake then
//     close their stdin half. Treating that as a permanent disconnect kills
//     the server before the first tool call arrives. Signal handlers +
//     transport.onclose still cover the legitimate shutdown paths.
//
// NOT ported from GBrain:
//   • The resolve-IPC server + brain-hot-memory metaHook — GBrain-specific
//     PGLite features (single-connection brain). Graphbrain uses HelixDB
//     (multi-connection), so there is no IPC resolve socket.
//   • `takesHoldersAllowList` + `sourceId` — GBrain's per-token source /
//     holder scoping. Graphbrain's OperationContext carries tenant + auth;
//     the stdio server builds a read-only apikey context.
//
// Trust boundary: MCP stdio is untrusted (matches GBrain line 44). The
// server sets `ctx.remote = true` and `auth.scopes = ['read']` by default —
// stdio MCP callers can use read ops but NOT write ops unless the operator
// explicitly grants write scope (set GRAPHBRAIN_MCP_SCOPES=write,admin to
// widen). This is documented in the startup banner.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tenant, OperationContext, AuthInfo } from "../types";
import type { DispatchDeps } from "../operations";
import { generateToolDefs } from "./tool-defs";
import { handleMcpCall } from "./dispatch";

/** The MCP server name advertised in `initialize` responses. */
const MCP_SERVER_NAME = "graphbrain";
/** The MCP server version advertised in `initialize` responses. */
const MCP_SERVER_VERSION = "0.0.0";

/**
 * Parse the operator-configurable MCP scope override. Operators who want
 * stdio MCP callers to be able to write set `GRAPHBRAIN_MCP_SCOPES=write`
 * (or `write,admin`). Default is `read` only — stdio has no per-token auth
 * on a local pipe, so the safe default is read-only.
 */
function resolveStdioScopes(): string[] {
  const raw = process.env.GRAPHBRAIN_MCP_SCOPES;
  if (!raw) return ["read"];
  const scopes = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return scopes.length > 0 ? scopes : ["read"];
}

export interface StartMcpServerOptions {
  /** The resolved tenant for this stdio server (loaded by the CLI). */
  tenant: Tenant;
}

/**
 * Start the stdio MCP server.
 *
 * The server is pure: it takes the already-constructed DispatchDeps (router
 * + gateway + embeddingService) + the resolved Tenant and runs the server
 * loop. It does NOT load config, open DB connections, or construct the
 * TenantRouter — that is the CLI's job (Stage 15). This keeps the server
 * testable + free of control-plane side effects.
 *
 * Shutdown: on stdin EOF / SIGTERM / SIGINT / SIGHUP / transport.onclose,
 * the engine is closed (best-effort) and the process exits. The
 * `MCP_STDIO=1` env var disables the stdin-EOF shutdown trigger (some MCP
 * clients pipe the handshake then close stdin half — see the GBrain guard
 * at _reference/gbrain/src/mcp/server.ts lines 113-117).
 */
export async function startMcpServer(
  deps: DispatchDeps,
  opts: StartMcpServerOptions,
): Promise<void> {
  const tenant = opts.tenant;
  const scopes = resolveStdioScopes();

  // Startup banner (stderr — stdout is reserved for JSON-RPC).
  process.stderr.write(
    `[graphbrain-mcp] stdio server starting (tenant: ${tenant.slug})\n`,
  );
  process.stderr.write(
    `[graphbrain-mcp] remote=true (untrusted). auth.scopes=${scopes.join(",")}\n`,
  );
  if (!scopes.includes("write") && !scopes.includes("admin")) {
    process.stderr.write(
      `[graphbrain-mcp] read-only: write ops (put_page, add_chunk, add_source, ` +
        `add_link, capture, create_page) are BLOCKED. Set GRAPHBRAIN_MCP_SCOPES=write ` +
        `to allow writes from stdio.\n`,
    );
  }

  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  // tools/list — emit the non-localOnly tool defs (remote callers never see
  // localOnly tools).
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: generateToolDefs(false),
  }));

  // tools/call — build an OperationContext (remote: true, apikey auth with
  // the resolved scopes) and dispatch through handleMcpCall. The MCP SDK's
  // CallToolResult accepts the legacy `{ content, isError? }` shape our
  // ToolResult uses; we cast through the union the SDK expects (the union
  // includes a managed-task wrapper variant that requires `task` — our ops
  // are synchronous, so we return the legacy shape and cast).
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const auth: AuthInfo = {
      mode: "apikey",
      orgId: tenant.clerkOrgId,
      orgSlug: tenant.slug,
      userId: null,
      scopes,
      allowedSources: [],
    };
    const ctx: OperationContext = {
      tenant,
      auth,
      remote: true,
    };
    // The handler return is the SDK's ServerResult union; our ToolResult is
    // a valid CallToolResult member but TS needs the cast through the union.
    return (await handleMcpCall(name, args, ctx, deps)) as never;
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // ─── Shutdown ────────────────────────────────────────────────────────────
  // Exit cleanly when the MCP client disconnects or on signals. Without
  // this, orphaned serve processes accumulate. Ported from GBrain
  // _reference/gbrain/src/mcp/server.ts lines 95-122.
  let shuttingDown = false;
  const shutdown = (reason: string, code = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[graphbrain-mcp] shutdown: ${reason}\n`);
    // Close the per-tenant engine (best-effort). The router caches engines;
    // closing here releases the HelixDB connection for this serve session.
    Promise.resolve(deps.router.getEngine(tenant))
      .then((engine) => engine.close?.())
      .catch(() => {})
      .finally(() => process.exit(code));
  };

  // MCP_STDIO=1 guard: when the wrapping gateway pipes the JSON-RPC handshake
  // then closes its stdin half, treating that as a permanent disconnect
  // kills the server before the first tool call arrives. Signal handlers +
  // transport.onclose still cover the legitimate shutdown paths.
  if (process.env.MCP_STDIO !== "1") {
    process.stdin.on("end", () => shutdown("stdin end"));
    process.stdin.on("close", () => shutdown("stdin close"));
  }
  // The SDK exposes `onclose` on the transport.
  transport.onclose = () => shutdown("transport close");
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));
}
