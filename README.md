# Graphbrain

> A cloud-native, multi-tenant **knowledge brain** for AI agents — powered by HelixDB.
> Persistent memory, hybrid retrieval, and a Model Context Protocol (MCP) server
> designed so an agent can configure it for itself with minimal human help.

Graphbrain gives every tenant (Clerk organization) a **physically isolated**
HelixDB instance — not a shared schema with row-level security, but a separate
knowledge graph + vector + BM25 store per tenant. Agents talk to it over MCP
(stdio or HTTP) using a small, contract-first set of operations: `search`,
`query`, `put_page`, `capture`, `add_link`, and friends.

It is the hosted successor to GBrain, built for agent-memory tools like
**OpenClaw**, **Hermes**, and anything else that speaks MCP.

---

## Table of contents

- [Status: build in public](#status-build-in-public)
- [What it is](#what-it-is)
- [How an agent connects](#how-an-agent-connects)
  - [Path A — Hosted HTTP MCP (recommended, least friction)](#path-a--hosted-http-mcp-recommended-least-friction)
  - [Path B — Local stdio MCP](#path-b--local-stdio-mcp)
- [The copy/pastable agent-setup prompt](#the-copypastable-agent-setup-prompt)
- [MCP tools reference](#mcp-tools-reference)
- [REST API reference](#rest-api-reference)
- [Configuration](#configuration)
- [Local development](#local-development)
- [Architecture](#architecture)
- [Project layout](#project-layout)
- [Testing](#testing)
- [Comparables & philosophy](#comparables--philosophy)
- [License](#license)

---

## Status: build in public

Graphbrain is being built in public, stage by stage. Each stage lands as its
own commit (see `git log`). Current status:

| Stage | What | Status |
|------:|------|--------|
| 0 | Monorepo scaffold + local dev infra | done |
| 1 | Core types + config + Zod schemas | done |
| 2 | Polygres control plane + migrations | done |
| 3 | Coolify integration (HelixDB provisioning) | done |
| 4 | Clerk backend API client + webhooks | done |
| 5 | Clerk auth middleware + tenant resolver | done |
| 6 | HelixDB schema, indexes, dynamic queries | done |
| 7 | BrainEngine interface + HelixEngine + TenantRouter | done |
| 8 | AI Gateway (OpenRouter) + Embedding Service | done |
| 9 | Hybrid retrieval pipeline (RRF + rerank + token budget) | done |
| 10 | Operations contract (single source of truth) | done |
| 11 | MCP server (stdio + HTTP) | done |
| 12 | API service (Express 5) | done |
| 13 | Dashboard (Next.js 16) | done |
| 14 | Marketing site | scaffold stub |
| 15 | CLI (`graphbrain serve`, `graphbrain connect`) | **not started** |
| 16 | End-to-end integration tests | **not started** |

> **Heads up:** because Stage 15 (CLI) is not yet built, the stdio MCP server
> does not have a one-line launcher. The **HTTP MCP endpoint is the supported
> path today.** See [Path B](#path-b--local-stdio-mcp) for a hand-rolled stdio
> bootstrap if you need it.

---

## What it is

Graphbrain is three things stacked together:

1. **A control plane** (Polygres = Postgres 16 + pgGraph + pgVector) that owns
   tenant metadata, OAuth tokens, query cache, and metering.
2. **A per-tenant brain** (HelixDB instance per Clerk org) holding the actual
   knowledge graph: `Page`, `Chunk`, `Source` nodes + `MENTIONS`, `HAS_CHUNK`,
   `CONTAINS`, and typed edges.
3. **A contract-first operations layer** that is the single source of truth for
   the MCP server, the REST API, and the (future) CLI. Add an operation once
   and every transport surface gets it.

Retrieval is a real hybrid pipeline: vector search + BM25 + graph traversal,
fused with Reciprocal Rank Fusion, boosted by graph signals, cross-encoder
reranked, deduplicated, and trimmed to a token budget. There is a
Polygres-backed semantic query cache keyed on `knobs_hash` so repeated queries
skip the LLM.

External services:

- **Clerk** — auth, organizations, API keys, webhooks.
- **Coolify** — provisions and manages the per-tenant HelixDB containers.
- **OpenRouter** — chat, embeddings, reranking (the AI gateway).
- **MinIO** — S3-compatible object storage.

---

## How an agent connects

There are two transports. Pick the one that matches where your agent runs.

### Path A — Hosted HTTP MCP (recommended, least friction)

This is the path that works today with zero local infrastructure. Your agent
talks MCP "streamable HTTP" to the Graphbrain API and authenticates with a
Clerk API key scoped to your organization.

**What the human has to do once (≈2 minutes):**

1. Sign in at the dashboard and complete onboarding — this creates a Clerk
   organization and provisions your dedicated HelixDB instance (a minute or two).
2. Go to **Dashboard → API Keys** and generate a key. Copy it. Hand it to your
   agent (env var, secret store, whatever your agent uses).

**What the agent does from there:**

Add this to your MCP client config (Claude Desktop, Cursor, Windsurf, OpenClaw,
Hermes, etc. — anything that speaks MCP over HTTP):

```json
{
  "mcpServers": {
    "graphbrain": {
      "url": "https://api.graphbrain.belweave.ai/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_CLERK_API_KEY>"
      }
    }
  }
}
```

That's it. The endpoint exposes `initialize`, `tools/list`, and `tools/call`
over JSON-RPC. Write/admin operations require scopes — see
[Scopes & trust boundary](#scopes--trust-boundary) below.

### Path B — Local stdio MCP

For agents that prefer a local stdio pipe (Claude Desktop's native shape, a
self-hosted box, air-gapped setups). Because the CLI (Stage 15) is not yet
built, you need a tiny bootstrap that constructs the dispatch deps and starts
the server. Drop this as `mcp-stdio.ts` at your repo root:

```ts
import {
  startMcpServer,
  TenantRouter,
  AIGateway,
  EmbeddingService,
  OpenRouterProvider,
  getConfig,
  getTenantById, // from @graphbrain/core control plane
} from "@graphbrain/core";

const config = getConfig();

const router = new TenantRouter({ encryptionKey: config.encryptionKey });
const gateway = new AIGateway({
  provider: new OpenRouterProvider({ apiKey: config.openrouterApiKey }),
});
const embeddingService = new EmbeddingService({ gateway });

// Resolve the tenant this stdio server serves by its UUID primary key
// (seeded in _graphbrain.tenants — see the sandbox setup guide).
const tenant = await getTenantById(process.env.GRAPHBRAIN_TENANT_ID!);
if (!tenant) throw new Error(`tenant not found: ${process.env.GRAPHBRAIN_TENANT_ID}`);

await startMcpServer(
  { router, gateway, embeddingService },
  { tenant },
);
```

Then wire it into your MCP client config:

```json
{
  "mcpServers": {
    "graphbrain": {
      "command": "bun",
      "args": ["run", "/path/to/graphbrain/mcp-stdio.ts"],
      "env": {
        "GRAPHBRAIN_TENANT_ID": "<tenant-uuid>",
        "ENCRYPTION_KEY": "<base64 32-byte key>",
        "OPENROUTER_API_KEY": "<key>",
        "POLYGRES_DATABASE_URL": "postgres://graphbrain:graphbrain@localhost:5432/graphbrain_control",
        "GRAPHBRAIN_MCP_SCOPES": "write",
        "MCP_STDIO": "1"
      }
    }
  }
}
```

> `MCP_STDIO=1` is required for clients (OpenClaw's bundle-mcp layer, some
> others) that pipe the JSON-RPC handshake then close their stdin half.
> Without it the server treats that as a disconnect and exits before the first
> tool call. `GRAPHBRAIN_MCP_SCOPES=write` widens the default read-only scope
> so your agent can ingest pages — see below.

#### Scopes & trust boundary

The operations layer enforces a strict trust boundary (ported from GBrain):

- **read ops** — any authenticated caller.
- **write/admin ops** — allowed only if `ctx.remote === false` (trusted local)
  **or** the caller's `auth.scopes` include the op's scope.
- **localOnly ops** — `ctx.remote === false` always; no remote caller can ever
  invoke them, regardless of scopes.

Stdio MCP is treated as **untrusted** (`remote = true`) with `scopes = ['read']`
by default. To let a stdio agent write, set `GRAPHBRAIN_MCP_SCOPES=write` (or
`write,admin`). HTTP MCP scopes come from the Clerk API key's grants — manage
them in the dashboard.

---

## The copy/pastable agent-setup prompt

This is the block to hand your agent (Claude, Cursor, Windsurf, Devin, etc.)
so it can wire Graphbrain into its own MCP config with minimal back-and-forth.
It is written to be read by both a human and an agent.

```text
You are going to connect me to Graphbrain, a hosted knowledge brain for agents,
over MCP. Here is everything you need.

# Goal
Add Graphbrain as an MCP server in my MCP client config so I can use it for
persistent memory: search, query, capture pages, and add links.

# What I will give you
- GRAPHBRAIN_API_KEY  — a Clerk API key for my Graphbrain org (I'll generate it
  in the dashboard under API Keys and paste it here when you ask).
- GRAPHBRAIN_API_URL  — the Graphbrain API base URL. Default:
  https://api.graphbrain.belweave.ai  (confirm with me before assuming).

# What you should do
1. Confirm whether my MCP client supports HTTP MCP servers (streamable HTTP
   transport). Most modern clients do (Claude Desktop, Cursor, Windsurf,
   OpenClaw, Hermes). If yes, prefer the HTTP path below. If it only supports
   stdio, stop and ask me — stdio needs a local bootstrap and a running
   Polygres + HelixDB, which is more setup.
2. Find my MCP client config file. Common locations:
   - Claude Desktop:  ~/Library/Application Support/Claude/claude_desktop_config.json (macOS)
                      %APPDATA%\Claude\claude_desktop_config.json (Windows)
   - Cursor:          ~/.cursor/mcp.json  (or project-level .cursor/mcp.json)
   - Windsurf:        ~/.codeium/windsurf/mcp_config.json
   - Generic:         ask me where my client keeps its MCP config
3. Add (or merge) this server entry. Replace <GRAPHBRAIN_API_KEY> with the key
   I provide and <GRAPHBRAIN_API_URL> with the confirmed URL:
   {
     "mcpServers": {
       "graphbrain": {
         "url": "<GRAPHBRAIN_API_URL>/mcp",
         "headers": { "Authorization": "Bearer <GRAPHBRAIN_API_KEY>" }
       }
     }
   }
4. Do NOT commit the API key to any repo. If you write it to a file, make sure
   that file is gitignored or lives outside the repo.
5. After saving, tell me to restart my MCP client so it picks up Graphbrain.
6. Once it's connected, verify by calling the MCP `tools/list` method. You
   should see 14 tools: search, query, get_page, list_pages, put_page,
   create_page, add_chunk, list_sources, get_source, add_source, get_links,
   get_backlinks, add_link, capture. If tools/list fails with 401/403, the
   API key is wrong or lacks scopes — ask me to regenerate it with write scope
   in the dashboard.
7. Do a smoke test: call `capture` with a short note about this setup session,
   then call `search` for a word from that note. If both succeed, Graphbrain
   is wired up. Report success and the tool list back to me.

# Notes
- Default scopes on a fresh API key may be read-only. If `capture` or
  `put_page` returns permission_denied, ask me to issue a key with write scope
  from Dashboard → API Keys.
- Graphbrain is per-tenant: every call is scoped to my organization's isolated
  HelixDB instance. There is no cross-tenant access.
- For local stdio setup instead of HTTP, ask me — it requires a running
  Polygres + HelixDB and a small bootstrap script. Only go there if HTTP is
  not an option.
```

---

## MCP tools reference

All 14 tools are auto-generated from the operations registry in
`packages/core/src/operations/index.ts` — the single source of truth for MCP,
REST, and the future CLI. Adding an operation there automatically extends every
transport.

| Tool | Scope | Description |
|------|-------|-------------|
| `search` | read | Hybrid search over the tenant's brain (vector + BM25 + graph, RRF-fused, reranked, token-budgeted). |
| `query` | read | Hybrid search + LLM synthesis with citations. |
| `get_page` | read | Fetch a page by slug with its chunks and edges. |
| `list_pages` | read | List pages with filters + pagination. |
| `put_page` | write | Create or update a page from markdown. Auto-chunks, embeds, and extracts links. |
| `create_page` | write | Create a bare page (no chunking/embedding). |
| `add_chunk` | write | Add a single chunk to an existing page. |
| `list_sources` | read | List sources. |
| `get_source` | read | Get a source by ID. |
| `add_source` | write | Add a source. |
| `get_links` | read | Outgoing links from a page. |
| `get_backlinks` | read | Incoming links to a page. |
| `add_link` | write | Add a manual link between pages. |
| `capture` | write | Quick capture — infer type, wrap as a page. The agent-friendly ingest op. |

Tool input schemas are emitted via Zod 4's native `z.toJSONSchema()` (see
`packages/core/src/mcp/tool-defs.ts`). `localOnly` ops are filtered out of the
remote tool list.

<details>
<summary>JSON-RPC method summary (HTTP endpoint)</summary>

`POST /mcp` speaks the MCP streamable HTTP protocol. Methods:

- `initialize` — handshake; returns `{ name: "graphbrain", version: "0.0.0" }`.
- `notifications/initialized` — client ack.
- `tools/list` — returns the 14 tool defs above.
- `tools/call` — dispatches a tool by `name` with `arguments`.

`GET /mcp/tools` returns a plain JSON tool list for a quick probe without
JSON-RPC framing.

</details>

---

## REST API reference

Base URL: `http://localhost:3000` (or `API_PORT`). All authenticated routes
require a Clerk JWT (browser session) or a Clerk API key (agent) via the
`Authorization: Bearer <key>` header.

<details>
<summary>Public + webhook routes</summary>

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| `GET` | `/api/health` | none | Liveness; always `200 { status: "ok" }`. |
| `GET` | `/api/ready` | none | Readiness; checks Polygres + engine health. |
| `POST` | `/webhooks/clerk` | webhook secret | Clerk org + API-key lifecycle events. |

</details>

<details>
<summary>MCP routes</summary>

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| `POST` | `/mcp` | Clerk | MCP JSON-RPC endpoint. |
| `GET` | `/mcp/tools` | Clerk | Plain JSON tool list probe. |

</details>

<details>
<summary>Dashboard REST API (<code>/api/dashboard/*</code>)</summary>

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/api/dashboard/stats` | Page count, chunk count, recent pages. |
| `POST` | `/api/dashboard/search` | Hybrid search. |
| `GET` | `/api/dashboard/pages` | List pages with filters + pagination. |
| `POST` | `/api/dashboard/pages` | Create/update a page. |
| `GET` | `/api/dashboard/pages/:slug` | Get page by slug with chunks + edges. |
| `GET` | `/api/dashboard/sources` | List sources. |
| `GET` | `/api/dashboard/settings` | Get tenant settings. |
| `PUT` | `/api/dashboard/settings` | Update tenant settings (AI model, embedding model). |
| `POST` | `/api/dashboard/api-keys` | Issue a Clerk API key. |
| `GET` | `/api/dashboard/api-keys` | List API keys (metadata only). |
| `DELETE` | `/api/dashboard/api-keys/:id` | Revoke an API key. |

Phase 2 stubs (return `501`): `/api/dashboard/jobs`, `/api/dashboard/sources/sync`, `/api/dashboard/billing`.

</details>

---

## Configuration

Graphbrain is env-driven. Copy `.env.example` to `.env` and fill in real
values. See `packages/core/src/config.ts` for the loader.

<details>
<summary>Full environment variable reference</summary>

### Clerk (required for the hosted service)
| Var | Purpose |
|-----|---------|
| `CLERK_SECRET_KEY` | Clerk backend API secret key. |
| `CLERK_PUBLISHABLE_KEY` | Clerk frontend publishable key (dashboard). |
| `CLERK_JWT_ISSUER` | Clerk JWT issuer URL. |
| `CLERK_WEBHOOK_SECRET` | Clerk webhook signing secret. |
| `CLERK_API_URL` | Clerk Backend API base URL. Default `https://api.clerk.com/v1`. |

### Coolify (required for provisioning)
| Var | Purpose |
|-----|---------|
| `COOLIFY_API_URL` | Coolify REST API base URL. |
| `COOLIFY_API_TOKEN` | Coolify API service token. |
| `COOLIFY_SERVER_UUID` | Coolify server UUID where HelixDB instances land. |

### OpenRouter (required for AI)
| Var | Purpose |
|-----|---------|
| `OPENROUTER_API_KEY` | OpenRouter API key (chat, embeddings, rerank). |

### Encryption (required)
| Var | Purpose |
|-----|---------|
| `ENCRYPTION_KEY` | AES-256-GCM key, 32 bytes base64. Generate with `openssl rand -base64 32`. Used to encrypt per-tenant HelixDB credentials at rest. |

### Polygres (local dev — set by docker-compose)
| Var | Purpose |
|-----|---------|
| `POLYGRES_DATABASE_URL` | Postgres connection URL. Default `postgres://graphbrain:graphbrain@localhost:5432/graphbrain_control`. |

### MinIO (local dev — set by docker-compose)
| Var | Purpose |
|-----|---------|
| `MINIO_ENDPOINT` | MinIO S3 endpoint. Default `http://localhost:9000`. |
| `MINIO_ACCESS_KEY` | MinIO access key. Default `graphbrain`. |
| `MINIO_SECRET_KEY` | MinIO secret key. Default `graphbrain-dev-secret`. |

### HelixDB (local dev — set by docker-compose)
| Var | Purpose |
|-----|---------|
| `HELIX_INSTANCE_URL` | Local HelixDB instance URL. Default `http://localhost:8080`. |
| `HELIX_API_KEY` | Local HelixDB API key. Default `dev-key`. |

### Runtime + MCP
| Var | Purpose |
|-----|---------|
| `GRAPHBRAIN_DEBUG` | Enable debug logging. Default `false`. |
| `API_PORT` | API server port. Default `3000`. |
| `GRAPHBRAIN_MCP_SCOPES` | Comma-separated scopes for stdio MCP. Default `read`. Set `write` or `write,admin` to allow writes from stdio. |
| `MCP_STDIO` | Set `1` to disable stdin-EOF shutdown trigger (for clients that pipe the handshake then close stdin half). |

</details>

---

## Local development

Prerequisites: **Bun >= 1.3**, **Docker** (for the local infra stack).

```bash
# 1. Start the local infra stack (Polygres, MinIO, HelixDB)
docker compose up -d

# 2. Install deps
bun install

# 3. Configure env
cp .env.example .env
# fill in CLERK_*, COOLIFY_*, OPENROUTER_API_KEY, ENCRYPTION_KEY
# (POLYGRES_*, MINIO_*, HELIX_* are already set for docker-compose)

# 4. Run everything in dev (API + dashboard + marketing)
bun run dev

# Or run individual apps:
bun run dev:api         # Express API on :3000
bun run dev:dashboard   # Next.js dashboard
bun run dev:marketing   # Next.js marketing (stub)
```

<details>
<summary>Other scripts</summary>

```bash
bun run build        # build all workspaces
bun run typecheck    # tsc --noEmit across all workspaces
bun test             # run all tests
bun test packages/core   # core library tests only
bun test apps/api        # API tests only
```

</details>

---

## Architecture

<details>
<summary>Request flow (HTTP MCP)</summary>

```
Agent ── POST /mcp (Bearer apikey) ──▶ Express API
  │                                        │
  │                                        ▼
  │                              clerk-auth middleware
  │                              (verify JWT or API key)
  │                                        │
  │                                        ▼
  │                              tenant-resolver middleware
  │                              (Clerk org → Tenant, cached)
  │                                        │
  │                                        ▼
  │                              context builder
  │                              (OperationContext, remote=true)
  │                                        │
  │                                        ▼
  │                              MCP route → handleMcpCall
  │                              → dispatch(name, input, ctx, deps)
  │                                        │
  │                                        ▼
  │                              enforceTrustBoundary
  │                              → Zod validate
  │                              → TenantRouter.getEngine(tenant)
  │                                        │
  │                                        ▼
  │                              HelixEngine (per-tenant HelixDB)
  │                              + AIGateway + EmbeddingService
```

</details>

<details>
<summary>Hybrid retrieval pipeline (Stage 9)</summary>

```
query
  │
  ├── intent classifier (deterministic) ──▶ intent → ranking knobs
  ├── LLM query expansion (optional)
  │
  ├── vector search  ─┐
  ├── BM25 search   ─┤──▶ RRF fusion ──▶ graph-signal boosts
  ├── graph traverse ─┘                  ──▶ cross-encoder rerank
                                          ──▶ dedup
                                          ──▶ token-budget trim
                                          ──▶ (semantic query cache, Polygres)
                                          ──▶ results
```

Search mode presets: `conservative`, `balanced`, `tokenmax`. The semantic
query cache is keyed on `knobs_hash` so changing ranking knobs invalidates
correctly.

</details>

<details>
<summary>Per-tenant isolation</summary>

Each Clerk organization maps 1:1 to a Graphbrain tenant, which maps 1:1 to a
physically separate HelixDB container provisioned via Coolify. The
`TenantRouter` (`packages/core/src/tenant.ts`) holds an LRU cache of
`HelixEngine` instances keyed by tenant, with health checks. HelixDB
credentials are encrypted at rest in Polygres with AES-256-GCM and decrypted
per-request. There is no shared schema and no row-level security — isolation
is physical.

</details>

---

## Project layout

```
graphbrain/
├── apps/
│   ├── api/              Express 5 API (Stage 12) — MCP, dashboard REST, webhooks, health
│   ├── dashboard/        Next.js 16 dashboard (Stage 13) — onboarding, search, pages, API keys, settings
│   └── marketing/        Next.js marketing (Stage 14 — stub)
├── packages/
│   └── core/             Shared core library
│       ├── src/
│       │   ├── types.ts / schemas.ts / config.ts
│       │   ├── control/      Polygres, Coolify, Clerk, encryption, migrations
│       │   ├── helix/        HelixDB schema, indexes, dynamic queries
│       │   ├── ai/           AI gateway (OpenRouter + Triad stub)
│       │   ├── search/       Hybrid retrieval pipeline
│       │   ├── operations/   Contract-first operation registry + dispatcher
│       │   ├── mcp/          MCP server (stdio + HTTP), tool defs, dispatch
│       │   ├── engine.ts / helix-engine.ts / tenant.ts
│       │   └── embedding.ts
├── PLAN.md               Architecture & design reference
├── IMPLEMENTATION.md     Stage-by-stage implementation plan
├── .env.example
├── docker-compose.yml    Local dev stack
└── package.json          Bun workspace root
```

---

## Testing

```bash
bun test                # all tests
bun test packages/core  # core library
bun test apps/api       # API service
```

Tests live under `packages/core/test/` and `apps/api/test/`. End-to-end
integration tests (Stage 16) are not yet implemented.

---

## Comparables & philosophy

Graphbrain is built for the same niche as **OpenClaw** and **Hermes** —
agent-memory tools that want a persistent, queryable brain behind an MCP
interface. The design choices that matter for agents:

- **MCP-native.** The operations registry is the source of truth; MCP tools are
  auto-generated from it. No hand-maintained tool list to drift.
- **Per-tenant physical isolation.** Each agent (or org) gets its own HelixDB
  instance. No noisy neighbors, no cross-tenant leakage.
- **Contract-first trust boundary.** `remote = true` is fail-closed; write ops
  require explicit scope grants. Stdio defaults to read-only.
- **Agent-friendly ingest.** `capture` infers type and wraps content as a page;
  `put_page` auto-chunks, embeds, and extracts links from markdown. An agent
  can dump notes and search them without a human curating anything.
- **`MCP_STDIO=1`** explicitly handles clients that pipe the handshake then
  close stdin half — a real-world gotcha that quietly breaks stdio MCP servers.

---

## License

[MIT](./LICENSE) — © Graphbrain contributors.
