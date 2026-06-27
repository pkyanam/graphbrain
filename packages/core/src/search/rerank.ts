// @graphbrain/core — cross-encoder rerank via gateway.rerank (Stage 9).
//
// Slots into hybridSearch after dedup and before token-budget enforcement.
// Takes the top `topNIn` candidates by current RRF order, sends them to
// `gateway.rerank()`, and re-orders by the cross-encoder's relevance score.
// The un-reranked long tail keeps its original RRF order — preserves recall
// vs. truncating to topNIn.
//
// Fail-open posture (ported from _reference/gbrain/src/core/search/rerank.ts):
// every error class returns the original RRF order unchanged. Search
// reliability beats reranker quality; a flaky upstream must never break
// search.
//
// Caller (hybridSearch) decides whether the reranker fires via
// `tenant.settings.rerankerEnabled` (defaults false). The gateway's rerank
// throws if no model is set — the caller MUST check rerankerEnabled first
// and skip rerank when disabled. This module resolves a default rerank model
// (DEFAULT_RERANK_MODEL) and passes it to gateway.rerank.
//
// Adapted to Graphbrain's SearchResult shape: the document text sent to the
// reranker is the matched chunk content (falls back to page title).

import type { AIGateway } from "../ai/gateway";
import type { SearchResult, Tenant } from "../types";

/**
 * Default rerank model. PLAN.md's routing table lists cohere:rerank-v3.5
 * or zeroentropy:zerank-2. There is no platform-wide default in config —
 * the gateway's rerank throws if req.model is empty. Stage 9 resolves this
 * constant and passes it to gateway.rerank. A tenant can override via
 * per-call opts.rerankModel (future; not wired in Phase 1).
 */
export const DEFAULT_RERANK_MODEL = "cohere:rerank-v3.5";

export interface RerankerOpts {
  /** Master gate. False short-circuits to no-op. */
  enabled: boolean;
  /** How many of the top results to send to the reranker (default 30). */
  topNIn: number;
  /** Truncate the reranked output to this many (null = no truncate). */
  topNOut: number | null;
  /** Provider:model override. When undefined, DEFAULT_RERANK_MODEL is used. */
  model?: string;
}

/**
 * Reorder the top `topNIn` results by reranker relevance score. The
 * un-reranked tail (any rows past topNIn) preserves its original RRF
 * position — appended after the reordered head in the same order it had
 * coming in.
 *
 * On reranker failure, returns the input array unmodified. Never throws.
 *
 * Empty input passes through immediately (no upstream call).
 *
 * @param query    The original user query (cross-encoder input).
 * @param results  The post-dedup, post-RRF result list (sorted desc by score).
 * @param opts     Reranker options (enabled, topNIn, topNOut, model).
 * @param gateway  The AIGateway (rerank is called with the resolved model).
 * @param tenant   Optional tenant (for future per-tenant rerank model resolution).
 */
export async function applyReranker(
  query: string,
  results: SearchResult[],
  opts: RerankerOpts,
  gateway: AIGateway,
  tenant?: Pick<Tenant, "settings">,
): Promise<SearchResult[]> {
  if (!opts.enabled || results.length === 0) return results;
  if (opts.topNIn <= 0) return results;

  const head = results.slice(0, opts.topNIn);
  const tail = results.slice(opts.topNIn);

  // Document text — the matched chunk content is the evidence span. Fall
  // back to page title if no chunks (defensive; shouldn't happen in practice).
  const documents = head.map((r) => {
    const chunkText = r.chunks[0]?.content;
    if (chunkText && chunkText.length > 0) return chunkText;
    return r.page.title || "";
  });

  let reranked: { index: number; relevanceScore: number }[];
  try {
    const model = opts.model ?? DEFAULT_RERANK_MODEL;
    const res = await gateway.rerank(
      { model, query, documents },
      tenant,
    );
    reranked = res.results.map((r) => ({ index: r.index, relevanceScore: r.relevanceScore }));
  } catch {
    // Fail-open: any error (auth, network, timeout, rate-limit, payload-too-
    // large, unknown) returns the original RRF order unchanged.
    return results;
  }

  // Defensive: if the reranker returned a malformed shape, pass through.
  if (!Array.isArray(reranked) || reranked.length === 0) return results;

  // Build the reordered head. We keep ONLY indices the reranker returned
  // (so a top_n response with fewer items than head.length naturally drops
  // the missing ones — but since we don't pass top_n by default, every
  // input gets a score).
  const seen = new Set<number>();
  const reorderedHead: SearchResult[] = [];
  for (const r of reranked) {
    if (r.index >= 0 && r.index < head.length && !seen.has(r.index)) {
      seen.add(r.index);
      const item = head[r.index]!;
      reorderedHead.push(item);
    }
  }
  // If the reranker dropped some head items (rare; usually only happens
  // with explicit top_n), preserve their original positions at the end of
  // the head section so we don't silently lose recall.
  for (let i = 0; i < head.length; i++) {
    if (!seen.has(i)) reorderedHead.push(head[i]!);
  }

  const combined = [...reorderedHead, ...tail];
  return opts.topNOut !== null && opts.topNOut > 0
    ? combined.slice(0, opts.topNOut)
    : combined;
}
