// Tests for AIGateway (packages/core/src/ai/gateway.ts).
//
// Uses the stub-provider pattern from packages/core/test/tenant-router.test.ts:
// a controllable stub AIProvider is injected via AIGatewayOptions.provider so
// no real OpenRouter call is made. The stub records calls + can inject
// failures (retryable vs non-retryable) for the retry/backoff tests.
//
// Verifies:
//   - Per-tenant model resolution: tenant.settings → config.defaults.
//   - Per-call model override wins over tenant + config.
//   - Retry on 429 succeeds on 2nd attempt.
//   - Retry on 5xx succeeds on 3rd attempt.
//   - Non-retryable 4xx fails immediately (no retry).
//   - 3rd failure throws (max attempts exhausted).
//   - Backoff schedule is respected (via injected sleep).
//   - rerank throws when no model is configured.
//   - TriadProvider stub throws on every method.

import { describe, it, expect, beforeAll } from "bun:test";
import {
  AIGateway,
  TriadProvider,
  AIProviderError,
  resolveChatModel,
  resolveEmbeddingModel,
  resolveEmbeddingDimensions,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_BACKOFF_MS,
} from "../../src/index.ts";
import type { AIProvider, ChatRequest, ChatResponse, EmbedRequest, EmbedResponse, RerankRequest, RerankResponse } from "../../src/index.ts";
import { loadConfig, resetConfig } from "../../src/index.ts";
import { POLYGRES_ENV } from "../control/_helpers.ts";

// ─── Config priming ──────────────────────────────────────────────────────────

beforeAll(() => {
  process.env = { ...POLYGRES_ENV };
  resetConfig();
  loadConfig(POLYGRES_ENV);
});

// ─── Stub provider ───────────────────────────────────────────────────────────

interface StubCall {
  method: "chat" | "embed" | "rerank";
  req: ChatRequest | EmbedRequest | RerankRequest;
}

/** A controllable stub AIProvider for gateway tests. */
class StubProvider implements AIProvider {
  readonly kind = "stub" as const;
  calls: StubCall[] = [];
  /** Queue of responses/failures per call index (consumed in order). */
  private responses: Array<
    | { kind: "ok"; chat?: Partial<ChatResponse>; embed?: Partial<EmbedResponse>; rerank?: Partial<RerankResponse> }
    | { kind: "error"; error: Error }
  > = [];

  /** Queue a successful response (next call). */
  queueOk(opts: {
    chat?: Partial<ChatResponse>;
    embed?: Partial<EmbedResponse>;
    rerank?: Partial<RerankResponse>;
  }): void {
    this.responses.push({ kind: "ok", ...opts });
  }

  /** Queue a failure (next call). */
  queueError(error: Error): void {
    this.responses.push({ kind: "error", error });
  }

  private next(): StubCall["method"] extends never ? never : any {
    const r = this.responses.shift();
    if (!r) throw new Error("StubProvider: no queued response");
    if (r.kind === "error") throw r.error;
    return r;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push({ method: "chat", req });
    const r = this.next();
    return {
      model: req.model,
      content: "stub-chat-content",
      finishReason: "stop",
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      ...r.chat,
    };
  }

  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    this.calls.push({ method: "embed", req });
    const r = this.next();
    const dims = req.dimensions ?? r.embed?.dimensions ?? 4;
    return {
      model: req.model,
      embeddings: req.inputs.map((_, i) => Array.from({ length: dims }, (_, j) => i + j)),
      dimensions: dims,
      usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
      ...r.embed,
    };
  }

  async rerank(req: RerankRequest): Promise<RerankResponse> {
    this.calls.push({ method: "rerank", req });
    const r = this.next();
    return {
      model: req.model,
      results: req.documents.map((_, i) => ({
        index: i,
        relevanceScore: 1 - i * 0.1,
        document: { text: req.documents[i] },
      })),
      usage: { promptTokens: 20, completionTokens: 0, totalTokens: 20 },
      ...r.rerank,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGateway(opts: {
  provider: AIProvider;
  maxAttempts?: number;
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}): { gateway: AIGateway; config: ReturnType<typeof loadConfig> } {
  const config = loadConfig(POLYGRES_ENV);
  const gateway = new AIGateway({
    provider: opts.provider,
    config,
    maxAttempts: opts.maxAttempts,
    backoffMs: opts.backoffMs,
    sleep: opts.sleep,
  });
  return { gateway, config };
}

function tenantWith(settings: Record<string, unknown>): { settings: Record<string, unknown> } {
  return { settings };
}

// ─── Model resolution ────────────────────────────────────────────────────────

describe("ai/gateway — model resolution", () => {
  it("resolveChatModel: tenant.settings wins over config default", () => {
    const config = loadConfig(POLYGRES_ENV);
    expect(resolveChatModel(config, undefined)).toBe(config.defaults.chatModel);
    expect(resolveChatModel(config, { chatModel: "openai:gpt-4o" })).toBe("openai:gpt-4o");
  });

  it("resolveEmbeddingModel: tenant.settings wins over config default", () => {
    const config = loadConfig(POLYGRES_ENV);
    expect(resolveEmbeddingModel(config, undefined)).toBe(config.defaults.embeddingModel);
    expect(resolveEmbeddingModel(config, { embeddingModel: "openai:text-embedding-3-large" })).toBe(
      "openai:text-embedding-3-large",
    );
  });

  it("resolveEmbeddingDimensions: tenant.settings wins over config default", () => {
    const config = loadConfig(POLYGRES_ENV);
    expect(resolveEmbeddingDimensions(config, undefined)).toBe(config.defaults.embeddingDimensions);
    expect(resolveEmbeddingDimensions(config, { embeddingDimensions: 1536 })).toBe(1536);
  });
});

// ─── Chat routing ────────────────────────────────────────────────────────────

describe("ai/gateway — chat routing", () => {
  it("uses tenant.settings.chatModel when req.model is empty", async () => {
    const stub = new StubProvider();
    stub.queueOk({ chat: { content: "routed" } });
    const { gateway } = makeGateway({ provider: stub });

    const res = await gateway.chat(
      { model: "", messages: [{ role: "user", content: "hi" }] },
      tenantWith({ chatModel: "openai:gpt-4o" }),
    );

    expect(res.content).toBe("routed");
    expect((stub.calls[0].req as ChatRequest).model).toBe("openai:gpt-4o");
  });

  it("per-call model override wins over tenant + config", async () => {
    const stub = new StubProvider();
    stub.queueOk({});
    const { gateway } = makeGateway({ provider: stub });

    await gateway.chat(
      { model: "google:gemini-2.5-pro", messages: [{ role: "user", content: "hi" }] },
      tenantWith({ chatModel: "openai:gpt-4o" }),
    );

    expect((stub.calls[0].req as ChatRequest).model).toBe("google:gemini-2.5-pro");
  });

  it("falls back to config default when no tenant + no per-call model", async () => {
    const stub = new StubProvider();
    stub.queueOk({});
    const { gateway, config } = makeGateway({ provider: stub });

    await gateway.chat({ model: "", messages: [{ role: "user", content: "hi" }] });
    expect((stub.calls[0].req as ChatRequest).model).toBe(config.defaults.chatModel);
  });
});

// ─── Embed routing ───────────────────────────────────────────────────────────

describe("ai/gateway — embed routing", () => {
  it("uses tenant.settings.embeddingModel when req.model is empty", async () => {
    const stub = new StubProvider();
    stub.queueOk({ embed: { dimensions: 1024 } });
    const { gateway } = makeGateway({ provider: stub });

    await gateway.embed(
      { model: "", inputs: ["hello"], dimensions: 1024 },
      tenantWith({ embeddingModel: "voyage:voyage-3-large" }),
    );

    expect((stub.calls[0].req as EmbedRequest).model).toBe("voyage:voyage-3-large");
  });
});

// ─── Rerank ──────────────────────────────────────────────────────────────────

describe("ai/gateway — rerank", () => {
  it("throws when no model is configured", async () => {
    const stub = new StubProvider();
    const { gateway } = makeGateway({ provider: stub });

    await expect(
      gateway.rerank({ model: "", query: "q", documents: ["a"] }),
    ).rejects.toThrow(AIProviderError);
    expect(stub.calls).toHaveLength(0);
  });

  it("passes through when model is set", async () => {
    const stub = new StubProvider();
    stub.queueOk({});
    const { gateway } = makeGateway({ provider: stub });

    const res = await gateway.rerank({
      model: "cohere:rerank-v3.5",
      query: "q",
      documents: ["a", "b"],
      topN: 2,
    });

    expect(res.results).toHaveLength(2);
    expect((stub.calls[0].req as RerankRequest).model).toBe("cohere:rerank-v3.5");
  });
});

// ─── Retry / backoff ─────────────────────────────────────────────────────────

describe("ai/gateway — retry + backoff", () => {
  it("DEFAULT_MAX_ATTEMPTS is 3 and backoff is [1000, 2000, 4000]", () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(3);
    expect(DEFAULT_BACKOFF_MS).toEqual([1000, 2000, 4000]);
  });

  it("retries on 429 and succeeds on 2nd attempt", async () => {
    const stub = new StubProvider();
    stub.queueError(new AIProviderError("rate limited", { status: 429 }));
    stub.queueOk({ chat: { content: "success" } });

    const sleeps: number[] = [];
    const { gateway } = makeGateway({
      provider: stub,
      backoffMs: [100, 200, 400],
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
    });

    const res = await gateway.chat({ model: "openai:gpt-4o", messages: [{ role: "user", content: "hi" }] });
    expect(res.content).toBe("success");
    expect(stub.calls).toHaveLength(2);
    expect(sleeps).toEqual([100]); // one backoff before the 2nd attempt
  });

  it("retries on 500 and succeeds on 3rd attempt", async () => {
    const stub = new StubProvider();
    stub.queueError(new AIProviderError("server error", { status: 500 }));
    stub.queueError(new AIProviderError("server error", { status: 503 }));
    stub.queueOk({ chat: { content: "third-time" } });

    const sleeps: number[] = [];
    const { gateway } = makeGateway({
      provider: stub,
      backoffMs: [100, 200, 400],
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
    });

    const res = await gateway.chat({ model: "openai:gpt-4o", messages: [{ role: "user", content: "hi" }] });
    expect(res.content).toBe("third-time");
    expect(stub.calls).toHaveLength(3);
    expect(sleeps).toEqual([100, 200]); // two backoffs
  });

  it("does NOT retry on 400 (non-retryable)", async () => {
    const stub = new StubProvider();
    stub.queueError(new AIProviderError("bad request", { status: 400 }));

    const sleeps: number[] = [];
    const { gateway } = makeGateway({
      provider: stub,
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
    });

    await expect(
      gateway.chat({ model: "openai:gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow("bad request");
    expect(stub.calls).toHaveLength(1);
    expect(sleeps).toHaveLength(0); // no backoff
  });

  it("throws after max attempts exhausted on persistent 429", async () => {
    const stub = new StubProvider();
    stub.queueError(new AIProviderError("rate limited", { status: 429 }));
    stub.queueError(new AIProviderError("rate limited", { status: 429 }));
    stub.queueError(new AIProviderError("rate limited", { status: 429 }));

    const sleeps: number[] = [];
    const { gateway } = makeGateway({
      provider: stub,
      backoffMs: [10, 20, 40],
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
    });

    await expect(
      gateway.chat({ model: "openai:gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow("rate limited");
    expect(stub.calls).toHaveLength(3);
    expect(sleeps).toEqual([10, 20]); // two backoffs (3rd attempt is the last)
  });

  it("does not retry on non-AIProviderError throws", async () => {
    const stub = new StubProvider();
    stub.queueError(new Error("network failure"));

    const { gateway } = makeGateway({ provider: stub });

    await expect(
      gateway.chat({ model: "openai:gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow("network failure");
    expect(stub.calls).toHaveLength(1);
  });

  it("retry works for embed too", async () => {
    const stub = new StubProvider();
    stub.queueError(new AIProviderError("rate limited", { status: 429 }));
    stub.queueOk({ embed: { dimensions: 4 } });

    const { gateway } = makeGateway({
      provider: stub,
      backoffMs: [10],
      sleep: () => Promise.resolve(),
    });

    const res = await gateway.embed({ model: "openai:text-embedding-3-large", inputs: ["x"], dimensions: 4 });
    expect(res.embeddings).toHaveLength(1);
    expect(stub.calls).toHaveLength(2);
  });
});

// ─── TriadProvider stub ──────────────────────────────────────────────────────

describe("ai/triad — stub", () => {
  it("throws on chat", async () => {
    const triad = new TriadProvider({ baseUrl: "https://triad.example.com/v1", apiKey: "k" });
    expect(triad.kind).toBe("triad");
    await expect(
      triad.chat({ model: "x:y", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow("TriadProvider not activated in Phase 1");
  });

  it("throws on embed", async () => {
    const triad = new TriadProvider({ baseUrl: "https://triad.example.com/v1", apiKey: "k" });
    await expect(
      triad.embed({ model: "x:y", inputs: ["hi"] }),
    ).rejects.toThrow("TriadProvider not activated in Phase 1");
  });

  it("throws on rerank", async () => {
    const triad = new TriadProvider({ baseUrl: "https://triad.example.com/v1", apiKey: "k" });
    await expect(
      triad.rerank({ model: "x:y", query: "q", documents: ["d"] }),
    ).rejects.toThrow("TriadProvider not activated in Phase 1");
  });
});
