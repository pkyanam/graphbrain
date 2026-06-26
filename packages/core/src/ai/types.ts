// @graphbrain/core — AI provider request/response types.
//
// The wire shapes every AIProvider implementation speaks. These are
// provider-agnostic: the OpenRouterProvider maps them onto OpenRouter's
// OpenAI-compatible REST API (chat/completions, embeddings, rerank), and a
// future TriadProvider (or any OpenAI-compatible endpoint) maps them onto
// its own endpoints. The AIGateway never sees provider-specific shapes —
// it calls provider.chat/embed/rerank and gets these types back.
//
// Model id format: "provider:model" (e.g. "anthropic:claude-sonnet-4-6",
// "voyage:voyage-3-large", "openai:text-embedding-3-large"). This matches
// the config.defaults + TenantSettings convention from Stage 1. The
// OpenRouterProvider converts ":" → "/" when calling the API
// (OpenRouter expects "anthropic/claude-sonnet-4-6"). Callers always pass
// the "provider:model" form.

// ─── Chat ────────────────────────────────────────────────────────────────────

export type ChatRole = "system" | "user" | "assistant" | "tool";

/** One message in a chat conversation (OpenAI-style role/content shape). */
export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Optional name for tool-role messages (OpenAI tool_call_id mapping). */
  name?: string;
}

/**
 * Chat completion request. `model` is "provider:model" form; the provider
 * converts to its wire format. `responseFormat: "json"` requests JSON mode
 * (OpenAI `response_format: { type: "json_object" }`).
 */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "json" | "text";
  /** Provider-specific passthrough flags (e.g. OpenRouter `provider` routing). */
  extra?: Record<string, unknown>;
}

/** Token usage reported by the provider (OpenAI usage shape). */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResponse {
  model: string;
  content: string;
  /** Finish reason: "stop", "length", "tool_calls", "content_filter", etc. */
  finishReason?: string;
  usage: Usage;
}

// ─── Embeddings ──────────────────────────────────────────────────────────────

/**
 * Embedding request. `inputs` is a batch of texts (one vector per text,
 * preserving order). `dimensions` is the target dimensionality (Matryoshka
 * shrink for providers that support it; ignored by providers that don't).
 */
export interface EmbedRequest {
  model: string;
  inputs: string[];
  dimensions?: number;
  /** Provider-specific passthrough flags. */
  extra?: Record<string, unknown>;
}

export interface EmbedResponse {
  model: string;
  /** One vector per input, preserving input order. */
  embeddings: number[][];
  dimensions: number;
  usage: Usage;
}

// ─── Rerank ──────────────────────────────────────────────────────────────────

/**
 * Cross-encoder rerank request. `documents` are the candidate texts to
 * re-score against `query`. `topN` limits the returned results (null/undefined
 * = return all, scored + sorted).
 */
export interface RerankRequest {
  model: string;
  query: string;
  documents: string[];
  topN?: number;
  /** Provider-specific passthrough flags. */
  extra?: Record<string, unknown>;
}

/** One reranked document: its original index + the cross-encoder score. */
export interface RerankResult {
  /** 0-based index into the original `documents` array. */
  index: number;
  /** Relevance score (higher = more relevant; scale is provider-specific). */
  relevanceScore: number;
  /** The document text (echoed back by some providers; may be undefined). */
  document?: { text?: string };
}

export interface RerankResponse {
  model: string;
  results: RerankResult[];
  usage?: Usage;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Error thrown by AI providers. Carries the HTTP status (when applicable) so
 * the gateway's retry logic can branch on 429/5xx vs 4xx. `retryable` is a
 * convenience flag computed from the status.
 */
export class AIProviderError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "AIProviderError";
    this.status = opts.status ?? 0;
    // Retry on 429 (rate limit) + 5xx (transient upstream). Do NOT retry on
    // 4xx (except 429) — those are caller errors that won't fix themselves.
    this.retryable = this.status === 429 || (this.status >= 500 && this.status < 600);
  }
}
