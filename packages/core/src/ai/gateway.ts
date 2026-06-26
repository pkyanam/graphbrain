// @graphbrain/core — AIGateway: per-tenant model routing + retry/backoff.
//
// The unified seam Stage 9 (retrieval) and Stage 10 (put_page) call through
// for every AI operation. Holds a default OpenRouterProvider (platform key)
// and resolves the active provider + model per call:
//
//   provider: platform key (Phase 1). Per-tenant BYO OpenRouter key is
//     Phase 2 — TenantSettings would gain an `openrouterApiKeyEncrypted`
//     field (stored via the Stage 2 encrypt/decrypt helpers); the gateway
//     would decrypt it and construct a per-tenant OpenRouterProvider. For
//     now, every tenant uses the platform provider.
//
//   model resolution chain (highest wins):
//     per-call override (req.model) → tenant.settings.{chatModel,embeddingModel}
//     → config.defaults.{chatModel,embeddingModel}
//
// Retry/backoff: 3 attempts, exponential backoff 1s/2s/4s, retry on 429 +
// 5xx (via AIProviderError.retryable). Do NOT retry on 4xx (except 429).
// The reference GBrain gateway has retry-with-jitter + a circuit breaker;
// Phase 1 ships only the basic exponential backoff (documented
// simplification — no jitter, no circuit breaker). The backoff is
// injectable via `backoffMs` for deterministic tests.
//
// Cost tracking: the gateway returns token usage in every response
// (ChatResponse.usage, EmbedResponse.usage, RerankResponse.usage). It does
// NOT write to any DB — there is no audit_log table until Stage 16. Callers
// log usage as needed. The gateway is a pure function of
// (request, provider) → response + usage.
//
// Ported from _reference/gbrain/src/core/ai/gateway.ts (recipe/touchpoint
// abstraction) but radically simplified: GBrain's gateway reads a recipe
// registry, resolves per-provider auth, and routes through the Vercel AI
// SDK. Graphbrain's gateway holds one provider + resolves a model string.
// The AI SDK dependency is NOT ported.

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
import type { Config } from "../config";
import { getConfig } from "../config";
import type { Tenant, TenantSettings } from "../types";

/** Default retry config: 3 attempts, exponential backoff 1s/2s/4s. */
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_MS = [1000, 2000, 4000];

export interface AIGatewayOptions {
  /** The platform-wide OpenRouter provider (platform key). */
  provider: AIProvider;
  /** Config singleton (read for defaults). Defaults to getConfig() on first use. */
  config?: Config;
  /** Max retry attempts (default 3 — the initial call + 2 retries). */
  maxAttempts?: number;
  /** Backoff schedule in ms (default [1000, 2000, 4000]). Injectable for tests. */
  backoffMs?: number[];
  /** Sleep function (test seam; defaults to a promise-wrapped setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * AIGateway — per-tenant model routing + retry/backoff over an AIProvider.
 *
 * Construct once at app startup with the platform OpenRouterProvider. Pass
 * `tenant` to chat/embed/rerank for per-tenant model resolution; omit it for
 * system-level calls (query expansion, calibration) that use platform
 * defaults.
 */
export class AIGateway {
  private readonly provider: AIProvider;
  private config: Config;
  private readonly maxAttempts: number;
  private readonly backoffMs: number[];
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: AIGatewayOptions) {
    this.provider = opts.provider;
    // Lazy config: read getConfig() on first use if not passed, so importing
    // the gateway doesn't trigger env validation.
    this.config = opts.config ?? getConfig();
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** Update the config reference (after resetConfig() in tests). */
  setConfig(config: Config): void {
    this.config = config;
  }

  // ─── Chat ──────────────────────────────────────────────────────────────────

  /**
   * Chat completion. Resolves the model from `req.model` → tenant.settings
   * → config.defaults.chatModel. `tenant` is optional (system-level calls
   * like query expansion use platform defaults).
   */
  async chat(req: ChatRequest, tenant?: Pick<Tenant, "settings">): Promise<ChatResponse> {
    const model = req.model || resolveChatModel(this.config, tenant?.settings);
    return this.withRetry(() => this.provider.chat({ ...req, model }));
  }

  // ─── Embeddings ────────────────────────────────────────────────────────────

  /**
   * Text embedding. Resolves the model from `req.model` → tenant.settings
   * → config.defaults.embeddingModel. `dimensions` is passed through
   * (Matryoshka shrink); the EmbeddingService resolves the tenant's
   * configured dimension and passes it here.
   */
  async embed(
    req: EmbedRequest,
    tenant?: Pick<Tenant, "settings">,
  ): Promise<EmbedResponse> {
    const model = req.model || resolveEmbeddingModel(this.config, tenant?.settings);
    return this.withRetry(() => this.provider.embed({ ...req, model }));
  }

  // ─── Rerank ────────────────────────────────────────────────────────────────

  /**
   * Cross-encoder rerank. `req.model` is the rerank model id (e.g.
   * "cohere:rerank-v3.5" or "zeroentropy:zerank-2"). When no model is
   * configured, throws — the caller (Stage 9 retrieval) must check
   * `tenant.settings.rerankerEnabled` before calling. The gateway does NOT
   * fall back to a no-op; that's the caller's responsibility (the
   * rerankerEnabled flag defaults to false).
   */
  async rerank(
    req: RerankRequest,
    _tenant?: Pick<Tenant, "settings">,
  ): Promise<RerankResponse> {
    if (!req.model) {
      throw new AIProviderError(
        "AIGateway.rerank requires a model id (no platform default for rerank in Phase 1)",
      );
    }
    return this.withRetry(() => this.provider.rerank(req));
  }

  // ─── Retry loop ────────────────────────────────────────────────────────────

  /**
   * Run `fn` with retry/backoff. Retries on AIProviderError.retryable
   * (429 + 5xx) up to `maxAttempts` total. Non-retryable errors (4xx except
   * 429) and non-AIProviderError throws propagate immediately.
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const retryable = err instanceof AIProviderError && err.retryable;
        if (!retryable || attempt === this.maxAttempts) throw err;
        const delay = this.backoffMs[attempt - 1] ?? this.backoffMs[this.backoffMs.length - 1] ?? 1000;
        await this.sleep(delay);
      }
    }
    throw lastError;
  }
}

// ─── Model resolution ────────────────────────────────────────────────────────

/** Resolve the chat model: per-call → tenant.settings → config default. */
export function resolveChatModel(
  config: Config,
  tenantSettings?: TenantSettings,
): string {
  if (tenantSettings?.chatModel) return tenantSettings.chatModel;
  return config.defaults.chatModel;
}

/** Resolve the embedding model: per-call → tenant.settings → config default. */
export function resolveEmbeddingModel(
  config: Config,
  tenantSettings?: TenantSettings,
): string {
  if (tenantSettings?.embeddingModel) return tenantSettings.embeddingModel;
  return config.defaults.embeddingModel;
}

/**
 * Resolve the embedding dimension: per-call → tenant.settings → config default.
 * The EmbeddingService uses this to assert returned vectors match the
 * tenant's configured dimension (mixing dimensions for one tenant corrupts
 * the HelixDB vector index).
 */
export function resolveEmbeddingDimensions(
  config: Config,
  tenantSettings?: TenantSettings,
): number {
  if (tenantSettings?.embeddingDimensions !== undefined) {
    return tenantSettings.embeddingDimensions;
  }
  return config.defaults.embeddingDimensions;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
