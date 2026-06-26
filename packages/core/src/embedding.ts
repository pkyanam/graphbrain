// @graphbrain/core — EmbeddingService: batching + dimension handling.
//
// Wraps AIGateway.embed with batch splitting + dimension resolution. Used by:
//   • Stage 9 (retrieval) — embeds the query text (single input, no batching).
//   • Stage 10 (put_page) — embeds chunk texts before writing to HelixDB.
//
// Resolution chain (highest wins):
//   model:        per-call override → tenant.settings.embeddingModel
//                 → config.defaults.embeddingModel
//   dimensions:   per-call override → tenant.settings.embeddingDimensions
//                 → config.defaults.embeddingDimensions
//
// The service asserts every returned vector matches the resolved dimension.
// Mixing dimensions for one tenant corrupts the HelixDB vector index (the
// index dimension is fixed at deploy time). A dimension mismatch throws.
//
// Config default note: config.ts defaults to "voyage:voyage-3-large" (1024d).
// PLAN.md's routing table lists OpenAI text-embedding-3-large (1536d) as the
// default. This is a documented discrepancy — the config default is Voyage
// (1024d), and the EmbeddingService resolves per-tenant. Tenants pick their
// embedding model + dimension at provisioning time; the HelixDB vector index
// dimension is fixed at deploy time (Stage 6 used 4d for dev tests). The
// service MUST use the tenant's configured dimension and MUST NOT mix
// dimensions for a given tenant.
//
// Default batch size: 100 texts/call (IMPLEMENTATION.md step 6). The service
// splits inputs into batches, calls gateway.embed per batch, concatenates the
// vectors in order, and returns number[][] (one vector per input text).

import type { AIGateway } from "./ai/gateway";
import type { Config } from "./config";
import { getConfig } from "./config";
import type { Tenant, TenantSettings } from "./types";
import {
  resolveEmbeddingModel,
  resolveEmbeddingDimensions,
} from "./ai/gateway";
import { AIProviderError } from "./ai/types";

/** Default batch size (IMPLEMENTATION.md step 6). */
export const DEFAULT_EMBED_BATCH_SIZE = 100;

export interface EmbeddingServiceOptions {
  /** The AIGateway to call through. */
  gateway: AIGateway;
  /** Config singleton (read for defaults). Defaults to getConfig() on first use. */
  config?: Config;
  /** Batch size override (default 100 texts/call). */
  batchSize?: number;
}

/**
 * EmbeddingService — batched text embedding with dimension enforcement.
 *
 * Construct once at app startup (alongside the AIGateway). `embed()` is the
 * primary entry point: pass the texts + the tenant, get back vectors.
 */
export class EmbeddingService {
  private readonly gateway: AIGateway;
  private config: Config;
  private readonly batchSize: number;

  constructor(opts: EmbeddingServiceOptions) {
    this.gateway = opts.gateway;
    this.config = opts.config ?? getConfig();
    this.batchSize = opts.batchSize ?? DEFAULT_EMBED_BATCH_SIZE;
  }

  /** Update the config reference (after resetConfig() in tests). */
  setConfig(config: Config): void {
    this.config = config;
  }

  /**
   * Embed a list of texts for a tenant. Returns one vector per text,
   * preserving input order. Resolves the model + dimension from the tenant's
   * settings (falling back to config defaults). Throws if any returned
   * vector's dimension doesn't match the resolved dimension.
   *
   * @param texts  The texts to embed (one vector per text, in order).
   * @param tenant The tenant (for model + dimension resolution). Optional —
   *   system-level calls (e.g. query embedding with a platform default) omit it.
   * @param override Per-call model/dimension override (highest precedence).
   */
  async embed(
    texts: string[],
    tenant?: Pick<Tenant, "settings">,
    override?: { model?: string; dimensions?: number },
  ): Promise<number[][]> {
    if (texts.length === 0) return [];

    const settings: TenantSettings | undefined = tenant?.settings;
    const model = override?.model ?? resolveEmbeddingModel(this.config, settings);
    const dimensions = override?.dimensions ?? resolveEmbeddingDimensions(this.config, settings);

    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const res = await this.gateway.embed(
        { model, inputs: batch, dimensions },
        tenant,
      );
      // Dimension enforcement — never mix dimensions for one tenant.
      if (res.dimensions !== dimensions) {
        throw new AIProviderError(
          `Embedding dimension mismatch: expected ${dimensions}, got ${res.dimensions} from model ${res.model}`,
        );
      }
      if (res.embeddings.length !== batch.length) {
        throw new AIProviderError(
          `Embedding count mismatch: sent ${batch.length} texts, got ${res.embeddings.length} vectors`,
        );
      }
      out.push(...res.embeddings);
    }
    return out;
  }

  /**
   * Embed a single text (convenience for query-side embedding in Stage 9).
   * Returns the vector directly (not wrapped in an array).
   */
  async embedOne(
    text: string,
    tenant?: Pick<Tenant, "settings">,
    override?: { model?: string; dimensions?: number },
  ): Promise<number[]> {
    const [vec] = await this.embed([text], tenant, override);
    if (!vec) throw new AIProviderError("embedOne returned no vector");
    return vec;
  }
}
