// @graphbrain/core — TriadProvider stub (Phase 1 placeholder).
//
// Triad is an OpenAI-compatible secondary provider (PLAN.md "AI Gateway —
// Triad integration (deferred)"). It is architecturally supported via the
// AIProvider seam but NOT wired in Phase 1 — OpenRouter is the sole provider.
// When activated, Triad becomes a fallback for embeddings + lightweight chat
// (query expansion, calibration judge, voice gate) for cost optimization.
//
// This stub implements AIProvider so the AIGateway can hold a TriadProvider
// instance without special-casing. All three methods throw — the gateway
// must not route to it until it's implemented. The constructor accepts the
// future wiring params (baseUrl + apiKey) so the Phase 2 activation is a
// method-body change, not a constructor change.

import type { AIProvider } from "./provider";
import type {
  ChatRequest,
  ChatResponse,
  EmbedRequest,
  EmbedResponse,
  RerankRequest,
  RerankResponse,
} from "./types";
import { AIProviderError } from "./types";

export interface TriadProviderOptions {
  baseUrl: string;
  apiKey: string;
}

/** Phase 1 stub — throws on every method. Activate in Phase 2. */
export class TriadProvider implements AIProvider {
  readonly kind = "triad" as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(opts: TriadProviderOptions) {
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey;
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw this.notImplemented();
  }
  async embed(_req: EmbedRequest): Promise<EmbedResponse> {
    throw this.notImplemented();
  }
  async rerank(_req: RerankRequest): Promise<RerankResponse> {
    throw this.notImplemented();
  }

  private notImplemented(): AIProviderError {
    return new AIProviderError(
      `TriadProvider not activated in Phase 1 (baseUrl=${this.baseUrl}, key=${this.apiKey ? "set" : "unset"})`,
    );
  }
}
