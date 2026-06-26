// @graphbrain/core — AIProvider interface.
//
// The seam every AI provider implements. Phase 1 ships one implementation:
// `OpenRouterProvider` (./openrouter.ts), a thin fetch-based REST client
// against OpenRouter's OpenAI-compatible API. `TriadProvider` (./triad.ts)
// is a stub for the deferred OpenAI-compatible secondary provider.
//
// The AIGateway (./gateway.ts) holds one or more AIProviders and routes
// per-tenant calls through them with model resolution + retry/backoff. The
// interface is deliberately minimal — three methods (chat, embed, rerank)
// covering every AI touchpoint Stage 9 (retrieval) and Stage 10 (put_page)
// need. A future provider (Azure OpenAI, a local Ollama server, etc.) drops
// in by implementing this interface.
//
// Ported from _reference/gbrain/src/core/ai/types.ts (recipe/touchpoint
// abstraction) but radically simplified: GBrain's recipe system carries
// per-provider auth resolvers, base-URL templates, batch-token caps, and
// multimodal flags. Graphbrain's Phase 1 needs only chat/embed/rerank over
// a single provider (OpenRouter), so the interface is three methods, not a
// recipe registry. The GBrain AI SDK dependency (ai + @ai-sdk/*) is NOT
// ported — this is a pure fetch-based client (see openrouter.ts design note).

import type {
  ChatRequest,
  ChatResponse,
  EmbedRequest,
  EmbedResponse,
  RerankRequest,
  RerankResponse,
} from "./types";

/**
 * The AI provider contract. Each method takes a typed request and returns a
 * typed response. Providers are responsible for:
 *   • Converting the "provider:model" id form to their wire format.
 *   • Setting auth + attribution headers.
 *   • Mapping HTTP errors onto `AIProviderError` (with status + retryable).
 *
 * Providers are NOT responsible for:
 *   • Retry/backoff — that's the AIGateway's job (it wraps provider calls).
 *   • Per-tenant model resolution — that's the AIGateway's job.
 *   • Cost tracking / metering — the gateway returns usage; callers log it.
 */
export interface AIProvider {
  /** Discriminator: lets the gateway branch on provider kind. */
  readonly kind: string;

  /** Chat completion (synthesis, query expansion, calibration, voice gate). */
  chat(req: ChatRequest): Promise<ChatResponse>;

  /** Text embedding (chunk embeddings for put_page, query embedding for search). */
  embed(req: EmbedRequest): Promise<EmbedResponse>;

  /** Cross-encoder rerank (top-N re-scoring in the hybrid retrieval pipeline). */
  rerank(req: RerankRequest): Promise<RerankResponse>;
}
