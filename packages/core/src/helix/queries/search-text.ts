// @graphbrain/core — BM25 text search dynamic queries (HelixDB).
//
// Contract (Stage 7 implements against):
//   textSearchPages(client, params)  → Promise<TextSearchHit[]>  (Page fields)
//   textSearchChunks(client, params) → Promise<TextSearchHit[]>  (Chunk.content)
//
// The DSL has no multi-field BM25 index (GAP-1 in schema.ts): nodeText is
// per-(label, property). textSearchPages therefore runs a separate
// textSearchNodes per Page field (title, compiled_truth) and merges + dedups
// client-side, summing scores for pages that hit multiple fields. Each field
// has its own nodeText index (indexes.ts). Uses defineParams for query + limit.

import type { Client } from "@helix-db/helix-db";
import {
  g,
  readBatch,
  defineParams,
  param,
  PropertyInput,
  PropertyProjection,
} from "@helix-db/helix-db";
import {
  sendRequest,
  extractRows,
  coerceId,
  coerceString,
  coerceNumber,
  type HelixRow,
} from "./_shared";

export interface TextSearchParams {
  query: string;
  limit?: number;
}

export interface TextSearchHit {
  /** Node id (string). */
  id: string;
  /** BM25 score from HelixDB (higher = more relevant). */
  score: number;
  /** Slug (Page hits) or null (Chunk hits). */
  slug: string | null;
  /** Title (Page hits) or null (Chunk hits). */
  title: string | null;
  /** Content (Chunk hits) or null (Page hits). */
  content: string | null;
  /** Which field index matched ("title" | "compiled_truth" | "content"). */
  field: string;
}

const textParams = defineParams({
  query: param.string(),
  limit: param.i64(),
});

function buildPageFieldSearch(
  field: "title" | "compiled_truth",
  limit: number,
) {
  const projections = [
    PropertyProjection.renamed("$id", "id"),
    PropertyProjection.renamed("$score", "score"),
    PropertyProjection.renamed("slug", "slug"),
    PropertyProjection.renamed("deleted_at", "deleted_at"),
  ];
  if (field === "title") {
    projections.push(PropertyProjection.renamed("title", "title"));
  } else {
    projections.push(PropertyProjection.renamed("compiled_truth", "compiled_truth"));
  }
  return g()
    .textSearchNodesWith("Page", field, PropertyInput.param("query"), textParams.limit)
    .project(projections);
}

// ─── textSearchPages ─────────────────────────────────────────────────────────

export async function textSearchPages(
  client: Client,
  params: TextSearchParams,
): Promise<TextSearchHit[]> {
  const limit = params.limit ?? 10;

  // Run title + compiled_truth searches, merge, dedup by id (sum scores).
  const byId = new Map<string, TextSearchHit>();
  for (const field of ["title", "compiled_truth"] as const) {
    const batch = readBatch()
      .varAs("hits", buildPageFieldSearch(field, limit))
      .returning(["hits"]);
    const request = batch.toDynamicRequest(textParams, { query: params.query, limit }, { queryName: `text_search_pages_${field}` });
    const res = await sendRequest(client, request);
    for (const row of extractRows(res, "hits")) {
      // Skip soft-deleted pages (GAP-3: no server-side filter in text search).
      if (row["deleted_at"] !== null && row["deleted_at"] !== undefined) continue;
      const id = coerceId(row["id"]);
      const score = coerceNumber(row["score"]) ?? 0;
      const existing = byId.get(id);
      if (existing) {
        existing.score += score;
      } else {
        byId.set(id, {
          id,
          score,
          slug: coerceString(row["slug"]),
          title: field === "title" ? coerceString(row["title"]) : coerceString(row["compiled_truth"]),
          content: null,
          field,
        });
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

// ─── textSearchChunks ────────────────────────────────────────────────────────

export async function textSearchChunks(
  client: Client,
  params: TextSearchParams,
): Promise<TextSearchHit[]> {
  const limit = params.limit ?? 10;
  const batch = readBatch()
    .varAs(
      "hits",
      g()
        .textSearchNodesWith("Chunk", "content", PropertyInput.param("query"), textParams.limit)
        .project([
          PropertyProjection.renamed("$id", "id"),
          PropertyProjection.renamed("$score", "score"),
          PropertyProjection.renamed("content", "content"),
          PropertyProjection.renamed("page_id", "page_id"),
        ]),
    )
    .returning(["hits"]);

  const request = batch.toDynamicRequest(textParams, { query: params.query, limit }, { queryName: "text_search_chunks" });
  const res = await sendRequest(client, request);

  return extractRows(res, "hits").map((row: HelixRow) => ({
    id: coerceId(row["id"]),
    score: coerceNumber(row["score"]) ?? 0,
    slug: null,
    title: null,
    content: coerceString(row["content"]),
    field: "content",
  }));
}
