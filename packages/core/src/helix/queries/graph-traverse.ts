// @graphbrain/core — graph traversal dynamic query (HelixDB).
//
// Contract (Stage 7 implements against):
//   traverseFrom(client, slug, opts) → Promise<TraversalNode[]>
//
// Walks the typed-edge graph from a seed Page (looked up by slug). Supports
// direction (out/in/both), edge-label filtering, depth (via repeat), and a
// result limit. Returns the reachable Page nodes with their graph distance
// from the seed. Phase 1 depth is capped at 1–3 hops; deeper traversals use
// the DSL's `repeat` with a maxDepth guard.
//
// For depth=1 the hop is a direct out/in/both step. For depth>1 the hop is
// wrapped in `repeat(RepeatConfig.new(sub().out(label)).times(depth))` which
// emits all intermediate nodes (emitAll) and projects $distance.

import type { Client, TraversalState } from "@helix-db/helix-db";
import {
  g,
  readBatch,
  Predicate,
  sub,
  RepeatConfig,
  PropertyProjection,
  type Traversal,
} from "@helix-db/helix-db";
import type { EdgeLabel } from "../../types";
import {
  sendRequest,
  extractRows,
  coerceId,
  coerceString,
  coerceNumber,
  type HelixRow,
} from "./_shared";

export type TraverseDirection = "out" | "in" | "both";

export interface TraverseOptions {
  direction?: TraverseDirection;
  /** Restrict to these edge labels. Empty/omitted = all edges. */
  edgeTypes?: EdgeLabel[];
  /** Hop depth (1 = direct neighbors, 2 = neighbors-of-neighbors). Default 1. */
  depth?: number;
  /** Max results. Default 50. */
  limit?: number;
}

export interface TraversalNode {
  /** Page node id (string). */
  id: string;
  slug: string;
  title: string;
  type: string;
  /** Hop distance from the seed (1 = direct neighbor). */
  distance: number;
}

export async function traverseFrom(
  client: Client,
  slug: string,
  opts: TraverseOptions = {},
): Promise<TraversalNode[]> {
  const direction = opts.direction ?? "out";
  const depth = Math.max(1, Math.min(opts.depth ?? 1, 3));
  const limit = opts.limit ?? 50;
  const labels = opts.edgeTypes && opts.edgeTypes.length > 0 ? opts.edgeTypes : [null];

  // Run one traversal per label (when filtering) and merge by id.
  const results = new Map<string, TraversalNode>();
  for (const label of labels) {
    let traversal: Traversal<TraversalState, "read"> = g()
      .nWithLabel("Page")
      .where(Predicate.eq("slug", slug))
      .where(Predicate.isNull("deleted_at"));

    if (depth > 1) {
      // Multi-hop: wrap the hop in a repeat that emits all intermediate nodes.
      const hop = buildSubHop(direction, label);
      traversal = traversal.repeat(
        RepeatConfig.new(hop).times(depth).emitAll().maxDepth(depth),
      ) as Traversal<TraversalState, "read">;
    } else {
      // Single-hop: apply the step directly.
      traversal = applyDirectHop(traversal, direction, label);
    }

    traversal = traversal
      .where(Predicate.isNull("deleted_at"))
      .project([
        PropertyProjection.renamed("$id", "id"),
        PropertyProjection.renamed("$distance", "distance"),
        PropertyProjection.renamed("slug", "slug"),
        PropertyProjection.renamed("title", "title"),
        PropertyProjection.renamed("type", "type"),
      ]) as Traversal<TraversalState, "read">;

    const batch = readBatch().varAs("nodes", traversal).returning(["nodes"]);
    const res = await sendRequest(client, batch.toDynamicRequest({ queryName: "traverse_from" }));
    for (const row of extractRows(res, "nodes")) {
      const id = coerceId(row["id"]);
      const rowSlug = coerceString(row["slug"]) ?? "";
      const distance = coerceNumber(row["distance"]) ?? 1;
      // Skip the seed node (distance 0 or slug matches the seed).
      if (distance === 0 || rowSlug === slug) continue;
      if (!results.has(id)) {
        results.set(id, {
          id,
          slug: rowSlug,
          title: coerceString(row["title"]) ?? "",
          type: coerceString(row["type"]) ?? "",
          distance,
        });
      }
    }
  }
  return [...results.values()].sort((a, b) => a.distance - b.distance).slice(0, limit);
}

/** Build a single-hop sub-traversal for repeat (depth>1). */
function buildSubHop(direction: TraverseDirection, label: EdgeLabel | null) {
  const s = sub();
  if (direction === "out") return s.out(label);
  if (direction === "in") return s.in(label);
  return s.both(label);
}

/** Apply a single hop directly to a traversal (depth=1 path). */
function applyDirectHop(
  traversal: Traversal<TraversalState, "read">,
  direction: TraverseDirection,
  label: EdgeLabel | null,
): Traversal<TraversalState, "read"> {
  if (direction === "out") return traversal.out(label) as Traversal<TraversalState, "read">;
  if (direction === "in") return traversal.in(label) as Traversal<TraversalState, "read">;
  return traversal.both(label) as Traversal<TraversalState, "read">;
}
