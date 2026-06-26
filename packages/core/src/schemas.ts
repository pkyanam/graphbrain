// @graphbrain/core — Zod schemas mirroring ./types.ts.
//
// Every domain type has a corresponding Zod schema. Where it reduces
// duplication, the inferred type is re-exported (e.g. `TenantSettings`,
// `Config`); hand-written types in ./types.ts remain the canonical
// cross-file contract for clarity.
//
// Conventions:
//   - `*Schema` suffix on schema names.
//   - Dates: `z.coerce.date()` so ISO strings from the wire / DB rows parse.
//   - Optional DB columns: `.nullish()` (undefined | null | T) to match the
//     hand-written types which use `?` + `| null`.
//   - `Record<string, unknown>` frontmatter / config blobs: `z.record(z.string(), z.unknown())`.

import { z } from "zod";
import {
  CR_MODES,
  PAGE_TYPE_SEED,
  TYPED_EDGE_LABELS,
} from "./types";

// ─── Primitives ──────────────────────────────────────────────────────────────

export const PageTypeSchema = z.string();

export const PageKindSchema = z.enum(["markdown", "code", "image"]);

export const ChunkSourceSchema = z.enum([
  "compiled_truth", "timeline", "fenced_code", "image_asset",
]);

export const ChunkModalitySchema = z.enum(["text", "image"]);

export const EffectiveDateSourceSchema = z.enum([
  "event_date", "date", "published", "filename", "fallback",
]);

export const CRModeSchema = z.enum(CR_MODES);

export const SearchIntentSchema = z.enum(["entity", "temporal", "event", "general"]);

export const SearchModeSchema = z.enum(["conservative", "balanced", "tokenmax"]);

export const TenantTierSchema = z.enum(["free", "pro", "enterprise"]);

export const TenantStatusSchema = z.enum([
  "pending", "active", "suspended", "deleted", "error",
]);

export const LinkOriginSchema = z.enum([
  "auto", "manual", "typed-link", "markdown", "frontmatter",
]);

/** Edge label — closed seed union widened with `z.string()` for pack-declared types. */
export const EdgeLabelSchema = z.enum(TYPED_EDGE_LABELS).or(z.string());

export const FactKindSchema = z.enum(["fact", "metric", "event", "claim"]);
export const FactVisibilitySchema = z.enum(["public", "private", "unlisted"]);
export const FactNotabilitySchema = z.enum(["high", "medium", "low"]);

export const TakeKindSchema = z.enum([
  "hunch", "prediction", "recommendation", "verdict", "opinion", "goal",
]);

export const RetrievalStreamSchema = z.enum([
  "lexical", "vector", "relational", "expansion", "cache",
]);

export const AuthModeSchema = z.enum(["jwt", "apikey"]);

// NOTE: PAGE_TYPE_SEED, TYPED_EDGE_LABELS, CR_MODES are exported from
// ./types.ts (the canonical source). They're imported here only for use in
// the enum schemas above.

// ─── Tenant ──────────────────────────────────────────────────────────────────

export const TenantSettingsSchema = z.object({
  chatModel: z.string().optional(),
  embeddingModel: z.string().optional(),
  embeddingDimensions: z.number().int().positive().max(8192).optional(),
  searchMode: SearchModeSchema.optional(),
  monthlyCostCapUsd: z.number().nonnegative().optional(),
  rerankerEnabled: z.boolean().optional(),
  contextualRetrievalMode: CRModeSchema.optional(),
  features: z.record(z.string(), z.boolean()).optional(),
});

export const TenantSchema = z.object({
  id: z.string(),
  clerkOrgId: z.string(),
  name: z.string(),
  slug: z.string(),
  helixInstanceUrl: z.string().url().nullish(),
  helixApiKeyEncrypted: z.string().nullish(),
  coolifyAppId: z.string().nullish(),
  tier: TenantTierSchema,
  status: TenantStatusSchema,
  settings: TenantSettingsSchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

// ─── Page ────────────────────────────────────────────────────────────────────

export const PageSchema = z.object({
  id: z.string(),
  slug: z.string(),
  type: PageTypeSchema,
  title: z.string(),
  compiledTruth: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  pageKind: PageKindSchema,
  contentHash: z.string().nullish(),
  emotionalWeight: z.number().min(0).max(1).nullish(),
  effectiveDate: z.coerce.date().nullish(),
  effectiveDateSource: EffectiveDateSourceSchema.nullish(),
  importFilename: z.string().nullish(),
  salienceTouchedAt: z.coerce.date().nullish(),
  lastRetrievedAt: z.coerce.date().nullish(),
  linksExtractedAt: z.coerce.date().nullish(),
  contextualRetrievalMode: CRModeSchema.nullish(),
  corpusGeneration: z.string().nullish(),
  generation: z.number().int().nonnegative().nullish(),
  deletedAt: z.coerce.date().nullish(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const PageInputSchema = z.object({
  slug: z.string(),
  type: PageTypeSchema,
  title: z.string(),
  compiledTruth: z.string(),
  frontmatter: z.record(z.string(), z.unknown()).optional(),
  pageKind: PageKindSchema.optional(),
  contentHash: z.string().nullish(),
  emotionalWeight: z.number().min(0).max(1).nullish(),
  effectiveDate: z.coerce.date().nullish(),
  effectiveDateSource: EffectiveDateSourceSchema.nullish(),
  importFilename: z.string().nullish(),
  contextualRetrievalMode: CRModeSchema.nullish(),
});

// ─── Chunk ───────────────────────────────────────────────────────────────────

const embeddingSchema = z.array(z.number()).nullish();

export const ChunkSchema = z.object({
  id: z.string(),
  pageId: z.string(),
  chunkIndex: z.number().int().nonnegative(),
  content: z.string(),
  chunkSource: ChunkSourceSchema,
  modality: ChunkModalitySchema,
  embedding: embeddingSchema,
  embeddingVoyage: embeddingSchema,
  embeddingImage: embeddingSchema,
  model: z.string().nullish(),
  tokenCount: z.number().int().nonnegative().nullish(),
  language: z.string().nullish(),
  symbolName: z.string().nullish(),
  symbolType: z.string().nullish(),
  startLine: z.number().int().nonnegative().nullish(),
  endLine: z.number().int().nonnegative().nullish(),
  embeddedAt: z.coerce.date().nullish(),
  createdAt: z.coerce.date(),
});

// ─── Source ──────────────────────────────────────────────────────────────────

export const SourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  localPath: z.string().nullish(),
  lastCommit: z.string().nullish(),
  lastSyncAt: z.coerce.date().nullish(),
  config: z.record(z.string(), z.unknown()),
  chunkerVersion: z.number().int().nonnegative().nullish(),
  archived: z.boolean(),
  archivedAt: z.coerce.date().nullish(),
  archiveExpiresAt: z.coerce.date().nullish(),
  contextualRetrievalMode: CRModeSchema.nullish(),
  trustFrontmatterOverrides: z.boolean().nullish(),
  newestContentAt: z.coerce.date().nullish(),
  createdAt: z.coerce.date(),
});

// ─── Link ────────────────────────────────────────────────────────────────────

export const LinkSchema = z.object({
  id: z.string(),
  fromSlug: z.string(),
  toSlug: z.string(),
  type: EdgeLabelSchema,
  origin: LinkOriginSchema,
  context: z.string().optional(),
  originSlug: z.string().nullish(),
  originField: z.string().nullish(),
  createdAt: z.coerce.date(),
});

// ─── Fact / Take / TimelineEntry / File ──────────────────────────────────────

export const FactSchema = z.object({
  id: z.string(),
  pageId: z.string(),
  rowNum: z.number().int().nonnegative(),
  claim: z.string(),
  kind: FactKindSchema,
  confidence: z.number().min(0).max(1),
  visibility: FactVisibilitySchema,
  notability: FactNotabilitySchema,
  validFrom: z.coerce.date(),
  validUntil: z.coerce.date().nullish(),
  source: z.string(),
  context: z.string().nullish(),
  createdAt: z.coerce.date(),
});

export const TakeSchema = z.object({
  id: z.string(),
  pageId: z.string(),
  rowNum: z.number().int().nonnegative(),
  claim: z.string(),
  kind: TakeKindSchema,
  who: z.string(),
  weight: z.number(),
  since: z.string().nullish(),
  source: z.string().nullish(),
  resolvedQuality: z.enum(["correct", "incorrect", "partial", "unresolvable"]).nullish(),
  resolvedOutcome: z.boolean().nullish(),
  resolvedEvidence: z.string().nullish(),
  createdAt: z.coerce.date(),
});

export const TimelineEntrySchema = z.object({
  id: z.string(),
  pageId: z.string(),
  date: z.string(),
  event: z.string(),
  source: z.string(),
  createdAt: z.coerce.date(),
});

export const FileSchema = z.object({
  id: z.string(),
  pageId: z.string(),
  storagePath: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string(),
  createdAt: z.coerce.date(),
});

// ─── Search ──────────────────────────────────────────────────────────────────

export const CitationSchema = z.object({
  chunkId: z.string().nullish(),
  slug: z.string(),
  stream: RetrievalStreamSchema,
  snippet: z.string().optional(),
});

export const SearchResultSchema = z.object({
  page: PageSchema,
  chunks: z.array(ChunkSchema),
  score: z.number(),
  sources: z.array(RetrievalStreamSchema),
  citations: z.array(CitationSchema),
  rank: z.number().int().nonnegative().optional(),
  evidence: z.enum([
    "alias_hit", "exact_title_match", "high_vector_match",
    "keyword_exact", "weak_semantic", "relational",
  ]).optional(),
  createSafety: z.enum(["exists", "probable", "unknown"]).optional(),
});

export const HybridSearchMetaSchema = z.object({
  vectorEnabled: z.boolean(),
  detailResolved: z.enum(["low", "medium", "high"]).nullish(),
  expansionApplied: z.boolean(),
  intent: SearchIntentSchema.optional(),
  mode: SearchModeSchema.optional(),
  embeddingColumn: z.string().optional(),
  tokenBudget: z.object({
    budget: z.number(),
    used: z.number(),
    kept: z.number(),
    dropped: z.number(),
  }).optional(),
  cache: z.object({
    status: z.enum(["hit", "miss", "disabled"]),
    similarity: z.number().optional(),
    ageSeconds: z.number().optional(),
  }).optional(),
  relational: z.object({
    enabled: z.boolean(),
    seed: z.string().optional(),
    hops: z.number().int().nonnegative().optional(),
    candidates: z.number().int().nonnegative().optional(),
  }).optional(),
});

// ─── Auth + OperationContext ─────────────────────────────────────────────────

export const AuthInfoSchema = z.object({
  mode: AuthModeSchema,
  orgId: z.string(),
  orgSlug: z.string(),
  userId: z.string().nullish(),
  scopes: z.array(z.string()),
  allowedSources: z.array(z.string()).optional(),
});

export const OperationContextSchema = z.object({
  tenant: TenantSchema,
  auth: AuthInfoSchema,
  remote: z.boolean(),
  sourceId: z.string().optional(),
  signal: z.instanceof(AbortSignal).optional(),
  dryRun: z.boolean().optional(),
  correlationId: z.string().optional(),
});
