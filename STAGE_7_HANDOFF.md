# Stage 7 Handoff — BrainEngine Interface + HelixEngine + Tenant Router

## What Stage 6 delivered

Stage 6 implemented the HelixDB schema, indexes, deployment, and dynamic query
modules. The complete contract Stage 7's `HelixEngine` will delegate to:

### Files created
- `packages/core/src/helix/schema.ts` — node/edge labels, property maps,
  snake_case ↔ camelCase field maps, design-decision docs.
- `packages/core/src/helix/indexes.ts` — 8 Phase 1 index specs.
- `packages/core/src/helix/deploy.ts` — `deploySchema(client)` (idempotent).
- `packages/core/src/helix/queries/_shared.ts` — response parsing + coercion
  helpers (`sendRequest`, `extractRows`, `extractOne`, `extractIds`,
  `extractEdges`, `coerceId`, `coerceDate`, `coerceNumber`, `coerceString`,
  `coerceBool`, `coerceObject`, `coerceVector`).
- `packages/core/src/helix/queries/page-crud.ts` — `addPage`, `getPageBySlug`,
  `updatePage`, `softDeletePage`, `listPages`.
- `packages/core/src/helix/queries/chunk-crud.ts` — `addChunk`,
  `getChunksByPage`, `updateChunkEmbedding`.
- `packages/core/src/helix/queries/source-crud.ts` — `addSource`, `getSource`,
  `listSources`.
- `packages/core/src/helix/queries/links.ts` — `addEdge`, `getOutEdges`,
  `getInEdges`, `traverseEdges`.
- `packages/core/src/helix/queries/search-vector.ts` — `vectorSearchChunks`.
- `packages/core/src/helix/queries/search-text.ts` — `textSearchPages`,
  `textSearchChunks`.
- `packages/core/src/helix/queries/graph-traverse.ts` — `traverseFrom`.
- `packages/core/src/helix/queries/index.ts` — barrel re-exporting all query
  functions + their param/result types.
- `packages/core/test/helix/schema.test.ts` — 23 pure unit tests.
- `packages/core/test/helix/queries.test.ts` — 30 live HelixDB integration
  tests (reachability-skip pattern).

### Wiring done
- `deploySchema(client)` is called inside `provisionHelixForTenant` (in
  `packages/core/src/control/helix-provision.ts`) after the `/health` poll
  passes. On failure it marks the tenant `error` and throws.
- All helix symbols are re-exported from `packages/core/src/index.ts`.
- `@helix-db/helix-db@2.0.5` added to `packages/core/package.json`.

### Verification status
- `bun run typecheck` — clean (all 4 packages).
- `bun test apps packages` — 239 pass, 0 fail.
- Live HelixDB integration tests pass against `docker compose up -d helixdb`
  (localhost:8080, dev mode, auth disabled).

## Stage 7 implementation guide

### What to build
Per `IMPLEMENTATION.md` Stage 7:
1. `packages/core/src/engine.ts` — `BrainEngine` interface + `SearchOpts` +
   `clampSearchLimit`.
2. `packages/core/src/helix-engine.ts` — `HelixEngine implements BrainEngine`,
   delegating to the Stage 6 query modules.
3. `packages/core/src/tenant.ts` — `TenantRouter` with LRU cache + health check.
4. `packages/core/test/engine.test.ts`, `helix-engine.test.ts`,
   `tenant-router.test.ts`.

### Key mappings (Stage 6 query → Stage 7 BrainEngine method)

| BrainEngine method | Stage 6 query function | Notes |
|---|---|---|
| `getPage(slug)` | `getPageBySlug(client, slug)` | Throws on not-found; engine should catch → return null OR rethrow as OperationError (Stage 10 decision) |
| `listPages(opts)` | `listPages(client, opts)` | Map SearchOpts → ListPagesParams |
| `putPage(page)` | `addPage` (new) or `updatePage` (existing) | Check existence first via getPageBySlug, then branch. Or use upsert pattern. |
| `softDeletePage(slug)` | `softDeletePage(client, slug)` | |
| `addChunk(chunk)` | `addChunk(client, params)` | |
| `getChunksByPage(slug)` | Resolve slug → pageId via `getPageBySlug`, then `getChunksByPage(client, pageId)` | Two-step: the engine layer resolves slug → id |
| `updateChunkEmbedding(chunkId, embedding)` | `updateChunkEmbedding(client, params)` | |
| `addEdge(link)` | `addEdge(client, params)` | |
| `getOutEdges(slug)` | `getOutEdges(client, slug)` | |
| `getInEdges(slug)` | `getInEdges(client, slug)` | |
| `vectorSearchChunks(embedding, limit)` | `vectorSearchChunks(client, params)` | |
| `textSearchPages(query, limit)` | `textSearchPages(client, params)` | |
| `textSearchChunks(query, limit)` | `textSearchChunks(client, params)` | |
| `traverse(slug, opts)` | `traverseFrom(client, slug, opts)` | |
| `addSource(source)` | `addSource(client, params)` | |
| `getSource(id)` | `getSource(client, name)` | Note: Stage 6 uses `name` not `id` — engine may need to resolve id→name or add a getById query |
| `listSources()` | `listSources(client, {})` | |
| `close()` | N/A | Drop the underlying `Client` (the SDK Client has no explicit close — just dereference) |

### Important design notes from Stage 6

1. **Numeric vs string ids**: The dev HelixDB image returns numeric `$id`
   (0, 1, 2, …). Stage 6 coerces all ids to `string` on read
   (`coerceId` in `_shared.ts`). The `BrainEngine` interface should use
   `string` ids throughout. `updateChunkEmbedding` uses `NodeRef.id(Number(chunkId))`
   internally — this works for dev but **Stage 7 must document that production
   ULIDs would need a string-id lookup path** (see chunk-crud.ts comment).

2. **Not-found behavior**: Stage 6 query functions throw `Error("...: no Page
   found for slug=...")` on not-found. The `BrainEngine` interface should
   decide: return `null` (GBrain engine pattern) or rethrow. Recommend
   returning `null` for `getPage`/`getSource` (read-side), keeping throws for
   write-side operations that can't proceed without the entity
   (`updatePage`, `softDeletePage`, `addEdge`).

3. **`putPage` (upsert)**: Stage 6 has separate `addPage` and `updatePage`.
   `putPage` should check existence via `getPageBySlug`, then branch. If the
   page exists, call `updatePage` with all fields as the patch. If not, call
   `addPage`. This is a 2-round-trip but keeps the query modules simple.

4. **`getChunksByPage(slug)`**: Stage 6's `getChunksByPage` takes a `pageId`
   (string), not a slug. The engine method takes a slug → must resolve
   slug→pageId first via `getPageBySlug`, then call `getChunksByPage`. This
   is the engine layer's job, not the query module's.

5. **`getSource(id)`**: Stage 6's `getSource` takes `name`, not `id`. If
   `BrainEngine.getSource(id)` is in the interface, either:
   - Add a `getSourceById` query module (lookup by `$id`), or
   - Change the interface to `getSource(name)` to match Stage 6.
   Recommend the latter (match the reference engine's `getSource(id)` but
   implement via a getById traversal — `g().n(NodeRef.id(Number(id))).hasLabel("Source")`).

6. **SearchOpts + clampSearchLimit**: Port from
   `_reference/gbrain/src/core/engine.ts`. The `clampSearchLimit` helper
   caps the limit based on the search mode (conservative=10, balanced=25,
   tokenmax=50 per `CLAUDE.md` Search Mode table). Stage 7 defines
   `SearchOpts { limit?, mode?, typeFilter?, includeDeleted? }` and maps it
   to the Stage 6 query params.

7. **TenantRouter health check**: The cached `HelixEngine` should be
   health-checked before reuse. The simplest path: `fetch(\`${url}/health\`)`
   with a 2s timeout. If non-200, evict + reconstruct. The SDK `Client`
   doesn't expose a health method — use raw `fetch`.

8. **LRU cache**: Use a simple `Map<string, { engine, expiresAt }>` with
   max 100 entries + 5min TTL. No external LRU dependency needed for Phase 1.
   `invalidate(tenantId)` deletes the entry (called when a tenant's instance
   is reprovisioned).

### Test patterns to follow
- `packages/core/test/helix/queries.test.ts` — the reachability-skip pattern
  (`helixReachable()` + `itP = reachable ? it : it.skip`). Reuse for
  `helix-engine.test.ts`.
- `packages/core/test/control/coolify.test.ts` — the fetch-stub pattern for
  mocking HTTP. Reuse for `tenant-router.test.ts` (mock `/health` responses
  to test eviction).
- `packages/core/test/engine.test.ts` — type-level conformance test:
  `const _e: BrainEngine = new HelixEngine({...});` (compile-time check).

### Dependencies
- No new dependencies needed. `@helix-db/helix-db` is already in
  `packages/core/package.json`. The `Client` class is imported from there.
- `TenantRouter` needs the encryption helper from
  `packages/core/src/control/encryption.ts` (Stage 2) to decrypt
  `tenant.helix_api_key_encrypted`.

### Verification
- `bun run typecheck` clean.
- `docker compose up -d helixdb` running.
- `bun test packages/core/test/engine.test.ts packages/core/test/helix-engine.test.ts packages/core/test/tenant-router.test.ts` green.
- `bun test apps packages` — all tests still green (no regressions).
