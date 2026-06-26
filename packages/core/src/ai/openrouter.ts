// @graphbrain/core — OpenRouterProvider: thin fetch-based REST client.
//
// Implements AIProvider against OpenRouter's OpenAI-compatible API:
//   • POST /chat/completions  — chat (OpenAI shape: choices[0].message.content)
//   • POST /embeddings        — embeddings (OpenAI shape: data[].embedding)
//   • POST /rerank            — rerank (OpenRouter-native: results[].relevance_score)
//
// Base URL: https://openrouter.ai/api/v1 (overridable via constructor for
// tests / proxies). Headers on every request:
//   Authorization: Bearer <apiKey>
//   HTTP-Referer: https://graphbrain.belweave.ai   (app attribution — required
//     for OpenRouter leaderboard entries per https://openrouter.ai/docs)
//   X-OpenRouter-Title: graphbrain                 (preferred title header)
//   X-Title: graphbrain                            (back-compat alias)
//   Content-Type: application/json
//
// Model id conversion: callers pass "provider:model" (e.g.
// "anthropic:claude-sonnet-4-6"); this provider converts to "provider/model"
// (e.g. "anthropic/claude-sonnet-4-6") which is OpenRouter's wire format.
// If the model already contains "/", it's passed through unchanged (some
// OpenRouter model ids use sub-paths).
//
// Rerank endpoint: confirmed via OpenRouter's API reference
// (https://openrouter.ai/docs/api/api-reference/rerank/create-rerank) —
// POST /rerank with {model, query, documents, top_n} returning
// {results: [{index, relevance_score, document: {text}}]}. This is a
// first-class OpenRouter endpoint, NOT a chat/completions passthrough.
//
// NO new dependencies. Uses the built-in `fetch` (Bun/Node 18+). The
// reference GBrain gateway uses the Vercel AI SDK (ai + @ai-sdk/*); that
// dependency is intentionally NOT ported — it adds provider-specific factory
// wiring and a larger dep surface for no Phase-1 benefit. This client is
// ~150 lines of fetch + JSON mapping.
//
// Error mapping: non-2xx responses throw `AIProviderError` with the HTTP
// status. The gateway's retry loop branches on `error.retryable`
// (429 + 5xx → retry; 4xx → fail fast).

import type { AIProvider } from "./provider";
import type {
  ChatRequest,
  ChatResponse,
  EmbedRequest,
  EmbedResponse,
  RerankRequest,
  RerankResponse,
  RerankResult,
  Usage,
} from "./types";
import { AIProviderError } from "./types";

/** Default OpenRouter API base URL. */
export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/** Default attribution headers (PLAN.md "OpenRouter integration"). */
export const OPENROUTER_DEFAULT_REFERER = "https://graphbrain.belweave.ai";
export const OPENROUTER_DEFAULT_TITLE = "graphbrain";

export interface OpenRouterProviderOptions {
  apiKey: string;
  /** Base URL override (defaults to the public OpenRouter API). */
  baseUrl?: string;
  /** HTTP-Referer override (defaults to graphbrain.belweave.ai). */
  referer?: string;
  /** X-OpenRouter-Title / X-Title override (defaults to "graphbrain"). */
  title?: string;
  /** Inject a custom fetch (test seam). Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Convert a "provider:model" id to OpenRouter's "provider/model" wire format.
 * Passes through ids that already contain "/" (some OpenRouter ids use
 * sub-paths like "openai/gpt-4o-2024-08-06"). Throws on ids with no provider
 * prefix (OpenRouter requires the provider/ prefix to route).
 */
export function toOpenRouterModelId(model: string): string {
  if (model.includes("/")) return model;
  const colonIdx = model.indexOf(":");
  if (colonIdx <= 0) {
    throw new AIProviderError(
      `OpenRouter model id must be "provider:model" or "provider/model", got: ${model}`,
    );
  }
  return model.slice(0, colonIdx) + "/" + model.slice(colonIdx + 1);
}

/**
 * OpenRouterProvider — fetch-based REST client implementing AIProvider.
 *
 * Stateless beyond the constructor config (apiKey, baseUrl, headers, fetch).
 * Safe to share across concurrent calls. The AIGateway holds one instance
 * for the platform key; a per-tenant BYO-key instance would be constructed
 * on demand (Phase 2).
 */
export class OpenRouterProvider implements AIProvider {
  readonly kind = "openrouter" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(opts: OpenRouterProviderOptions) {
    if (!opts.apiKey) throw new AIProviderError("OpenRouterProvider requires an apiKey");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL).replace(/\/+$/, "");
    const referer = opts.referer ?? OPENROUTER_DEFAULT_REFERER;
    const title = opts.title ?? OPENROUTER_DEFAULT_TITLE;
    this.headers = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": referer,
      "X-OpenRouter-Title": title,
      "X-Title": title,
    };
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: toOpenRouterModelId(req.model),
      messages: req.messages,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.responseFormat === "json") {
      body.response_format = { type: "json_object" };
    }
    if (req.extra) Object.assign(body, req.extra);

    const json = await this.post("/chat/completions", body);
    const choice = json.choices?.[0];
    if (!choice) {
      throw new AIProviderError("OpenRouter chat response missing choices[0]", { status: 502 });
    }
    return {
      model: json.model ?? req.model,
      content: choice.message?.content ?? "",
      finishReason: choice.finish_reason,
      usage: normalizeUsage(json.usage),
    };
  }

  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    const body: Record<string, unknown> = {
      model: toOpenRouterModelId(req.model),
      input: req.inputs,
    };
    if (req.dimensions !== undefined) body.dimensions = req.dimensions;
    if (req.extra) Object.assign(body, req.extra);

    const json = await this.post("/embeddings", body);
    const data = json.data;
    if (!Array.isArray(data)) {
      throw new AIProviderError("OpenRouter embeddings response missing data[]", { status: 502 });
    }
    // OpenAI shape: data[].{index, embedding}. Sort by index to preserve
    // input order (providers occasionally return out-of-order).
    const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const embeddings = sorted.map((d) => d.embedding as number[]);
    const dimensions = embeddings[0]?.length ?? req.dimensions ?? 0;
    return {
      model: json.model ?? req.model,
      embeddings,
      dimensions,
      usage: normalizeUsage(json.usage),
    };
  }

  async rerank(req: RerankRequest): Promise<RerankResponse> {
    const body: Record<string, unknown> = {
      model: toOpenRouterModelId(req.model),
      query: req.query,
      documents: req.documents,
    };
    if (req.topN !== undefined) body.top_n = req.topN;
    if (req.extra) Object.assign(body, req.extra);

    const json = await this.post("/rerank", body);
    // OpenRouter returns snake_case: results[].{index, relevance_score, document}.
    // Map to the camelCase RerankResult type.
    const results: RerankResult[] = (json.results ?? []).map(
      (r: Record<string, unknown>) => ({
        index: r.index as number,
        relevanceScore: (r.relevance_score as number) ?? (r.relevanceScore as number) ?? 0,
        document: r.document as { text?: string } | undefined,
      }),
    );
    return {
      model: req.model,
      results,
      usage: json.usage ? normalizeUsage(json.usage) : undefined,
    };
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  /** POST JSON to a path under baseUrl, parse the response, map errors. */
  private async post(path: string, body: Record<string, unknown>): Promise<any> {
    const url = this.baseUrl + path;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail = text;
      try {
        const parsed = JSON.parse(text);
        detail = parsed.error?.message ?? parsed.message ?? text;
      } catch {
        /* keep raw text */
      }
      throw new AIProviderError(
        `OpenRouter ${path} failed (${res.status}): ${detail || res.statusText}`,
        { status: res.status },
      );
    }
    return res.json();
  }
}

/** Normalize an OpenAI-style usage block into the Usage type. */
function normalizeUsage(raw: unknown): Usage {
  const u = (raw ?? {}) as Record<string, number>;
  const promptTokens = u.prompt_tokens ?? u.promptTokens ?? 0;
  const completionTokens = u.completion_tokens ?? u.completionTokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: u.total_tokens ?? u.totalTokens ?? promptTokens + completionTokens,
  };
}
