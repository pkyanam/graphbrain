// @graphbrain/core — HelixDB schema deployment.
//
// `deploySchema(client)` idempotently creates the Phase 1 indexes on a
// freshly provisioned (or existing) HelixDB instance. Node/edge labels are
// implicit in HelixDB (materialize on first write — see schema.ts GAP note),
// so deployment is index-only. Each index is created with `if_not_exists: true`
// so re-running deploySchema is a safe no-op (verified end-to-end against the
// local Docker Compose HelixDB: second run returns HTTP 200, no error).
//
// Wiring: provisionHelixForTenant (Stage 3) calls deploySchema(client) after
// the /health poll passes, before returning { url, apiKey, appId }. This
// guarantees every newly provisioned tenant instance has the Phase 1 indexes
// before the first query lands. The Stage 3 file edit is intentional and
// required by the Stage 6 handoff.

import type { Client } from "@helix-db/helix-db";
import { g, writeBatch } from "@helix-db/helix-db";
import { DEPLOYED_INDEXES } from "./indexes";

/**
 * Deploy the Phase 1 schema (indexes) onto a HelixDB instance.
 *
 * Idempotent: safe to call on an instance that already has some/all indexes.
 * Sends one write batch with a `createIndexIfNotExists` step per index spec.
 *
 * @throws if any index creation request fails (non-200 from HelixDB). The
 *   HelixDB client wraps non-200 responses in a `HelixError` (kind: "Remote").
 */
export async function deploySchema(client: Client): Promise<void> {
  // Build a single write batch with one createIndexIfNotExists step per index.
  // Each step is a separate named query in the batch so a per-index error
  // surfaces clearly in the server response.
  let batch = writeBatch();
  for (let i = 0; i < DEPLOYED_INDEXES.length; i++) {
    const spec = DEPLOYED_INDEXES[i]!;
    // `g()` returns an empty read traversal; createIndexIfNotExists flips it
    // to a terminal write traversal. Each varAs adds a named query.
    batch = batch.varAs(`idx_${i}`, g().createIndexIfNotExists(spec));
  }
  const request = batch.toDynamicRequest({ queryName: "deploy_schema" });

  // Send via the client. The SDK throws HelixError on non-200; we let it
  // propagate so the caller (provisioning flow) can mark the tenant errored.
  await client.query().dynamic(request).send();
}
