// @graphbrain/core — LLM multi-query expansion (Stage 9).
//
// Generates alternative phrasings of a query so the lexical + vector arms
// can match paraphrases the original phrasing missed. Opt-in via the mode
// bundle's `expansion` knob (tokenmax only; off for conservative/balanced).
//
// Sanitization layer (prompt-injection defense) stays HERE, not in the
// gateway: the gateway is provider-agnostic; sanitization is Graphbrain's
// responsibility.
//
// Ported from _reference/gbrain/src/core/search/expansion.ts. GBrain's
// version calls `gateway.expand()` (a dedicated recipe); Graphbrain's
// AIGateway exposes `chat()`, so expansion is implemented as a JSON-mode
// chat completion with a constrained prompt. The sanitization helpers
// (sanitizeQueryForPrompt + sanitizeExpansionOutput) are ported verbatim.
//
// Fail-open: any error (no key, network, malformed JSON) returns `[query]`
// — the original query alone. Search reliability beats expansion quality.

import type { AIGateway } from "../ai/gateway";
import type { Tenant } from "../types";

const MAX_QUERIES = 3;
const MIN_WORDS = 3;
const MAX_QUERY_CHARS = 500;

/**
 * Defense-in-depth sanitization for user queries before they reach the LLM.
 * Strips code fences, HTML tags, and prompt-injection prefixes. Truncates
 * to MAX_QUERY_CHARS. Never logs the query text itself (privacy).
 */
export function sanitizeQueryForPrompt(query: string): string {
  let q = query;
  if (q.length > MAX_QUERY_CHARS) q = q.slice(0, MAX_QUERY_CHARS);
  q = q.replace(/```[\s\S]*?```/g, " ");
  q = q.replace(/<\/?[a-zA-Z][^>]*>/g, " ");
  q = q.replace(/^(\s*(ignore|forget|disregard|override|system|assistant|human)[\s:]+)+/gi, "");
  q = q.replace(/\s+/g, " ").trim();
  return q;
}

/**
 * Validate LLM-produced alternative queries. LLM output is untrusted.
 * Strips control chars, dedups case-insensitively, caps at 2 alternatives
 * (so the total expansion is original + 2 = 3, matching MAX_QUERIES).
 */
export function sanitizeExpansionOutput(alternatives: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of alternatives) {
    if (typeof raw !== "string") continue;
    let s = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
    if (s.length === 0) continue;
    if (s.length > MAX_QUERY_CHARS) s = s.slice(0, MAX_QUERY_CHARS);
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 2) break;
  }
  return out;
}

/** Cheap word counter (whitespace split). Queries below MIN_WORDS skip expansion. */
function countWords(query: string): number {
  const trimmed = query.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

const EXPANSION_SYSTEM_PROMPT =
  "You are a search query expansion assistant. Given a user query, generate " +
  "2 alternative phrasings that a relevant document might use. Return a JSON " +
  'object: {"alternatives": ["alt1", "alt2"]}. No preamble, no explanation.';

/**
 * Expand a query into up to MAX_QUERIES phrasings (original + alternatives).
 *
 * Flow:
 *   1. Short queries (< MIN_WORDS) skip expansion → [query].
 *   2. Sanitize the query (strip injection patterns).
 *   3. Call gateway.chat with JSON mode + a constrained prompt.
 *   4. Parse the JSON, sanitize the alternatives.
 *   5. Return [original, ...alternatives] deduped, capped at MAX_QUERIES.
 *
 * Fail-open: any error returns [query]. Search reliability beats expansion.
 *
 * @param query   The original user query.
 * @param gateway The AIGateway (chat is called with the platform default model).
 * @param tenant  Optional tenant (for model resolution; system-level calls omit).
 * @returns        Array of query phrasings, original first. Never empty.
 */
export async function expandQuery(
  query: string,
  gateway: AIGateway,
  tenant?: Pick<Tenant, "settings">,
): Promise<string[]> {
  if (countWords(query) < MIN_WORDS) return [query];

  try {
    const sanitized = sanitizeQueryForPrompt(query);
    if (sanitized.length === 0) return [query];

    const res = await gateway.chat(
      {
        // Empty model → gateway resolves per-call → tenant → config default.
        model: "",
        messages: [
          { role: "system", content: EXPANSION_SYSTEM_PROMPT },
          { role: "user", content: sanitized },
        ],
        temperature: 0,
        responseFormat: "json",
        maxTokens: 200,
      },
      tenant,
    );

    const parsed = safeParseAlternatives(res.content);
    const alts = sanitizeExpansionOutput(parsed);
    const all = [query, ...alts];
    // Dedup case-insensitively, preserving first-seen order + original casing.
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const q of all) {
      const key = q.toLowerCase().trim();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(q);
      if (unique.length >= MAX_QUERIES) break;
    }
    return unique;
  } catch {
    // Fail-open: network error, malformed JSON, provider error — return original.
    return [query];
  }
}

/** Best-effort parse of the LLM's JSON response. Returns [] on any failure. */
function safeParseAlternatives(content: string): unknown[] {
  try {
    const obj = JSON.parse(content);
    if (obj && typeof obj === "object" && Array.isArray(obj.alternatives)) {
      return obj.alternatives;
    }
    // Some models wrap in a different shape; tolerate a bare array.
    if (Array.isArray(obj)) return obj;
    return [];
  } catch {
    // Not valid JSON — try to extract a JSON blob from surrounding prose.
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const obj = JSON.parse(match[0]);
        if (obj && typeof obj === "object" && Array.isArray(obj.alternatives)) {
          return obj.alternatives;
        }
      } catch {
        /* give up */
      }
    }
    return [];
  }
}
