// @graphbrain/core — vector search dynamic query (HelixDB).
//
// Contract (Stage 7 implements against):
//   vectorSearchChunks(client, params) → Promise<VectorSearchHit[]>
//
// Runs a `vectorSearchNodes` on Chunk.embedding (the nodeVector index from
// indexes.ts) and projects $id + $distance + content + page_id. Uses
// defineParams for the embedding + limit (the handoff calls out defineParams
// for the search modules). $distance is the ANN distance (0 = identical);
// the hit's `score` is `1 - distance` (cosine similarity space).

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

export interface VectorSearchChunksParams {
  /** Query embedding (must match the Chunk.embedding dimensionality). */
  embedding: number[];
  /** Number of nearest neighbors to return. Default 10. */
  limit?: number;
}

export interface VectorSearchHit {
  /** Chunk node id (string). */
  chunkId: string;
  /** Page node id the chunk belongs to (string). */
  pageId: string;
  /** Chunk content snippet. */
  content: string;
  /** ANN distance from the query vector (0 = identical). */
  distance: number;
  /** Cosine-similarity-style score: 1 - distance. */
  score: number;
}

const vecParams = defineParams({
  embedding: param.array(param.f32()),
  limit: param.i64(),
});

export async function vectorSearchChunks(
  client: Client,
  params: VectorSearchChunksParams,
): Promise<VectorSearchHit[]> {
  const limit = params.limit ?? 10;
  const batch = readBatch()
    .varAs(
      "hits",
      g()
        .vectorSearchNodesWith(
          "Chunk",
          "embedding",
          PropertyInput.param("embedding"),
          vecParams.limit,
        )
        .project([
          PropertyProjection.renamed("$id", "chunk_id"),
          PropertyProjection.renamed("$distance", "distance"),
          PropertyProjection.renamed("content", "content"),
          PropertyProjection.renamed("page_id", "page_id"),
        ]),
    )
    .returning(["hits"]);

  const request = batch.toDynamicRequest(vecParams, {
    embedding: params.embedding,
    limit,
  }, { queryName: "vector_search_chunks" });
  const res = await sendRequest(client, request);

  return extractRows(res, "hits").map((row: HelixRow) => {
    const distance = coerceNumber(row["distance"]) ?? 0;
    return {
      chunkId: coerceId(row["chunk_id"]),
      pageId: coerceString(row["page_id"]) ?? "",
      content: coerceString(row["content"]) ?? "",
      distance,
      score: 1 - distance,
    };
  });
}
