// @graphbrain/core — intent → ranking knob adjustments (Stage 9).
//
// Sits on top of the intent classifier (./intent.ts). Maps a classified
// intent onto concrete weight adjustments applied during the hybrid search
// pipeline:
//
//   - entity   → boost exact slug/title matches (keyword pre-filter favored)
//   - temporal → suggest recency='on' when the caller left it undefined
//   - event    → increase keyword weight in hybrid fusion (rare named
//                entities that keyword search nails while vector smears)
//   - general  → default semantic (no adjustment)
//
// All adjustments are SUBTLE — they nudge weights, they don't override
// caller-explicit options. If the caller passed `recency: 'off'`, intent
// weighting will NOT silently re-enable it. The classifier is a default,
// not a mandate.
//
// Ported from _reference/gbrain/src/core/search/intent-weights.ts. The
// applyExactMatchBoost helper is adapted to Graphbrain's SearchResult shape
// (page.slug + page.title live on `result.page`, not the top level).
//
// Pure module. No DB, no LLM, no async.

import type { SearchIntent } from "../types";
import type { SearchResult } from "../types";

/**
 * Weight adjustments to apply for a classified intent. All factors are
 * multiplicative on the existing pipeline weights; the defaults map to
 * 1.0 (no-op) for the `general` intent. A factor > 1.0 increases the
 * weight of that signal; < 1.0 decreases it.
 *
 * Magnitudes were tuned conservatively (max 1.25x boost) so the existing
 * search behavior on ambiguous queries stays close to baseline. The point
 * of the classifier isn't to flip rankings — it's to break ties in favor
 * of the user's plausible intent.
 */
export interface IntentWeights {
  /** Multiplier on the keyword-list rank in RRF fusion. Higher = keyword wins more ties. */
  keywordWeight: number;
  /** Multiplier on the vector-list rank in RRF fusion. Higher = semantic wins more ties. */
  vectorWeight: number;
  /** Recency tilt to suggest when caller hasn't specified one. null = no suggestion. */
  suggestedRecency: "off" | "on" | "strong" | null;
  /** Score multiplier for results whose slug/title exactly matches the (lowercased) query. */
  exactMatchBoost: number;
}

const DEFAULT_WEIGHTS: IntentWeights = {
  keywordWeight: 1.0,
  vectorWeight: 1.0,
  suggestedRecency: null,
  exactMatchBoost: 1.0,
};

const INTENT_WEIGHTS: Record<SearchIntent, IntentWeights> = {
  entity: {
    // Entity queries: "who is X", "tell me about Y". The user knows the
    // name. Reward exact slug/title matches; lean into keyword.
    keywordWeight: 1.15,
    vectorWeight: 1.0,
    suggestedRecency: null,
    exactMatchBoost: 1.25,
  },
  temporal: {
    // Temporal queries: "what happened last week", "meeting prep". Recency
    // tilt is the whole game; keyword and vector stay balanced.
    keywordWeight: 1.0,
    vectorWeight: 1.0,
    suggestedRecency: "on",
    exactMatchBoost: 1.0,
  },
  event: {
    // Event queries: "announcement", "launched", "raised $". Named events
    // have rare entity surface forms that keyword search nails (think
    // company names, dollar amounts). Recency gets a soft tilt too.
    keywordWeight: 1.2,
    vectorWeight: 0.95,
    suggestedRecency: "on",
    exactMatchBoost: 1.1,
  },
  general: DEFAULT_WEIGHTS,
};

/** Lookup the weights for a classified intent. */
export function weightsForIntent(intent: SearchIntent): IntentWeights {
  return INTENT_WEIGHTS[intent] ?? DEFAULT_WEIGHTS;
}

/**
 * Apply the per-list rank weighting before RRF. Caller passes the list
 * source ('keyword' | 'vector') and the weights; we return the effective
 * RRF k constant to use for THAT list. Lower k = stronger boost on top
 * ranks; higher k = flatter contribution. So a higher weight maps to a
 * LOWER k.
 *
 * Default RRF_K is 60. With keywordWeight=1.20, the effective k for the
 * keyword list becomes 60 / 1.20 = 50, which gives top-keyword results
 * a meaningfully stronger contribution to the fused score.
 */
export function effectiveRrfK(baseK: number, weight: number): number {
  if (weight <= 0) return baseK;
  return baseK / weight;
}

/**
 * Apply exact-match boost in place. Mutates each result's score by
 * `weights.exactMatchBoost` when the result's page slug or title
 * (lowercased, trimmed) matches the lowercased query exactly. No-op when
 * the boost is 1.0. Caller re-sorts after.
 *
 * Normalization: slug is matched as-is (slugs are already canonicalized
 * lowercase-kebab); title is lowercased + trimmed. The query is
 * lowercased + trimmed once before the loop. A kebab form is also
 * pre-computed so "garry tan" → "garry-tan" matches the slug.
 */
export function applyExactMatchBoost(
  results: SearchResult[],
  query: string,
  weights: IntentWeights,
): void {
  if (weights.exactMatchBoost === 1.0) return;
  const q = query.toLowerCase().trim();
  if (!q) return;
  const qKebab = q.replace(/\s+/g, "-");
  for (const r of results) {
    const slug = (r.page.slug ?? "").toLowerCase();
    const title = (r.page.title ?? "").toLowerCase().trim();
    if (slug === q || slug === qKebab || slug.endsWith(`/${qKebab}`) || title === q) {
      r.score *= weights.exactMatchBoost;
    }
  }
}
