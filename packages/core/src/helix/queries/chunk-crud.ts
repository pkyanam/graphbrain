// @graphbrain/core — Chunk CRUD dynamic queries (HelixDB).
//
// Contract (Stage 7 implements against):
//   addChunk(client, params)             → Promise<Chunk>
//   getChunksByPage(client, pageId)      → Promise<Chunk[]>
//   updateChunkEmbedding(client, params) → Promise<Chunk>  (throws if not found)
//
// page_id is stored as a STRING (coerced node id) on the Chunk node — see
// schema.ts design note 4. getChunksByPage filters by the page_id property
// (no numeric id parsing needed).

import type { Client, PropertyValueInput, Expr as ExprType } from "@helix-db/helix-db";
import {
  g,
  readBatch,
  writeBatch,
  NodeRef,
  Predicate,
  PropertyValue,
  Expr,
  Order,
} from "@helix-db/helix-db";
import type {
  Chunk,
  ChunkModality,
  ChunkSource,
} from "../../types";
import { CHUNK_FIELD_MAP, propertyNames } from "../schema";
import {
  sendRequest,
  extractOne,
  extractRows,
  coerceId,
  coerceDate,
  coerceNumber,
  coerceString,
  coerceVector,
  type HelixRow,
} from "./_shared";

export interface AddChunkParams {
  /** Page node id (string; from Page.id). */
  pageId: string;
  chunkIndex: number;
  content: string;
  chunkSource?: ChunkSource;
  modality?: ChunkModality;
  /** Primary text embedding (number[]). */
  embedding?: number[] | null;
  /** Optional Voyage text embedding. */
  embeddingVoyage?: number[] | null;
  /** Optional multimodal image embedding. */
  embeddingImage?: number[] | null;
  model?: string | null;
  tokenCount?: number | null;
  language?: string | null;
  symbolName?: string | null;
  symbolType?: string | null;
  startLine?: number | null;
  endLine?: number | null;
}

export interface UpdateChunkEmbeddingParams {
  /** Chunk node id (string; from Chunk.id). */
  chunkId: string;
  embedding: number[];
  model?: string | null;
}

const CHUNK_PROPS = ["$id", ...propertyNames("Chunk")];

function rowToChunk(row: HelixRow): Chunk {
  const get = (camel: keyof Chunk): unknown => {
    const snake = CHUNK_FIELD_MAP[camel];
    return row[snake];
  };
  return {
    id: coerceId(get("id")),
    pageId: coerceString(get("pageId")) ?? "",
    chunkIndex: coerceNumber(get("chunkIndex")) ?? 0,
    content: String(get("content") ?? ""),
    chunkSource: (coerceString(get("chunkSource")) as ChunkSource) ?? "compiled_truth",
    modality: (coerceString(get("modality")) as ChunkModality) ?? "text",
    embedding: coerceVector(get("embedding")),
    embeddingVoyage: coerceVector(get("embeddingVoyage")),
    embeddingImage: coerceVector(get("embeddingImage")),
    model: coerceString(get("model")),
    tokenCount: coerceNumber(get("tokenCount")),
    language: coerceString(get("language")),
    symbolName: coerceString(get("symbolName")),
    symbolType: coerceString(get("symbolType")),
    startLine: coerceNumber(get("startLine")),
    endLine: coerceNumber(get("endLine")),
    embeddedAt: coerceDate(get("embeddedAt")),
    createdAt: coerceDate(get("createdAt")) ?? new Date(0),
  };
}

// ─── addChunk ────────────────────────────────────────────────────────────────

export async function addChunk(client: Client, params: AddChunkParams): Promise<Chunk> {
  const props: Record<string, PropertyValueInput | ExprType> = {
    page_id: params.pageId,
    chunk_index: params.chunkIndex,
    content: params.content,
    chunk_source: params.chunkSource ?? "compiled_truth",
    modality: params.modality ?? "text",
    created_at: Expr.datetime(),
  };
  if (params.embedding) props.embedding = PropertyValue.f32Array(params.embedding);
  if (params.embeddingVoyage) props.embedding_voyage = PropertyValue.f32Array(params.embeddingVoyage);
  if (params.embeddingImage) props.embedding_image = PropertyValue.f32Array(params.embeddingImage);
  if (params.model) props.model = params.model;
  if (params.tokenCount !== undefined && params.tokenCount !== null) props.token_count = params.tokenCount;
  if (params.language) props.language = params.language;
  if (params.symbolName) props.symbol_name = params.symbolName;
  if (params.symbolType) props.symbol_type = params.symbolType;
  if (params.startLine !== undefined && params.startLine !== null) props.start_line = params.startLine;
  if (params.endLine !== undefined && params.endLine !== null) props.end_line = params.endLine;

  const batch = writeBatch()
    .varAs("created", g().addN("Chunk", props))
    .varAs("chunk", g().n(NodeRef.var("created")).valueMap(CHUNK_PROPS))
    .returning(["chunk"]);
  const res = await sendRequest(client, batch.toDynamicRequest({ queryName: "add_chunk" }));
  const row = extractOne(res, "chunk");
  if (!row) throw new Error(`addChunk: server returned no row for pageId="${params.pageId}"`);
  return rowToChunk(row);
}

// ─── getChunksByPage ─────────────────────────────────────────────────────────

export async function getChunksByPage(client: Client, pageId: string): Promise<Chunk[]> {
  const batch = readBatch()
    .varAs(
      "chunks",
      g()
        .nWithLabel("Chunk")
        .where(Predicate.eq("page_id", pageId))
        .orderBy("chunk_index", Order.Asc)
        .valueMap(CHUNK_PROPS),
    )
    .returning(["chunks"]);
  const res = await sendRequest(client, batch.toDynamicRequest({ queryName: "get_chunks_by_page" }));
  return extractRows(res, "chunks").map(rowToChunk);
}

// ─── updateChunkEmbedding ────────────────────────────────────────────────────

export async function updateChunkEmbedding(
  client: Client,
  params: UpdateChunkEmbeddingParams,
): Promise<Chunk> {
  // Look up by $id (coerce string chunkId back to number for NodeRef — the dev
  // image uses numeric ids; production ULIDs would need a string-id lookup path,
  // documented as a Stage 7 concern). For now: filter by $id via a where on the
  // numeric id. We use NodeRef.id(Number(chunkId)) since $id is numeric in dev.
  const numericId = Number(params.chunkId);
  let traversal = g()
    .n(NodeRef.id(numericId))
    .hasLabel("Chunk")
    .setProperty("embedding", PropertyValue.f32Array(params.embedding))
    .setProperty("embedded_at", Expr.datetime());
  if (params.model) traversal = traversal.setProperty("model", params.model);

  const batch = writeBatch()
    .varAs("chunk", traversal.valueMap(CHUNK_PROPS))
    .returning(["chunk"]);
  const res = await sendRequest(client, batch.toDynamicRequest({ queryName: "update_chunk_embedding" }));
  const row = extractOne(res, "chunk");
  if (!row) throw new Error(`updateChunkEmbedding: no Chunk found for id="${params.chunkId}"`);
  return rowToChunk(row);
}
