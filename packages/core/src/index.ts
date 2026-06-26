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
  updatePage,
  softDeletePage,
  listPages,
  addChunk,
  getChunksByPage,
  updateChunkEmbedding,
  addSource,
  getSource,
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
