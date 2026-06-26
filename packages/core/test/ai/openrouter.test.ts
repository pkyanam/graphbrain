// Tests for OpenRouterProvider (packages/core/src/ai/openrouter.ts).
//
// OpenRouter is mocked by stubbing `globalThis.fetch` with a lightweight
// router that inspects the URL + method + body and returns canned `Response`
// objects. No real network and no real OpenRouter key are required. This
// follows the fetch-stub pattern established in
// packages/core/test/control/coolify.test.ts.
//
// Verifies:
//   - chat/embed/rerank happy paths: correct URL, headers, body shape, and
//     response parsing.
//   - Model id conversion: "provider:model" → "provider/model".
//   - Attribution headers (HTTP-Referer, X-OpenRouter-Title, X-Title).
//   - Error mapping: non-2xx → AIProviderError with status + retryable flag.
//   - toOpenRouterModelId edge cases (passthrough, no-prefix throw).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  OpenRouterProvider,
  toOpenRouterModelId,
  OPENROUTER_DEFAULT_BASE_URL,
  OPENROUTER_DEFAULT_REFERER,
  OPENROUTER_DEFAULT_TITLE,
  AIProviderError,
} from "../../src/index.ts";
import type { AIProvider } from "../../src/index.ts";

// ─── Compile-time conformance ────────────────────────────────────────────────
// OpenRouterProvider MUST satisfy AIProvider. Type-level assertion — if the
// provider drifts from the interface, `bun run typecheck` fails.
const _conformance: AIProvider = new OpenRouterProvider({ apiKey: "test-key" });
void _conformance;

// ─── Fetch stub ──────────────────────────────────────────────────────────────

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

let _originalFetch: typeof globalThis.fetch;
let _captured: CapturedRequest[] = [];
let _routes: Array<{
  match: (req: CapturedRequest, parsed: any) => boolean;
  respond: (req: CapturedRequest, parsed: any) => { status?: number; body?: unknown };
}> = [];

function installFetchStub(): void {
  _originalFetch = globalThis.fetch;
  _captured = [];
  _routes = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "POST").toUpperCase();
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders) {
      const entries =
        rawHeaders instanceof Headers
          ? Array.from(rawHeaders.entries())
          : Array.isArray(rawHeaders)
            ? (rawHeaders as [string, string][])
            : Object.entries(rawHeaders as Record<string, string>);
      for (const [k, v] of entries) headers[k] = v;
    }
    const body = init?.body != null ? String(init.body) : undefined;
    const req: CapturedRequest = { url, method, headers, body };
    _captured.push(req);
    let parsed: any = {};
    if (body) {
      try {
        parsed = JSON.parse(body);
      } catch {
        /* keep empty */
      }
    }
    for (const route of _routes) {
      if (route.match(req, parsed)) {
        const { status = 200, body: respBody } = route.respond(req, parsed);
        const text =
          respBody === undefined ? null : typeof respBody === "string" ? respBody : JSON.stringify(respBody);
        return new Response(text, {
          status,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ error: "no mock route" }), { status: 599 });
  }) as typeof globalThis.fetch;
}

function restoreFetchStub(): void {
  globalThis.fetch = _originalFetch;
}

function onRoute(
  match: (req: CapturedRequest, parsed: any) => boolean,
  respond: (req: CapturedRequest, parsed: any) => { status?: number; body?: unknown },
): void {
  _routes.push({ match, respond });
}

function capturedRequests(): CapturedRequest[] {
  return _captured;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ai/openrouter — toOpenRouterModelId", () => {
  it("converts provider:model to provider/model", () => {
    expect(toOpenRouterModelId("anthropic:claude-sonnet-4-6")).toBe("anthropic/claude-sonnet-4-6");
    expect(toOpenRouterModelId("voyage:voyage-3-large")).toBe("voyage/voyage-3-large");
    expect(toOpenRouterModelId("openai:text-embedding-3-large")).toBe("openai/text-embedding-3-large");
  });

  it("passes through ids that already contain /", () => {
    expect(toOpenRouterModelId("openai/gpt-4o-2024-08-06")).toBe("openai/gpt-4o-2024-08-06");
    expect(toOpenRouterModelId("cohere/rerank-v3.5")).toBe("cohere/rerank-v3.5");
  });

  it("throws on ids with no provider prefix", () => {
    expect(() => toOpenRouterModelId("claude-sonnet-4-6")).toThrow(AIProviderError);
    expect(() => toOpenRouterModelId(":claude")).toThrow(AIProviderError);
  });
});

describe("ai/openrouter — constructor + headers", () => {
  it("uses default base URL + attribution headers", () => {
    const p = new OpenRouterProvider({ apiKey: "k" });
    expect(p.kind).toBe("openrouter");
    expect(OPENROUTER_DEFAULT_BASE_URL).toBe("https://openrouter.ai/api/v1");
    expect(OPENROUTER_DEFAULT_REFERER).toBe("https://graphbrain.belweave.ai");
    expect(OPENROUTER_DEFAULT_TITLE).toBe("graphbrain");
  });

  it("throws on empty apiKey", () => {
    expect(() => new OpenRouterProvider({ apiKey: "" })).toThrow(AIProviderError);
  });

  it("accepts custom baseUrl, referer, title", () => {
    const p = new OpenRouterProvider({
      apiKey: "k",
      baseUrl: "https://proxy.example.com/v1/",
      referer: "https://custom.example.com",
      title: "custom-app",
    });
    void p;
  });
});

describe("ai/openrouter — chat", () => {
  let provider: OpenRouterProvider;

  beforeAll(() => {
    installFetchStub();
    onRoute(
      (req) => req.method === "POST" && req.url.endsWith("/chat/completions"),
      (_req, parsed) => ({
        status: 200,
        body: {
          id: "chatcmpl-1",
          model: parsed.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Hello from the model" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      }),
    );
    provider = new OpenRouterProvider({ apiKey: "or-test-key" });
  });

  afterAll(() => restoreFetchStub());
  beforeEach(() => {
    _captured = [];
  });

  it("posts to /chat/completions with correct headers + body", async () => {
    const res = await provider.chat({
      model: "anthropic:claude-sonnet-4-6",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hi" },
      ],
      temperature: 0.7,
      maxTokens: 100,
    });

    expect(res.content).toBe("Hello from the model");
    expect(res.finishReason).toBe("stop");
    expect(res.usage.promptTokens).toBe(10);
    expect(res.usage.completionTokens).toBe(5);
    expect(res.usage.totalTokens).toBe(15);

    const req = capturedRequests()[0];
    expect(req.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(req.headers["Authorization"]).toBe("Bearer or-test-key");
    expect(req.headers["HTTP-Referer"]).toBe("https://graphbrain.belweave.ai");
    expect(req.headers["X-OpenRouter-Title"]).toBe("graphbrain");
    expect(req.headers["X-Title"]).toBe("graphbrain");
    expect(req.headers["Content-Type"]).toBe("application/json");

    const parsed = JSON.parse(req.body!);
    expect(parsed.model).toBe("anthropic/claude-sonnet-4-6");
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.temperature).toBe(0.7);
    expect(parsed.max_tokens).toBe(100);
  });

  it("converts responseFormat json to response_format", async () => {
    await provider.chat({
      model: "openai:gpt-4o",
      messages: [{ role: "user", content: "return json" }],
      responseFormat: "json",
    });
    const parsed = JSON.parse(capturedRequests()[0].body!);
    expect(parsed.response_format).toEqual({ type: "json_object" });
  });

  it("passes through extra fields", async () => {
    await provider.chat({
      model: "openai:gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      extra: { provider: { allow_fallbacks: true } },
    });
    const parsed = JSON.parse(capturedRequests()[0].body!);
    expect(parsed.provider).toEqual({ allow_fallbacks: true });
  });
});

describe("ai/openrouter — embed", () => {
  let provider: OpenRouterProvider;

  beforeAll(() => {
    installFetchStub();
    onRoute(
      (req) => req.method === "POST" && req.url.endsWith("/embeddings"),
      (_req, parsed) => ({
        status: 200,
        body: {
          model: parsed.model,
          data: (parsed.input as string[]).map((text, i) => ({
            index: i,
            embedding: Array.from({ length: parsed.dimensions ?? 4 }, (_, j) => i * 10 + j),
          })),
          usage: { prompt_tokens: 8, total_tokens: 8 },
        },
      }),
    );
    provider = new OpenRouterProvider({ apiKey: "or-test-key" });
  });

  afterAll(() => restoreFetchStub());
  beforeEach(() => {
    _captured = [];
  });

  it("posts to /embeddings and returns vectors in order", async () => {
    const res = await provider.embed({
      model: "openai:text-embedding-3-large",
      inputs: ["hello", "world"],
      dimensions: 4,
    });

    expect(res.embeddings).toHaveLength(2);
    expect(res.embeddings[0]).toEqual([0, 1, 2, 3]);
    expect(res.embeddings[1]).toEqual([10, 11, 12, 13]);
    expect(res.dimensions).toBe(4);
    expect(res.usage.promptTokens).toBe(8);

    const parsed = JSON.parse(capturedRequests()[0].body!);
    expect(parsed.model).toBe("openai/text-embedding-3-large");
    expect(parsed.input).toEqual(["hello", "world"]);
    expect(parsed.dimensions).toBe(4);
  });

  it("sorts out-of-order responses by index", async () => {
    // Override the route for this test to return reversed order.
    _routes = [];
    onRoute(
      (req) => req.method === "POST" && req.url.endsWith("/embeddings"),
      (_req, parsed) => ({
        status: 200,
        body: {
          model: parsed.model,
          data: [
            { index: 1, embedding: [10, 11, 12, 13] },
            { index: 0, embedding: [0, 1, 2, 3] },
          ],
          usage: { prompt_tokens: 8, total_tokens: 8 },
        },
      }),
    );
    const res = await provider.embed({
      model: "openai:text-embedding-3-large",
      inputs: ["a", "b"],
      dimensions: 4,
    });
    expect(res.embeddings[0]).toEqual([0, 1, 2, 3]);
    expect(res.embeddings[1]).toEqual([10, 11, 12, 13]);
  });
});

describe("ai/openrouter — rerank", () => {
  let provider: OpenRouterProvider;

  beforeAll(() => {
    installFetchStub();
    onRoute(
      (req) => req.method === "POST" && req.url.endsWith("/rerank"),
      (_req, parsed) => ({
        status: 200,
        body: {
          results: [
            { index: 1, relevance_score: 0.95, document: { text: parsed.documents[1] } },
            { index: 0, relevance_score: 0.42, document: { text: parsed.documents[0] } },
          ],
          usage: { prompt_tokens: 20, total_tokens: 20 },
        },
      }),
    );
    provider = new OpenRouterProvider({ apiKey: "or-test-key" });
  });

  afterAll(() => restoreFetchStub());
  beforeEach(() => {
    _captured = [];
  });

  it("posts to /rerank with model, query, documents, top_n", async () => {
    const res = await provider.rerank({
      model: "cohere:rerank-v3.5",
      query: "capital of France",
      documents: ["Berlin is the capital of Germany.", "Paris is the capital of France."],
      topN: 2,
    });

    expect(res.results).toHaveLength(2);
    expect(res.results[0].index).toBe(1);
    expect(res.results[0].relevanceScore).toBe(0.95);
    expect(res.results[0].document?.text).toBe("Paris is the capital of France.");
    expect(res.usage?.promptTokens).toBe(20);

    const parsed = JSON.parse(capturedRequests()[0].body!);
    expect(parsed.model).toBe("cohere/rerank-v3.5");
    expect(parsed.query).toBe("capital of France");
    expect(parsed.documents).toHaveLength(2);
    expect(parsed.top_n).toBe(2);
  });
});

describe("ai/openrouter — error mapping", () => {
  let provider: OpenRouterProvider;

  beforeAll(() => {
    installFetchStub();
    provider = new OpenRouterProvider({ apiKey: "or-test-key" });
  });

  afterAll(() => restoreFetchStub());
  beforeEach(() => {
    _captured = [];
    _routes = [];
  });

  it("maps 429 to retryable AIProviderError", async () => {
    onRoute(
      (req) => req.url.endsWith("/chat/completions"),
      () => ({ status: 429, body: { error: { message: "Rate limited" } } }),
    );
    await expect(
      provider.chat({ model: "openai:gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(AIProviderError);
    try {
      await provider.chat({ model: "openai:gpt-4o", messages: [{ role: "user", content: "hi" }] });
    } catch (e) {
      const err = e as AIProviderError;
      expect(err.status).toBe(429);
      expect(err.retryable).toBe(true);
      expect(err.message).toContain("Rate limited");
    }
  });

  it("maps 500 to retryable AIProviderError", async () => {
    onRoute(
      (req) => req.url.endsWith("/chat/completions"),
      () => ({ status: 500, body: { error: { message: "Internal error" } } }),
    );
    try {
      await provider.chat({ model: "openai:gpt-4o", messages: [{ role: "user", content: "hi" }] });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as AIProviderError;
      expect(err.status).toBe(500);
      expect(err.retryable).toBe(true);
    }
  });

  it("maps 400 to non-retryable AIProviderError", async () => {
    onRoute(
      (req) => req.url.endsWith("/chat/completions"),
      () => ({ status: 400, body: { error: { message: "Bad request" } } }),
    );
    try {
      await provider.chat({ model: "openai:gpt-4o", messages: [{ role: "user", content: "hi" }] });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as AIProviderError;
      expect(err.status).toBe(400);
      expect(err.retryable).toBe(false);
    }
  });

  it("maps 401 to non-retryable AIProviderError", async () => {
    onRoute(
      (req) => req.url.endsWith("/chat/completions"),
      () => ({ status: 401, body: { message: "Unauthorized" } }),
    );
    try {
      await provider.chat({ model: "openai:gpt-4o", messages: [{ role: "user", content: "hi" }] });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as AIProviderError;
      expect(err.status).toBe(401);
      expect(err.retryable).toBe(false);
    }
  });

  it("includes the URL path + status in the error message", async () => {
    onRoute(
      (req) => req.url.endsWith("/embeddings"),
      () => ({ status: 502, body: "Bad Gateway" }),
    );
    try {
      await provider.embed({ model: "openai:text-embedding-3-large", inputs: ["x"] });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as AIProviderError;
      expect(err.message).toContain("/embeddings");
      expect(err.message).toContain("502");
    }
  });
});
