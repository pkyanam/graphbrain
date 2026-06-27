// @graphbrain/core — graph signals: adjacency + session diversification (Stage 9).
//
// Two additive signals applied inside hybridSearch after RRF fusion, pre-dedup:
//
//   1. Adjacency-within-top-K (~1.05x): if a top-K page is linked-to by
//      >=2 OTHER top-K pages, it's a hub for this query — small bump.
//
//   2. Session diversification (~0.95x): if multiple top-K pages share a
//      session prefix (e.g. `chat/2026-05-20-foo/...`), keep the highest-
//      scoring one at full score and DEMOTE the rest. This is MMR-lite:
//      the original framing "boost the cluster" was structurally wrong —
//      the stated motivation was "weak chunks competing for token budget,"
//      which amplification makes worse.
//
// Ported from _reference/gbrain/src/core/search/graph-signals.ts. The
// GBrain version also has a cross-source adjacency signal (~1.10x) that
// fires when a page is linked-to from >=2 distinct OTHER sources.
// Graphbrain Phase 1 is single-source per tenant (each tenant has one
// brain), so cross-source is dormant — the adjacency signal is computed
// in TypeScript from engine.getInEdges (GBrain used a SQL
// `getAdjacencyBoosts` helper; Graphbrain's BrainEngine exposes edge
// methods instead).
//
// Fail-open: any error from the edge lookups returns input unchanged.
// Session diversification ALSO skips on failure (predictable all-or-
// nothing posture).

import type { BrainEngine } from "../engine";
import type { SearchResult } from "../types";

// ─── Constants (conservative magnitudes) ─────────────────────────────────────

/** Multiplier applied when in-set adjacency hits >= ADJACENCY_MIN_HITS. */
export const ADJACENCY_BOOST = 1.05;
/** How many top-ranked results to consider for graph signals. */
export const DEFAULT_TOP_K = 20;
/** Minimum in-set inbound link count before adjacency boost fires. */
export const ADJACENCY_MIN_HITS = 2;
/** Multiplier applied to non-top-scoring members of a session group (DEMOTE). */
export const SESSION_DEMOTE = 0.95;
/** Minimum group size before session diversification fires. */
export const SESSION_MIN_SHARE = 2;

export interface GraphSignalsMeta {
  enabled: boolean;
  topKSize: number;
  adjacencyFires: number;
  sessionDemotions: number;
  errored: boolean;
}

export interface GraphSignalsOpts {
  /** Master gate. False short-circuits to no-op with zero-meta emitted. */
  enabled: boolean;
  /** Top-K size (default DEFAULT_TOP_K). */
  topK?: number;
  /** Observability sink — called once per invocation with fire counts. */
  onMeta?: (meta: GraphSignalsMeta) => void;
}

// ─── Session prefix detection ────────────────────────────────────────────────

const DATE_SEGMENT_RE = /^\d{4}-\d{2}-\d{2}/;
// Only 'chat' / 'session' / 'sessions' are session MARKERS — words that
// indicate "the next segment is a session id." Words like 'transcripts'
// or 'meetings' are CATEGORIES (parents of sessions, not markers
// themselves).
const SESSION_MARKERS = new Set(["chat", "session", "sessions"]);

/**
 * Detect a session-like prefix in a slug. Returns null when the slug isn't
 * session-shaped (entity/topic/docs directory — skip diversification).
 *
 * Examples that ARE sessions (return a real session prefix):
 *   - `your-agent/chat/2026-05-20-foo`           → 'your-agent/chat/2026-05-20-foo'
 *   - `daily/2026-05-20/journal-entry-1`         → 'daily/2026-05-20'
 *   - `meetings/2026-04-03/notes`                → 'meetings/2026-04-03'
 *   - `transcripts/chat/funding-discussion`      → 'transcripts/chat/funding-discussion'
 *
 * Examples that are NOT sessions (return null — no diversification):
 *   - `people/alice`, `people/bob`               → entity directory
 *   - `companies/acme`, `companies/stripe`       → entity directory
 *   - `docs/quickstart`, `docs/api`              → topical directory
 */
export function sessionPrefix(slug: string): string | null {
  if (!slug.includes("/")) return null;
  const segments = slug.split("/");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (SESSION_MARKERS.has(seg)) {
      // Session id is segment i+1 (or the marker itself if i+1 doesn't exist).
      const sessionIdIdx = Math.min(i + 1, segments.length - 1);
      return segments.slice(0, sessionIdIdx + 1).join("/");
    }
    if (DATE_SEGMENT_RE.test(seg)) {
      // Date anchor — session is everything up to and including the date.
      return segments.slice(0, i + 1).join("/");
    }
  }
  return null;
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Apply selective graph signals to a sorted-desc results array. Mutates
 * `score` in place; caller re-sorts after.
 *
 * Behavior:
 *   1. If !enabled or empty results → no-op + zero-meta.
 *   2. Adjacency: for each top-K page, count how many OTHER top-K pages
 *      link to it (via engine.getInEdges). If >= ADJACENCY_MIN_HITS,
 *      multiply score by ADJACENCY_BOOST.
 *   3. Session diversification: single-pass Map<prefix, members>; highest-
 *      scoring keeps full score, others * SESSION_DEMOTE.
 *   4. Fail-open on engine error: return unchanged (session diversification
 *      also skips — predictable all-or-nothing posture).
 */
export async function applyGraphSignals(
  results: SearchResult[],
  engine: BrainEngine,
  opts: GraphSignalsOpts,
): Promise<void> {
  const meta: GraphSignalsMeta = {
    enabled: opts.enabled,
    topKSize: 0,
    adjacencyFires: 0,
    sessionDemotions: 0,
    errored: false,
  };

  if (!opts.enabled || results.length === 0) {
    opts.onMeta?.(meta);
    return;
  }

  const topKSize = opts.topK ?? DEFAULT_TOP_K;
  const topK = results.slice(0, topKSize);
  meta.topKSize = topK.length;

  // ---- Adjacency ----
  // For each top-K page, count inbound edges from OTHER top-K pages.
  // Phase 1 is single-source per tenant, so cross-source is dormant.
  const topKSlugs = new Set(topK.map((r) => r.page.slug));
  const inboundCounts = new Map<string, number>();
  try {
    // Batch: for each top-K page, fetch its inbound edges and count how
    // many come from other top-K pages. getInEdges returns Link[] with
    // fromSlug + toSlug.
    await Promise.all(
      topK.map(async (r) => {
        const inEdges = await engine.getInEdges(r.page.slug);
        let count = 0;
        for (const e of inEdges) {
          // Count only edges from OTHER top-K pages (exclude self-loops).
          if (e.fromSlug !== r.page.slug && topKSlugs.has(e.fromSlug)) {
            count++;
          }
        }
        inboundCounts.set(r.page.slug, count);
      }),
    );
  } catch {
    // Fail-open: caller's results are unchanged. Session diversification
    // also skips (predictable all-or-nothing posture).
    meta.errored = true;
    opts.onMeta?.(meta);
    return;
  }

  for (const r of topK) {
    const hits = inboundCounts.get(r.page.slug) ?? 0;
    if (hits >= ADJACENCY_MIN_HITS) {
      r.score *= ADJACENCY_BOOST;
      meta.adjacencyFires++;
    }
  }

  // ---- Session diversification (single-pass Map, DEMOTE non-top members) ----
  // Only fires when sessionPrefix detects a session-like pattern. Non-session
  // slugs (entity directories like `people/`, `companies/`, topical dirs like
  // `docs/`) skip diversification entirely.
  const sessionGroups = new Map<string, SearchResult[]>();
  for (const r of topK) {
    const prefix = sessionPrefix(r.page.slug);
    if (prefix === null) continue;
    let group = sessionGroups.get(prefix);
    if (!group) {
      group = [];
      sessionGroups.set(prefix, group);
    }
    group.push(r);
  }
  for (const [, members] of sessionGroups) {
    if (members.length < SESSION_MIN_SHARE) continue;
    // Highest-scoring member keeps full score; others demoted. Sort by
    // current score (post-adjacency boost) descending so the representative
    // is whichever member scored highest AFTER any adjacency boost. Stable
    // for ties via slug for determinism.
    members.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.page.slug.localeCompare(b.page.slug);
    });
    for (let i = 1; i < members.length; i++) {
      members[i]!.score *= SESSION_DEMOTE;
      meta.sessionDemotions++;
    }
  }

  opts.onMeta?.(meta);
}
