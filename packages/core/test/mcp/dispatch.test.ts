// Tests for the MCP tool-call dispatch (Stage 11).
//
// Verifies handleMcpCall:
//   - Maps tool name → operation correctly (returns ToolResult with content
//     = JSON string of the op output, isError absent/false).
//   - On OperationError, returns isError: true with the error's toJSON().
//   - On unknown (non-OperationError) throw, returns isError: true with
//     internal_error (and does NOT leak the raw error message).
//   - Passes the OperationContext through to dispatch unchanged — does NOT
//     override `remote` or `auth`. Verified via the trust boundary: a write
//     op with remote: true + read-only scopes yields permission_denied
//     (proving remote was honored as passed), and the same op with
//     remote: false succeeds (proving remote was not overridden to true).
//
// Uses the mock factories from test/operations/_helpers.ts (makeDispatchDeps,
// makeMockEngine, makeCtx, makePage). No real DB, no real LLM.

import { describe, it, expect, beforeAll } from "bun:test";
import { handleMcpCall, OperationError } from "../../src/index";
import type { ToolResult } from "../../src/index";
import {
  makeCtx,
  makeDispatchDeps,
  makeMockEngine,
  makePage,
} from "../operations/_helpers";
import { POLYGRES_ENV } from "../control/_helpers";
import { loadConfig, resetConfig } from "../../src/index";

// Prime the config singleton — some op handlers (search/query via
// hybridSearch) call loadConfig. The tests below don't exercise those ops,
// but priming keeps the suite robust against future op additions.
beforeAll(() => {
  process.env = { ...POLYGRES_ENV };
  resetConfig();
  loadConfig(POLYGRES_ENV);
});

// ─── success path ────────────────────────────────────────────────────────────

describe("handleMcpCall success", () => {
  it("maps tool name → operation and returns the op output as JSON text", async () => {
    const page = makePage("acme", "Acme");
    const engine = makeMockEngine({ pages: new Map([["acme", page]]) });
    const deps = makeDispatchDeps(engine);
    const ctx = makeCtx({ remote: true });

    const result = await handleMcpCall("get_page", { slug: "acme" }, ctx, deps);

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.page.slug).toBe("acme");
    expect(parsed.page.title).toBe("Acme");
  });

  it("accepts undefined args (dispatch + Zod handle validation)", async () => {
    const engine = makeMockEngine();
    const deps = makeDispatchDeps(engine);
    const ctx = makeCtx({ remote: true });

    // get_page requires `slug` — undefined args → invalid_params error.
    const result = await handleMcpCall("get_page", undefined, ctx, deps);
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.error).toBe("invalid_params");
  });
});

// ─── OperationError path ─────────────────────────────────────────────────────

describe("handleMcpCall OperationError", () => {
  it("returns isError: true with the error's toJSON() body", async () => {
    // get_page on a missing slug throws page_not_found.
    const engine = makeMockEngine({ pages: new Map() });
    const deps = makeDispatchDeps(engine);
    const ctx = makeCtx({ remote: true });

    const result = await handleMcpCall("get_page", { slug: "missing" }, ctx, deps);

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.error).toBe("page_not_found");
    expect(typeof parsed.message).toBe("string");
    // toJSON() includes suggestion when set.
    expect(parsed.suggestion).toBeTruthy();
  });

  it("returns isError: true for unknown_operation (dispatch throws)", async () => {
    const engine = makeMockEngine();
    const deps = makeDispatchDeps(engine);
    const ctx = makeCtx({ remote: true });

    const result = await handleMcpCall("does_not_exist", {}, ctx, deps);
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.error).toBe("unknown_operation");
  });
});

// ─── unknown throw path ──────────────────────────────────────────────────────

describe("handleMcpCall unknown throw", () => {
  it("wraps a non-OperationError throw as internal_error without leaking the message", async () => {
    // engine.getPage throws a plain Error with a sensitive message.
    const engine = makeMockEngine();
    (engine.getPage as unknown as (slug: string) => Promise<unknown>) = async () => {
      throw new Error("DB connection lost: postgres://user:secret@host/db");
    };
    const deps = makeDispatchDeps(engine);
    const ctx = makeCtx({ remote: true });

    const result = await handleMcpCall("get_page", { slug: "acme" }, ctx, deps);

    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toBe("internal_error");
    // The raw error message must NOT leak.
    expect(text).not.toContain("secret");
    expect(text).not.toContain("postgres://");
    expect(parsed.message).toBe("Internal error.");
  });
});

// ─── ctx pass-through (trust boundary honored) ───────────────────────────────

describe("handleMcpCall ctx pass-through", () => {
  it("does NOT override remote: a write op with remote:true + read scopes → permission_denied", async () => {
    // add_link is a write op. remote: true + scopes: ['read'] → the
    // dispatcher's trust boundary rejects it with permission_denied.
    const engine = makeMockEngine({
      pages: new Map([
        ["a", makePage("a")],
        ["b", makePage("b")],
      ]),
    });
    const deps = makeDispatchDeps(engine);
    const ctx = makeCtx({ remote: true, auth: { ...makeCtx().auth, scopes: ["read"] } });

    const result = await handleMcpCall(
      "add_link",
      { fromSlug: "a", toSlug: "b", type: "MENTIONS" },
      ctx,
      deps,
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.error).toBe("permission_denied");
  });

  it("does NOT override remote: the same write op with remote:false succeeds", async () => {
    // remote: false (trusted local) → write op allowed.
    const engine = makeMockEngine({
      pages: new Map([
        ["a", makePage("a")],
        ["b", makePage("b")],
      ]),
    });
    const deps = makeDispatchDeps(engine);
    const ctx = makeCtx({ remote: false });

    const result = await handleMcpCall(
      "add_link",
      { fromSlug: "a", toSlug: "b", type: "MENTIONS" },
      ctx,
      deps,
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0]!.text);
    // add_link returns { link: Link }.
    expect(parsed.link.fromSlug).toBe("a");
    expect(parsed.link.toSlug).toBe("b");
  });

  it("remote: true + write scope → write op allowed (explicit grant honored)", async () => {
    const engine = makeMockEngine({
      pages: new Map([
        ["a", makePage("a")],
        ["b", makePage("b")],
      ]),
    });
    const deps = makeDispatchDeps(engine);
    const ctx = makeCtx({ remote: true, auth: { ...makeCtx().auth, scopes: ["write"] } });

    const result = await handleMcpCall(
      "add_link",
      { fromSlug: "a", toSlug: "b", type: "MENTIONS" },
      ctx,
      deps,
    );

    expect(result.isError).toBeFalsy();
  });
});

// ─── ToolResult shape ────────────────────────────────────────────────────────

describe("handleMcpCall ToolResult shape", () => {
  it("always returns content as a single text block", async () => {
    const engine = makeMockEngine({ pages: new Map([["x", makePage("x")]]) });
    const deps = makeDispatchDeps(engine);
    const ctx = makeCtx({ remote: true });

    const result: ToolResult = await handleMcpCall("get_page", { slug: "x" }, ctx, deps);
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBe(1);
    expect(result.content[0]!.type).toBe("text");
    expect(typeof result.content[0]!.text).toBe("string");
    // text is JSON-parseable (every response is JSON-parseable — GBrain contract).
    expect(() => JSON.parse(result.content[0]!.text)).not.toThrow();
  });

  it("OperationError is still the core class (sanity)", () => {
    const err = new OperationError("storage_error", "boom");
    expect(err.code).toBe("storage_error");
    expect(err.toJSON().error).toBe("storage_error");
  });
});
