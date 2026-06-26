# Graphbrain — Architecture & Implementation Plan

> Cloud-native hosted knowledge brain, powered by HelixDB.
> Reimplements GBrain's full feature set as a multi-tenant SaaS for agent memory (Openclaw, Hermes, and others).

## Design Principles

1. **Full GBrain parity (1:1 or better).** Every operation, every feature, every retrieval signal. No feature left behind. Performance must meet or exceed GBrain.
2. **Per-tenant isolation from day one.** Every tenant gets their own HelixDB instance. No shared-cluster logical isolation — physical isolation only.
3. **HelixDB-powered.** The knowledge graph, vectors, and BM25 live in HelixDB. This is the core differentiator vs. GBrain's Postgres+pgvector.
4. **Contract-first operations.** Port GBrain's operation contract system — single source of truth for MCP, CLI, and API.
5. **Engine abstraction.** `BrainEngine` interface keeps us portable. A Polygres-backed engine is possible as a fallback.

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Runtime | Bun >= 1.3 | Same as GBrain; enables code reuse |
| Language | TypeScript | Direct port of GBrain's TS codebase (MIT licensed) |
| Knowledge graph + vectors + BM25 | HelixDB (self-hosted on Coolify) | Per-tenant isolated instances, provisioned via Coolify |
| Control plane (relational) | Polygres (Evokoa) | Postgres + pgGraph + pgVector; shared instance, per-tenant schemas |
| AI gateway (primary) | OpenRouter | Unified access to Anthropic, OpenAI, Google, Meta, Mistral, etc. |
| AI gateway (secondary) | Triad | OpenAI-compatible API; low-cost coding + embeddings; deferred — focus on OpenRouter |
| Agent transport | MCP (stdio + HTTP/OAuth 2.1) | Ported from GBrain |
| Authentication | Clerk | User auth, org/tenant mapping, session management |
| Validation | Zod | Ported from GBrain |
| HTTP framework | Express 5 | Ported from GBrain |
| SDK (HelixDB) | `helixdb` TS SDK | Dynamic queries + stored queries |
| Infrastructure | Coolify (home server cluster) | Container orchestration, HelixDB instance provisioning, SSL, routing |
| Frontend (app) | Next.js (graphbrain.belweave.ai) | Dashboard, tenant management, billing |
| Frontend (marketing) | Next.js (belweave.ai/graphbrain) | Landing page, docs, pricing |

---

## Architecture

```
                    Agents (Openclaw / Hermes / Claude / Cursor / Windsurf / ...)
                                    │
                    ┌───────────────┼───────────────┐
                    │  MCP stdio    │  MCP HTTP     │
                    │  (local)      │  (Clerk JWT)  │
                    └───────┬───────┴───────┬───────┘
                            │               │
                            ▼               ▼
                    ┌───────────────────────────────┐
                    │     Graphbrain API Service     │
                    │  (TypeScript / Bun)            │
                    │                                │
                    │  ┌──────────────────────────┐  │
                    │  │  Clerk Auth Middleware   │  │  ← JWT verification, org/tenant resolution
                    │  └──────────┬───────────────┘  │
                    │             │                  │
                    │  ┌──────────▼───────────────┐  │
                    │  │  Operations Contract     │  │  ← 90+ ops, ported from GBrain
                    │  │  (tenant-aware dispatch) │  │
                    │  └──────────┬───────────────┘  │
                    │             │                  │
                    │  ┌──────────▼───────────────┐  │
                    │  │  Tenant Router           │  │  ← resolves tenant → HelixDB instance
                    │  └──────────┬───────────────┘  │
                    │             │                  │
                    │  ┌──────────▼───────────────┐  │
                    │  │  BrainEngine (HelixDB)   │  │  ← per-tenant isolated engine
                    │  └──────────┬───────────────┘  │
                    │             │                  │
                    │  ┌──────────▼───────────────┐  │
                    │  │  Retrieval Pipeline      │  │  ← app-layer RRF + boosts + rerank
                    │  │  (hybrid search)         │  │
                    │  └──────────┬───────────────┘  │
                    │             │                  │
                    │  ┌──────────▼───────────────┐  │
                    │  │  AI Gateway              │  │  ← OpenRouter (primary)
                    │  │  (embed / rerank /       │  │    Triad (secondary, deferred)
                    │  │   expand / synth /       │  │
                    │  │   calibrate)             │  │
                    │  └──────────────────────────┘  │
                    └───────────────────────────────┘
                         │                    │
            ┌────────────┘                    └────────────┐
            ▼                                              ▼
  ┌───────────────────┐                         ┌────────────────────┐
  │  HelixDB          │                         │  Polygres          │
  │  (Coolify-managed)│                         │  (Coolify-managed) │
  │                   │                         │                    │
  │  Per-tenant       │                         │  Per-tenant        │
  │  isolated         │                         │  schemas:          │
  │  instances:       │                         │  - tenants meta    │
  │                   │                         │  - oauth_clients   │
  │  Tenant A → DB-A  │                         │  - minion_jobs     │
  │  Tenant B → DB-B  │                         │  - query_cache     │
  │  Tenant C → DB-C  │                         │  - calibration     │
  │  ...              │                         │  - audit_log       │
  │                   │                         │  - usage_metering  │
  │  Provisioned via  │                         │                    │
  │  Coolify API      │                         │  pgGraph + pgVector│
  └───────────────────┘                         │  for analytics     │
                                                └────────────────────┘

  ┌───────────────────────────────────────────────────────────────┐
  │  Coolify (home server cluster)                                │
  │                                                                │
  │  - Container orchestration for all services                   │
  │  - HelixDB instance provisioning (API-driven)                 │
  │  - SSL / TLS termination                                      │
  │  - Reverse proxy + routing                                    │
  │  - graphbrain.belweave.ai  → Graphbrain app (Next.js)         │
  │  - belweave.ai/graphbrain  → Marketing page (Next.js)         │
  │  - api.graphbrain.belweave.ai → Graphbrain API (Bun)          │
  │  - helix-<tenant>.internal  → Per-tenant HelixDB instances    │
  └───────────────────────────────────────────────────────────────┘

  ┌───────────────────┐
  │  Clerk            │
  │  (hosted)         │
  │                   │
  │  - User auth      │
  │  - Org / tenant   │
  │    mapping        │
  │  - API keys for   │
  │    MCP agents     │
  │  - Session mgmt   │
  └───────────────────┘
```

---

## Storage Mapping

### HelixDB — Knowledge Graph (per-tenant isolated instance)

Each tenant gets a dedicated HelixDB instance containing ALL knowledge data.

#### Node Types

| HelixDB Label | GBrain Table | Key Properties |
|---|---|---|
| `Page` | `pages` | `slug`, `type`, `title`, `compiled_truth`, `frontmatter` (object), `content_hash`, `emotional_weight`, `effective_date`, `effective_date_source`, `import_filename`, `salience_touched_at`, `last_retrieved_at`, `links_extracted_at`, `contextual_retrieval_mode`, `corpus_generation`, `generation`, `created_at`, `updated_at`, `deleted_at` |
| `Chunk` | `content_chunks` | `page_id` (ref to Page), `chunk_index`, `content`, `modality`, `embedding` (vector — text), `embedding_voyage` (vector — Voyage), `embedding_image` (vector — multimodal), `created_at` |
| `Source` | `sources` | `name`, `local_path`, `last_commit`, `last_sync_at`, `config` (object), `chunker_version`, `archived`, `archived_at`, `archive_expires_at`, `contextual_retrieval_mode`, `trust_frontmatter_overrides`, `newest_content_at`, `created_at` |
| `Fact` | `facts` | `page_id` (ref), `row_num`, `claim`, `kind`, `confidence`, `visibility`, `notability`, `valid_from`, `valid_until`, `source`, `context` |
| `Take` | `takes` | `page_id` (ref), `row_num`, `claim`, `kind`, `who`, `weight`, `since`, `source`, `resolvedQuality`, `resolvedOutcome`, `resolvedEvidence` |
| `TimelineEntry` | `timeline` | `page_id` (ref), `date`, `event`, `source` |
| `File` | `files` | `page_id` (ref), `storage_path`, `mime_type`, `size_bytes`, `sha256`, `created_at` |
| `CodeSymbol` | (derived from code pages) | `page_id`, `symbol_name`, `symbol_kind`, `file_path`, `line_start`, `line_end`, `embedding` |
| `Tag` | (derived from frontmatter) | `name`, `slug` |

#### Edge Types

| Edge Label | From → To | GBrain Concept | Properties |
|---|---|---|---|
| `WORKS_AT` | Page → Page | typed link | `origin` (auto/manual/typed-link) |
| `FOUNDED` | Page → Page | typed link | `origin` |
| `INVESTED_IN` | Page → Page | typed link | `origin` |
| `ATTENDED` | Page → Page | typed link | `origin` |
| `ADVISES` | Page → Page | typed link | `origin` |
| `MENTIONS` | Page → Page | generic link | `origin` |
| `CONTAINS` | Source → Page | source membership | — |
| `HAS_CHUNK` | Page → Chunk | page chunking | — |
| `HAS_FACT` | Page → Fact | facts fence | — |
| `HAS_TAKE` | Page → Take | takes fence | — |
| `TIMELINE` | Page → TimelineEntry | timeline | — |
| `HAS_FILE` | Page → File | file attachment | — |
| `TAGGED` | Page → Tag | tag association | — |
| `CALLS` | CodeSymbol → CodeSymbol | code reference | `call_kind` |
| `DEFINED_IN` | CodeSymbol → Page | code definition | — |

#### Indexes

| Index Type | Target | Config |
|---|---|---|
| `nodeVector` | `Chunk.embedding` | ANN, m=16, ef_construction=128, ef_search=768 |
| `nodeVector` | `Chunk.embedding_voyage` | ANN (Voyage embeddings) |
| `nodeVector` | `Chunk.embedding_image` | ANN (multimodal) |
| `nodeVector` | `Page` synthetic embedding | ANN (page-level compiled truth embedding) |
| `nodeText` | `Chunk.content` | BM25 |
| `nodeText` | `Page.compiled_truth` | BM25 |
| `nodeText` | `Page.title` | BM25 |
| `nodeEquality` | `Page.slug` | exact lookup |
| `nodeEquality` | `Page.type` | type filtering |
| `nodeRange` | `Page.effective_date` | temporal queries |
| `nodeRange` | `Page.updated_at` | recency |
| `nodeRange` | `Page.salience_touched_at` | salience scans |
| `nodeEquality` | `Fact.visibility` | privacy filtering |
| `nodeEquality` | `Take.who` | holder filtering |

### Polygres — Control Plane (shared, per-tenant schemas)

| Schema/Table | Purpose |
|---|---|
| `_graphbrain.tenants` | `id`, `name`, `helix_instance_id`, `helix_instance_url`, `helix_api_key` (encrypted), `tier`, `created_at`, `settings` (JSONB — per-tenant config overrides) |
| `_graphbrain.oauth_clients` | OAuth 2.1 client registration (ported from GBrain) |
| `_graphbrain.oauth_tokens` | Token store (ported) |
| `_graphbrain.minion_jobs` | Job queue — Postgres-native (ported from GBrain's queue.ts) |
| `_graphbrain.query_cache` | Semantic cache: `tenant_id`, `query_hash`, `knobs_hash`, `results` (JSONB), `created_at`, `hits`, `ttl_at` |
| `_graphbrain.calibration_profiles` | Per-entity quality tracking: `tenant_id`, `entity_slug`, `brier_score`, `conviction_bucket`, `hit_rate`, `pattern_statements` (JSONB), `updated_at` |
| `_graphbrain.audit_log` | Per-tenant operation audit: `tenant_id`, `operation`, `caller`, `params_hash`, `result_status`, `latency_ms`, `tokens_used`, `cost_usd`, `created_at` |
| `_graphbrain.usage_metering` | Billing/metering: `tenant_id`, `operation`, `count`, `tokens_in`, `tokens_out`, `embeddings_count`, `cost_usd`, `period_start`, `period_end` |
| `_graphbrain.tenant_ai_keys` | Per-tenant BYO API keys (encrypted): `tenant_id`, `provider`, `api_key_encrypted`, `created_at` |

**Polygres pgGraph + pgVector usage:** Available for control-plane analytics — e.g., global entity resolution graphs, cross-tenant knowledge graphs (if opted in), calibration trajectory analysis with vector similarity. Not used for primary knowledge storage (that's HelixDB).

---

## Multi-Tenancy — Per-Tenant Isolated HelixDB

### Provisioning (via Coolify)

Every tenant gets a dedicated HelixDB instance provisioned at signup, orchestrated through Coolify's API:

1. **User signs up** via Clerk on `graphbrain.belweave.ai` → Clerk org created
2. **Tenant row created** in Polygres `_graphbrain.tenants` with `clerk_org_id`, `tier`, `status=pending`
3. **Coolify API call:** Provision new HelixDB container
   - `POST /api/v1/applications` (Coolify REST API) with HelixDB Docker image + unique name `helix-<tenant-slug>`
   - Configure port (auto-assigned), env vars (HELIX_API_KEY generated), storage volume
   - Coolify handles container scheduling on the home server cluster
4. **Wait for health:** Poll HelixDB instance `/health` until ready
5. **Schema deployment:** Push stored queries + create indexes via HelixDB TS SDK
6. **Update tenant row:** `helix_instance_url`, `helix_api_key` (encrypted), `coolify_app_id`, `status=active`
7. **Internal routing:** Coolify reverse proxy maps `helix-<tenant-slug>.internal` → container port
8. **Tenant notified:** Dashboard shows "Brain ready"

### Routing

```
MCP/HTTP request → Clerk JWT verification → extract clerk_org_id
                 → lookup tenants row by clerk_org_id
                 → get helix_instance_url + helix_api_key (decrypted)
                 → TenantRouter returns cached or new HelixEngine(instance_url, api_key)
                 → dispatch operation through that engine
```

The `TenantRouter`:
- Caches `HelixEngine` instances per-tenant (LRU with TTL + health checks)
- Validates instance health before reuse; re-provisions if unhealthy
- No tenant ever touches another tenant's HelixDB instance — isolation is physical

### Instance lifecycle (Coolify-managed)

| Stage | Action | Mechanism |
|---|---|---|
| **Provision** | New HelixDB container + schema + indexes | Coolify API → Docker container → health check → schema push |
| **Scale** | Per-instance reader auto-scaling | HelixDB's multi-reader architecture within the container |
| **Backup** | Per-instance volume snapshots | Coolify scheduled backups → S3-compatible storage |
| **Migrate** | Move container between cluster nodes | Coolify redeploy to different server |
| **Suspend** | Stop container (non-paying tenant) | Coolify API: stop app, retain volume |
| **Resume** | Restart container | Coolify API: start app, health check |
| **Deprovision** | Snapshot + archive + teardown | Coolify API: backup → delete app + volume |

### Coolify integration module

```
src/control/coolify.ts
  - provisionHelixInstance(tenantSlug) → { url, apiKey, appId }
  - stopHelixInstance(appId)
  - startHelixInstance(appId)
  - deleteHelixInstance(appId)
  - getHelixInstanceStatus(appId) → 'running' | 'stopped' | 'pending' | 'error'
  - backupHelixInstance(appId)
```

Coolify API base URL + token stored in env vars (`COOLIFY_API_URL`, `COOLIFY_API_TOKEN`).

---

## Authentication — Clerk

### Architecture

Clerk handles all user-facing authentication. Graphbrain API verifies Clerk JWTs and maps Clerk organizations to tenants.

```
┌─────────────┐     ┌─────────────┐     ┌─────────────────────┐
│  User       │────▶│  Clerk      │────▶│  graphbrain.        │
│  (browser)  │     │  (hosted)   │     │  belweave.ai        │
│             │     │             │     │  (Next.js app)      │
│             │     │  - Sign up  │     │  - Dashboard        │
│             │     │  - Sign in  │     │  - Tenant mgmt      │
│             │     │  - Orgs     │     │  - Billing          │
│             │     │  - API keys │     │  - Brain settings   │
│             │     │  - Sessions │     │                     │
│             │     │             │     │  ClerkProvider      │
│             │     │             │     │  wraps app          │
│             │     └──────┬──────┘     └──────────┬──────────┘
│             │            │                       │
│             │            │ JWT (session)         │ API key (MCP agents)
│             │            ▼                       ▼
│             │     ┌─────────────────────────────────────┐
│             │     │  Graphbrain API (Bun)               │
│             │     │                                     │
│             │     │  ┌─────────────────────────────┐   │
│             │     │  │  Clerk Auth Middleware      │   │
│             │     │  │                             │   │
│             │     │  │  Two auth modes:            │   │
│             │     │  │  1. JWT (browser sessions)  │   │
│             │     │  │     - Verify Clerk JWT      │   │
│             │     │  │     - Extract org_id        │   │
│             │     │  │     - Map to tenant         │   │
│             │     │  │                             │   │
│             │     │  │  2. API key (MCP agents)    │   │
│             │     │  │     - Clerk API key verify  │   │
│             │     │  │     - Extract org_id        │   │
│             │     │  │     - Map to tenant         │   │
│             │     │  └─────────────────────────────┘   │
│             │     └─────────────────────────────────────┘
```

### Clerk → Tenant mapping

- Each Clerk **organization** = one Graphbrain **tenant**
- `tenants.clerk_org_id` links Clerk orgs to Graphbrain tenants
- Clerk API keys (issued per-org) are used by MCP agents for HTTP auth
- Clerk JWTs (session tokens) are used by the dashboard for browser auth

### Auth flows

**Browser (dashboard):**
1. User signs in via Clerk on `graphbrain.belweave.ai`
2. Next.js app uses `@clerk/nextjs` — `ClerkProvider`, `SignIn`, `SignUp`, `OrganizationSwitcher`
3. API calls from dashboard include Clerk session JWT in `Authorization: Bearer <jwt>`
4. Graphbrain API verifies JWT via Clerk's JWKS endpoint, extracts `org_id`, resolves tenant

**MCP agent (HTTP):**
1. Tenant generates an API key in the dashboard (Clerk API key, scoped to their org)
2. Agent connects: `graphbrain connect https://api.graphbrain.belweave.ai/mcp --token <clerk-api-key>`
3. Graphbrain API verifies API key via Clerk Backend API, extracts `org_id`, resolves tenant

**MCP agent (stdio, local):**
1. User runs `graphbrain serve` locally with `GRAPHBRAIN_API_KEY=<clerk-api-key>` env var
2. Local stdio server forwards operations to the remote API (thin-client mode) OR connects directly to their HelixDB instance if running locally
3. Auth via Clerk API key → tenant resolution

### Clerk configuration

- **Instance:** Belweave Clerk instance (hosted)
- **Domains:** `graphbrain.belweave.ai` (app), `belweave.ai` (marketing, optional auth)
- **Organizations:** Enabled — each org = one tenant
- **API keys:** Enabled — for MCP agent auth
- **JWT template:** Custom JWT template that includes `org_id` and `org_slug` claims
- **Webhooks:** Clerk webhook → Graphbrain API on org creation/deletion (auto-provision/deprovision HelixDB)

### Clerk webhook handling

| Event | Action |
|---|---|
| `organization.created` | Create tenant row → provision HelixDB via Coolify |
| `organization.deleted` | Snapshot HelixDB → deprovision via Coolify → mark tenant deleted |
| `organization.updated` | Update tenant metadata (name, slug) |
| `api_key.created` | Store encrypted API key reference in tenant row |
| `api_key.revoked` | Invalidate cached sessions for that key |

---

## Infrastructure — Coolify

### Overview

Coolify runs on the home server cluster and manages all containerized services:

| Service | Container | Domain | Notes |
|---|---|---|---|
| Graphbrain API | `graphbrain-api` (Bun) | `api.graphbrain.belweave.ai` | Main API + MCP HTTP server |
| Graphbrain App | `graphbrain-app` (Next.js) | `graphbrain.belweave.ai` | Dashboard, tenant management |
| Marketing Page | `belweave-web` (Next.js) | `belweave.ai/graphbrain` | Landing, docs, pricing |
| Polygres | `polygres` | `polygres.internal:5432` | Shared control plane DB |
| HelixDB (per-tenant) | `helix-<tenant-slug>` | `helix-<tenant-slug>.internal` | One container per tenant |
| MinIO / S3 | `storage` | `storage.internal:9000` | File storage + HelixDB backups |

### Coolify API usage

Graphbrain API calls Coolify's REST API to manage HelixDB instances:

```
COOLIFY_API_URL=https://coolify.belweave.ai
COOLIFY_API_TOKEN=<service token>

# Provision
POST /api/v1/applications
  body: {
    server_uuid: <server>,
    docker_compose: <helixdb-compose-template>,
    name: "helix-<tenant-slug>",
    ports_exposes: "8080"
  }

# Start / Stop / Delete
POST /api/v1/applications/{uuid}/start
POST /api/v1/applications/{uuid}/stop
DELETE /api/v1/applications/{uuid}

# Status
GET /api/v1/applications/{uuid}
```

### HelixDB instance template

Each per-tenant HelixDB instance uses a Docker Compose template:

```yaml
# helix-<tenant-slug>/docker-compose.yml
services:
  helixdb:
    image: ghcr.io/helixdb/enterprise-dev:latest
    ports:
      - "8080"
    environment:
      - HELIX_API_KEY=<generated-per-tenant>
      - HELIX_STORAGE=disk
      - HELIX_S3_ENDPOINT=https://storage.internal:9000
      - HELIX_S3_BUCKET=helix-<tenant-slug>
      - HELIX_S3_ACCESS_KEY=<key>
      - HELIX_S3_SECRET_KEY=<secret>
    volumes:
      - helix-<tenant-slug>-data:/data
    deploy:
      resources:
        limits:
          memory: 2G
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  helix-<tenant-slug>-data:
```

### Resource management

- **Default per-tenant:** 2GB RAM, 1 CPU, 10GB storage
- **Scale-up:** Increase container resources via Coolify API for paid tiers
- **Idle consolidation:** Stop containers for inactive tenants (data retained on volume + S3)
- **Cluster scheduling:** Coolify distributes containers across home server cluster nodes

---

## Website Structure

### graphbrain.belweave.ai (Next.js app)

The main application — authenticated dashboard for tenants.

| Route | Purpose | Auth |
|---|---|---|
| `/` | Redirect to `/dashboard` or `/onboarding` | Clerk |
| `/onboarding` | New tenant setup (create org, provision brain) | Clerk |
| `/dashboard` | Brain overview — stats, recent pages, search | Clerk |
| `/dashboard/search` | Search interface (hybrid retrieval) | Clerk |
| `/dashboard/pages` | Page browser (list, filter, view) | Clerk |
| `/dashboard/pages/[slug]` | Page detail (content, links, facts, takes, timeline) | Clerk |
| `/dashboard/graph` | Knowledge graph visualization | Clerk |
| `/dashboard/sources` | Source management (sync, mount, configure) | Clerk |
| `/dashboard/jobs` | Job queue monitor (minions, autopilot) | Clerk |
| `/dashboard/settings` | Tenant settings (AI keys, embedding model, schema packs) | Clerk |
| `/dashboard/api-keys` | API key management for MCP agents | Clerk |
| `/dashboard/billing` | Usage metering, billing, plan selection | Clerk |
| `/dashboard/eval` | Eval dashboard (retrieval quality, calibration) | Clerk |

### belweave.ai/graphbrain (Next.js marketing)

Marketing site — public, no auth.

| Route | Purpose |
|---|---|
| `/graphbrain` | Landing page (hero, features, CTA) |
| `/graphbrain/features` | Feature deep-dive (retrieval pipeline, knowledge graph, synthesis) |
| `/graphbrain/pricing` | Pricing tiers |
| `/graphbrain/docs` | Documentation (MCP integration, API reference, CLI) |
| `/graphbrain/docs/quickstart` | Agent quickstart guide |
| `/graphbrain/docs/mcp` | MCP setup for Claude/Cursor/Windsurf/Openclaw/Hermes |
| `/graphbrain/blog` | Blog (updates, use cases) |

### api.graphbrain.belweave.ai (Bun API)

The API service — MCP HTTP server + REST API for the dashboard.

| Endpoint | Purpose | Auth |
|---|---|---|
| `POST /mcp` | MCP HTTP endpoint (agent operations) | Clerk API key |
| `GET /mcp/tools` | List available MCP tools | Clerk API key |
| `GET /api/health` | Health check (unauthenticated) | — |
| `GET /api/ready` | Readiness check (unauthenticated) | — |
| `GET /api/dashboard/stats` | Dashboard stats | Clerk JWT |
| `POST /api/dashboard/search` | Dashboard search | Clerk JWT |
| `GET /api/dashboard/pages` | List pages | Clerk JWT |
| `POST /api/dashboard/pages` | Create page | Clerk JWT |
| `GET /api/dashboard/sources` | List sources | Clerk JWT |
| `POST /api/dashboard/sources/sync` | Sync source | Clerk JWT |
| `GET /api/dashboard/jobs` | List jobs | Clerk JWT |
| `GET /api/dashboard/settings` | Get settings | Clerk JWT |
| `PUT /api/dashboard/settings` | Update settings | Clerk JWT |
| `POST /api/dashboard/api-keys` | Generate API key | Clerk JWT |
| `GET /api/dashboard/billing` | Usage + billing | Clerk JWT |
| `POST /webhooks/clerk` | Clerk webhooks (org lifecycle) | Clerk webhook secret |

---

## AI Gateway — OpenRouter (primary), Triad (deferred)

### Architecture

OpenRouter is the sole AI gateway for the initial implementation. Triad (OpenAI-compatible) is architecturally supported via the provider abstraction but not wired until a later phase.

```
┌─────────────────────────────────────────┐
│           AI Gateway                     │
│                                          │
│  ┌─────────────────────────────────────┐ │
│  │  OpenRouter (primary, sole provider)│ │
│  │                                     │ │
│  │  Chat:                              │ │
│  │   Claude 4 Opus / Sonnet            │ │
│  │   GPT-4o / GPT-4o-mini              │ │
│  │   Gemini 2.5 Pro / Flash            │ │
│  │   Mistral / Llama / DeepSeek        │ │
│  │                                     │ │
│  │  Rerank:                            │ │
│  │   zerank-2 / Cohere rerank-3        │ │
│  │                                     │ │
│  │  Embeddings:                        │ │
│  │   OpenAI text-embedding-3-large     │ │
│  │   Voyage voyage-3-large             │ │
│  │   (multimodal via OpenAI)           │ │
│  └─────────────────────────────────────┘ │
│                                          │
│  ┌─────────────────────────────────────┐ │
│  │  Provider Abstraction               │ │
│  │  - OpenRouterProvider (active)      │ │
│  │  - TriadProvider (stub, deferred)   │ │  ← OpenAI-compatible, drop-in later
│  │  - Interface: AIProvider            │ │
│  └─────────────────────────────────────┘ │
│                                          │
│  ┌─────────────────────────────────────┐ │
│  │  Routing Logic                      │ │
│  │  - Per-tenant model preferences     │ │
│  │  - Per-operation model selection    │ │
│  │  - Per-tenant BYO OpenRouter key    │ │
│  │  - Cost tracking + metering         │ │
│  │  - Retry with backoff               │ │
│  └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

### Model routing (OpenRouter only)

| Operation | Default Model | Fallback | Notes |
|---|---|---|---|
| Embeddings (text) | OpenAI text-embedding-3-large (1536d) | Voyage voyage-3-large (1024d) | Per-tenant configurable |
| Embeddings (image) | OpenAI multimodal (1024d) | — | For image pages |
| Chat (synthesis, think) | Claude Sonnet | GPT-4o, Gemini 2.5 Pro | Per-tenant configurable |
| Query expansion | GPT-4o-mini | Haiku | Lightweight, high volume |
| Cross-encoder rerank | zerank-2 | Cohere rerank-3 | |
| Calibration judge | Haiku | GPT-4o-mini | |
| Voice gate | Haiku | GPT-4o-mini | |
| Code analysis | Claude Sonnet | DeepSeek | |

### Triad integration (deferred)

Triad is OpenAI-compatible, so the `TriadProvider` is a thin subclass of an OpenAI-compatible client:

```typescript
// src/core/ai/triad.ts — stub for future
class TriadProvider implements AIProvider {
  // OpenAI-compatible: same chat/completions + embeddings endpoints
  // Different base URL + API key
  // Drop-in replacement for OpenRouter for embeddings + lightweight chat
}
```

When activated, the routing logic adds Triad as a fallback for embeddings and lightweight chat (query expansion, calibration judge, voice gate). No architectural changes needed — just register the provider and update routing rules.

### Per-tenant configuration

Tenants can:
- Use platform-provided OpenRouter key with metering (default)
- BYO OpenRouter API key (costs billed directly to their OpenRouter account)
- Configure model preferences per operation type (e.g., always use Claude for synthesis)
- Set cost limits / budgets per period
- Choose embedding model + dimensionality (affects HelixDB vector index)

### OpenRouter integration

```typescript
// src/core/ai/openrouter.ts
class OpenRouterProvider implements AIProvider {
  // OpenRouter uses OpenAI-compatible API
  // Base URL: https://openrouter.ai/api/v1
  // Headers: Authorization: Bearer <key>, HTTP-Referer: https://graphbrain.belweave.ai
  // Supports: chat/completions, embeddings, rerank (via model routing)
  // Model IDs: anthropic/claude-4-sonnet, openai/gpt-4o, google/gemini-2.5-pro, etc.
}
```

OpenRouter's unified API means we get access to all providers (Anthropic, OpenAI, Google, Meta, Mistral, Cohere, etc.) through a single client. Model selection is just a model ID string.

---

## Retrieval Pipeline — Full GBrain Parity on HelixDB

GBrain's hybrid search is SQL-heavy (RRF fusion, 10+ boost factors, cross-encoder rerank). HelixDB provides vector search, BM25, and graph traversal primitives but no fusion/rerank. The fusion moves to the application layer.

### Pipeline (ported from GBrain's `src/core/search/hybrid.ts`)

```
┌─────────────────────────────────────────────────────────────┐
│  1. INTENT CLASSIFY (deterministic, no LLM — ported)        │
│     entity / temporal / event / general                     │
│     → sets ranking knobs (graph weight, timeline, etc.)     │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  2. QUERY EXPANSION (optional, AI gateway — ported)         │
│     LLM expands query with synonyms + related terms         │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  3. PARALLEL RETRIEVAL (3 streams vs HelixDB)               │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │ VECTOR      │  │ BM25        │  │ GRAPH TRAVERSAL     │ │
│  │             │  │             │  │                     │ │
│  │ vector_     │  │ text_search │  │ Seed pages from     │ │
│  │ search_     │  │ _nodes on   │  │ (a)+(b), traverse   │ │
│  │ nodes on    │  │ Chunk +     │  │ typed edges:        │ │
│  │ Chunk.      │  │ Page.       │  │ out/in/both on      │ │
│  │ embedding   │  │ compiled_   │  │ WORKS_AT, FOUNDED,  │ │
│  │             │  │ truth,      │  │ INVESTED_IN, etc.   │ │
│  │             │  │ title       │  │ → relational recall │ │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘ │
│         │                │                    │             │
└─────────┼────────────────┼────────────────────┼─────────────┘
          ▼                ▼                    ▼
┌─────────────────────────────────────────────────────────────┐
│  4. RRF FUSION (app layer — ported, RRF_K=60)               │
│     score = Σ 1/(60 + rank_in_list) across all 3 streams    │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  5. BOOSTS (app layer — ported from GBrain)                 │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ compiled_truth_boost    = 2.0x                        │ │
│  │ cosine_rescore          = 0.7*rrf + 0.3*cosine        │ │
│  │ backlink_boost          = ported formula              │ │
│  │ salience_boost          = ported (emotional_weight)   │ │
│  │ recency_boost           = ported (effective_date)     │ │
│  │ source_boost            = ported (per-source config)  │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  6. GRAPH SIGNALS (app layer — ported)                      │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ adjacency_boost   = 1.05 (linked from 2+ top-K)       │ │
│  │ cross_source_boost = 1.10 (corroborated across srcs)  │ │
│  │ session_demote    = 0.95 (dedupe same chat session)   │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  7. CROSS-ENCODER RERANK (AI gateway — OpenRouter)          │
│     zerank-2 / Cohere rerank on top 30 candidates           │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  8. TOKEN-BUDGET ENFORCEMENT (ported)                       │
│     conservative=4000 / balanced=12000 / tokenmax=off       │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  9. DEDUPLICATION (ported)                                  │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
                     RESULTS (with citations)
```

### Search modes (ported from GBrain)

| Knob | conservative | balanced | tokenmax |
|---|---|---|---|
| cache.enabled | true | true | true |
| tokenBudget | 4000 | 12000 | off |
| expansion | false | false | true |
| relationalRetrieval | false | true | true |
| searchLimit | 10 | 25 | 50 |

### Performance optimization vs. GBrain

| Aspect | GBrain (Postgres) | Graphbrain (HelixDB) | Advantage |
|---|---|---|---|
| Vector ANN | HNSW on pgvector | HelixDB native ANN (HNSW-like, tuned m/ef) | Specialized engine, no Postgres overhead |
| BM25 | tsvector in Postgres | HelixDB native BM25 | Purpose-built text index |
| Graph traversal | SQL JOINs on `links` table | Native graph traversal (out/in/both) | No JOIN overhead, direct edge following |
| RRF fusion | SQL CTEs | App-layer TypeScript | Parallel retrieval streams, no SQL serialization |
| Rerank | External API call | External API call (same) | Neutral |
| Per-tenant isolation | Sources (logical) | Dedicated HelixDB instance | No noisy neighbors, no tenant filtering overhead |
| Query caching | Postgres `query_cache` table | Polygres `query_cache` (per-tenant) | Same, with physical isolation |

---

## Full Operation Set — 1:1 GBrain Parity

### Read operations (ported + adapted to HelixDB)

| Operation | Description | HelixDB Query Pattern |
|---|---|---|
| `search` | Hybrid search with RRF + rerank | vector_search + text_search + traversal → app-layer fusion |
| `query` | Natural language query with synthesis | search + AI gateway synthesis |
| `get_page` | Get page by slug or ID | n_where(eq slug) → return with chunks, facts, takes |
| `list_pages` | List pages with filters | n_where(type, source, date range) + pagination |
| `get_tags` | Get tags for a page | n(slug) → out(TAGGED) → Tag nodes |
| `get_links` | Get outgoing links | n(slug) → out_e() → edges with type |
| `get_backlinks` | Get incoming links | n(slug) → in_e() → edges with type |
| `get_timeline` | Get timeline entries | n(slug) → out(TIMELINE) → TimelineEntry nodes |
| `find_experts` | Find experts on a topic | vector_search → traversal to Person pages with expertise signals |
| `get_recent_salience` | Recent high-salience pages | n_range(salience_touched_at) + filter emotional_weight |
| `find_anomalies` | Detect anomalous patterns | vector_search + distance analysis + graph signals |
| `get_recent_transcripts` | Recent conversation transcripts | n_where(type=conversation) + date range |
| `find_trajectory` | Track entity evolution over time | n(slug) → out(TIMELINE) + facts with valid_from/until |
| `find_contradictions` | Find contradictory facts/takes | Fact/Take nodes with conflicting claims + AI analysis |

### Write operations

| Operation | Description | HelixDB Query Pattern |
|---|---|---|
| `put_page` | Create/update page + chunks + embeddings | write_batch: add_n(Page) + add_n(Chunk) + vector embedding |
| `add_link` | Add typed edge between pages | write_batch: n(from).add_e(type, to) |
| `add_timeline_entry` | Add timeline event | write_batch: n(page).add_e(TIMELINE, add_n(TimelineEntry)) |
| `capture` | Quick capture (note, conversation, etc.) | put_page with type inference |
| `file_upload` | Upload file + create File node | storage upload + write_batch: add_n(File) + add_e(HAS_FILE) |
| `volunteer_context` | Push context to active sessions | Retrieval Reflex (ported) |

### Admin operations

| Operation | Description |
|---|---|
| `sync_brain` | Sync a source (git pull, re-chunk, re-embed) |
| `submit_job` | Submit a minion job (embed, extract, enrich, synthesize) |

### Code operations

| Operation | Description | HelixDB Query Pattern |
|---|---|---|
| `code_def` | Get symbol definition | n_where(CodeSymbol, eq symbol_name) → DEFINED_IN → Page |
| `code_refs` | Find references to symbol | n(CodeSymbol) → in(CALLS) → caller symbols |
| `code_callers` | Find callers of symbol | n(CodeSymbol) → in_e(CALLS) |
| `code_callees` | Find callees of symbol | n(CodeSymbol) → out_e(CALLS) |

### Synthesis operations

| Operation | Description |
|---|---|
| `think` | Synthesize answer with citations + gap analysis (AI gateway) |

### All operations to port (complete list from GBrain's operations.ts)

**Read (15):** search, query, get_page, list_pages, get_tags, get_links, get_backlinks, get_timeline, find_experts, get_recent_salience, find_anomalies, get_recent_transcripts, find_trajectory, find_contradictions, get_facts

**Write (6):** put_page, add_link, add_timeline_entry, capture, file_upload, volunteer_context

**Admin (2):** sync_brain, submit_job

**Code (4):** code_def, code_refs, code_callers, code_callees

**Facts/Takes (4):** get_facts, add_fact, get_takes, add_take

**Schema (3):** get_schema_pack, list_schema_packs, apply_schema_pack

**Eval (10+):** eval_search, eval_recall, eval_precision, eval_latency, eval_cost, eval_quality, eval_calibration, eval_retrieval, eval_synthesis, eval_e2e

**Total: 44+ core operations** (plus eval subcommands)

---

## Feature Parity Checklist

### Core features (all must be ported 1:1)

- [ ] **Hybrid search pipeline** — vector + BM25 + graph + RRF + boosts + rerank + token budget + dedup
- [ ] **Intent classification** — deterministic, no LLM, routes ranking knobs
- [ ] **Query expansion** — LLM-based, optional per mode
- [ ] **Relational recall** — typed-edge graph traversal for retrieval
- [ ] **Graph signals** — adjacency boost, cross-source boost, session demote
- [ ] **Cross-encoder reranking** — zerank-2 / Cohere via OpenRouter
- [ ] **Semantic query cache** — per-tenant, knobs_hash, TTL
- [ ] **Auto-link extraction** — zero-LLM regex-based, typed edge inference
- [ ] **Facts fence** — structured facts with kind/confidence/visibility/notability/validity
- [ ] **Takes fence** — structured takes with holder attribution + resolution fields
- [ ] **Schema packs** — dynamic type system, bundled + user packs, resolution chain
- [ ] **Timeline** — temporal events per page
- [ ] **Sources & mounts** — multi-source per brain, source-level config
- [ ] **Minion job queue** — Postgres-native (Polygres), durable, crash-safe, child jobs, backoff
- [ ] **Autopilot daemon** — sync → extract → embed → consolidate → patterns → synthesize
- [ ] **Calibration system** — voice gate, Brier score, conviction buckets, hit rate, pattern statements, morning pulse
- [ ] **Retrieval Reflex** — push-based context, entity salience, alias resolution, confidence-gated volunteering
- [ ] **Synthesis (think)** — synthesized answers with citations + gap analysis
- [ ] **Code operations** — tree-sitter chunking, symbol graph, def/refs/callers/callees
- [ ] **Multimodal embeddings** — text + image (multimodal) embedding columns
- [ ] **Dynamic embedding columns** — per-brain embedding model selection
- [ ] **Soft delete** — deleted_at with generation counter for cache invalidation
- [ ] **Two-axis organization** — brains (database) + sources (repo)
- [ ] **OAuth 2.1** — client credentials + auth code + PKCE, DCR, scope-gated
- [ ] **Admin dashboard** — React SPA at /admin, SSE activity feed
- [ ] **Skills system** — 30+ bundled skills, RESOLVER dispatcher
- [ ] **Eval system** — 10+ eval commands, P@5/R@5 metrics, calibration eval
- [ ] **CLI** — 100+ commands (init, import, sync, search, query, think, capture, doctor, upgrade, extract, embed, enrich, reindex, auth, sources, mounts, jobs, autopilot, schema, eval, code-*, cache, anomalies, salience, transcripts, lsd)

### New features (beyond GBrain)

- [ ] **Per-tenant isolated HelixDB instances** — physical isolation, no shared cluster
- [ ] **Multi-tenant control plane** — Polygres-backed tenant management
- [ ] **OpenRouter + Triad AI gateway** — unified, per-tenant configurable, fallback chain
- [ ] **Usage metering & billing** — per-tenant cost tracking
- [ ] **Audit logging** — per-tenant operation audit trail
- [ ] **Per-tenant BYO API keys** — encrypted storage, provider routing
- [ ] **Health checks & readiness probes** — for orchestration
- [ ] **Metrics & observability** — Prometheus / OpenTelemetry
- [ ] **Graceful shutdown** — drain connections, finish in-flight ops
- [ ] **Backup/restore automation** — per-tenant HelixDB snapshots
- [ ] **Instance lifecycle management** — provision/scale/migrate/deprovision

---

## Phased Implementation

### Phase 1 — Foundation, Auth & Core Retrieval

**Goal:** Hosted, agent-usable memory over MCP, per-tenant isolated, with Clerk auth, Coolify provisioning, and the full hybrid retrieval pipeline.

**Infrastructure:**
- [ ] Monorepo scaffold (Bun workspaces: `apps/api`, `apps/dashboard`, `apps/marketing`, `packages/core`)
- [ ] Docker Compose for local dev (Polygres + MinIO + HelixDB)
- [ ] Coolify deployment configs for all services
- [ ] Clerk instance setup (domains, organizations, API keys, JWT template, webhooks)

**Control plane (Polygres):**
- [ ] `tenants` table (clerk_org_id, helix_instance_url, helix_api_key, coolify_app_id, tier, status)
- [ ] `oauth_clients` + `oauth_tokens` tables (for MCP agent API keys via Clerk)
- [ ] Polygres migrations system
- [ ] Coolify integration module (`coolify.ts`) — provision/stop/start/delete HelixDB containers
- [ ] Clerk webhook handler — org.created → provision HelixDB, org.deleted → deprovision
- [ ] Clerk auth middleware — JWT verification + API key verification + org_id → tenant resolution

**Knowledge engine (HelixDB):**
- [ ] HelixDB TS SDK integration + connection management
- [ ] Tenant router: resolve tenant → HelixDB instance → HelixEngine (cached, health-checked)
- [ ] HelixDB schema: Page, Chunk, Source nodes + all edges + indexes (deployed on provisioning)
- [ ] BrainEngine interface + HelixEngine implementation
- [ ] Dynamic query definitions for all CRUD + search operations

**AI gateway:**
- [ ] AIProvider interface
- [ ] OpenRouterProvider (chat, embeddings, rerank)
- [ ] TriadProvider stub (deferred)
- [ ] Per-tenant model configuration
- [ ] Embedding service (OpenRouter — OpenAI text-embedding-3-large)

**Operations (core set):**
- [ ] search, query, get_page, list_pages, get_links, get_backlinks, put_page, add_link, capture
- [ ] Hybrid retrieval pipeline: vector + BM25 + graph + RRF + boosts + rerank + token budget + dedup
- [ ] Intent classifier (ported, deterministic)
- [ ] Auto-link extraction (ported)
- [ ] Semantic query cache (Polygres-backed)

**MCP + API:**
- [ ] MCP stdio server (local agent integration)
- [ ] MCP HTTP server (Clerk API key auth)
- [ ] Dashboard REST API (Clerk JWT auth) — stats, search, pages, settings, api-keys
- [ ] Health + readiness endpoints

**Dashboard (Next.js):**
- [ ] ClerkProvider + sign-in/sign-up flows
- [ ] Onboarding flow (create org → provision brain → wait for ready)
- [ ] Dashboard overview (stats, recent pages)
- [ ] Search interface
- [ ] Page browser (list, view)
- [ ] API key management (generate/revoke Clerk API keys)
- [ ] Settings (AI model config, embedding model)

**Marketing page (Next.js):**
- [ ] Landing page (hero, features, CTA → sign up)
- [ ] Pricing page
- [ ] Docs: quickstart, MCP setup guide

**CLI:**
- [ ] init, serve, search, query, get, put, capture, connect

**Deliverable:** Users can sign up via Clerk, get a provisioned HelixDB brain, connect agents via MCP (HTTP or stdio), store pages, and search with full hybrid retrieval. Dashboard for management. Marketing page live. Per-tenant isolation. OpenRouter for embeddings + reranking.

### Phase 2 — Knowledge Depth

**Goal:** Full knowledge structuring parity with GBrain.

- [ ] Facts fence (parser, CRUD, visibility filtering, strikethrough semantics)
- [ ] Takes fence (parser, CRUD, holder attribution, resolution fields)
- [ ] Schema pack system (bundled packs, user packs, resolution chain)
- [ ] Timeline (entries, temporal queries)
- [ ] Sources & mounts (multi-source, source-level config, sync)
- [ ] Tags (frontmatter-derived, tag associations)
- [ ] File upload (MinIO storage backend, File nodes)
- [ ] Multimodal embeddings (image embedding via OpenRouter)
- [ ] Dynamic embedding column selection
- [ ] Minion job queue (Polygres-backed, ported from GBrain)
- [ ] Jobs: embed, extract, enrich
- [ ] Volunteer context / Retrieval Reflex (ported)
- [ ] Soft delete + generation counter
- [ ] Dashboard: sources management, jobs monitor, graph visualization, page detail (facts/takes/timeline)
- [ ] CLI: import, sync, doctor, upgrade, extract, embed, enrich, reindex, sources, mounts, jobs, schema

**Deliverable:** Full knowledge structuring — facts, takes, schema packs, timeline, sources, jobs, multimodal. Dashboard covers all knowledge features.

### Phase 3 — Intelligence & Synthesis

**Goal:** Full GBrain intelligence parity.

- [ ] `think` operation (synthesis with citations + gap analysis)
- [ ] `find_experts` (expertise routing)
- [ ] `find_anomalies` (anomaly detection)
- [ ] `find_trajectory` (entity evolution tracking)
- [ ] `find_contradictions` (contradictory fact/take detection)
- [ ] `get_recent_salience` (salience scanning)
- [ ] `get_recent_transcripts` (conversation retrieval)
- [ ] Calibration system (voice gate, Brier score, conviction buckets, hit rate, pattern statements, morning pulse)
- [ ] Autopilot daemon (sync → extract → embed → consolidate → patterns → synthesize)
- [ ] Code operations (tree-sitter chunking, CodeSymbol nodes, def/refs/callers/callees)
- [ ] Query expansion (LLM-based, per-mode)
- [ ] Graph signals (adjacency, cross-source, session demote)
- [ ] Dashboard: eval dashboard, calibration views, autopilot controls
- [ ] CLI: think, autopilot, eval, code-*, cache, anomalies, salience, transcripts, lsd

**Deliverable:** Full intelligence — synthesis, calibration, autopilot, code ops, all analytical operations. 1:1 GBrain feature parity achieved.

### Phase 4 — SaaS & Scale

**Goal:** Production multi-tenant SaaS with billing, observability, and operational tooling.

- [ ] Skills system (30+ bundled skills, RESOLVER)
- [ ] Eval system (10+ eval commands, metrics, P@5/R@5)
- [ ] Usage metering & billing (per-tenant cost tracking, plan enforcement)
- [ ] Audit logging (per-tenant operation audit trail)
- [ ] Per-tenant BYO OpenRouter API keys
- [ ] Triad provider activation (OpenAI-compatible drop-in for cost optimization)
- [ ] Health checks & readiness probes (Kubernetes-style, for Coolify)
- [ ] Metrics & observability (Prometheus / OpenTelemetry)
- [ ] Graceful shutdown (drain connections, finish in-flight ops)
- [ ] Backup/restore automation (per-tenant HelixDB snapshots via Coolify)
- [ ] Instance lifecycle management (suspend/resume for inactive tenants, scale-up for paid)
- [ ] Rate limiting (per-tenant, per-operation)
- [ ] Horizontal scaling of API layer (stateless, tenant router with shared cache)
- [ ] Connection pooling for Polygres
- [ ] Secret management (encrypted tenant keys)
- [ ] Dashboard: billing page, usage charts, audit log viewer
- [ ] Marketing: blog, full docs, integration guides (Openclaw, Hermes, Claude, Cursor, Windsurf)

**Deliverable:** Production SaaS with billing, observability, scaling, Triad integration, and full operational tooling.

---

## Project Structure

This is a monorepo with three deployable apps (API, dashboard, marketing) plus shared core library.

```
graphbrain/
├── apps/
│   ├── api/                           # Graphbrain API (Bun service)
│   │   ├── src/
│   │   │   ├── index.ts               # Entry point — Express server
│   │   │   ├── middleware/
│   │   │   │   ├── clerk-auth.ts      # Clerk JWT + API key verification
│   │   │   │   ├── tenant-resolver.ts # Clerk org_id → tenant → HelixEngine
│   │   │   │   ├── rate-limit.ts      # Per-tenant rate limiting
│   │   │   │   └── error-handler.ts   # Unified error handling
│   │   │   ├── routes/
│   │   │   │   ├── mcp.ts             # MCP HTTP endpoint
│   │   │   │   ├── dashboard.ts       # Dashboard REST API
│   │   │   │   └── webhooks/
│   │   │   │       └── clerk.ts       # Clerk webhooks (org lifecycle)
│   │   │   └── server.ts              # Server setup + graceful shutdown
│   │   ├── package.json
│   │   └── Dockerfile
│   ├── dashboard/                     # graphbrain.belweave.ai (Next.js)
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── layout.tsx         # ClerkProvider wrapper
│   │   │   │   ├── onboarding/
│   │   │   │   ├── dashboard/
│   │   │   │   │   ├── page.tsx       # Overview
│   │   │   │   │   ├── search/
│   │   │   │   │   ├── pages/
│   │   │   │   │   ├── graph/
│   │   │   │   │   ├── sources/
│   │   │   │   │   ├── jobs/
│   │   │   │   │   ├── settings/
│   │   │   │   │   ├── api-keys/
│   │   │   │   │   ├── billing/
│   │   │   │   │   └── eval/
│   │   │   │   └── sign-in/[[...sign-in]]/
│   │   │   ├── components/            # UI components
│   │   │   └── lib/
│   │   │       └── api.ts             # API client (calls api.graphbrain.belweave.ai)
│   │   ├── package.json
│   │   └── Dockerfile
│   └── marketing/                     # belweave.ai/graphbrain (Next.js)
│       ├── src/
│       │   ├── app/
│       │   │   └── graphbrain/
│       │   │       ├── page.tsx       # Landing page
│       │   │       ├── features/
│       │   │       ├── pricing/
│       │   │       ├── docs/
│       │   │       └── blog/
│       │   └── components/
│       ├── package.json
│       └── Dockerfile
├── packages/
│   └── core/                          # Shared core library (imported by api + dashboard)
│       ├── src/
│       │   ├── operations.ts          # Contract-first op definitions (ported, tenant-aware)
│       │   ├── engine.ts              # BrainEngine interface
│       │   ├── helix-engine.ts        # HelixDB implementation
│       │   ├── types.ts               # Core types (Page, Chunk, Link, Fact, Take, Tenant, ...)
│       │   ├── tenant.ts              # Tenant router (resolve → HelixEngine)
│       │   ├── config.ts              # Config (env, per-tenant overrides)
│       │   ├── search/
│       │   │   ├── hybrid.ts          # App-layer RRF fusion + boosts (ported)
│       │   │   ├── rerank.ts          # Cross-encoder reranking (OpenRouter)
│       │   │   ├── intent.ts          # Intent classifier (ported, deterministic)
│       │   │   ├── intent-weights.ts  # Intent-aware ranking knobs (ported)
│       │   │   ├── expansion.ts       # Query expansion (ported)
│       │   │   ├── graph-signals.ts   # Adjacency/cross-source/session boosts (ported)
│       │   │   ├── relational-recall.ts # Graph traversal for retrieval (ported)
│       │   │   ├── query-cache.ts     # Semantic cache (Polygres-backed)
│       │   │   └── mode.ts            # Search mode presets (ported)
│       │   ├── ai/
│       │   │   ├── gateway.ts         # Unified AI gateway (provider abstraction)
│       │   │   ├── openrouter.ts      # OpenRouter provider (active)
│       │   │   ├── triad.ts           # Triad provider (stub, deferred)
│       │   │   ├── provider.ts        # AIProvider interface
│       │   │   ├── recipes/           # Provider recipes (ported + adapted)
│       │   │   └── types.ts           # AI type definitions
│       │   ├── embedding.ts           # Embedding service (ported)
│       │   ├── link-extraction.ts     # Zero-LLM auto-link extraction (ported)
│       │   ├── facts/
│       │   │   ├── facts-fence.ts     # Facts fence parser (ported)
│       │   │   └── takes-fence.ts     # Takes fence parser (ported)
│       │   ├── schema-pack/           # Schema pack system (ported)
│       │   ├── minions/               # Job queue (ported, Polygres-backed)
│       │   │   ├── queue.ts           # Postgres-native queue (ported)
│       │   │   └── worker.ts          # Worker implementation (ported)
│       │   ├── calibration/           # Calibration system (ported)
│       │   │   ├── voice-gate.ts      # Voice gate (ported)
│       │   │   └── profiles.ts        # Calibration profiles (ported)
│       │   ├── context/
│       │   │   └── retrieval-reflex.ts # Push-based context (ported)
│       │   ├── code/                  # Code operations (ported)
│       │   │   ├── chunker.ts         # Tree-sitter chunking (ported)
│       │   │   └── symbol-graph.ts    # Symbol graph builder (ported)
│       │   └── storage.ts             # File storage backend (MinIO/S3)
│       ├── control/                   # Polygres control plane
│       │   ├── db.ts                  # Polygres connection pool
│       │   ├── tenants.ts             # Tenant CRUD + Clerk org mapping
│       │   ├── coolify.ts             # Coolify API integration (HelixDB provisioning)
│       │   ├── clerk.ts               # Clerk Backend API client (webhook handling)
│       │   ├── jobs.ts                # Job queue (Polygres-backed minions)
│       │   ├── query-cache.ts         # Query cache (Polygres-backed)
│       │   ├── calibration.ts         # Calibration profiles (Polygres)
│       │   ├── audit.ts               # Audit log
│       │   ├── metering.ts            # Usage metering & billing
│       │   └── migrations/            # Polygres control-plane migrations
│       ├── mcp/
│       │   ├── server.ts              # MCP stdio server (ported)
│       │   ├── http-server.ts         # MCP HTTP transport (Clerk auth)
│       │   └── dispatch.ts            # Operation dispatcher (tenant-aware)
│       ├── commands/                  # CLI command handlers (ported)
│       ├── cli.ts                     # CLI entry point (ported)
│       ├── helix/
│       │   └── queries/               # HelixDB query definitions (dynamic JSON)
│       │       ├── page-crud.ts       # Page CRUD operations
│       │       ├── chunk-crud.ts      # Chunk CRUD + embedding
│       │       ├── search-vector.ts   # Vector search
│       │       ├── search-text.ts     # BM25 text search
│       │       ├── graph-traverse.ts  # Graph traversal patterns
│       │       ├── facts-takes.ts     # Facts/takes operations
│       │       ├── timeline.ts        # Timeline operations
│       │       ├── code-ops.ts        # Code symbol operations
│       │       └── indexes.ts         # Index creation
│       ├── skills/                    # Agent skills (ported from GBrain)
│       ├── package.json
│       └── tsconfig.json
├── docs/                              # Documentation
├── test/                              # Tests
├── docker-compose.yml                 # Local dev: Polygres + MinIO + HelixDB
├── docker-compose.test.yml            # Test environment
├── package.json                       # Monorepo root (workspaces)
├── bunfig.toml
├── turbo.json                         # Turborepo config (optional)
└── PLAN.md                            # This file
```

### Monorepo workspace structure

```json
// package.json (root)
{
  "name": "graphbrain",
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev": "bun run --filter '*' dev",
    "build": "bun run --filter '*' build",
    "test": "bun test",
    "dev:api": "bun run --filter api dev",
    "dev:dashboard": "bun run --filter dashboard dev",
    "dev:marketing": "bun run --filter marketing dev"
  }
}
```

The `packages/core` workspace is imported by both `apps/api` and `apps/dashboard`. This keeps the operation contract, types, and retrieval logic in one place while allowing the dashboard to call operations directly (via the API) or render shared types.

---

## Key Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| HelixDB write throughput (single-writer) | Multi-tenant write load could bottleneck | Per-tenant isolation means each tenant has their own writer — no cross-tenant contention. Minion queue batches writes. |
| HelixDB TS SDK maturity | Missing query patterns could block features | Validate TS SDK capabilities early in Phase 1. Fall back to dynamic JSON queries if DSL is incomplete. |
| App-layer RRF fusion latency | Extra round-trips vs. SQL CTEs | Parallel retrieval streams (Promise.all). Cache aggressively. Profile early. |
| Per-tenant instance overhead | Many small tenants = many HelixDB instances | Lightweight instance provisioning. Consolidate idle instances. Future: shared tier for small tenants if needed. |
| GBrain port complexity | 90+ operations, 3650+ tests | Phased approach. Port in dependency order. Reuse GBrain's test structure. |
| OpenRouter dependency | If OpenRouter is down, AI ops fail | Triad fallback for embeddings + lightweight chat. Retry with backoff. Circuit breaker. |
| Polygres + pgGraph + pgVector integration | New technology, unknown edge cases | Use Polygres as standard Postgres first. Adopt pgGraph/pgVector features incrementally for control-plane analytics. |

---

## Resolved Decisions

| Question | Decision | Rationale |
|---|---|---|
| **HelixDB instance provisioning** | Coolify REST API — provision/stop/start/delete Docker containers per-tenant | Home server cluster already running Coolify; API-driven container management; handles scheduling, SSL, reverse proxy, backups |
| **HelixDB stored vs. dynamic queries** | Dynamic JSON queries at runtime (Phase 1), migrate to stored queries (Phase 2) | Dynamic = no deployment step per-tenant, simpler to update across all instances. Stored = faster, deploy once schema is stable. |
| **Polygres deployment** | Single shared Polygres instance with per-tenant schemas (`_graphbrain` schema for control plane, per-tenant schemas if needed for isolation) | Schemas are simpler to manage; control plane data is low-volume; Polygres handles multi-schema well |
| **GBrain license** | MIT licensed — confirmed. Full port is legally clear. | GBrain repo is MIT; we can copy, modify, and redistribute freely |
| **Triad API contract** | OpenAI-compatible. Deferred — focus on OpenRouter only for now. TriadProvider stub built for future drop-in. | OpenRouter covers all needed providers (chat, embeddings, rerank). Triad added later for cost optimization on embeddings + lightweight chat. |
| **File storage backend** | MinIO (S3-compatible) on Coolify cluster, per-tenant buckets | Self-hosted, S3-compatible API, integrates with HelixDB backups, no external dependency |
| **Authentication** | Clerk (hosted) — organizations = tenants, API keys for MCP agents, JWTs for dashboard | Managed auth, org/tenant mapping, API key lifecycle, webhooks for auto-provisioning |
| **Infrastructure** | Coolify on home server cluster — manages all containers, SSL, routing | Already running, API-driven, handles container lifecycle |
| **Website** | Next.js — `graphbrain.belweave.ai` (app/dashboard) + `belweave.ai/graphbrain` (marketing) + `api.graphbrain.belweave.ai` (API) | App and marketing are separate Next.js apps; API is Bun service; all on Coolify |
