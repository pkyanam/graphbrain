// @graphbrain/core — deterministic query intent classifier (Stage 9).
//
// Zero-LLM classifier that labels a query with one of four intents:
//   entity / temporal / event / general
//
// Ported from _reference/gbrain/src/core/search/query-intent.ts (the
// classifyQueryIntent + intentToDetail portions). The full GBrain classifier
// also emits salience/recency/modality axes; Graphbrain Phase 1 only needs the
// intent axis (the HybridSearchMeta carries `intent` + `detailResolved`).
// The recency/salience axes are folded into the intent-weights map
// (./intent-weights.ts) as suggestedRecency — see that file.
//
// Pure module. No DB, no LLM, no async. Tested in test/search/intent.test.ts.

import type { SearchIntent } from "../types";

/**
 * Detail-resolution suggestion derived from the classified intent.
 *   entity   → low    (the user knows the name; one canonical page is enough)
 *   temporal → high   (the user wants the timeline; pull more chunks)
 *   event    → high   (named events have rare surface forms; pull more)
 *   general  → undefined (no suggestion; caller default wins)
 */
export type DetailSuggestion = "low" | "medium" | "high" | undefined;

export interface IntentClassification {
  intent: SearchIntent;
  suggestedDetail: DetailSuggestion;
}

// ─── Pattern banks ───────────────────────────────────────────────────────────

// "give me everything about X" / "full history of Y" — full-context queries
// are temporal-shaped (the user wants the whole timeline).
const FULL_CONTEXT_PATTERNS = [
  /\beverything\b/i,
  /\ball\s+(about|info|information|details)\b/i,
  /\bfull\s+(history|context|picture|story|details)\b/i,
  /\bcomprehensive\b/i,
  /\bdeep\s+dive\b/i,
  /\bgive\s+me\s+everything\b/i,
];

const TEMPORAL_PATTERNS = [
  /\bwhen\b/i,
  /\blast\s+(met|meeting|call|conversation|chat|talked|spoke|seen|heard|time)\b/i,
  /\brecent(ly)?\b/i,
  /\bhistory\b/i,
  /\btimeline\b/i,
  /\bmeeting\s+notes?\b/i,
  /\bwhat('s| is| was)\s+new\b/i,
  /\blatest\b/i,
  /\bupdate(s)?\s+(on|from|about)\b/i,
  /\bhow\s+long\s+(ago|since)\b/i,
  /\b\d{4}[-/]\d{2}\b/i,
  /\blast\s+(week|month|quarter|year)\b/i,
];

const EVENT_PATTERNS = [
  /\bannounce[ds]?(ment)?\b/i,
  /\blaunch(ed|es|ing)?\b/i,
  /\braised?\s+\$?\d/i,
  /\bfund(ing|raise)\b/i,
  /\bIPO\b/i,
  /\bacquisition\b/i,
  /\bmerge[drs]?\b/i,
  /\bnews\b/i,
  /\bhappened?\b/i,
];

const ENTITY_PATTERNS = [
  /\bwho\s+is\b/i,
  /\bwhat\s+(is|does|are)\b/i,
  /\btell\s+me\s+about\b/i,
  /\bdescribe\b/i,
  /\bsummar(y|ize)\b/i,
  /\boverview\b/i,
  /\bbackground\b/i,
  /\bprofile\b/i,
  /\bwhat\s+do\s+(you|we)\s+know\b/i,
];

// ─── Classifier ──────────────────────────────────────────────────────────────

function matches(patterns: RegExp[], q: string): boolean {
  for (const re of patterns) {
    if (re.test(q)) return true;
  }
  return false;
}

/**
 * Classify a query into one of four intents. Priority (matches GBrain
 * v0.29.0): full-context > temporal > event > entity > general.
 *
 * Pure function. Deterministic. No LLM, no DB.
 */
export function classifyIntent(query: string): SearchIntent {
  if (matches(FULL_CONTEXT_PATTERNS, query)) return "temporal";
  if (matches(TEMPORAL_PATTERNS, query)) return "temporal";
  if (matches(EVENT_PATTERNS, query)) return "event";
  if (matches(ENTITY_PATTERNS, query)) return "entity";
  return "general";
}

/**
 * Map an intent to a detail-resolution suggestion.
 *   entity   → low
 *   temporal → high
 *   event    → high
 *   general  → undefined (no suggestion)
 */
export function intentToDetail(intent: SearchIntent): DetailSuggestion {
  switch (intent) {
    case "entity":
      return "low";
    case "temporal":
      return "high";
    case "event":
      return "high";
    case "general":
      return undefined;
  }
}

/**
 * Full classification: intent + suggested detail. Convenience wrapper so
 * hybridSearch makes one call instead of two.
 */
export function classifyQuery(query: string): IntentClassification {
  const intent = classifyIntent(query);
  return { intent, suggestedDetail: intentToDetail(intent) };
}
