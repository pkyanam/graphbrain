// @graphbrain/core — search + query operations (Stage 10).
//
// The two retrieval-facing operations:
//   • `search` — thin wrapper over hybridSearch (Stage 9). Returns
//     { results, meta }. Read scope.
//   • `query`  — the flagship think-loop: hybridSearch → LLM synthesis
//     (gateway.chat) over the top-K results → answer with citations.
//     Read scope.
//
// Both ops construct the HybridSearchOpts from the validated input + ctx and
// call hybridSearch(engine, gateway, embeddingService, query, opts, ctx). The
// engine + gateway + embeddingService arrive via ResolvedDeps (the dispatcher
// resolves the engine from ctx.tenant; the gateway + embeddingService are
// app-wide singletons).
//
// Ported from _reference/gbrain/src/core/operations.ts (search + query ops)
// and adapted to Graphbrain's multi-tenant model:
//   • No source_id axis (Phase 1: single brain per tenant).
//   • The query op's synthesis uses gateway.chat (Stage 8) instead of
//     GBrain's runThink multi-round scaffolding. Phase 1 ships a single-pass
//     synthesis; multi-round gap-driven retrieval is Phase 3.

import { z } from "zod";
import { hybridSearch, type HybridSearchOpts } from "../search/hybrid";
import type { SearchMode } from "../types";
import type { SearchResult, Citation, HybridSearchMeta } from "../types";
import type { ChatMessage } from "../ai/types";
import { OperationError } from "./types";
import type { Operation, ResolvedDeps } from "./types";
import type { OperationContext } from "../types";

// ─── search op ───────────────────────────────────────────────────────────────

export const SearchInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),
  mode: z.enum(["conservative", "balanced", "tokenmax"]).optional(),
  typeFilter: z.string().optional(),
  includeDeleted: z.boolean().optional(),
  // Per-call hybrid-knob overrides (win over tenant.settings + mode bundle).
  rerankerEnabled: z.boolean().optional(),
  expansion: z.boolean().optional(),
  relationalRetrieval: z.boolean().optional(),
  tokenBudget: z.number().int().nonnegative().optional(),
  cacheEnabled: z.boolean().optional(),
  rerankModel: z.string().optional(),
});

export type SearchInput = z.infer<typeof SearchInputSchema>;

export interface SearchOutput {
  results: SearchResult[];
  meta: HybridSearchMeta;
}

/**
 * `search` — thin wrapper over hybridSearch. Read scope.
 *
 * Returns the ranked SearchResult[] + HybridSearchMeta. The caller (agent /
 * dashboard / CLI) gets the raw retrieval payload; use `query` when you need
 * a synthesized answer.
 */
export const searchOp: Operation<SearchInput, SearchOutput> = {
  name: "search",
  description:
    "Hybrid search over the tenant's brain: vector + BM25 + graph + RRF + " +
    "rerank + token budget + dedup. Returns ranked results + retrieval meta. " +
    "Use `query` for a synthesized answer with citations.",
  scope: "read",
  inputSchema: SearchInputSchema,
  handler: async (input, ctx, deps) => {
    const opts: HybridSearchOpts = {
      limit: input.limit,
      mode: input.mode as SearchMode | undefined,
      typeFilter: input.typeFilter,
      includeDeleted: input.includeDeleted,
      rerankerEnabled: input.rerankerEnabled,
      expansion: input.expansion,
      relationalRetrieval: input.relationalRetrieval,
      tokenBudget: input.tokenBudget,
      cacheEnabled: input.cacheEnabled,
      rerankModel: input.rerankModel,
    };
    return hybridSearch(deps.engine, deps.gateway, deps.embeddingService, input.query, opts, ctx);
  },
};

// ─── query op (flagship) ─────────────────────────────────────────────────────

export const QueryInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(50).optional(),
  mode: z.enum(["conservative", "balanced", "tokenmax"]).optional(),
  typeFilter: z.string().optional(),
  // Per-call hybrid-knob overrides.
  rerankerEnabled: z.boolean().optional(),
  expansion: z.boolean().optional(),
  relationalRetrieval: z.boolean().optional(),
  tokenBudget: z.number().int().nonnegative().optional(),
  cacheEnabled: z.boolean().optional(),
  rerankModel: z.string().optional(),
  // Synthesis knobs.
  /** Model override for the synthesis LLM call (defaults to tenant chat model). */
  model: z.string().optional(),
  /** Max results to feed the synthesizer (default: min(limit, 10)). */
  synthesisTopK: z.number().int().positive().max(20).optional(),
  /** System prompt override (advanced; defaults to the built-in synthesis prompt). */
  systemPrompt: z.string().optional(),
});

export type QueryInput = z.infer<typeof QueryInputSchema>;

/** One citation in the synthesized answer, mapping a [N] marker to its source. */
export interface QueryCitation {
  /** 1-based citation index matching the [N] marker in the answer. */
  index: number;
  slug: string;
  title: string;
  /** The chunk snippet that grounded this citation. */
  snippet?: string;
  /** Which retrieval stream surfaced this evidence. */
  stream?: string;
}

export interface QueryOutput {
  /** The synthesized answer text, with [N] citation markers. */
  answer: string;
  /** Citations referenced in the answer (1-based index → source page). */
  citations: QueryCitation[];
  /** The search results that grounded the synthesis. */
  results: SearchResult[];
  /** Retrieval metadata (what the pipeline actually ran). */
  meta: HybridSearchMeta;
  /** The model that produced the answer. */
  model: string;
}

/**
 * Default system prompt for the synthesis pass. Instructs the model to answer
 * only from the provided context, cite with [N] markers, and say when the
 * context is insufficient. Ported from GBrain's think-loop synthesis prompt
 * (simplified for Phase 1 single-pass).
 */
export const DEFAULT_SYNTHESIS_SYSTEM_PROMPT = `You are a knowledge synthesis assistant. Answer the user's question using ONLY the provided context passages. Cite every claim with a [N] marker matching the source index. If the context does not contain enough information to answer, say so explicitly — do not fabricate. Be concise and direct.`;

/**
 * Build the chat messages for the synthesis pass: a system prompt + a user
 * message that interleaves the numbered context passages with the question.
 *
 * Each passage is formatted as:
 *   [N] <slug> — <title>
 *   <snippet>
 *
 * The synthesizer is instructed to cite with [N] markers; the caller maps
 * those back to the citations array.
 */
export function buildSynthesisMessages(
  query: string,
  results: SearchResult[],
  systemPrompt: string,
): { messages: ChatMessage[]; citations: QueryCitation[] } {
  const citations: QueryCitation[] = [];
  const passages: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const idx = i + 1;
    // Pick the strongest citation snippet for this result.
    const primaryCitation = r.citations[0];
    const snippet =
      primaryCitation?.snippet ??
      r.chunks[0]?.content ??
      r.page.compiledTruth ??
      "";
    passages.push(`[${idx}] ${r.page.slug} — ${r.page.title}\n${snippet}`);
    citations.push({
      index: idx,
      slug: r.page.slug,
      title: r.page.title,
      snippet: snippet || undefined,
      stream: primaryCitation?.stream,
    });
  }

  const contextBlock = passages.length > 0
    ? `Context passages:\n\n${passages.join("\n\n")}\n\nQuestion: ${query}`
    : `No context passages were retrieved for this question.\n\nQuestion: ${query}`;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: contextBlock },
  ];

  return { messages, citations };
}

/**
 * Extract the [N] citation markers actually used in the answer text, so the
 * caller can prune the citations list to only those referenced.
 */
export function extractUsedCitations(answer: string): Set<number> {
  const used = new Set<number>();
  const re = /\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) {
    used.add(Number.parseInt(m[1]!, 10));
  }
  return used;
}

/**
 * `query` — the flagship think-loop. Read scope.
 *
 * Pipeline:
 *   1. hybridSearch → top-K results + meta.
 *   2. Build a synthesis prompt from the top-K results (numbered passages).
 *   3. gateway.chat → synthesized answer with [N] citation markers.
 *   4. Map [N] markers back to citations; prune to referenced sources.
 *   5. Return { answer, citations, results, meta, model }.
 *
 * Phase 1 ships single-pass synthesis (no gap-driven multi-round retrieval).
 * The `synthesisTopK` knob caps how many results feed the synthesizer
 * (default: min(limit, 10)) to bound the LLM context cost.
 */
export const queryOp: Operation<QueryInput, QueryOutput> = {
  name: "query",
  description:
    "Natural-language query with synthesis: hybrid search → LLM answer with " +
    "citations. The flagship retrieval op. Returns a synthesized answer with " +
    "[N] citation markers, the citation list (1-based index → source page), " +
    "the grounding search results, and retrieval meta.",
  scope: "read",
  inputSchema: QueryInputSchema,
  handler: async (input, ctx, deps) => {
    // ─── 1. Hybrid search ──────────────────────────────────────────────────
    const searchLimit = input.limit ?? 20;
    const opts: HybridSearchOpts = {
      limit: searchLimit,
      mode: input.mode as SearchMode | undefined,
      typeFilter: input.typeFilter,
      rerankerEnabled: input.rerankerEnabled,
      expansion: input.expansion,
      relationalRetrieval: input.relationalRetrieval,
      tokenBudget: input.tokenBudget,
      cacheEnabled: input.cacheEnabled,
      rerankModel: input.rerankModel,
    };
    const { results, meta } = await hybridSearch(
      deps.engine,
      deps.gateway,
      deps.embeddingService,
      input.query,
      opts,
      ctx,
    );

    // ─── 2. Build synthesis prompt ─────────────────────────────────────────
    const topK = input.synthesisTopK ?? Math.min(searchLimit, 10);
    const synthesisResults = results.slice(0, topK);
    const systemPrompt = input.systemPrompt ?? DEFAULT_SYNTHESIS_SYSTEM_PROMPT;
    const { messages, citations } = buildSynthesisMessages(
      input.query,
      synthesisResults,
      systemPrompt,
    );

    // ─── 3. LLM synthesis ──────────────────────────────────────────────────
    let answer: string;
    let model: string;
    try {
      const response = await deps.gateway.chat(
        {
          model: input.model ?? "", // gateway resolves tenant default when empty
          messages,
          temperature: 0.2,
        },
        ctx.tenant,
      );
      answer = response.content;
      model = response.model;
    } catch (err) {
      throw new OperationError(
        "synthesis_failed",
        `LLM synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    // ─── 4. Prune citations to those referenced in the answer ──────────────
    const used = extractUsedCitations(answer);
    const referencedCitations = used.size > 0
      ? citations.filter((c) => used.has(c.index))
      : citations;

    // ─── 5. Return ─────────────────────────────────────────────────────────
    return {
      answer,
      citations: referencedCitations,
      results,
      meta,
      model,
    };
  },
};
