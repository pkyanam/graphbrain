# Graphbrain — Implementation Stages (Phase 1 Prototype)

> Executable, linear stage-by-stage plan for delivering a working Graphbrain prototype.
> This file is the **build order**. `PLAN.md` is the **design reference** — read it for
> architecture, storage mapping, retrieval pipeline, and rationale. Each stage below
> references the relevant `PLAN.md` section and `_reference/` source files.

## How to use this document

- **One stage per agent session.** An agent picks up the next incomplete stage, reads
  its `Depends on` stages (already merged), executes the `Implementation steps` in
  order, runs `Verification`, and stops. The next agent picks up the following stage.
- **Stages are strictly ordered.** Do not skip ahead. Each stage's `Handoff notes`
  define the contract the next stage depends on.
- **Port from GBrain.** The GBrain source lives at `_reference/gbrain/` (MIT licensed).
  Each stage lists the exact GBrain files to port or adapt. HelixDB TS SDK reference
  lives at `_reference/helix-db/sdks/typescript/`.
- **Real services.** Clerk, Coolify, and OpenRouter are used for real throughout.
  See `Prerequisites` — these must be provisioned before Stage 0.
- **Unit tests per stage.** Every stage ships unit tests for the code it introduces
  (`bun test`). Typecheck (`bun run typecheck`) and build (`bun run build`) must pass.
  Tests live in `packages/core/test/` or `apps/<app>/test/` mirroring source layout.
- **Commit per stage.** One git commit per stage, message format:
  `stage N: <title>`. This makes linear progress visible and rollback trivial.

## Prerequisites (set up before Stage 0)

These are **operator tasks**, not agent tasks. The operator must complete them and
record credentials in a `.env` (gitignored) before any agent starts Stage 0.

| Prerequisite | How | Env vars to set |
|---|---|---|
| **Bun >= 1.3** | `curl -fsSL https://bun.sh/install \| bash` | — |
| **Docker** (local dev) | Docker Desktop / OrbStack / Colima | — |
| **Clerk instance** | Create at clerk.com. Enable Organizations + API keys. Add domains `graphbrain.belweave.ai` (app) and `belweave.ai` (marketing). Create a JWT template including `org_id` + `org_slug` claims. | `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_ISSUER`, `CLERK_WEBHOOK_SECRET` |
| **Coolify** | Running on home server cluster. Generate a service API token. | `COOLIFY_API_URL`, `COOLIFY_API_TOKEN`, `COOLIFY_SERVER_UUID` |
| **OpenRouter** | Create account, generate API key. | `OPENROUTER_API_KEY` |
| **Polygres** (local dev) | Provided by Stage 0's `docker-compose.yml`. | `POLYGRES_DATABASE_URL` (set by compose) |
| **MinIO** (local dev) | Provided by Stage 0's `docker-compose.yml`. | `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` (set by compose) |

A `.env.example` is produced by Stage 0 documenting every variable.

## Stage format

Each stage uses this template:

```
### Stage N — Title
**Goal:** one-line outcome.
**Depends on:** Stage numbers that must be merged first.
**References:** PLAN.md sections + _reference/ paths to read before coding.
**Files to create:** explicit paths.
**Port from:** GBrain files to adapt.
**Implementation steps:** ordered, concrete, numbered.
**Verification:** commands to run + tests to pass.
**Handoff notes:** what the next stage assumes is available.
```

---

## Stage 0 — Monorepo Scaffold + Local Dev Infrastructure

**Goal:** Bun workspace monorepo with `apps/api`, `apps/dashboard`, `apps/marketing`, `packages/core`, plus a Docker Compose stack for local Polygres + MinIO + HelixDB.

**Depends on:** Prerequisites complete.

**References:**
- `PLAN.md` → "Project Structure" (lines ~961–1101)
- `PLAN.md` → "Infrastructure — Coolify" (lines ~356–436)

**Files to create:**
- `package.json` (root, workspaces: `["apps/*", "packages/*"]`)
- `bunfig.toml`
- `tsconfig.base.json` (shared TS config, strict, ES2022, Bundler moduleResolution)
- `.gitignore` (extend existing: `node_modules`, `.env`, `.next`, `dist`, `.turbo`)
- `.env.example` (every env var from Prerequisites table + compose-derived ones)
- `docker-compose.yml` (Polygres + MinIO + HelixDB single-instance for local dev)
- `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/Dockerfile` (stub)
- `apps/dashboard/package.json`, `apps/dashboard/tsconfig.json`, `apps/dashboard/Dockerfile` (stub)
- `apps/marketing/package.json`, `apps/marketing/tsconfig.json`, `apps/marketing/Dockerfile` (stub)
- `packages/core/package.json`, `packages/core/tsconfig.json`
- `packages/core/src/index.ts` (empty barrel export)
- `packages/core/test/scaffold.test.ts` (smoke test: imports resolve)

**Implementation steps:**
1. Init git repo (already done) — verify `.gitignore` covers `node_modules`, `.env`, build artifacts.
2. Create root `package.json` with workspaces and scripts: `dev`, `build`, `typecheck`, `test` (all using `bun run --filter '*'`).
3. Create `tsconfig.base.json` — strict mode, `target: ES2022`, `module: ESNext`, `moduleResolution: Bundler`, `types: ["bun-types"]`.
4. Create the four workspace `package.json` files. `packages/core` is `"type": "module"` with exports map. Apps depend on `@graphbrain/core` (workspace `*`).
5. Create per-workspace `tsconfig.json` extending base.
6. Write `docker-compose.yml` with three services:
   - `polygres`: Postgres 16 image (use `postgres:16-alpine` for the prototype; Polygres-specific image can be swapped later), port 5432, volume, `POSTGRES_DB=graphbrain_control`, healthcheck.
   - `minio`: `minio/minio`, ports 9000+9001, default creds, volume.
   - `helixdb`: HelixDB Docker image (`ghcr.io/helixdb/enterprise-dev:latest` per PLAN.md), port 8080, `HELIX_API_KEY=dev-key`, healthcheck hitting `/health`.
7. Create stub Dockerfiles for each app (placeholder `FROM oven/bun` + `CMD`).
8. Write `.env.example` enumerating every env var from the Prerequisites table.
9. `bun install` — verify workspaces resolve.
10. Write `packages/core/test/scaffold.test.ts`: asserts `import '../src/index.js'` resolves.

**Verification:**
- `bun install` succeeds with no workspace errors.
- `bun run typecheck` passes (empty packages typecheck clean).
- `bun test` passes (scaffold test green).
- `docker compose up -d` starts all three services; `curl http://localhost:8080/health` returns 200; `psql $POLYGRES_DATABASE_URL -c 'SELECT 1'` works; MinIO console reachable at `:9001`.
- `docker compose down` cleans up.

**Handoff notes:** All four workspaces exist and typecheck. `packages/core` is importable as `@graphbrain/core`. Docker Compose provides Polygres, MinIO, and a single local HelixDB instance. `.env.example` documents every env var. Next stage (1) begins filling `packages/core/src/`.

---

## Stage 1 — Core Types + Config + Zod Schemas

**Goal:** All shared TypeScript types and Zod schemas for Phase 1 entities (Page, Chunk, Source, Link, Tenant, SearchResult, etc.) plus the config loader.

**Depends on:** Stage 0.

**References:**
- `PLAN.md` → "Storage Mapping" → HelixDB Node Types + Edge Types (lines ~130–188)
- `_reference/gbrain/src/types/` (GBrain type definitions)
- `_reference/gbrain/src/core/config.ts` (config pattern)

**Files to create:**
- `packages/core/src/types.ts` — all core domain types
- `packages/core/src/schemas.ts` — Zod schemas mirroring the types
- `packages/core/src/config.ts` — env-driven config loader with per-tenant override shape
- `packages/core/src/index.ts` — re-export types, schemas, config
- `packages/core/test/types.test.ts` — schema round-trip tests
- `packages/core/test/config.test.ts` — config loading tests

**Port from:**
- `_reference/gbrain/src/types/` — Page, Chunk, Source, Link, Fact, Take, TimelineEntry, SearchResult, HybridSearchMeta shapes.
- `_reference/gbrain/src/core/config.ts` — config resolution pattern (env → per-tenant overrides).

**Implementation steps:**
1. Define `Tenant` type: `id`, `clerk_org_id`, `name`, `slug`, `helix_instance_url`, `helix_api_key_encrypted`, `coolify_app_id`, `tier`, `status` (`pending` | `active` | `suspended` | `deleted`), `settings` (JSON), `created_at`.
2. Define `Page` type matching PLAN.md Page node properties (slug, type, title, compiled_truth, frontmatter, content_hash, emotional_weight, effective_date, etc.). Include `page_kind: 'markdown' | 'code' | 'image'`.
3. Define `Chunk` type: `id`, `page_id`, `chunk_index`, `content`, `modality`, `embedding` (number[]), `embedding_voyage?`, `embedding_image?`, `created_at`.
4. Define `Source` type per PLAN.md Source node.
5. Define `Link` (edge): `from_slug`, `to_slug`, `type` (typed-edge label union), `origin`.
6. Define `SearchResult`: `page`, `chunks`, `score`, `sources` (which retrieval streams matched), `citations`.
7. Define `HybridSearchMeta`: intent, mode, knobs used, token budget, cache hit flag.
8. Define `OperationContext` (tenant-aware): `tenant`, `remote: boolean`, `sourceId?`, `auth`, `signal?`. Port the trust-boundary invariant from GBrain `CLAUDE.md` (`remote === false` for trusted).
9. Write Zod schemas for every type above. Export inferred types from schemas where it reduces duplication (but keep hand-written types for cross-file clarity).
10. Write `config.ts`: load env vars (Clerk, Coolify, OpenRouter, Polygres, MinIO), validate with a Zod schema, export a singleton `config`. Include `TenantSettings` shape for per-tenant overrides (model preferences, embedding model, cost limits).
11. Tests: `types.test.ts` — round-trip each schema (parse valid → serialize → parse). `config.test.ts` — load with valid env, assert missing required var throws with a clear message.

**Verification:**
- `bun run typecheck` clean.
- `bun test packages/core/test/types.test.ts packages/core/test/config.test.ts` green.
- `bun run build` (core workspace) produces `dist/`.

**Handoff notes:** `@graphbrain/core` exports `Tenant`, `Page`, `Chunk`, `Source`, `Link`, `SearchResult`, `HybridSearchMeta`, `OperationContext`, all Zod schemas, and `config`. Next stages import these directly. The `OperationContext.remote` trust boundary is established here and must be respected by every operation in Stage 10.

---

## Stage 2 — Polygres Control Plane + Migrations

**Goal:** Polygres connection pool, a migrations runner, and the Phase 1 control-plane tables (`tenants`, `oauth_clients`, `oauth_tokens`, `query_cache`).

**Depends on:** Stage 1.

**References:**
- `PLAN.md` → "Polygres — Control Plane" (lines ~189–203)
- `PLAN.md` → "Phased Implementation" → Control plane checklist (lines ~838–845)
- `_reference/gbrain/src/core/migrate.ts` (migration pattern)
- `_reference/gbrain/src/core/db.ts` (connection pattern)

**Files to create:**
- `packages/core/src/control/db.ts` — Polygres connection pool (use `postgres` or `pg` driver; pick one and document choice in a comment)
- `packages/core/src/control/migrations/index.ts` — migration runner
- `packages/core/src/control/migrations/001_tenants.sql.ts` — `tenants` table
- `packages/core/src/control/migrations/002_oauth.sql.ts` — `oauth_clients` + `oauth_tokens`
- `packages/core/src/control/migrations/003_query_cache.sql.ts` — `query_cache` table
- `packages/core/src/control/tenants.ts` — tenant CRUD + Clerk org mapping helpers
- `packages/core/test/control/db.test.ts`
- `packages/core/test/control/migrations.test.ts`
- `packages/core/test/control/tenants.test.ts`

**Port from:**
- `_reference/gbrain/src/core/migrate.ts` — `MIGRATIONS` array pattern, idempotent `CREATE TABLE IF NOT EXISTS`, migration tracking table.
- `_reference/gbrain/src/core/db.ts` — pool setup.

**Implementation steps:**
1. Choose a Postgres driver. Prefer `postgres` (postgres.js) since GBrain uses it and it handles JSONB correctly (see GBrain `CLAUDE.md` JSONB invariant — never `JSON.stringify` into `::jsonb`; pass raw objects). Document the choice in `db.ts`.
2. `db.ts`: export `getPool()` returning a pooled client. Read `POLYGRES_DATABASE_URL` from config. Use a single shared pool (module-level singleton).
3. Migration runner: `migrations/index.ts` — creates `_graphbrain.migrations` tracking table, runs pending migrations in order inside a transaction (except `CONCURRENTLY` DDL if any — none in Phase 1), records each. Expose `runMigrations()`.
4. `001_tenants.sql.ts`: create `_graphbrain.tenants` schema + table per PLAN.md. Columns: `id` (uuid PK), `clerk_org_id` (text unique), `name`, `slug` (text unique), `helix_instance_url`, `helix_api_key_encrypted` (bytea or text), `coolify_app_id`, `tier` (text default 'free'), `status` (text default 'pending'), `settings` (jsonb default '{}'), `created_at`, `updated_at`. Index on `clerk_org_id`.
5. `002_oauth.sql.ts`: `_graphbrain.oauth_clients` + `_graphbrain.oauth_tokens` per GBrain's OAuth 2.1 tables (port schema from GBrain; for Phase 1 these store Clerk-issued API key references — minimal columns: client_id, tenant_id, scopes, created_at, revoked_at).
6. `003_query_cache.sql.ts`: `_graphbrain.query_cache` per PLAN.md — `tenant_id`, `query_hash`, `knobs_hash`, `results` (jsonb), `created_at`, `hits`, `ttl_at`. Index on `(tenant_id, query_hash, knobs_hash)`.
7. `tenants.ts`: `createTenant(data)`, `getTenantByClerkOrg(orgId)`, `getTenantById(id)`, `updateTenant(id, patch)`, `listTenants()`. All tenant-scoped.
8. Tests: use a transaction-rollback pattern (begin → run → rollback) against the Docker Compose Polygres. `migrations.test.ts` runs migrations twice (idempotency). `tenants.test.ts` exercises CRUD.

**Verification:**
- `bun run typecheck` clean.
- `docker compose up -d polygres` running.
- `bun test packages/core/test/control/` green (requires Polygres up; tests skip with a clear message if unreachable).
- `runMigrations()` is idempotent (run twice, no error, no duplicate rows).

**Handoff notes:** `getPool()`, `runMigrations()`, and tenant CRUD are available. The `tenants` table is the source of truth for Clerk org → HelixDB instance mapping. Next stage (3) provisions HelixDB instances and writes `helix_instance_url` + `helix_api_key_encrypted` back into this table. Stage 4 (Clerk) will call `createTenant` from webhooks.

---

## Stage 3 — Coolify Integration Module

**Goal:** Programmatic HelixDB instance lifecycle via Coolify's REST API — provision, start, stop, delete, status, backup.

**Depends on:** Stage 2.

**References:**
- `PLAN.md` → "Multi-Tenancy — Provisioning" (lines ~207–265)
- `PLAN.md` → "Coolify API usage" + "HelixDB instance template" (lines ~371–429)
- Coolify REST API docs (operator should confirm endpoint shapes; base path `/api/v1/applications`)

**Files to create:**
- `packages/core/src/control/coolify.ts` — Coolify API client
- `packages/core/src/control/helix-provision.ts` — orchestrates provision flow (create container → wait health → return url+key)
- `packages/core/src/control/encryption.ts` — AES-GCM encrypt/decrypt for `helix_api_key` (use `node:crypto`)
- `packages/core/test/control/coolify.test.ts` — tests against a mock Coolify (nock or undici MockAgent)
- `packages/core/test/control/encryption.test.ts`

**Port from:**
- No direct GBrain equivalent (GBrain uses local PGLite/Supabase). This is new code per PLAN.md.

**Implementation steps:**
1. `encryption.ts`: `encrypt(plaintext, key)` / `decrypt(ciphertext, key)` using AES-256-GCM. Key from `config.encryptionKey` (env `ENCRYPTION_KEY`, 32 bytes base64). Output format: `base64(iv:ciphertext:tag)`.
2. `coolify.ts`: HTTP client wrapping Coolify REST API. Methods:
   - `provisionHelixInstance(tenantSlug, apiKey): Promise<{ appId, url, apiKey }>` — `POST /api/v1/applications` with the docker-compose template from PLAN.md (lines 401–429), substituting `<tenant-slug>` and a generated `HELIX_API_KEY`.
   - `startInstance(appId)`, `stopInstance(appId)`, `deleteInstance(appId)`.
   - `getInstanceStatus(appId): Promise<'running' | 'stopped' | 'pending' | 'error'>`.
   - `backupInstance(appId)`.
   - All requests carry `Authorization: Bearer ${COOLIFY_API_TOKEN}`. Use `fetch` (Bun has it global).
3. `helix-provision.ts`: `provisionHelixForTenant(tenant)` — calls `provisionHelixInstance`, polls the instance `/health` endpoint until 200 (timeout 120s, 2s interval), returns `{ url, apiKey }`. On timeout, mark tenant `status=error` and throw.
4. The docker-compose template: embed the YAML from PLAN.md lines 401–429 as a template string, substituting `<tenant-slug>`, `<generated-api-key>`, and MinIO creds from config. Validate the substituted YAML parses.
5. Tests: mock Coolify with `undici` MockAgent or a lightweight stub. Assert `provisionHelixInstance` sends correct body, polls health, returns on 200. `encryption.test.ts` round-trips encrypt/decrypt and asserts ciphertext differs from plaintext.

**Verification:**
- `bun run typecheck` clean.
- `bun test packages/core/test/control/coolify.test.ts packages/core/test/control/encryption.test.ts` green.
- (Optional, requires real Coolify) Manually call `provisionHelixInstance('test-tenant', 'test-key')` against the real Coolify and confirm a container starts and `/health` returns 200. Tear down after.

**Handoff notes:** `provisionHelixForTenant(tenant)` returns a ready HelixDB instance URL + API key. Stage 4 (Clerk webhooks) calls this on `organization.created`. Stage 6 (HelixDB schema) deploys the schema onto a freshly provisioned instance. `encrypt`/`decrypt` are used by Stage 2's tenant CRUD to store `helix_api_key_encrypted`.

---

## Stage 4 — Clerk Backend API Client + Webhook Handlers

**Goal:** Clerk Backend API client for org/API-key management, plus webhook handlers that auto-provision and deprovision HelixDB instances on org lifecycle events.

**Depends on:** Stage 3.

**References:**
- `PLAN.md` → "Authentication — Clerk" (lines ~268–353)
- `PLAN.md` → "Clerk webhook handling" table (lines ~346–352)
- Clerk Backend API docs (operator confirms endpoint shapes)

**Files to create:**
- `packages/core/src/control/clerk.ts` — Clerk Backend API client
- `packages/core/src/control/clerk-webhooks.ts` — webhook event handlers (org lifecycle)
- `packages/core/test/control/clerk.test.ts` — mocked Clerk API
- `packages/core/test/control/clerk-webhooks.test.ts` — webhook handler tests with signed payloads

**Port from:**
- No direct GBrain equivalent (GBrain is single-user). New code per PLAN.md.

**Implementation steps:**
1. `clerk.ts`: Backend API client using `CLERK_SECRET_KEY`. Methods:
   - `getOrganization(orgId)` → `{ id, slug, name }`.
   - `listOrganizationApiKeys(orgId)` → API key metadata (not raw keys).
   - `revokeApiKey(orgId, keyId)`.
   - `verifyApiKey(apiKey)` → resolves to `{ org_id, org_slug }` or throws. (Use Clerk's API key verification endpoint.)
   - `getJwks()` → JWKS for JWT verification (cached).
2. `clerk-webhooks.ts`: `handleClerkWebhook(payload, signature)` — verify signature using `CLERK_WEBHOOK_SECRET` (HMAC-SHA256), then dispatch:
   - `organization.created` → `createTenant({ clerk_org_id, name, slug })` → `provisionHelixForTenant(tenant)` → `updateTenant({ helix_instance_url, helix_api_key_encrypted, status: 'active' })`.
   - `organization.deleted` → `backupHelixInstance(tenant.coolify_app_id)` → `deleteHelixInstance(appId)` → `updateTenant({ status: 'deleted' })`.
   - `organization.updated` → `updateTenant({ name, slug })`.
   - `api_key.created` / `api_key.revoked` → record/invalidate (Phase 1: log only; full OAuth store is Stage 2's `oauth_tokens`).
3. Provisioning is async — `organization.created` should respond 200 immediately and provision in the background (the dashboard polls tenant status). Implement with a simple in-process queue (Phase 1; durable queue is Phase 2).
4. Tests: mock Clerk Backend API. `clerk.test.ts` exercises `verifyApiKey` happy + invalid paths. `clerk-webhooks.test.ts` constructs signed webhook payloads (use `node:crypto` HMAC with the test secret) and asserts the correct tenant CRUD + Coolify calls are made (mock Coolify too).

**Verification:**
- `bun run typecheck` clean.
- `bun test packages/core/test/control/clerk*.test.ts` green.
- (Manual, requires real Clerk) Trigger a test `organization.created` webhook from the Clerk dashboard and confirm a tenant row + HelixDB instance appear.

**Handoff notes:** `handleClerkWebhook` is wired to provision/deprovision. `clerk.verifyApiKey` and `clerk.getJwks` are used by Stage 5's auth middleware. The webhook HTTP route itself is mounted in Stage 12 (API service).

---

## Stage 5 — Clerk Auth Middleware + Tenant Resolver

**Goal:** Express 5 middleware that verifies Clerk JWTs (browser) and Clerk API keys (MCP agents), resolves the Clerk org to a Graphbrain tenant, and attaches `OperationContext` to the request.

**Depends on:** Stage 4.

**References:**
- `PLAN.md` → "Auth flows" (lines ~318–334)
- `PLAN.md` → "Clerk → Tenant mapping" (lines ~310–316)
- `_reference/gbrain/src/mcp/server.ts` (trust-boundary `remote` flag pattern)

**Files to create:**
- `apps/api/src/middleware/clerk-auth.ts` — JWT + API key verification
- `apps/api/src/middleware/tenant-resolver.ts` — org_id → tenant → cached HelixEngine handle
- `apps/api/src/middleware/error-handler.ts` — unified error response shape
- `apps/api/src/middleware/context.ts` — builds `OperationContext` from resolved tenant + auth
- `apps/api/test/middleware/clerk-auth.test.ts`
- `apps/api/test/middleware/tenant-resolver.test.ts`

**Port from:**
- `_reference/gbrain/src/mcp/server.ts` — `remote` flag setting, fail-closed trust boundary.
- `_reference/gbrain/src/core/scope.ts` — source scoping (Phase 1: single default source, but preserve the seam).

**Implementation steps:**
1. `clerk-auth.ts`: two auth modes detected by the `Authorization` header:
   - JWT (session): verify against Clerk JWKS (use `jose` library — add as dependency). Extract `org_id` claim. Set `req.auth = { mode: 'jwt', orgId, userId }`.
   - API key: call `clerk.verifyApiKey(token)`. Set `req.auth = { mode: 'apikey', orgId }`.
   - Missing/invalid → 401 with the unified error shape.
2. `tenant-resolver.ts`: given `req.auth.orgId`, call `getTenantByClerkOrg(orgId)`. If not found → 403 (org exists in Clerk but no Graphbrain tenant — provisioning incomplete or webhook missed). If `status !== 'active'` → 503 with retry hint. Decrypt `helix_api_key`. Attach `req.tenant` and `req.helixCreds = { url, apiKey }`. Cache the tenant row for 60s (in-memory LRU) to avoid a Polygres hit per request.
3. `context.ts`: build `OperationContext` — `tenant`, `remote: true` (HTTP callers are always untrusted per GBrain invariant), `auth`, `sourceId` (default `'default'` for Phase 1), `signal` from `req`.
4. `error-handler.ts`: catch `OperationError` (from Stage 10) and emit `{ error: { code, message, suggestion? } }` with correct HTTP status mapping (`page_not_found` → 404, `permission_denied` → 403, `rate_limited` → 429, `invalid_params` → 400, else 500).
5. Tests: mock Clerk JWKS + API key verification. Assert JWT with valid signature + org claim passes; invalid signature → 401. API key happy path + revoked → 401. Tenant resolver: existing active tenant → 200; pending tenant → 503; missing tenant → 403.

**Verification:**
- `bun run typecheck` clean.
- `bun test apps/api/test/middleware/` green.
- Add `jose` to `apps/api` dependencies (`bun add jose` in the api workspace).

**Handoff notes:** Every authenticated route mounts `clerkAuth → tenantResolver → contextBuilder` in order. `req.context` is a fully populated `OperationContext` ready for Stage 10's operations and Stage 11's MCP dispatch. The `remote: true` invariant is enforced here for all HTTP callers.

---

## Stage 6 — HelixDB Schema + Index Deployment

**Goal:** HelixDB node/edge schema and indexes for Phase 1 entities, deployed onto a freshly provisioned instance, plus the dynamic query definitions for CRUD and search.

**Depends on:** Stage 3.

**References:**
- `PLAN.md` → "Storage Mapping" → HelixDB Node Types, Edge Types, Indexes (lines ~130–188)
- `_reference/helix-db/sdks/typescript/README.md` (DSL: `g()`, `addN`, `nWithLabel`, `readBatch`, `writeBatch`, `defineParams`, `defineQueries`)
- `_reference/helix-db/sdks/typescript/src/dsl.ts` (full DSL)
- `_reference/gbrain/src/schema.sql` (source of truth for node/edge properties)

**Files to create:**
- `packages/core/src/helix/schema.ts` — schema definition (node labels, edge labels, property types)
- `packages/core/src/helix/indexes.ts` — index creation (vector, text/BM25, equality, range)
- `packages/core/src/helix/deploy.ts` — `deploySchema(client)` pushes schema + indexes to an instance
- `packages/core/src/helix/queries/page-crud.ts` — Page CRUD dynamic queries
- `packages/core/src/helix/queries/chunk-crud.ts` — Chunk CRUD + embedding write
- `packages/core/src/helix/queries/source-crud.ts` — Source CRUD
- `packages/core/src/helix/queries/links.ts` — edge add/list (typed + generic)
- `packages/core/src/helix/queries/search-vector.ts` — vector search on Chunk.embedding
- `packages/core/src/helix/queries/search-text.ts` — BM25 text search on Chunk.content + Page.compiled_truth + Page.title
- `packages/core/src/helix/queries/graph-traverse.ts` — out/in/both edge traversal
- `packages/core/test/helix/schema.test.ts`
- `packages/core/test/helix/queries.test.ts` — tests against the local Docker Compose HelixDB

**Port from:**
- `_reference/gbrain/src/schema.sql` — column → node property mapping (see PLAN.md storage mapping table).
- HelixDB TS SDK DSL patterns from the README quick-start.

**Implementation steps:**
1. `schema.ts`: define node labels (`Page`, `Chunk`, `Source`) with property name + type maps. Phase 1 omits `Fact`, `Take`, `TimelineEntry`, `File`, `CodeSymbol`, `Tag` (those are Phase 2/3). Define edge labels: `MENTIONS`, `HAS_CHUNK`, `CONTAINS`, plus the typed-edge union (`WORKS_AT`, `FOUNDED`, etc.) — store edge `type` as a property on a generic `MENTIONS`-style edge for Phase 1 simplicity, OR use distinct edge labels per type if HelixDB supports it cleanly (confirm via SDK). Document the choice.
2. `indexes.ts`: define indexes per PLAN.md index table — `nodeVector` on `Chunk.embedding`, `nodeText` (BM25) on `Chunk.content` / `Page.compiled_truth` / `Page.title`, `nodeEquality` on `Page.slug` + `Page.type`, `nodeRange` on `Page.effective_date` + `Page.updated_at`. Use the HelixDB SDK's index-creation DSL.
3. `deploy.ts`: `deploySchema(client)` — create node/edge labels (idempotent), create indexes (idempotent). Called by the provisioning flow after health check (wire into `helix-provision.ts` from Stage 3 — add a `deploySchema` call after health passes).
4. `page-crud.ts`: dynamic queries using `defineParams` + `writeBatch`/`readBatch`:
   - `addPage(params: { slug, type, title, compiled_truth, frontmatter, content_hash, ... })`
   - `getPageBySlug(params: { slug })` — `nWithLabel('Page')` + filter `eq slug`
   - `updatePage(params: { slug, patch })`
   - `softDeletePage(params: { slug })` — set `deleted_at`
   - `listPages(params: { type?, limit, offset })`
5. `chunk-crud.ts`: `addChunk`, `getChunksByPage`, `updateChunkEmbedding`.
6. `source-crud.ts`: `addSource`, `getSource`, `listSources`.
7. `links.ts`: `addEdge(params: { fromSlug, toSlug, type, origin })`, `getOutEdges(slug)`, `getInEdges(slug)`.
8. `search-vector.ts`: `vectorSearchChunks(params: { embedding, limit })` — `nodeVector` search on `Chunk.embedding`.
9. `search-text.ts`: `textSearchPages(params: { query, limit })` — `nodeText` BM25 on Page fields; `textSearchChunks(params: { query, limit })`.
10. `graph-traverse.ts`: `traverseFrom(slug, { direction, edgeTypes, depth, limit })`.
11. Tests: spin up the local HelixDB from Docker Compose, run `deploySchema`, then exercise each query (add page → get by slug → add chunk → vector search with a known embedding → text search → add edge → traverse). Use deterministic test embeddings (e.g. unit vectors) so vector search results are predictable.

**Verification:**
- `bun run typecheck` clean.
- `docker compose up -d helixdb` running.
- `bun test packages/core/test/helix/` green.
- `deploySchema` is idempotent (run twice, no error).

**Handoff notes:** `deploySchema(client)` is called during provisioning. The dynamic query modules are imported by Stage 7's `HelixEngine`. The query function signatures define the contract Stage 7 implements against. If HelixDB's DSL lacks a needed primitive (e.g. range filter), document the gap and the workaround in `schema.ts` — Stage 7 will need to know.

---

## Stage 7 — BrainEngine Interface + HelixEngine + Tenant Router

**Goal:** The `BrainEngine` interface (engine abstraction), the `HelixEngine` implementation backed by the dynamic queries from Stage 6, and the `TenantRouter` that resolves a tenant to a cached `HelixEngine` instance.

**Depends on:** Stage 6.

**References:**
- `PLAN.md` → "Engine abstraction" design principle (line ~12)
- `PLAN.md` → "Routing" (lines ~226–238)
- `_reference/gbrain/src/core/engine.ts` (BrainEngine interface)
- `_reference/gbrain/src/core/postgres-engine.ts` (engine impl pattern)

**Files to create:**
- `packages/core/src/engine.ts` — `BrainEngine` interface + `clampSearchLimit` helper
- `packages/core/src/helix-engine.ts` — `HelixEngine implements BrainEngine`
- `packages/core/src/tenant.ts` — `TenantRouter`
- `packages/core/test/engine.test.ts` — interface conformance
- `packages/core/test/helix-engine.test.ts` — impl tests against local HelixDB
- `packages/core/test/tenant-router.test.ts`

**Port from:**
- `_reference/gbrain/src/core/engine.ts` — interface shape, `clampSearchLimit`, search-opts type.
- `_reference/gbrain/src/core/postgres-engine.ts` — method-by-method port target (adapt SQL → HelixDB dynamic queries).

**Implementation steps:**
1. `engine.ts`: define `BrainEngine` interface with methods matching GBrain's engine but adapted to HelixDB:
   - `getPage(slug)`, `listPages(opts)`, `putPage(page)`, `softDeletePage(slug)`
   - `addChunk(chunk)`, `getChunksByPage(slug)`, `updateChunkEmbedding(chunkId, embedding)`
   - `addEdge(link)`, `getOutEdges(slug)`, `getInEdges(slug)`
   - `vectorSearchChunks(embedding, limit)`, `textSearchPages(query, limit)`, `textSearchChunks(query, limit)`
   - `traverse(slug, opts)`
   - `addSource(source)`, `getSource(id)`, `listSources()`
   - `close()` — release the underlying client
   Include `SearchOpts` type (limit, mode, filters) and `clampSearchLimit(opts, mode)`.
2. `helix-engine.ts`: `HelixEngine` wraps a HelixDB `Client` (from the TS SDK) and delegates each interface method to the corresponding dynamic query from Stage 6. Constructor: `new HelixEngine({ url, apiKey })`. Lazily create the client. Implement `close()` to drop the client.
3. `tenant.ts`: `TenantRouter` — `getEngine(tenant): HelixEngine`. Maintain an LRU cache keyed by `tenant.id` with TTL 5min + max 100 entries. On cache miss, construct `new HelixEngine({ url: tenant.helix_instance_url, apiKey: decrypt(tenant.helix_api_key_encrypted) })`. Before reuse, validate the cached engine is healthy (ping `/health`); if unhealthy, evict and reconstruct. Expose `invalidate(tenantId)` for use when a tenant's instance is reprovisioned.
4. Tests: `engine.test.ts` — type-level test asserting `HelixEngine` satisfies `BrainEngine`. `helix-engine.test.ts` — against local HelixDB, exercise every method end-to-end (put page → get → list → add chunk → search → traverse → delete). `tenant-router.test.ts` — cache hit/miss, TTL expiry (mock clock), health-check eviction.

**Verification:**
- `bun run typecheck` clean.
- `docker compose up -d helixdb` running.
- `bun test packages/core/test/engine.test.ts packages/core/test/helix-engine.test.ts packages/core/test/tenant-router.test.ts` green.

**Handoff notes:** `TenantRouter.getEngine(tenant)` returns a healthy `HelixEngine`. Stage 10's operations call engine methods through this. Stage 5's tenant-resolver middleware can expose `getEngine(req.tenant)` to handlers. The `BrainEngine` interface is the seam a future Polygres engine would implement.

---

## Stage 8 — AI Gateway (OpenRouter) + Embedding Service

**Goal:** The `AIProvider` interface, the `OpenRouterProvider` (chat, embeddings, rerank), a `TriadProvider` stub, the unified gateway with per-tenant routing, and the embedding service.

**Depends on:** Stage 1.

**References:**
- `PLAN.md` → "AI Gateway" (lines ~501–597)
- `PLAN.md` → "Model routing" table (lines ~549–558)
- `_reference/gbrain/src/core/ai/` (GBrain AI recipes — port the recipe pattern, not the Anthropic-specific client)

**Files to create:**
- `packages/core/src/ai/provider.ts` — `AIProvider` interface
- `packages/core/src/ai/types.ts` — `ChatMessage`, `ChatRequest`, `ChatResponse`, `EmbedRequest`, `EmbedResponse`, `RerankRequest`, `RerankResponse`
- `packages/core/src/ai/openrouter.ts` — `OpenRouterProvider implements AIProvider`
- `packages/core/src/ai/triad.ts` — `TriadProvider` stub (throws "not implemented" for Phase 1)
- `packages/core/src/ai/gateway.ts` — `AIGateway` with per-tenant model routing + retry/backoff
- `packages/core/src/embedding.ts` — `EmbeddingService` (wraps gateway.embed, handles batching + dimension)
- `packages/core/test/ai/openrouter.test.ts` — mocked OpenRouter API
- `packages/core/test/ai/gateway.test.ts` — routing + retry logic
- `packages/core/test/embedding.test.ts`

**Port from:**
- `_reference/gbrain/src/core/ai/` — recipe structure, retry/backoff pattern, model-config resolution.
- `_reference/gbrain/src/core/embedding-context.ts` / embedding service — batching, dimension handling.

**Implementation steps:**
1. `provider.ts`: `AIProvider` interface — `chat(req)`, `embed(req)`, `rerank(req)`. Each returns the typed response from `types.ts`.
2. `types.ts`: define request/response shapes. `ChatRequest`: `model`, `messages`, `temperature?`, `maxTokens?`, `responseFormat?` (json). `EmbedRequest`: `model`, `inputs: string[]`, `dimensions?`. `RerankRequest`: `model`, `query`, `documents`, `topN`.
3. `openrouter.ts`: implement against `https://openrouter.ai/api/v1`. Headers: `Authorization: Bearer <key>`, `HTTP-Referer: https://graphbrain.belweave.ai`, `X-Title: graphbrain`. Endpoints: `chat/completions`, `embeddings`, and rerank (OpenRouter routes rerank models via `chat/completions` with a rerank model ID — confirm; if not, call the underlying provider's rerank endpoint directly via OpenRouter's passthrough). Map model IDs per PLAN.md routing table.
4. `triad.ts`: stub — `chat`/`embed`/`rerank` throw `Error('TriadProvider not activated in Phase 1')`. Constructor accepts `{ baseUrl, apiKey }` for future wiring.
5. `gateway.ts`: `AIGateway` — holds a default `OpenRouterProvider` (platform key) + per-tenant override support. Methods resolve the active provider + model from `tenant.settings` (BYO key, model prefs) falling back to defaults. Implement retry with exponential backoff (3 attempts, 1s/2s/4s) on 429/5xx. Track token usage + cost (delegate to Stage 16 metering; for Phase 1, log to `audit_log`-shaped structure).
6. `embedding.ts`: `EmbeddingService` — `embed(texts: string[], tenant): Promise<number[][]>`. Resolves the tenant's configured embedding model (default `text-embedding-3-large`, 1536d). Batches (e.g. 100 texts/call). Returns vectors. Used by Stage 9 (retrieval) and Stage 10 (put_page).
7. Tests: mock OpenRouter with `undici` MockAgent. `openrouter.test.ts` — chat/embed/rerank happy paths + error mapping. `gateway.test.ts` — per-tenant model override, BYO key used, retry on 429 succeeds on 2nd attempt, 3rd failure throws. `embedding.test.ts` — batching, dimension passthrough.

**Verification:**
- `bun run typecheck` clean.
- `bun test packages/core/test/ai/ packages/core/test/embedding.test.ts` green.
- (Manual, requires real OpenRouter key) Call `gateway.embed(['hello world'], defaultTenant)` and confirm a 1536-dim vector returns.

**Handoff notes:** `AIGateway` and `EmbeddingService` are available. Stage 9's rerank step calls `gateway.rerank`. Stage 10's `put_page` calls `embeddingService.embed` before writing chunks. The per-tenant model resolution reads `tenant.settings` from Stage 1's config shape.

---

## Stage 9 — Hybrid Retrieval Pipeline

**Goal:** The full app-layer hybrid search pipeline — intent classification, parallel retrieval (vector + BM25 + graph), RRF fusion, boosts, graph signals, cross-encoder rerank, token budget, dedup — ported from GBrain and adapted to HelixDB + the AI gateway.

**Depends on:** Stage 7, Stage 8.

**References:**
- `PLAN.md` → "Retrieval Pipeline" (lines ~601–699)
- `PLAN.md` → "Search modes" table (lines ~679–687)
- `_reference/gbrain/src/core/search/hybrid.ts` (the pipeline)
- `_reference/gbrain/src/core/search/intent-weights.ts`, `query-intent.ts`, `expansion.ts`, `graph-signals.ts`, `relational-recall.ts`, `rerank.ts`, `dedup.ts`, `mode.ts`, `token-budget.ts`, `query-cache.ts`

**Files to create:**
- `packages/core/src/search/intent.ts` — deterministic intent classifier (ported)
- `packages/core/src/search/intent-weights.ts` — intent → ranking knobs (ported)
- `packages/core/src/search/mode.ts` — search mode presets + `KNOBS_HASH_VERSION` (ported)
- `packages/core/src/search/expansion.ts` — LLM query expansion via gateway (ported)
- `packages/core/src/search/hybrid.ts` — `hybridSearch(engine, gateway, query, opts, ctx)` orchestrating the pipeline
- `packages/core/src/search/rerank.ts` — cross-encoder rerank via gateway (ported)
- `packages/core/src/search/graph-signals.ts` — adjacency/cross-source/session boosts (ported)
- `packages/core/src/search/relational-recall.ts` — graph traversal recall arm (ported, simplified for Phase 1 edge set)
- `packages/core/src/search/token-budget.ts` — token budget enforcement (ported)
- `packages/core/src/search/dedup.ts` — dedup (ported)
- `packages/core/src/search/query-cache.ts` — Polygres-backed semantic cache (uses Stage 2's `query_cache` table)
- `packages/core/test/search/intent.test.ts`
- `packages/core/test/search/hybrid.test.ts` — end-to-end against local HelixDB + mocked gateway
- `packages/core/test/search/query-cache.test.ts`

**Port from:**
- The GBrain `src/core/search/` files listed above. Port logic verbatim where it's engine-agnostic (intent, weights, mode, expansion, rerank, graph-signals, token-budget, dedup). Adapt the SQL-heavy fusion (`hybrid.ts`) to call `engine.vectorSearchChunks`, `engine.textSearchPages`, `engine.textSearchChunks`, `engine.traverse` in parallel via `Promise.all`, then fuse in TS.

**Implementation steps:**
1. `intent.ts`: port the deterministic classifier — entity / temporal / event / general. No LLM. Returns intent + confidence.
2. `intent-weights.ts`: port the intent → knobs map (graph weight, timeline boost, etc.).
3. `mode.ts`: port `MODE_BUNDLES` (conservative/balanced/tokenmax) + `KNOBS_HASH_VERSION`. Resolution chain: per-call opts → per-key config → MODE_BUNDLES[mode] → balanced fallback.
4. `expansion.ts`: `expandQuery(query, gateway, ctx)` — calls `gateway.chat` with a expansion prompt; returns expanded terms. Gated by mode (`expansion: false` for conservative/balanced, `true` for tokenmax).
5. `hybrid.ts`: `hybridSearch(engine, gateway, query, opts, ctx)`:
   a. Resolve mode + knobs.
   b. Check query cache (Stage 2 table) — return cached if hit + `knobs_hash` matches + embedding similarity < threshold.
   c. Classify intent → set ranking knobs.
   d. Optionally expand query.
   e. Embed the query via `embeddingService.embed([query])`.
   f. Parallel retrieval: `Promise.all([engine.vectorSearchChunks(embedding, limit), engine.textSearchChunks(query, limit), engine.textSearchPages(query, limit), relationalRecall(engine, query, ctx)])`.
   g. RRF fusion (RRF_K=60) across all streams.
   h. Apply boosts: compiled_truth_boost (2.0x), cosine_rescore (0.7*rrf + 0.3*cosine), backlink_boost, salience_boost, recency_boost, source_boost (port formulas from GBrain).
   i. Apply graph signals: adjacency_boost, cross_source_boost, session_demote.
   j. Cross-encoder rerank top 30 via `gateway.rerank` (zerank-2).
   k. Token budget enforcement.
   l. Dedup.
   m. Write to query cache.
   n. Return results + `HybridSearchMeta`.
6. `rerank.ts`: wrap `gateway.rerank`, map to the result list.
7. `graph-signals.ts`: port the three signal computations.
8. `relational-recall.ts`: port — resolve seed entity from query, `engine.traverse` typed edges, inject edge-derived answers into RRF. Simplify for Phase 1 edge set (MENTIONS + typed edges from Stage 6).
9. `token-budget.ts`: port — truncate results to fit budget (conservative=4000, balanced=12000, tokenmax=off).
10. `dedup.ts`: port — dedupe by page slug + chunk overlap.
11. `query-cache.ts`: `getCached(tenantId, queryHash, knobsHash, embedding)` / `setCached(...)`. Uses Stage 2's `query_cache` table. `knobs_hash` includes mode + embedding column + relational flag (per GBrain v9→v10 invariant).
12. Tests: `intent.test.ts` — deterministic cases. `hybrid.test.ts` — seed local HelixDB with 5 pages + chunks + embeddings, run `hybridSearch`, assert relevant page ranks first + meta is populated. Mock the gateway (rerank returns input order; expansion returns input). `query-cache.test.ts` — write/read hit, `knobs_hash` mismatch → miss.

**Verification:**
- `bun run typecheck` clean.
- `docker compose up -d helixdb polygres` running.
- `bun test packages/core/test/search/` green.
- The hybrid test demonstrates a query returning the expected top page with citations.

**Handoff notes:** `hybridSearch(engine, gateway, query, opts, ctx)` is the retrieval primitive. Stage 10's `search` and `query` operations call it. The `HybridSearchMeta` is returned to callers. The query cache is wired and reduces repeat query latency.

---

## Stage 10 — Operations Contract (Core Set)

**Goal:** The contract-first `operations.ts` defining the Phase 1 core operations with schemas, handlers, and scope — the single source of truth for MCP (Stage 11) and CLI (Stage 15).

**Depends on:** Stage 7, Stage 8, Stage 9.

**References:**
- `PLAN.md` → "Full Operation Set" (lines ~703–773)
- `PLAN.md` → "Phased Implementation" → Operations core set (lines ~860–865)
- `_reference/gbrain/src/core/operations.ts` (the contract source)
- `_reference/gbrain/src/core/link-extraction.ts` (auto-link extraction)

**Files to create:**
- `packages/core/src/operations.ts` — operation registry + dispatcher
- `packages/core/src/operations/search.ts`, `query.ts`, `get-page.ts`, `list-pages.ts`, `get-links.ts`, `get-backlinks.ts`, `put-page.ts`, `add-link.ts`, `capture.ts` — one file per op
- `packages/core/src/link-extraction.ts` — zero-LLM auto-link extraction (ported)
- `packages/core/src/operations/types.ts` — `Operation`, `OperationContext`, `OperationError`, `ErrorCode`
- `packages/core/test/operations/search.test.ts`
- `packages/core/test/operations/put-page.test.ts`
- `packages/core/test/operations/get-page.test.ts`
- `packages/core/test/operations/capture.test.ts`
- `packages/core/test/link-extraction.test.ts`

**Port from:**
- `_reference/gbrain/src/core/operations.ts` — operation definition shape, `OperationError`, `ErrorCode` union, scope/localOnly flags, dispatch pattern.
- `_reference/gbrain/src/core/link-extraction.ts` — `extractPageLinks`, typed-edge inference, `isAutoLinkEnabled`.

**Implementation steps:**
1. `operations/types.ts`: define `Operation<I, O>` — `{ name, description, scope: 'read'|'write'|'admin', localOnly?, inputSchema: ZodSchema<I>, handler: (input, ctx) => Promise<O> }`. Define `OperationError` + `ErrorCode` (port the open-union pattern from GBrain).
2. `link-extraction.ts`: port `extractPageLinks(content, frontmatter)` — regex-based wikilink + typed-link extraction. Returns `Link[]` with inferred `type` + `origin: 'auto'`. Port `isAutoLinkEnabled`.
3. `put-page.ts`: handler — validate input, chunk content (simple fixed-size chunker for Phase 1; GBrain's tree-sitter chunker is Phase 2/3), embed chunks via `embeddingService`, write Page + Chunks + edges (auto-extracted links) via `engine.putPage` + `engine.addChunk` + `engine.addEdge`. Set `compiled_truth` (Phase 1: use the page title + first paragraph as a stub; full synthesis is Phase 3). Return the page.
4. `search.ts`: handler — call `hybridSearch`, return results + meta.
5. `query.ts`: handler — call `hybridSearch`, then `gateway.chat` to synthesize an answer with citations. Return answer + citations + meta.
6. `get-page.ts`: handler — `engine.getPage(slug)` + chunks + edges. 404 if not found.
7. `list-pages.ts`: handler — `engine.listPages(opts)` with filters (type, date range) + pagination.
8. `get-links.ts` / `get-backlinks.ts`: `engine.getOutEdges` / `engine.getInEdges`.
9. `add-link.ts`: handler — validate, `engine.addEdge`.
10. `capture.ts`: handler — quick capture; infer type, wrap content as a page, call `put-page` handler internally.
11. `operations.ts`: registry mapping op name → `Operation`. `dispatch(name, input, ctx)` — look up op, validate input with Zod, enforce `scope`/`localOnly` against `ctx` (write/admin ops require `ctx.remote === false` for localOnly; all ops require a tenant), call handler. Port the trust-boundary enforcement from GBrain.
12. Tests: each op test seeds local HelixDB, calls the handler with a mock `ctx`, asserts output. `put-page.test.ts` — put a page with wikilinks, assert chunks + edges created. `link-extraction.test.ts` — port GBrain's link extraction fixtures.

**Verification:**
- `bun run typecheck` clean.
- `docker compose up -d helixdb polygres` running.
- `bun test packages/core/test/operations/ packages/core/test/link-extraction.test.ts` green.
- The `search` op test demonstrates: put 3 pages → search → top result is the relevant one.

**Handoff notes:** `dispatch(name, input, ctx)` is the single entry point. Stage 11's MCP server and Stage 15's CLI both call it. The operation registry is the source of truth for the MCP tool list (Stage 11 generates tool defs from it). `OperationError` flows to Stage 5's error-handler middleware.

---

## Stage 11 — MCP Server (stdio + HTTP) + Dispatch

**Goal:** MCP server exposing the Phase 1 operations as tools, over stdio (local agents) and HTTP (remote agents with Clerk auth).

**Depends on:** Stage 10, Stage 5.

**References:**
- `PLAN.md` → "Agent transport" + "MCP + API" (lines ~866–871)
- `_reference/gbrain/src/mcp/server.ts` (stdio server)
- `_reference/gbrain/src/mcp/http-transport.ts` (HTTP transport)
- `_reference/gbrain/src/mcp/tool-defs.ts` (tool def generation from operations)
- `_reference/gbrain/src/mcp/dispatch.ts` (dispatch wiring)

**Files to create:**
- `packages/core/src/mcp/tool-defs.ts` — generate MCP tool definitions from the operation registry
- `packages/core/src/mcp/dispatch.ts` — wire MCP tool calls to `operations.dispatch` with tenant-aware `OperationContext`
- `packages/core/src/mcp/server.ts` — stdio MCP server (local agents)
- `packages/core/src/mcp/http-server.ts` — HTTP MCP transport (remote agents, Clerk API key auth via Stage 5 middleware)
- `packages/core/test/mcp/tool-defs.test.ts`
- `packages/core/test/mcp/dispatch.test.ts`

**Port from:**
- `_reference/gbrain/src/mcp/server.ts` — stdio server setup, `remote: true` for MCP callers.
- `_reference/gbrain/src/mcp/tool-defs.ts` — operation → MCP tool mapping (name, description, inputSchema as JSON Schema from Zod).
- `_reference/gbrain/src/mcp/http-transport.ts` — HTTP transport shape.

**Implementation steps:**
1. `tool-defs.ts`: `generateToolDefs()` — iterate the operation registry, emit MCP tool objects (`{ name, description, inputSchema }`) where `inputSchema` is the Zod schema converted to JSON Schema (use `zod-to-json-schema` — add as dependency). Exclude `localOnly` ops from the remote tool list.
2. `dispatch.ts`: `handleMcpCall(toolName, args, ctx)` — map tool name → operation name, call `operations.dispatch`, return MCP-formatted result (text content with JSON). Set `ctx.remote = true` for MCP callers (enforced here, matching GBrain).
3. `server.ts`: stdio MCP server using the MCP SDK (`@modelcontextprotocol/sdk` — add as dependency). Register tools from `generateToolDefs()`. On tool call, build `OperationContext` from env-configured tenant (local mode: `GRAPHBRAIN_TENANT_ID` env var → load tenant from Polygres → `TenantRouter.getEngine`). Run over stdio.
4. `http-server.ts`: HTTP MCP transport — mounts at `POST /mcp`. Uses Stage 5's `clerkAuth` + `tenantResolver` + `contextBuilder` middleware to populate `req.context`. On tool call, `handleMcpCall(toolName, args, req.context)`. Implement the MCP HTTP transport spec (SSE or streamable HTTP per the MCP spec version — confirm and document).
5. Tests: `tool-defs.test.ts` — assert every non-localOnly op has a tool def with valid JSON Schema. `dispatch.test.ts` — mock `operations.dispatch`, assert `handleMcpCall` maps names correctly + sets `remote: true`.

**Verification:**
- `bun run typecheck` clean.
- `bun test packages/core/test/mcp/` green.
- Add `@modelcontextprotocol/sdk` and `zod-to-json-schema` to `packages/core` dependencies.
- (Manual) Run the stdio server locally with `GRAPHBRAIN_TENANT_ID=<test-tenant>` and send a `tools/list` MCP request — confirm the Phase 1 tools appear.

**Handoff notes:** `generateToolDefs()` and `handleMcpCall` are the MCP seam. Stage 12 mounts the HTTP server at `/mcp`. Stage 15's CLI `serve` command launches the stdio server. The tool list is auto-generated — adding operations in Stage 10 automatically extends MCP.

---

## Stage 12 — API Service (Express 5) + Routes + Webhooks

**Goal:** The Express 5 API service tying together auth middleware, MCP HTTP server, dashboard REST routes, Clerk webhooks, and health/readiness endpoints — with graceful shutdown.

**Depends on:** Stage 5, Stage 11.

**References:**
- `PLAN.md` → "api.graphbrain.belweave.ai" endpoint table (lines ~476–498)
- `PLAN.md` → "Phased Implementation" → MCP + API checklist (lines ~866–872)
- `_reference/gbrain/src/mcp/http-transport.ts` (HTTP wiring reference)

**Files to create:**
- `apps/api/src/index.ts` — Express app assembly
- `apps/api/src/server.ts` — server lifecycle (start, graceful shutdown, signal handling)
- `apps/api/src/routes/mcp.ts` — mounts `httpServer` at `/mcp`
- `apps/api/src/routes/dashboard.ts` — dashboard REST endpoints (stats, search, pages, sources, settings, api-keys)
- `apps/api/src/routes/webhooks/clerk.ts` — mounts `handleClerkWebhook` at `POST /webhooks/clerk`
- `apps/api/src/routes/health.ts` — `GET /api/health`, `GET /api/ready`
- `apps/api/test/routes/dashboard.test.ts`
- `apps/api/test/routes/health.test.ts`
- `apps/api/test/routes/webhooks.test.ts`
- `apps/api/test/server.test.ts` — graceful shutdown test

**Port from:**
- `_reference/gbrain/src/mcp/http-transport.ts` — Express mounting pattern.

**Implementation steps:**
1. `index.ts`: create Express 5 app. Mount middleware in order: JSON body parser, `clerkAuth`, `tenantResolver`, `contextBuilder` (applied only to authenticated routes — health/webhooks are public or use webhook-secret auth). Mount routes.
2. `routes/health.ts`: `GET /api/health` → 200 `{ status: 'ok' }` (unauthenticated). `GET /api/ready` → checks Polygres connectivity + at least one tenant engine reachable → 200 or 503.
3. `routes/mcp.ts`: mount `httpServer` (from Stage 11) at `POST /mcp` + `GET /mcp/tools`.
4. `routes/dashboard.ts`: implement the dashboard endpoints from PLAN.md (lines 486–496):
   - `GET /api/dashboard/stats` — page count, chunk count, recent pages (calls `engine.listPages`).
   - `POST /api/dashboard/search` — calls `operations.dispatch('search', body, req.context)`.
   - `GET /api/dashboard/pages` — `dispatch('list_pages', ...)`.
   - `POST /api/dashboard/pages` — `dispatch('put_page', ...)`.
   - `GET /api/dashboard/sources` — `engine.listSources`.
   - `GET/PUT /api/dashboard/settings` — read/update `tenant.settings` via Stage 2 tenant CRUD.
   - `POST /api/dashboard/api-keys` — calls Clerk Backend API to issue an API key for the org (Stage 4 client).
   All require `req.context` (authenticated).
5. `routes/webhooks/clerk.ts`: `POST /webhooks/clerk` — raw body + signature header → `handleClerkWebhook(rawBody, signature)`. Return 200 always (webhook best practice) even on handler errors (log + 200 to avoid Clerk retries masking real issues — but surface errors in logs).
6. `server.ts`: `startServer()` — listen on `PORT` (env, default 3000). Handle `SIGTERM`/`SIGINT`: stop accepting new connections, drain in-flight requests (10s timeout), close Polygres pool, close cached Helix engines, exit.
7. Tests: `health.test.ts` — health 200, ready 200 when Polygres up. `dashboard.test.ts` — mock auth middleware + engine, assert each endpoint returns expected shape. `webhooks.test.ts` — signed payload → 200 + correct side effect (mocked). `server.test.ts` — start, send SIGTERM, assert process exits cleanly.

**Verification:**
- `bun run typecheck` clean.
- `docker compose up -d` (full stack) running.
- `bun test apps/api/test/` green.
- (Manual smoke) `curl http://localhost:3000/api/health` → 200. With a valid Clerk JWT, `curl -H "Authorization: Bearer <jwt>" http://localhost:3000/api/dashboard/stats` → 200 with stats.

**Handoff notes:** The API service is runnable: `bun run dev:api`. All Phase 1 endpoints are live. Stage 13's dashboard calls these. Stage 14's marketing links to the sign-up flow. Stage 15's CLI `connect` command targets `POST /mcp`.

---

## Stage 13 — Dashboard (Next.js) — Core Pages

**Goal:** The authenticated dashboard at `graphbrain.belweave.ai` — Clerk auth, onboarding (provision brain), overview, search, pages, API keys, settings.

**Depends on:** Stage 12.

**References:**
- `PLAN.md` → "graphbrain.belweave.ai" route table (lines ~446–460)
- `PLAN.md` → "Phased Implementation" → Dashboard checklist (lines ~873–880)

**Files to create:**
- `apps/dashboard/src/app/layout.tsx` — `ClerkProvider` wrapper
- `apps/dashboard/src/app/sign-in/[[...sign-in]]/page.tsx` — Clerk SignIn
- `apps/dashboard/src/app/sign-up/[[...sign-up]]/page.tsx` — Clerk SignUp
- `apps/dashboard/src/app/onboarding/page.tsx` — create/join org → wait for brain ready (polls tenant status)
- `apps/dashboard/src/app/dashboard/page.tsx` — overview (stats, recent pages)
- `apps/dashboard/src/app/dashboard/search/page.tsx` — search interface
- `apps/dashboard/src/app/dashboard/pages/page.tsx` — page browser (list)
- `apps/dashboard/src/app/dashboard/pages/[slug]/page.tsx` — page detail (content, links, backlinks)
- `apps/dashboard/src/app/dashboard/api-keys/page.tsx` — generate/revoke Clerk API keys
- `apps/dashboard/src/app/dashboard/settings/page.tsx` — AI model config, embedding model
- `apps/dashboard/src/lib/api.ts` — typed API client (calls `api.graphbrain.belweave.ai`, attaches Clerk session JWT)
- `apps/dashboard/src/components/` — shared UI (StatCard, PageList, SearchBar, ApiKeyTable)
- `apps/dashboard/test/api.test.ts` — API client tests (mocked fetch)

**Implementation steps:**
1. Add `@clerk/nextjs` to `apps/dashboard` dependencies (`bun add @clerk/nextjs`).
2. `layout.tsx`: wrap app in `ClerkProvider` with publishable key from env. Set up middleware (`apps/dashboard/src/middleware.ts`) to protect `/dashboard/*` routes.
3. `lib/api.ts`: `apiClient` — uses Clerk's `auth()` to get the session JWT, attaches `Authorization: Bearer <jwt>`, calls the API service. Typed methods matching Stage 12's dashboard endpoints.
4. Onboarding: detect if user has an org with a Graphbrain tenant. If not, prompt to create a Clerk org → POST triggers Clerk `organization.created` webhook (Stage 4) → poll `GET /api/dashboard/stats` (or a dedicated status endpoint) until brain ready. Show provisioning progress.
5. Overview: `GET /api/dashboard/stats` → render stats + recent pages list.
6. Search: input → `POST /api/dashboard/search` → render results with citations.
7. Pages: `GET /api/dashboard/pages` → list. Click → detail page (`GET` page by slug — add a `GET /api/dashboard/pages/[slug]` endpoint if not in Stage 12; if missing, extend Stage 12's dashboard route here and note it).
8. API keys: `POST /api/dashboard/api-keys` → display new key once. List existing keys. Revoke button.
9. Settings: form for `tenant.settings` (model preferences, embedding model) → `PUT /api/dashboard/settings`.
10. Use Tailwind CSS (`bun add -D tailwindcss` + config) for styling — keep it clean and minimal (this is a prototype dashboard, not a polished product).
11. Tests: `api.test.ts` — mock `fetch`, assert the client attaches the JWT and parses responses. Component tests optional for Phase 1.

**Verification:**
- `bun run typecheck` clean.
- `bun run build` (dashboard workspace) succeeds (Next.js build).
- `bun test apps/dashboard/test/` green.
- (Manual) `bun run dev:dashboard` with the API running — sign in via Clerk, complete onboarding, see stats, run a search, view a page, generate an API key.

**Handoff notes:** The dashboard is the user-facing management surface. It depends entirely on Stage 12's API. The marketing page (Stage 14) links into the sign-up flow here. The CLI (Stage 15) uses API keys generated here.

---

## Stage 14 — Marketing Page (Next.js)

**Goal:** The public marketing site at `belweave.ai/graphbrain` — landing, features, pricing, docs (quickstart + MCP setup).

**Depends on:** Stage 0 (scaffold only; no runtime dependency on the API).

**References:**
- `PLAN.md` → "belweave.ai/graphbrain" route table (lines ~462–474)

**Files to create:**
- `apps/marketing/src/app/graphbrain/page.tsx` — landing (hero, features, CTA → sign up)
- `apps/marketing/src/app/graphbrain/features/page.tsx` — feature deep-dive
- `apps/marketing/src/app/graphbrain/pricing/page.tsx` — pricing tiers
- `apps/marketing/src/app/graphbrain/docs/page.tsx` — docs index
- `apps/marketing/src/app/graphbrain/docs/quickstart/page.tsx` — agent quickstart
- `apps/marketing/src/app/graphbrain/docs/mcp/page.tsx` — MCP setup for Claude/Cursor/Windsurf/Openclaw/Hermes
- `apps/marketing/src/components/` — Hero, FeatureGrid, PricingTable, CodeBlock
- `apps/marketing/test/render.test.ts` — smoke render tests

**Implementation steps:**
1. Use Tailwind CSS (same setup as dashboard). Keep visual style consistent with the dashboard.
2. Landing page: hero with value prop, feature grid (retrieval pipeline, knowledge graph, per-tenant isolation, MCP-native), CTA button linking to `graphbrain.belweave.ai/sign-up`.
3. Features page: expand on the retrieval pipeline, HelixDB-backed graph, OpenRouter AI gateway. Reference PLAN.md content.
4. Pricing page: placeholder tiers (Free / Pro / Enterprise) — Phase 1 doesn't enforce billing (that's Phase 4), but the page should exist.
5. Docs quickstart: step-by-step — sign up, create org, get API key, connect an agent. Reference Stage 15's CLI commands.
6. Docs MCP setup: per-agent instructions (Claude Desktop config, Cursor MCP config, Windsurf, Openclaw, Hermes) with the `graphbrain connect` command + API key.
7. Tests: `render.test.ts` — render each page with React Testing Library, assert key text present.

**Verification:**
- `bun run typecheck` clean.
- `bun run build` (marketing workspace) succeeds.
- `bun test apps/marketing/test/` green.
- (Manual) `bun run dev:marketing` — navigate the pages, confirm CTAs link to the dashboard sign-up.

**Handoff notes:** The marketing page is static/public. It links to `graphbrain.belweave.ai/sign-up` (Stage 13). Docs reference the CLI commands from Stage 15 — keep them in sync when Stage 15 finalizes command names.

---

## Stage 15 — CLI

**Goal:** The `graphbrain` CLI with Phase 1 commands: `init`, `serve`, `search`, `query`, `get`, `put`, `capture`, `connect`.

**Depends on:** Stage 11.

**References:**
- `PLAN.md` → "Phased Implementation" → CLI checklist (line ~888)
- `_reference/gbrain/src/cli.ts` (CLI entry point)
- `_reference/gbrain/src/commands/` (command handlers)

**Files to create:**
- `packages/core/src/cli.ts` — CLI entry point (arg parsing, command dispatch)
- `packages/core/src/commands/init.ts` — configure tenant + API key locally
- `packages/core/src/commands/serve.ts` — launch the stdio MCP server (Stage 11)
- `packages/core/src/commands/connect.ts` — print MCP connection config for agents
- `packages/core/src/commands/search.ts` — `graphbrain search <query>` → calls API
- `packages/core/src/commands/query.ts` — `graphbrain query <question>` → calls API
- `packages/core/src/commands/get.ts` — `graphbrain get <slug>` → calls API
- `packages/core/src/commands/put.ts` — `graphbrain put <file>` → calls API
- `packages/core/src/commands/capture.ts` — `graphbrain capture <text>` → calls API
- `packages/core/src/commands/api-client.ts` — thin HTTP client targeting `api.graphbrain.belweave.ai` with the tenant's API key
- `packages/core/test/commands/search.test.ts`
- `packages/core/test/commands/put.test.ts`
- `packages/core/test/commands/capture.test.ts`

**Port from:**
- `_reference/gbrain/src/cli.ts` — arg parsing pattern, command registration.
- `_reference/gbrain/src/commands/search.ts`, `capture.ts`, etc. — command shapes (adapt to remote API calls instead of local engine).

**Implementation steps:**
1. Choose an arg parser (`bun`'s built-in `process.argv` parsing, or add `commander`/`yargs` — prefer minimal deps; GBrain uses a custom parser). Document the choice.
2. `api-client.ts`: `RemoteClient` — base URL from config or `--api-url` flag, API key from `GRAPHBRAIN_API_KEY` env or `--token` flag. Methods call Stage 12's API (`POST /mcp` with the operation as the MCP tool call, OR direct REST endpoints — prefer MCP for consistency since the CLI is an MCP client). Set `remote: false`? No — the CLI calls the remote API over HTTP, so it's still `remote: true` from the API's perspective. The local stdio `serve` mode is the `remote: false` path.
3. `init.ts`: prompt for API URL + API key, write to `~/.graphbrain/config.json`. Verify the key works by calling `/api/health` + a `list_pages` call.
4. `serve.ts`: launch `packages/core/src/mcp/server.ts` (stdio) with `GRAPHBRAIN_TENANT_ID` + `GRAPHBRAIN_API_KEY` from the local config. This is the local-agent integration path.
5. `connect.ts`: print the MCP connection config (URL or stdio command) for pasting into an agent's config (Claude Desktop `mcpServers` JSON, etc.).
6. `search.ts`/`query.ts`/`get.ts`/`put.ts`/`capture.ts`: parse args, call `RemoteClient` with the corresponding operation, print results (JSON or pretty-printed).
7. Tests: mock the HTTP client. `search.test.ts` — assert correct request shape + result parsing. `put.test.ts` — read a fixture file, assert it's sent. `capture.test.ts` — assert text arg is sent.

**Verification:**
- `bun run typecheck` clean.
- `bun test packages/core/test/commands/` green.
- (Manual, requires running API + a provisioned tenant) `graphbrain init` → `graphbrain search "test"` returns results; `graphbrain capture "hello world"` creates a page; `graphbrain serve` starts the stdio MCP server and an MCP `tools/list` returns the tools.
- Add a `bin` entry to `packages/core/package.json` (`"graphbrain": "./src/cli.ts"`) so `bun link` makes it executable.

**Handoff notes:** The CLI is the agent-facing local tool. `graphbrain serve` is how local agents (Claude Desktop, Cursor) connect. `graphbrain connect` prints the config they paste. The marketing docs (Stage 14) reference these commands — verify the names match.

---

## Stage 16 — End-to-End Integration Test + Smoke Validation

**Goal:** A single end-to-end test that exercises the full Phase 1 flow — signup → provision → put page → search → think — plus a documented manual smoke checklist. This is the gate that declares the prototype "working."

**Depends on:** Stage 12, Stage 13, Stage 14, Stage 15.

**References:**
- `PLAN.md` → "Phase 1 Deliverable" (line ~890)
- `PLAN.md` → "Feature Parity Checklist" → core features (lines ~779–808, Phase 1 subset)

**Files to create:**
- `test/e2e/phase1.test.ts` — the end-to-end integration test
- `test/e2e/helpers.ts` — test harness (provision test tenant, get API key, etc.)
- `SMOKE.md` — manual smoke checklist for the operator

**Implementation steps:**
1. `helpers.ts`: `provisionTestTenant()` — calls Clerk Backend API to create a test org (or uses a pre-provisioned test org), waits for the webhook to provision HelixDB, returns `{ tenantId, apiKey }`. `cleanupTestTenant()` — deletes the org + HelixDB instance. These require real Clerk + Coolify + Polygres running.
2. `phase1.test.ts`: the full flow:
   a. Provision test tenant.
   b. Get an API key.
   c. `PUT` a page with wikilinks via the API (`POST /api/dashboard/pages` with a JWT, or `POST /mcp` with the API key calling `put_page`).
   d. `SEARCH` for the page — assert it's the top result.
   e. `QUERY` (synthesize) — assert the answer cites the page.
   f. Verify the page appears in the dashboard stats.
   g. Cleanup.
3. The test is gated behind an env flag `RUN_E2E=1` (it requires real external services and is slow). Unit tests in earlier stages don't need it.
4. `SMOKE.md`: a manual checklist for the operator to validate the deployed prototype:
   - [ ] Marketing page loads at `belweave.ai/graphbrain`.
   - [ ] Sign up via Clerk → org created → brain provisions (dashboard shows "ready" within ~2 min).
   - [ ] Dashboard shows stats (0 pages initially).
   - [ ] Generate an API key.
   - [ ] `graphbrain init` with the API key succeeds.
   - [ ] `graphbrain capture "Acme Corp is a startup founded by Jane Doe"` creates a page.
   - [ ] `graphbrain search "Acme"` returns the page.
   - [ ] `graphbrain query "Who founded Acme?"` returns "Jane Doe" with a citation.
   - [ ] MCP: configure Claude Desktop with `graphbrain serve` → tools list appears → `search` tool works.
   - [ ] Per-tenant isolation: create a second tenant, confirm it cannot see tenant 1's pages.
5. Run the E2E test against the full Docker Compose stack + real Clerk/Coolify/OpenRouter.

**Verification:**
- `RUN_E2E=1 bun test test/e2e/phase1.test.ts` green (requires all external services + Docker Compose up).
- `bun run typecheck` + `bun run build` clean across all workspaces.
- The `SMOKE.md` checklist passes when followed manually against a deployed environment.

**Handoff notes:** This stage is the prototype gate. When green, the Phase 1 deliverable from PLAN.md (line ~890) is met: "Users can sign up via Clerk, get a provisioned HelixDB brain, connect agents via MCP (HTTP or stdio), store pages, and search with full hybrid retrieval. Dashboard for management. Marketing page live. Per-tenant isolation. OpenRouter for embeddings + reranking." Subsequent phases (2, 3, 4) build on this foundation per `PLAN.md`.

---

## Stage Dependency Graph

```
0 scaffold
└─ 1 types + config
   ├─ 2 Polygres control plane
   │  └─ 3 Coolify
   │     ├─ 4 Clerk client + webhooks
   │     │  └─ 5 auth middleware ─────────────────────┐
   │     └─ 6 HelixDB schema                           │
   │        └─ 7 engine + router                       │
   │           ├─ 9 retrieval ──┐                      │
   │           └────────────────┴─ 10 operations       │
   │                              └─ 11 MCP ───┬─ 12 API ──┐
   │                                           └─ 15 CLI   │
   └─ 8 AI gateway ───────────────┬─ 9 retrieval           │
                                  └─ 10 operations         │
                                                          │
0 scaffold ── 14 marketing                                 │
                                                           │
12 API ──────────────────────────────────── 13 dashboard ──┤
                                                           ▼
                                              16 E2E (needs 12,13,14,15)
```

**Critical path (longest chain):** 0 → 1 → 2 → 3 → 6 → 7 → 9 → 10 → 11 → 12 → 16.
**Parallelizable after their deps land:**
- Stage 8 (after 1) — parallel with 2–7
- Stage 14 (after 0) — parallel with everything
- Stage 4 (after 3) — parallel with 6
- Stage 5 (after 4) — parallel with 6–10
- Stage 15 (after 11) — parallel with 12
- Stage 13 (after 12) — parallel with 15

---

## Phase 1 Deliverable Checklist

When Stage 16 is green, all of these are true:

- [x] Monorepo scaffolded (Bun workspaces, Docker Compose for local dev)
- [x] Clerk auth (JWT + API key) with org → tenant mapping
- [x] Per-tenant isolated HelixDB instances provisioned via Coolify
- [x] Clerk webhooks auto-provision/deprovision on org lifecycle
- [x] HelixDB schema deployed (Page, Chunk, Source + edges + indexes)
- [x] BrainEngine + HelixEngine + TenantRouter
- [x] OpenRouter AI gateway (embeddings, chat, rerank)
- [x] Full hybrid retrieval pipeline (vector + BM25 + graph + RRF + boosts + rerank + token budget + dedup + cache)
- [x] Core operations: search, query, get_page, list_pages, get_links, get_backlinks, put_page, add_link, capture
- [x] Auto-link extraction (zero-LLM)
- [x] MCP stdio + HTTP server
- [x] Dashboard REST API (stats, search, pages, sources, settings, api-keys)
- [x] Health + readiness endpoints
- [x] Next.js dashboard (onboarding, overview, search, pages, api-keys, settings)
- [x] Next.js marketing page (landing, features, pricing, docs)
- [x] CLI (init, serve, search, query, get, put, capture, connect)
- [x] Semantic query cache (Polygres-backed, knobs_hash-aware)
- [x] End-to-end integration test passing
- [x] Per-tenant isolation verified (tenant B cannot read tenant A's data)
