// @graphbrain/core — shared library barrel export.
//
// Stage 1: core domain types, Zod schemas, and the env-driven config singleton.
// Subsequent stages add the control plane (Stage 2), Coolify integration
// (Stage 3), Clerk (Stage 4), HelixDB engines (Stage 6), and the retrieval
// pipeline (Stage 10). See IMPLEMENTATION.md for the build order.

// Types
export * from "./types";

// Schemas
export * from "./schemas";

// Config
export {
  ConfigSchema,
  loadConfig,
  getConfig,
  resetConfig,
  resolveSetting,
} from "./config";
export type { Config } from "./config";

// Control plane (Stage 2) — Polygres pool, migrations, tenant CRUD.
// All of these are lazy: importing @graphbrain/core does NOT open a DB
// connection or validate env. The pool is created on first `getPool()` call.
export {
  getPool,
  resetPool,
  hasPool,
  connectedUrl,
  isReachable,
  withTransaction,
} from "./control/db";
export type { Sql } from "./control/db";

export {
  runMigrations,
  dropGraphbrainSchema,
  MIGRATIONS,
} from "./control/migrations/index";
export type { Migration } from "./control/migrations/index";

export {
  createTenant,
  getTenantByClerkOrg,
  getTenantById,
  updateTenant,
  listTenants,
} from "./control/tenants";
export type {
  CreateTenantInput,
  UpdateTenantPatch,
} from "./control/tenants";

// Control plane (Stage 3) — Coolify integration + HelixDB provisioning +
// AES-256-GCM encryption for tenant secrets. All lazy: importing
// @graphbrain/core does NOT call Coolify, open a DB connection, or validate
// env. Config is read inside each function on first use.
export { encrypt, decrypt } from "./control/encryption";

export {
  provisionHelixInstance,
  startInstance,
  stopInstance,
  deleteInstance,
  getInstanceStatus,
  backupInstance,
  buildHelixComposeYaml,
} from "./control/coolify";
export type {
  ProvisionedInstance,
  InstanceStatus,
} from "./control/coolify";

export {
  provisionHelixForTenant,
} from "./control/helix-provision";
export type {
  ProvisionResult,
  ProvisionOptions,
} from "./control/helix-provision";

// Control plane (Stage 4) — Clerk Backend API client + webhook handlers.
// All lazy: importing @graphbrain/core does NOT call Clerk, open a DB
// connection, or validate env. Config is read inside each function on first
// use. Webhook signature verification uses node:crypto (no Svix dep needed).
export {
  getOrganization,
  listOrganizationApiKeys,
  createApiKey,
  revokeApiKey,
  verifyApiKey,
  getJwks,
  resetJwksCache,
} from "./control/clerk";
export type {
  ClerkOrganization,
  ClerkApiKey,
  VerifiedApiKey,
  CreateApiKeyInput,
  Jwks,
} from "./control/clerk";

export {
  verifyWebhookSignature,
  handleClerkWebhook,
} from "./control/clerk-webhooks";
export type {
  ClerkWebhookEvent,
  WebhookDeps,
  WebhookResult,
} from "./control/clerk-webhooks";

// HelixDB schema + indexes + deployment (Stage 6). All lazy: importing
// @graphbrain/core does NOT contact HelixDB. deploySchema(client) is called
// by provisionHelixForTenant after the /health poll passes. The dynamic
// query modules under ./helix/queries/ are the contract Stage 7's HelixEngine
// implements against.
export {
  NODE_LABELS,
  EDGE_LABELS,
  PAGE_TO_PAGE_EDGES,
  HAS_CHUNK_EDGE,
  CONTAINS_EDGE,
  PAGE_PROPERTIES,
  CHUNK_PROPERTIES,
  SOURCE_PROPERTIES,
  EDGE_PROPERTIES,
  NODE_PROPERTY_MAP,
  propertyNames,
  PAGE_FIELD_MAP,
  CHUNK_FIELD_MAP,
  SOURCE_FIELD_MAP,
  PAGE_SNAKE_TO_CAMEL,
  CHUNK_SNAKE_TO_CAMEL,
  SOURCE_SNAKE_TO_CAMEL,
} from "./helix/schema";
export type {
  NodeLabel,
  PropertyDecl,
  PropType,
} from "./helix/schema";

export {
  DEPLOYED_INDEXES,
  CHUNK_EMBEDDING_VECTOR_INDEX,
  CHUNK_CONTENT_TEXT_INDEX,
  PAGE_COMPILED_TRUTH_TEXT_INDEX,
  PAGE_TITLE_TEXT_INDEX,
  PAGE_SLUG_EQUALITY_INDEX,
  PAGE_TYPE_EQUALITY_INDEX,
  PAGE_EFFECTIVE_DATE_RANGE_INDEX,
  PAGE_UPDATED_AT_RANGE_INDEX,
} from "./helix/indexes";

export { deploySchema } from "./helix/deploy";

// Dynamic query modules (Stage 7 HelixEngine contract).
export {
  addPage,
  getPageBySlug,
  getPageById,
  updatePage,
  softDeletePage,
  listPages,
  addChunk,
  getChunksByPage,
  getChunkById,
  updateChunkEmbedding,
  addSource,
  getSource,
  getSourceById,
  listSources,
  addEdge,
  getOutEdges,
  getInEdges,
  vectorSearchChunks,
  textSearchPages,
  textSearchChunks,
  traverseFrom,
} from "./helix/queries";
export type {
  AddPageParams,
  UpdatePagePatch,
  UpdatePageParams,
  ListPagesParams,
  AddChunkParams,
  UpdateChunkEmbeddingParams,
  AddSourceParams,
  ListSourcesParams,
  AddEdgeParams,
  VectorSearchChunksParams,
  VectorSearchHit,
  TextSearchParams,
  TextSearchHit,
  TraverseDirection,
  TraverseOptions,
  TraversalNode,
} from "./helix/queries";

// BrainEngine interface + HelixEngine + TenantRouter (Stage 7). All lazy:
// importing @graphbrain/core does NOT open a HelixDB connection. The engine
// is constructed per-tenant by TenantRouter.getEngine(tenant) on first use.
export {
  clampSearchLimit,
  MAX_SEARCH_LIMIT,
  MODE_SEARCH_LIMITS,
} from "./engine";
export type {
  BrainEngine,
  SearchOpts,
} from "./engine";

export { HelixEngine } from "./helix-engine";
export type { HelixEngineOptions } from "./helix-engine";

export { TenantRouter } from "./tenant";
export type { TenantRouterOptions } from "./tenant";

// AI Gateway (Stage 8) — OpenRouter provider + Triad stub + AIGateway +
// EmbeddingService. All lazy: importing @graphbrain/core does NOT call
// OpenRouter or validate env. The gateway is constructed at app startup
// with the platform OpenRouterProvider; the EmbeddingService wraps it.
export {
  AIProviderError,
} from "./ai/types";
export type {
  ChatRole,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  Usage,
  EmbedRequest,
  EmbedResponse,
  RerankRequest,
  RerankResponse,
  RerankResult,
} from "./ai/types";

export type { AIProvider } from "./ai/provider";

export {
  OpenRouterProvider,
  toOpenRouterModelId,
  OPENROUTER_DEFAULT_BASE_URL,
  OPENROUTER_DEFAULT_REFERER,
  OPENROUTER_DEFAULT_TITLE,
} from "./ai/openrouter";
export type { OpenRouterProviderOptions } from "./ai/openrouter";

export { TriadProvider } from "./ai/triad";
export type { TriadProviderOptions } from "./ai/triad";

export {
  AIGateway,
  resolveChatModel,
  resolveEmbeddingModel,
  resolveEmbeddingDimensions,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_BACKOFF_MS,
} from "./ai/gateway";
export type { AIGatewayOptions } from "./ai/gateway";

export {
  EmbeddingService,
  DEFAULT_EMBED_BATCH_SIZE,
} from "./embedding";
export type { EmbeddingServiceOptions } from "./embedding";

// Hybrid search pipeline (Stage 9) — intent classifier, mode bundles,
// expansion, rerank, graph signals, relational recall, token budget, dedup,
// query cache, and the hybridSearch orchestrator. All lazy: importing
// @graphbrain/core does NOT open a DB connection or call OpenRouter. The
// query cache uses the Polygres pool (created on first getPool() call); the
// expansion + rerank call the AIGateway (constructed at app startup).
export {
  classifyIntent,
  intentToDetail,
  classifyQuery,
} from "./search/intent";
export type {
  DetailSuggestion,
  IntentClassification,
} from "./search/intent";

export {
  weightsForIntent,
  effectiveRrfK,
  applyExactMatchBoost,
} from "./search/intent-weights";
export type { IntentWeights } from "./search/intent-weights";

export {
  MODE_BUNDLES,
  KNOBS_HASH_VERSION,
  knobsHash,
} from "./search/mode";
export type {
  ModeBundle,
  KnobsHashContext,
} from "./search/mode";

export {
  expandQuery,
  sanitizeQueryForPrompt,
  sanitizeExpansionOutput,
} from "./search/expansion";

export {
  applyReranker,
  DEFAULT_RERANK_MODEL,
} from "./search/rerank";
export type { RerankerOpts } from "./search/rerank";

export {
  applyGraphSignals,
  sessionPrefix,
  ADJACENCY_BOOST,
  DEFAULT_TOP_K,
  ADJACENCY_MIN_HITS,
  SESSION_DEMOTE,
  SESSION_MIN_SHARE,
} from "./search/graph-signals";
export type {
  GraphSignalsMeta,
  GraphSignalsOpts,
} from "./search/graph-signals";

export {
  buildRelationalArm,
  parseRelationalQuery,
  slugifySeed,
  KNOWN_LINK_TYPES,
} from "./search/relational-recall";
export type {
  RelationalArmMeta,
  RelationalArmOpts,
  RelationalQuery,
  RelationalKind,
  RelationDirection,
} from "./search/relational-recall";

export {
  dedupResults,
} from "./search/dedup";

export {
  enforceTokenBudget,
  estimateTokens,
  resultTokens,
} from "./search/token-budget";
export type { TokenBudgetMeta } from "./search/token-budget";

export {
  SemanticQueryCache,
  queryHash,
  cosineSimilarity,
  DEFAULT_SIMILARITY_THRESHOLD,
  DEFAULT_TTL_SECONDS,
} from "./search/query-cache";
export type {
  CacheLookupResult,
  QueryCacheConfig,
} from "./search/query-cache";

export {
  hybridSearch,
  RRF_K,
  DEFAULT_RERANKER_TOP_N_IN,
} from "./search/hybrid";
export type {
  HybridSearchOpts,
  HybridSearchResult,
} from "./search/hybrid";

// Operations layer (Stage 10) — the contract-first operation registry +
// dispatcher. The single `OPERATIONS` map (name → Operation) is the source
// of truth for the API (Stage 12), CLI (Stage 15), and MCP server (Stage 11).
// `dispatch(name, input, ctx, deps)` is the single entry point. The trust
// boundary (ctx.remote !== false gates write/admin ops) is enforced in the
// dispatcher. All lazy: importing @graphbrain/core does NOT resolve an engine
// or call any AI provider — that happens at dispatch time.
export {
  OPERATIONS,
  OPERATION_NAMES,
  getOperation,
  dispatch,
  enforceTrustBoundary,
  OperationError,
  hasScope,
} from "./operations";
export type {
  Operation,
  OperationScope,
  ErrorCode,
  ResolvedDeps,
  DispatchDeps,
} from "./operations";

// Individual operation definitions (for per-op testing + direct handler use).
export { searchOp, queryOp } from "./operations";
export type {
  SearchInput,
  SearchOutput,
  QueryInput,
  QueryOutput,
  QueryCitation,
} from "./operations";
export {
  DEFAULT_SYNTHESIS_SYSTEM_PROMPT,
  buildSynthesisMessages,
  extractUsedCitations,
} from "./operations";
export {
  getPageOp,
  listPagesOp,
  putPageOp,
  createPageOp,
  addChunkOp,
  chunkContent,
  splitFrontmatter,
  CHUNK_TARGET_CHARS,
  CHUNK_MAX_CHARS,
} from "./operations";
export type {
  GetPageInput,
  GetPageOutput,
  ListPagesInput,
  ListPagesOutput,
  PutPageInput,
  PutPageOutput,
  CreatePageInput,
  CreatePageOutput,
  AddChunkInput,
  AddChunkOutput,
} from "./operations";
export { listSourcesOp, getSourceOp, addSourceOp } from "./operations";
export type {
  ListSourcesInput,
  ListSourcesOutput,
  GetSourceInput,
  GetSourceOutput,
  AddSourceInput,
  AddSourceOutput,
} from "./operations";
export { getLinksOp, getBacklinksOp, addLinkOp } from "./operations";
export type {
  GetLinksInput,
  GetLinksOutput,
  GetBacklinksInput,
  GetBacklinksOutput,
  AddLinkInput,
  AddLinkOutput,
} from "./operations";
export { captureOp, inferCaptureType, generateCaptureSlug } from "./operations";
export type { CaptureInput, CaptureOutput } from "./operations";

// MCP server layer (Stage 11) — exposes the Phase 1 operations as MCP tools
// over stdio (local agents) + HTTP (remote agents with Clerk auth). The tool
// list is auto-generated from OPERATIONS — adding ops in Stage 10
// automatically extends MCP. No manual tool registration.
//   • generateToolDefs() — the MCP tool-def seam (used by both transports).
//   • handleMcpCall() — the MCP tool-call → operations.dispatch seam.
//   • startMcpServer() — the stdio transport (Stage 15's CLI `serve`).
//   • createMcpHttpHandler() — the HTTP transport (Stage 12 mounts at /mcp).
// All lazy: importing @graphbrain/core does NOT start an MCP server or open
// a DB connection — the transports are constructed explicitly by the CLI /
// API service.
export { generateToolDefs } from "./mcp/tool-defs";
export type { McpToolDef } from "./mcp/tool-defs";
export { handleMcpCall } from "./mcp/dispatch";
export type { ToolResult } from "./mcp/dispatch";
export { startMcpServer } from "./mcp/server";
export type { StartMcpServerOptions } from "./mcp/server";
export { createMcpHttpHandler } from "./mcp/http-server";
export type { McpExpressRequest } from "./mcp/http-server";
