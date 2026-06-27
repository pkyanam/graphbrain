// @graphbrain/core — relational recall arm (typed-edge retrieval, Stage 9).
//
// Turns a relational query into a ranked list of edge-derived candidates
// that hybridSearch injects as a fourth RRF arm (alongside lexical + vector
// + expansion), so a relationship answer competes for ranking instead of
// relying on lexical or vector similarity to surface it.
//
// Flow:  parseRelationalQuery → resolve seed entity (via engine.getPage) →
//   engine.traverse (walk the typed-edge graph) → hydrate to SearchResult
//   rows (page-level key for chunkless entity pages).
//
// Simplified for Phase 1 (per IMPLEMENTATION.md + handoff note 7): the
// typed edges available are in TYPED_EDGE_LABELS (MENTIONS + WORKS_AT,
// FOUNDED, INVESTED_IN, ATTENDED, ADVISES, …). The GBrain version uses
// `engine.relationalFanout` + `resolveEntitySlugWithSource` (federated,
// confidence-gated). Graphbrain Phase 1 is single-source per tenant, so
// seed resolution is a direct `engine.getPage(seedPhrase)` (after
// slugifying the phrase). Fail-open: any error returns an empty arm.
//
// Determinism: parses the ORIGINAL query (never an LLM-expanded variant);
// traversal is deterministic. Fail-open: any error returns an empty arm,
// never breaking the search hot path.

import type { BrainEngine } from "../engine";
import type { SearchResult, RetrievalStream, EdgeLabel } from "../types";
import { TYPED_EDGE_LABELS } from "../types";

export interface RelationalArmMeta {
  fired: boolean;
  seed: string | undefined;
  hops: number;
  candidates: number;
  errored: boolean;
}

export interface RelationalArmOpts {
  /** Traversal depth (hops). Default 2. */
  depth?: number;
  /** Max candidates to return. Default 25. */
  limit?: number;
  /** Observability sink — called once per invocation with fire counts. */
  onMeta?: (meta: RelationalArmMeta) => void;
}

// ─── Relational query parser ─────────────────────────────────────────────────

export type RelationalKind = "who_rel" | "who_at" | "connects" | "intro";
export type RelationDirection = "in" | "out" | "both";

export interface RelationalQuery {
  kind: RelationalKind;
  /** Raw entity phrases to resolve, in query order. 1 for most, 2 for connects. */
  seeds: string[];
  /** Typed edges to traverse, or null for type-agnostic traversal. */
  linkTypes: EdgeLabel[] | null;
  /** Traversal direction from the seed. */
  direction: RelationDirection;
  /** The matched relation phrase, for telemetry. */
  relationPhrase: string;
}

// Seeds that are pronouns / generic nouns, not entities. If a pattern's seed
// cleans down to one of these, the parse is rejected (precision-first).
const STOPWORD_SEEDS: ReadonlySet<string> = new Set([
  "it", "that", "this", "them", "these", "those", "here", "there",
  "everyone", "anyone", "someone", "anybody", "somebody", "people",
  "things", "us", "me", "him", "her", "you", "who", "what", "which",
]);

/** Known typed-edge labels ingest can actually produce. */
const KNOWN_LINK_TYPES: ReadonlySet<string> = new Set(TYPED_EDGE_LABELS);

// Maps a relation verb to the typed edges it implies. The verb regex is
// anchored to the seed phrase so "who invested TIME in learning Rust" does
// not match "who invested in <seed>".
interface VerbSpec {
  verb: string;
  linkTypes: EdgeLabel[];
  direction: RelationDirection;
}

const VERB_SPECS: VerbSpec[] = [
  { verb: "invested\\s+in", linkTypes: ["INVESTED_IN"], direction: "in" },
  { verb: "founded", linkTypes: ["FOUNDED"], direction: "in" },
  { verb: "works\\s+at|working\\s+at|employed\\s+at", linkTypes: ["WORKS_AT"], direction: "in" },
  { verb: "attended", linkTypes: ["ATTENDED"], direction: "out" },
  { verb: "advises|advised\\s+by|advisor\\s+to", linkTypes: ["ADVISES"], direction: "both" },
];

// "who introduced me to X" / "what connects A and B" — type-agnostic traversal
// (Graphbrain has no INTRODUCED/KNOWS edge; any edge touching the seed is the
// signal). intro is single-seed (the introducee); connects is two-seed.
const INTRO_RE = /\b(?:who\s+)?introduc(?:ed|es|ing)\s+(?:me\s+)?to\s+(.{1,80}?)(?:\.|$)/i;
const CONNECTS_RE =
  /\bwhat\s+connects\s+(.{1,80}?)\s+(?:and|to|with)\s+(.{1,80}?)(?:\.|$)/i;
const WHO_REL_RE = /\bwho\s+(?:invested\s+in|founded|works\s+at|working\s+at|employed\s+at|attended|advises|advised\s+by|advisor\s+to)\s+(.{1,80}?)(?:\.|$)/i;
const WHO_AT_RE = /\bwho\s+at\s+(.{1,80}?)\s+(?:works|is|does|built|built|wrote|shipped|leads|owns|maintains)(?:\.|$)/i;

/**
 * Detect a relational query. Returns null when the query isn't relational
 * (the arm no-ops). Precision-first: patterns require the relation phrase
 * and the entity to be adjacent, and the seed must not be a stopword.
 *
 * Pure function. Deterministic. No LLM, no DB.
 */
export function parseRelationalQuery(query: string): RelationalQuery | null {
  // connects (two seeds) — check first so "what connects A and B" wins over
  // a who_rel match on the same query.
  const connectsMatch = query.match(CONNECTS_RE);
  if (connectsMatch) {
    const a = cleanSeed(connectsMatch[1] ?? "");
    const b = cleanSeed(connectsMatch[2] ?? "");
    if (a && b && !isStopword(a) && !isStopword(b)) {
      return {
        kind: "connects",
        seeds: [a, b],
        linkTypes: null, // type-agnostic
        direction: "both",
        relationPhrase: "connects",
      };
    }
  }

  // intro — "who introduced me to X"
  const introMatch = query.match(INTRO_RE);
  if (introMatch) {
    const seed = cleanSeed(introMatch[1] ?? "");
    if (seed && !isStopword(seed)) {
      return {
        kind: "intro",
        seeds: [seed],
        linkTypes: null, // type-agnostic
        direction: "both",
        relationPhrase: "introduced to",
      };
    }
  }

  // who_rel — "who invested in X" / "who founded X" / etc.
  const whoRelMatch = query.match(WHO_REL_RE);
  if (whoRelMatch) {
    const seed = cleanSeed(whoRelMatch[1] ?? "");
    if (seed && !isStopword(seed)) {
      // Determine link types + direction from the matched verb.
      const verbText = query.slice(0, (whoRelMatch.index ?? 0) + whoRelMatch[0].length);
      for (const spec of VERB_SPECS) {
        const re = new RegExp(`\\b${spec.verb}\\b`, "i");
        if (re.test(verbText)) {
          return {
            kind: "who_rel",
            seeds: [seed],
            linkTypes: spec.linkTypes,
            direction: spec.direction,
            relationPhrase: spec.verb.replace(/\\s\+/g, " "),
          };
        }
      }
    }
  }

  // who_at — "who at X works on Y" (single seed = the org)
  const whoAtMatch = query.match(WHO_AT_RE);
  if (whoAtMatch) {
    const seed = cleanSeed(whoAtMatch[1] ?? "");
    if (seed && !isStopword(seed)) {
      return {
        kind: "who_at",
        seeds: [seed],
        linkTypes: ["WORKS_AT"],
        direction: "in",
        relationPhrase: "who at",
      };
    }
  }

  return null;
}

/** Clean a captured seed phrase: trim, strip trailing punctuation, collapse whitespace. */
function cleanSeed(raw: string): string {
  return raw
    .replace(/[\s]+/g, " ")
    .replace(/[.,;:!?]+$/g, "")
    .trim();
}

function isStopword(seed: string): boolean {
  return STOPWORD_SEEDS.has(seed.toLowerCase());
}

// ─── Seed resolution + traversal ─────────────────────────────────────────────

/**
 * Slugify a seed phrase: lowercase, replace whitespace with hyphens, strip
 * non-alphanumeric (except hyphens). Matches GBrain's slug convention.
 */
export function slugifySeed(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Resolve a seed phrase to a page slug. Tries the slugified form directly
 * via engine.getPage; returns null if no page exists at that slug.
 *
 * Phase 1 simplification: GBrain's `resolveEntitySlugWithSource` does
 * fuzzy title matching + federated source enumeration. Phase 1 is single-
 * source per tenant, so a direct slug lookup is the natural first step.
 * A future fuzzy-title resolver would slot in here.
 */
async function resolveSeed(
  engine: BrainEngine,
  phrase: string,
): Promise<string | null> {
  const slug = slugifySeed(phrase);
  if (!slug) return null;
  const page = await engine.getPage(slug);
  return page ? page.slug : null;
}

/**
 * Build the relational recall arm. Returns an empty list (pure no-op) when
 * the query isn't relational or no seed resolves. Never throws.
 */
export async function buildRelationalArm(
  engine: BrainEngine,
  query: string,
  opts: RelationalArmOpts = {},
): Promise<SearchResult[]> {
  const meta: RelationalArmMeta = {
    fired: false,
    seed: undefined,
    hops: opts.depth ?? 2,
    candidates: 0,
    errored: false,
  };
  const finish = (list: SearchResult[]) => {
    meta.candidates = list.length;
    opts.onMeta?.(meta);
    return list;
  };

  const parsed = parseRelationalQuery(query);
  if (!parsed) return finish([]);

  try {
    const depth = opts.depth ?? 2;
    const limit = opts.limit ?? 25;

    if (parsed.kind === "connects" && parsed.seeds.length === 2) {
      // Resolve both endpoints; both must resolve or the arm no-ops.
      const slugA = await resolveSeed(engine, parsed.seeds[0]!);
      const slugB = await resolveSeed(engine, parsed.seeds[1]!);
      if (!slugA || !slugB) return finish([]);
      meta.seed = `${slugA} ↔ ${slugB}`;

      // Traverse from both endpoints; shared midpoints are nodes reachable
      // from BOTH (excluding the endpoints themselves).
      const [fanA, fanB] = await Promise.all([
        engine.traverse(slugA, { direction: parsed.direction, depth, limit }),
        engine.traverse(slugB, { direction: parsed.direction, depth, limit }),
      ]);
      const bByKey = new Map(fanB.map((n) => [n.slug, n] as const));
      const endpointSlugs = new Set([slugA, slugB]);
      const shared = fanA
        .filter((n) => bByKey.has(n.slug) && !endpointSlugs.has(n.slug))
        .sort((a, b) => (a.distance + (bByKey.get(a.slug)?.distance ?? 0)) - (b.distance + (bByKey.get(b.slug)?.distance ?? 0)))
        .slice(0, limit);
      const list = await hydrate(engine, shared, "relational");
      meta.fired = list.length > 0;
      return finish(list);
    }

    // who_rel / who_at / intro: single seed.
    const seedSlug = await resolveSeed(engine, parsed.seeds[0]!);
    if (!seedSlug) return finish([]);
    meta.seed = seedSlug;

    const nodes = await engine.traverse(seedSlug, {
      direction: parsed.direction,
      edgeTypes: parsed.linkTypes ?? undefined,
      depth,
      limit,
    });
    // Exclude the seed itself (traverse already filters distance=0, but
    // double-check the slug).
    const filtered = nodes.filter((n) => n.slug !== seedSlug).slice(0, limit);
    const list = await hydrate(engine, filtered, "relational");
    meta.fired = list.length > 0;
    return finish(list);
  } catch {
    meta.errored = true;
    return finish([]);
  }
}

/**
 * Hydrate traversal nodes into SearchResult rows. Fetches the full Page for
 * each slug (traverse returns id/slug/title/type/distance only). Page-level
 * key: chunkless entity pages get an empty chunks array + a compiled_truth
 * citation. Fail-open: a missing page is skipped (not an error).
 */
async function hydrate(
  engine: BrainEngine,
  nodes: { id: string; slug: string; title: string; type: string; distance: number }[],
  _stream: RetrievalStream,
): Promise<SearchResult[]> {
  if (nodes.length === 0) return [];
  const out: SearchResult[] = [];
  for (const n of nodes) {
    const page = await engine.getPage(n.slug);
    if (!page) continue; // fail-open: skip missing pages
    out.push({
      page,
      chunks: [], // chunkless entity page — page-level key
      score: 0, // rank-based: RRF derives score from list position
      sources: ["relational"],
      citations: [{ chunkId: null, slug: page.slug, stream: "relational" }],
    });
  }
  return out;
}

/** Re-export for tests that want to validate the parser directly. */
export { KNOWN_LINK_TYPES };
