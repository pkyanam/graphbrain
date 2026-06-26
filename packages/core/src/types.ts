// @graphbrain/core — shared domain types for Phase 1.
//
// Ports the essential shapes from GBrain (_reference/gbrain/src/core/types.ts,
// engine.ts, operations.ts) and adapts them to Graphbrain's multi-tenant
// architecture: every knowledge entity is tenant-scoped (lives in a per-tenant
// isolated HelixDB instance), while the control plane (Tenant, etc.) lives in
// the shared Polygres instance.
//
// The HelixDB Node Types + Edge Types these mirror are documented in
// PLAN.md → "Storage Mapping" (lines ~130–188). Zod schemas that validate
// these shapes live in ./schemas.ts.

// ─── Primitives ──────────────────────────────────────────────────────────────

/**
 * Page type is an open string (mirrors GBrain v0.38). The closed union was
 * always a fiction — tenants accumulate organic types via frontmatter. The
 * built-in `gbrain-base` seed list lives in `PAGE_TYPE_SEED` below for
 * reference / codegen; runtime validation against a schema pack is the
 * authoritative check, not compile-time exhaustiveness.
 */
export type PageType = string;

/** Seed list of types declared by the built-in `gbrain-base` schema pack. */
export const PAGE_TYPE_SEED = [
  "person", "company", "deal", "yc", "civic", "project", "concept",
  "source", "media", "writing", "analysis", "guide", "hardware",
  "architecture", "meeting", "note", "email", "slack", "calendar-event",
  "conversation", "atom", "code", "image", "synthesis", "extract_receipt",
] as const;

/** Ingestion modality — parallel to GBrain's PageKind. */
export type PageKind = "markdown" | "code" | "image";

/** Chunk content source — which section of the page the chunk came from. */
export type ChunkSource =
  | "compiled_truth"
  | "timeline"
  | "fenced_code"
  | "image_asset";

/** Chunk modality discriminator (text vs multimodal image). */
export type ChunkModality = "text" | "image";

/** Effective-date precedence winner (GBrain v0.29.1). */
export type EffectiveDateSource =
  | "event_date"
  | "date"
  | "published"
  | "filename"
  | "fallback";

/** Contextual-retrieval tier ladder per search.mode (GBrain v0.40.3.0). */
export const CR_MODES = ["none", "title", "per_chunk_synopsis"] as const;
export type CRMode = (typeof CR_MODES)[number];

/** Search intent inferred by the zero-LLM classifier (GBrain v0.32.x). */
export type SearchIntent = "entity" | "temporal" | "event" | "general";

/** Search mode bundle name (GBrain v0.32.3). */
export type SearchMode = "conservative" | "balanced" | "tokenmax";

// ─── Tenant (control plane — Polygres `_graphbrain.tenants`) ─────────────────

export type TenantTier = "free" | "pro" | "enterprise";

export type TenantStatus = "pending" | "active" | "suspended" | "deleted" | "error";

/**
 * Per-tenant settings override shape (stored as JSONB in `tenants.settings`).
 * Resolution chain (highest wins): per-call override → tenant settings →
 * global config defaults. See ./config.ts → `TenantSettings`.
 */
export interface TenantSettings {
  /** Default chat model id ("provider:model", e.g. "anthropic:claude-sonnet-4-6"). */
  chatModel?: string;
  /** Default embedding model id (e.g. "voyage:voyage-3-large"). */
  embeddingModel?: string;
  /** Embedding dimensions — must match the HelixDB schema's vector column. */
  embeddingDimensions?: number;
  /** Active search mode bundle. */
  searchMode?: SearchMode;
  /** Per-tenant monthly cost cap in USD. Operations refuse to spend past this. */
  monthlyCostCapUsd?: number;
  /** Reranker on/off override (wins over the mode bundle). */
  rerankerEnabled?: boolean;
  /** Contextual-retrieval tier override (wins over the mode bundle). */
  contextualRetrievalMode?: CRMode;
  /** Free-form feature flags. */
  features?: Record<string, boolean>;
}

/**
 * A Graphbrain tenant. One Clerk organization = one tenant. Each tenant gets
 * a dedicated HelixDB instance; `helix_instance_url` + `helix_api_key_encrypted`
 * point at it. The control plane row is the source of truth for the
 * Clerk org → HelixDB instance mapping (see PLAN.md "Clerk → Tenant mapping").
 */
export interface Tenant {
  id: string;
  clerkOrgId: string;
  name: string;
  slug: string;
  helixInstanceUrl: string | null;
  /** AES-256-GCM ciphertext (base64(iv:ciphertext:tag)) of the HelixDB API key. */
  helixApiKeyEncrypted: string | null;
  coolifyAppId: string | null;
  tier: TenantTier;
  status: TenantStatus;
  settings: TenantSettings;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Knowledge graph entities (per-tenant HelixDB) ───────────────────────────

/**
 * A Page node (HelixDB `Page` label). Mirrors GBrain's Page interface,
 * adapted to Graphbrain's per-tenant isolation (no `source_id` column —
 * each tenant has exactly one brain; sources are tracked via the `Source`
 * node + `CONTAINS` edge instead).
 *
 * `id` is a string (HelixDB node ids are ULID strings, unlike GBrain's
 * numeric autoincrement).
 */
export interface Page {
  id: string;
  slug: string;
  type: PageType;
  title: string;
  compiledTruth: string;
  frontmatter: Record<string, unknown>;
  pageKind: PageKind;
  contentHash?: string | null;
  /** Deterministic 0..1 salience score (GBrain v0.29 emotional_weight). */
  emotionalWeight?: number | null;
  /** Content date from frontmatter precedence (GBrain v0.29.1). */
  effectiveDate?: Date | null;
  effectiveDateSource?: EffectiveDateSource | null;
  /** Basename without extension captured at import. */
  importFilename?: string | null;
  /** Bumped when emotionalWeight changes; salience window uses GREATEST(updatedAt, salienceTouchedAt). */
  salienceTouchedAt?: Date | null;
  /** Last time this page was surfaced by a user-facing search/query. */
  lastRetrievedAt?: Date | null;
  /** Last time link/timeline extraction ran on this page. */
  linksExtractedAt?: Date | null;
  /** Contextual-retrieval tier the page was last embedded under (GBrain v0.40.3.0). */
  contextualRetrievalMode?: CRMode | null;
  /** Composite hash of (synopsis prompt, model, wrapper version, embedding model) at write time. */
  corpusGeneration?: string | null;
  /** Monotonic generation counter for cache invalidation. */
  generation?: number | null;
  /** Soft-delete timestamp. Hidden from search/getPage by default. */
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Input shape for creating/updating a Page (subset of Page, no server-stamped fields). */
export interface PageInput {
  slug: string;
  type: PageType;
  title: string;
  compiledTruth: string;
  frontmatter?: Record<string, unknown>;
  pageKind?: PageKind;
  contentHash?: string | null;
  emotionalWeight?: number | null;
  effectiveDate?: Date | null;
  effectiveDateSource?: EffectiveDateSource | null;
  importFilename?: string | null;
  contextualRetrievalMode?: CRMode | null;
}

/**
 * A Chunk node (HelixDB `Chunk` label). One page decomposes into many chunks;
 * each chunk carries one or more embedding vectors. `embedding` is the
 * primary text vector; `embeddingVoyage` and `embeddingImage` are optional
 * secondary vectors (Voyage text, Voyage multimodal).
 */
export interface Chunk {
  id: string;
  pageId: string;
  chunkIndex: number;
  content: string;
  chunkSource: ChunkSource;
  modality: ChunkModality;
  /** Primary text embedding (number[] over the wire; HelixDB stores as vector). */
  embedding: number[] | null;
  /** Optional Voyage text embedding. */
  embeddingVoyage?: number[] | null;
  /** Optional multimodal image embedding. */
  embeddingImage?: number[] | null;
  /** Model id that produced `embedding` (e.g. "voyage:voyage-3-large"). */
  model?: string | null;
  tokenCount?: number | null;
  /** v0.19.0 code metadata (null for markdown/image chunks). */
  language?: string | null;
  symbolName?: string | null;
  symbolType?: string | null;
  startLine?: number | null;
  endLine?: number | null;
  embeddedAt?: Date | null;
  createdAt: Date;
}

/**
 * A Source node (HelixDB `Source` label). Represents a repo / folder / feed
 * inside a tenant's brain. Pages belong to a source via the `CONTAINS` edge.
 * Mirrors GBrain's `sources` table.
 */
export interface Source {
  id: string;
  name: string;
  localPath?: string | null;
  lastCommit?: string | null;
  lastSyncAt?: Date | null;
  config: Record<string, unknown>;
  chunkerVersion?: number | null;
  archived: boolean;
  archivedAt?: Date | null;
  archiveExpiresAt?: Date | null;
  contextualRetrievalMode?: CRMode | null;
  /** When true, page frontmatter overrides win over source/global config. */
  trustFrontmatterOverrides?: boolean;
  newestContentAt?: Date | null;
  createdAt: Date;
}

/**
 * A typed or generic link between two pages (HelixDB edge). The edge label
 * is `type`; `origin` records how the edge was created. Mirrors GBrain's
 * `page_links` table + the PLAN.md Edge Types table.
 */
export type LinkOrigin = "auto" | "manual" | "typed-link" | "markdown" | "frontmatter";

/** The closed set of typed-edge labels declared by the base schema pack. */
export const TYPED_EDGE_LABELS = [
  "WORKS_AT", "FOUNDED", "INVESTED_IN", "ATTENDED", "ADVISES",
  "MENTIONS", "CONTAINS", "HAS_CHUNK", "HAS_FACT", "HAS_TAKE",
  "TIMELINE", "HAS_FILE", "TAGGED", "CALLS", "DEFINED_IN",
] as const;

export type EdgeLabel = (typeof TYPED_EDGE_LABELS)[number] | (string & {});

export interface Link {
  id: string;
  fromSlug: string;
  toSlug: string;
  /** Edge label (typed or `MENTIONS` for generic). */
  type: EdgeLabel;
  origin: LinkOrigin;
  /** Surrounding text where the link was extracted (for `--explain` + dedup). */
  context?: string;
  /** For frontmatter-origin edges: the slug of the page whose frontmatter created this. */
  originSlug?: string | null;
  /** For frontmatter-origin edges: the field name (e.g. "investors", "key_people"). */
  originField?: string | null;
  createdAt: Date;
}

/** A Fact row (HelixDB `Fact` label). Ported from GBrain `FactRow`. */
export type FactKind = "fact" | "metric" | "event" | "claim";
export type FactVisibility = "public" | "private" | "unlisted";

export interface Fact {
  id: string;
  pageId: string;
  rowNum: number;
  claim: string;
  kind: FactKind;
  confidence: number;
  visibility: FactVisibility;
  notability: "high" | "medium" | "low";
  validFrom: Date;
  validUntil?: Date | null;
  source: string;
  context?: string | null;
  createdAt: Date;
}

/** A Take row (HelixDB `Take` label). Ported from GBrain `Take`. */
export type TakeKind =
  | "hunch"
  | "prediction"
  | "recommendation"
  | "verdict"
  | "opinion"
  | "goal";

export interface Take {
  id: string;
  pageId: string;
  rowNum: number;
  claim: string;
  kind: TakeKind;
  /** Who holds the take (person slug or "world" for public). */
  who: string;
  weight: number;
  since: string | null;
  source: string | null;
  resolvedQuality: "correct" | "incorrect" | "partial" | "unresolvable" | null;
  resolvedOutcome: boolean | null;
  resolvedEvidence: string | null;
  createdAt: Date;
}

/** A Timeline entry (HelixDB `TimelineEntry` label). Ported from GBrain. */
export interface TimelineEntry {
  id: string;
  pageId: string;
  date: string;
  event: string;
  source: string;
  createdAt: Date;
}

/** A File attachment (HelixDB `File` label). Bytes live in MinIO; this is metadata. */
export interface File {
  id: string;
  pageId: string;
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: Date;
}

// ─── Search ──────────────────────────────────────────────────────────────────

/**
 * One search result. Mirrors GBrain's SearchResult, adapted to Graphbrain's
 * per-tenant HelixDB (no source_id — the whole tenant is one brain).
 *
 * `page` carries the hydrated Page node; `chunks` are the matching chunks
 * (one page can contribute multiple chunks); `score` is the post-fusion
 * ranker score; `sources` names which retrieval streams matched
 * (lexical, vector, relational, expansion); `citations` carry the
 * evidence attribution.
 */
export type RetrievalStream = "lexical" | "vector" | "relational" | "expansion" | "cache";

export interface Citation {
  chunkId: string | null;
  slug: string;
  /** Which retrieval stream surfaced this evidence. */
  stream: RetrievalStream;
  /** Snippet of the matching chunk content. */
  snippet?: string;
}

export interface SearchResult {
  page: Page;
  chunks: Chunk[];
  score: number;
  /** Which retrieval streams contributed to this result. */
  sources: RetrievalStream[];
  citations: Citation[];
  /** Post-fusion rank (0-indexed). */
  rank?: number;
  /** Strongest signal that surfaced this page (GBrain v0.40.4 evidence). */
  evidence?: "alias_hit" | "exact_title_match" | "high_vector_match" | "keyword_exact" | "weak_semantic" | "relational";
  /** "Is this page already in the brain?" hint for the agent's dedup decision. */
  createSafety?: "exists" | "probable" | "unknown";
}

/**
 * Side-channel metadata about what actually ran during a hybrid search.
 * Surfaced so callers / `--explain` formatters can audit the retrieval
 * pipeline. Ported from GBrain's HybridSearchMeta.
 */
export interface HybridSearchMeta {
  vectorEnabled: boolean;
  detailResolved: "low" | "medium" | "high" | null;
  expansionApplied: boolean;
  intent?: SearchIntent;
  mode?: SearchMode;
  /** Embedding column that ran the search (e.g. "embedding", "embedding_voyage"). */
  embeddingColumn?: string;
  tokenBudget?: {
    budget: number;
    used: number;
    kept: number;
    dropped: number;
  };
  cache?: {
    status: "hit" | "miss" | "disabled";
    similarity?: number;
    ageSeconds?: number;
  };
  /** Relational-recall arm decision (GBrain v0.43). */
  relational?: {
    enabled: boolean;
    seed?: string;
    hops?: number;
    candidates?: number;
  };
}

// ─── Operation context + trust boundary ──────────────────────────────────────

/**
 * Auth info for the calling principal. Two modes (PLAN.md "Auth flows"):
 *   1. JWT (browser session) — `mode: "jwt"`, `orgId` + `orgSlug` from claims.
 *   2. API key (MCP agent) — `mode: "apikey"`, `orgId` resolved via Clerk verify.
 *
 * `scopes` carries Clerk-issued scopes for per-operation enforcement.
 * `allowedSources` is the federated read grant (Phase 2; empty in Phase 1
 * since each tenant has one brain).
 */
export type AuthMode = "jwt" | "apikey";

export interface AuthInfo {
  mode: AuthMode;
  /** Clerk organization id — maps to `Tenant.clerkOrgId`. */
  orgId: string;
  orgSlug: string;
  /** Clerk user id for JWT mode; null for API-key mode. */
  userId?: string | null;
  /** Granted scopes (Clerk scopes for JWT, API-key scopes for apikey). */
  scopes: string[];
  /** Federated read grant (Phase 2). Empty array = no federation. */
  allowedSources?: string[];
}

/**
 * Per-operation context, threaded through every operation handler.
 *
 * **Trust boundary (critical, ported from GBrain CLAUDE.md):**
 * `remote` distinguishes trusted local CLI callers (`remote === false`, set
 * by the API's internal admin paths) from untrusted agent-facing callers
 * (`remote === true`, set by the MCP/HTTP transport). Security-sensitive
 * operations tighten their behavior when `remote !== false`. The field is
 * REQUIRED on the type — every transport MUST set it explicitly. Consumers
 * treat anything that isn't strictly `false` as remote/untrusted (fail-closed
 * defense in depth).
 *
 * `tenant` is the resolved Tenant row (looked up from `auth.orgId` via the
 * control plane). `sourceId` scopes the op to a specific Source within the
 * tenant's brain (Phase 1: single-source default; Phase 2: federated reads
 * via `auth.allowedSources`).
 */
export interface OperationContext {
  /** Resolved tenant for this operation. */
  tenant: Tenant;
  /** Auth info for the calling principal. */
  auth: AuthInfo;
  /**
   * REQUIRED. `false` ONLY for trusted local admin callers; `true` for every
   * agent-facing / MCP / HTTP entry point. Fail-closed: anything not strictly
   * `false` is treated as remote/untrusted.
   */
  remote: boolean;
  /** Optional source scope within the tenant's brain. */
  sourceId?: string;
  /** Optional AbortSignal for cooperative cancellation. */
  signal?: AbortSignal;
  /** Dry-run flag — handlers skip side effects when true. */
  dryRun?: boolean;
  /** Correlation id for audit logging. */
  correlationId?: string;
}
