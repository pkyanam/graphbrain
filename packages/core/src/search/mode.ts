// @graphbrain/core — search mode bundles + knobs hash (Stage 9).
//
// Three named mode bundles (conservative / balanced / tokenmax) that bundle
// the search-lite knobs from PLAN.md "Search Mode" table into a single
// config key. The resolution chain (per-call → tenant.settings → config
// defaults → MODE_BUNDLES) is implemented in ./hybrid.ts.
//
// Ported from _reference/gbrain/src/core/search/mode.ts (the MODE_BUNDLES +
// KNOBS_HASH_VERSION + knobsHash portions). Radically simplified for Phase 1:
// GBrain's ModeBundle carries ~30 knobs (cross-modal, autocut, floor-ratio,
// title-boost, schema-pack identity, …). Phase 1 ships the subset the
// retrieval pipeline actually reads:
//
//   - tokenBudget        (conservative=4000, balanced=12000, tokenmax=off)
//   - expansion          (LLM multi-query; tokenmax only)
//   - relationalRetrieval(balanced + tokenmax)
//   - searchLimit        (conservative=10, balanced=25, tokenmax=50)
//   - rerankerEnabled    (defaults false; tenant.settings can override)
//   - cacheEnabled       (true for all three)
//   - cacheSimilarityThreshold (0.92 for all three)
//   - cacheTtlSeconds    (3600 for all three)
//   - intentWeighting    (true for all three)
//
// The knobs_hash folds mode + embedding column + relational flag (GBrain
// v9→v10 invariant) so a tokenmax write can't be served to a conservative
// read, and a relational-on write can't be served to a relational-off
// lookup. KNOBS_HASH_VERSION is the single source of truth — bumping it
// invalidates every persisted cache row (one-time cold-miss on upgrade).

import { createHash } from "node:crypto";
import type { SearchMode, CRMode } from "../types";

/**
 * A complete knob set for one mode. Every field is required so the bundle
 * is self-contained and per-key overrides are obvious diffs.
 */
export interface ModeBundle {
  /** Semantic query cache. Free win; on for everyone. */
  cacheEnabled: boolean;
  cacheSimilarityThreshold: number;
  cacheTtlSeconds: number;
  /** Zero-LLM intent classifier weight adjustments. On for everyone. */
  intentWeighting: boolean;
  /**
   * Per-call token budget cap. undefined = no-op (tokenmax).
   * 4000 = tight (conservative, fits Haiku context loop).
   * 12000 = balanced (sweet-spot for Sonnet).
   */
  tokenBudget: number | undefined;
  /** LLM multi-query expansion (Haiku call per search). tokenmax only. */
  expansion: boolean;
  /** Default `limit` for the operation layer. */
  searchLimit: number;
  /** Cross-encoder reranker. Defaults false; tenant.settings can override. */
  rerankerEnabled: boolean;
  /** Relational recall arm (typed-edge traversal). balanced + tokenmax. */
  relationalRetrieval: boolean;
  /** Relational traversal depth (hops). */
  relationalRetrievalDepth: number;
  /** Contextual-retrieval tier. conservative=none, balanced=title, tokenmax=per_chunk_synopsis. */
  contextualRetrieval: CRMode;
}

/**
 * The canonical mode bundles. These are FROZEN — the public eval table
 * depends on these being canonical. Power-user customization happens via
 * per-key config overrides (tenant.settings); if there's real demand for a
 * custom bundle, that's a future conversation.
 */
export const MODE_BUNDLES: Readonly<Record<SearchMode, Readonly<ModeBundle>>> = Object.freeze({
  conservative: Object.freeze({
    cacheEnabled: true,
    cacheSimilarityThreshold: 0.92,
    cacheTtlSeconds: 3600,
    intentWeighting: true,
    tokenBudget: 4000,
    expansion: false,
    searchLimit: 10,
    // Reranker off — conservative is cost-sensitive; reranker spend doesn't
    // fit the tier's value prop. Tenant can override via settings.rerankerEnabled.
    rerankerEnabled: false,
    // Relational recall OFF for conservative (cost-sensitive tier). Power
    // users opt in per-call.
    relationalRetrieval: false,
    relationalRetrievalDepth: 2,
    contextualRetrieval: "none",
  }),
  balanced: Object.freeze({
    cacheEnabled: true,
    cacheSimilarityThreshold: 0.92,
    cacheTtlSeconds: 3600,
    intentWeighting: true,
    tokenBudget: 12000,
    expansion: false,
    searchLimit: 25,
    // Reranker off by default at the platform level; tenant.settings can
    // flip it on. The mode bundle is the default, not the mandate.
    rerankerEnabled: false,
    // Relational recall ON for balanced (contingent on the no-regression
    // gate; ships default-false everywhere if the gate flags any regression).
    relationalRetrieval: true,
    relationalRetrievalDepth: 2,
    contextualRetrieval: "title",
  }),
  tokenmax: Object.freeze({
    cacheEnabled: true,
    cacheSimilarityThreshold: 0.92,
    cacheTtlSeconds: 3600,
    intentWeighting: true,
    // undefined = no truncation (tokenmax is the power-user tier).
    tokenBudget: undefined,
    // LLM multi-query expansion on for tokenmax to preserve the power-user
    // retrieval ceiling. ~$0.0001/query Haiku cost.
    expansion: true,
    searchLimit: 50,
    // Reranker off by default at the platform level; tenant.settings can
    // flip it on. tokenmax is the high-cost-tolerant tier where rerank
    // earns its fee.
    rerankerEnabled: false,
    relationalRetrieval: true,
    relationalRetrievalDepth: 2,
    contextualRetrieval: "per_chunk_synopsis",
  }),
});

/**
 * KNOBS_HASH_VERSION — bump on any change to the hash parts list. This is
 * a breaking change for any persisted cache row (one-time cold-miss on
 * upgrade as old rows become unreachable).
 *
 * v=1 (Stage 9): initial Phase 1 hash. Folds mode + cache knobs + token
 * budget + expansion + searchLimit + reranker + relational + contextual
 * retrieval + embedding column + embedding model. The embedding column +
 * model are passed via KnobsHashContext (orthogonal to mode bundles).
 */
export const KNOBS_HASH_VERSION = 1;

/**
 * Second-arg context for the cache key. The embedding column + model live
 * OUTSIDE ModeBundle because they're orthogonal to search mode (mode
 * bundles don't pick columns). Passing them as a second argument keeps
 * ModeBundle pure and lets the hash invalidate correctly across
 * column/provider switches (GBrain v9→v10 invariant: a query against
 * `embedding_voyage` must never be served from a cache row that ran
 * against `embedding`).
 */
export interface KnobsHashContext {
  /** Resolved column name, e.g. "embedding", "embeddingVoyage". */
  embeddingColumn?: string;
  /** Resolved provider:model, e.g. "voyage:voyage-3-large". */
  embeddingModel?: string;
}

/**
 * Compute a deterministic knobs hash for a (bundle, context) pair. The hash
 * is the cache key's `knobs_hash` column value. Fixed-order key list —
 * adding a knob here REQUIRES bumping KNOBS_HASH_VERSION and is a breaking
 * change for any persisted cache.
 */
export function knobsHash(
  bundle: Readonly<ModeBundle>,
  resolvedMode: SearchMode,
  ctx?: KnobsHashContext,
): string {
  const parts = [
    `v=${KNOBS_HASH_VERSION}`,
    `mode=${resolvedMode}`,
    `cache=${bundle.cacheEnabled ? 1 : 0}`,
    `sim=${bundle.cacheSimilarityThreshold.toFixed(4)}`,
    `ttl=${bundle.cacheTtlSeconds}`,
    `iw=${bundle.intentWeighting ? 1 : 0}`,
    `tb=${bundle.tokenBudget ?? "none"}`,
    `exp=${bundle.expansion ? 1 : 0}`,
    `lim=${bundle.searchLimit}`,
    `rr=${bundle.rerankerEnabled ? 1 : 0}`,
    // Relational recall arm (GBrain v9→v10 invariant): a relational-on write
    // (edge-seeded result set) must NOT be served to a relational-off lookup.
    // The depth changes the candidate set too, so it folds in as well.
    `rel=${bundle.relationalRetrieval ? 1 : 0}`,
    `reld=${bundle.relationalRetrievalDepth}`,
    `cr=${bundle.contextualRetrieval}`,
    // Embedding column + model (orthogonal to mode; passed via ctx). A query
    // against `embeddingVoyage` must never be served from a row that ran
    // against `embedding` — they sit in different vector spaces.
    `col=${ctx?.embeddingColumn ?? "embedding"}`,
    `prov=${ctx?.embeddingModel ?? "default"}`,
  ];
  const h = createHash("sha256");
  h.update(parts.join("|"));
  return h.digest("hex").slice(0, 16);
}
