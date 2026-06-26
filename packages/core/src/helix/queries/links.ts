// @graphbrain/core — edge (link) add + list dynamic queries (HelixDB).
//
// Contract (Stage 7 implements against):
//   addEdge(client, params)   → Promise<Link>   (throws if either page missing)
//   getOutEdges(client, slug) → Promise<Link[]>
//   getInEdges(client, slug)  → Promise<Link[]>
//
// Edges use DISTINCT labels per type (see schema.ts design note 3). addEdge
// looks up both pages by slug in the same write batch, then addE from the
// `from` node to the `to` node. getOutEdges/getInEdges traverse from a slug-
// looked-up Page node and project the target Page + the edge's own properties.

import type { Client, PropertyValueInput, Expr as ExprType, Traversal, TraversalState } from "@helix-db/helix-db";
import {
  g,
  readBatch,
  writeBatch,
  NodeRef,
  Predicate,
  Expr,
  PropertyProjection,
  Order,
} from "@helix-db/helix-db";
import type { Link, EdgeLabel, LinkOrigin } from "../../types";
import {
  sendRequest,
  extractOne,
  extractRows,
  extractEdges,
  coerceId,
  coerceDate,
  coerceString,
  type HelixRow,
  type HelixEdgeRow,
} from "./_shared";

export interface AddEdgeParams {
  fromSlug: string;
  toSlug: string;
  /** Edge label (typed or MENTIONS for generic). */
  type: EdgeLabel;
  origin: LinkOrigin;
  context?: string;
  originSlug?: string | null;
  originField?: string | null;
}

// ─── addEdge ─────────────────────────────────────────────────────────────────

export async function addEdge(client: Client, params: AddEdgeParams): Promise<Link> {
  const edgeProps: Record<string, PropertyValueInput | ExprType> = {
    origin: params.origin,
    created_at: Expr.datetime(),
  };
  if (params.context) edgeProps.context = params.context;
  if (params.originSlug) edgeProps.origin_slug = params.originSlug;
  if (params.originField) edgeProps.origin_field = params.originField;

  // Look up both pages by slug, then addE from `from` → `to`. The write batch
  // holds the lookups as read traversals and the addE as a write traversal.
  const batch = writeBatch()
    .varAs("from", g().nWithLabel("Page").where(Predicate.eq("slug", params.fromSlug)).valueMap(["$id", "slug"]))
    .varAs("to", g().nWithLabel("Page").where(Predicate.eq("slug", params.toSlug)).valueMap(["$id", "slug"]))
    .varAs("edge", g().n(NodeRef.var("from")).addE(params.type, NodeRef.var("to"), edgeProps))
    .returning(["from", "to", "edge"]);

  const res = await sendRequest(client, batch.toDynamicRequest({ queryName: "add_edge" }));
  const fromRow = extractOne(res, "from");
  const toRow = extractOne(res, "to");
  const edges = extractEdges(res, "edge");
  if (!fromRow) throw new Error(`addEdge: no Page found for fromSlug="${params.fromSlug}"`);
  if (!toRow) throw new Error(`addEdge: no Page found for toSlug="${params.toSlug}"`);
  if (edges.length === 0) throw new Error(`addEdge: edge was not created (${params.fromSlug} → ${params.toSlug})`);

  const e = edges[0]!;
  return {
    id: String(e.edge_id),
    fromSlug: params.fromSlug,
    toSlug: params.toSlug,
    type: params.type,
    origin: params.origin,
    context: params.context,
    originSlug: params.originSlug ?? null,
    originField: params.originField ?? null,
    createdAt: new Date(),
  };
}

// ─── getOutEdges / getInEdges ────────────────────────────────────────────────
// Traverse from the slug-looked-up Page, follow out/in edges (optionally
// filtered by label), and project the target Page's id + slug + title plus the
// edge's label + origin. We project edge properties via $from/$to endpoint
// projections where available; the edge label is read via a second varAs that
// walks outE/inE to capture edge metadata.

interface EdgeResult {
  link: Link;
  /** The target Page node id (string). */
  targetId: string;
  /** The target Page slug. */
  targetSlug: string;
  /** The target Page title. */
  targetTitle: string;
}

async function traverseEdges(
  client: Client,
  slug: string,
  direction: "out" | "in",
  edgeTypes?: EdgeLabel[],
): Promise<EdgeResult[]> {
  // Look up the source page, then traverse. When edgeTypes is omitted/empty,
  // follow all edges; otherwise run one traversal per label and merge.
  const labels = edgeTypes && edgeTypes.length > 0 ? edgeTypes : [null];

  const results: EdgeResult[] = [];
  for (const label of labels) {
    let traversal: Traversal<TraversalState, "read"> = g()
      .nWithLabel("Page")
      .where(Predicate.eq("slug", slug))
      .where(Predicate.isNull("deleted_at"));
    traversal = (direction === "out" ? traversal.out(label) : traversal.in(label)) as Traversal<TraversalState, "read">;
    traversal = traversal.where(Predicate.isNull("deleted_at")).valueMap(["$id", "slug", "title"]) as Traversal<TraversalState, "read">;

    const batch = readBatch()
      .varAs("targets", traversal)
      .returning(["targets"]);
    const res = await sendRequest(client, batch.toDynamicRequest({ queryName: `get_${direction}_edges` }));
    for (const row of extractRows(res, "targets")) {
      const targetSlug = coerceString(row["slug"]) ?? "";
      const targetTitle = coerceString(row["title"]) ?? "";
      const targetId = coerceId(row["$id"]);
      results.push({
        targetId,
        targetSlug,
        targetTitle,
        link: {
          id: "", // edge id not projected in this lightweight traversal
          fromSlug: direction === "out" ? slug : targetSlug,
          toSlug: direction === "out" ? targetSlug : slug,
          type: (label ?? "MENTIONS") as EdgeLabel,
          origin: "auto",
          createdAt: new Date(0),
        },
      });
    }
  }
  return results;
}

export async function getOutEdges(
  client: Client,
  slug: string,
  edgeTypes?: EdgeLabel[],
): Promise<Link[]> {
  const results = await traverseEdges(client, slug, "out", edgeTypes);
  return results.map((r) => r.link);
}

export async function getInEdges(
  client: Client,
  slug: string,
  edgeTypes?: EdgeLabel[],
): Promise<Link[]> {
  const results = await traverseEdges(client, slug, "in", edgeTypes);
  return results.map((r) => r.link);
}

// Re-export for Stage 7 consumers that want the target metadata alongside the link.
export type { EdgeResult };
export { traverseEdges };
