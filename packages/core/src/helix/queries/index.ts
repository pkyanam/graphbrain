// @graphbrain/core — barrel for the HelixDB dynamic query modules.
//
// Re-exports the query functions + their param/result types so Stage 7's
// HelixEngine can import them from a single entry point:
//   import { addPage, getPageBySlug, vectorSearchChunks, ... } from "../helix/queries";

// Page CRUD
export {
  addPage,
  getPageBySlug,
  updatePage,
  softDeletePage,
  listPages,
} from "./page-crud";
export type {
  AddPageParams,
  UpdatePagePatch,
  UpdatePageParams,
  ListPagesParams,
} from "./page-crud";

// Chunk CRUD
export {
  addChunk,
  getChunksByPage,
  updateChunkEmbedding,
} from "./chunk-crud";
export type {
  AddChunkParams,
  UpdateChunkEmbeddingParams,
} from "./chunk-crud";

// Source CRUD
export {
  addSource,
  getSource,
  listSources,
} from "./source-crud";
export type {
  AddSourceParams,
  ListSourcesParams,
} from "./source-crud";

// Links (edges)
export {
  addEdge,
  getOutEdges,
  getInEdges,
  traverseEdges,
} from "./links";
export type {
  AddEdgeParams,
  EdgeResult,
} from "./links";

// Vector search
export {
  vectorSearchChunks,
} from "./search-vector";
export type {
  VectorSearchChunksParams,
  VectorSearchHit,
} from "./search-vector";

// Text search
export {
  textSearchPages,
  textSearchChunks,
} from "./search-text";
export type {
  TextSearchParams,
  TextSearchHit,
} from "./search-text";

// Graph traversal
export {
  traverseFrom,
} from "./graph-traverse";
export type {
  TraverseDirection,
  TraverseOptions,
  TraversalNode,
} from "./graph-traverse";
