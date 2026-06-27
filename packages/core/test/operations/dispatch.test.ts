// Tests for the operations registry + dispatcher (Stage 10).
//
// Verifies:
//   - The OPERATIONS map contains the Phase 1 operation subset.
//   - dispatch routes to the right handler + returns its output.
//   - The trust boundary: write/admin ops gated by ctx.remote + auth.scopes.
//   - localOnly ops reject remote callers.
//   - Unknown ops throw OperationError('unknown_operation').
//   - Invalid input throws OperationError('invalid_params').
//   - Dry-run short-circuits handler execution.
//   - Engine resolution failure throws OperationError('not_provisioned').

import { describe, it, expect } from "bun:test";
import {
  dispatch,
  OPERATIONS,
  OPERATION_NAMES,
  getOperation,
  enforceTrustBoundary,
  OperationError,
  hasScope,
} from "../../src/operations";
import type { Operation, OperationScope } from "../../src/operations";
import {
  makeCtx,
  makeDispatchDeps,
  makeMockEngine,
  makePage,
  expectOpError,
  expectOpErrorAsync,
} from "./_helpers";

// ─── Registry ────────────────────────────────────────────────────────────────

describe("OPERATIONS registry", () => {
  it("contains the Phase 1 operation subset", () => {
    const expected = [
      "search",
      "query",
      "get_page",
      "list_pages",
      "put_page",
      "create_page",
      "add_chunk",
      "list_sources",
      "get_source",
      "add_source",
      "get_links",
      "get_backlinks",
      "add_link",
      "capture",
    ];
    for (const name of expected) {
      expect(OPERATIONS.has(name)).toBe(true);
    }
    expect(OPERATION_NAMES.length).toBeGreaterThanOrEqual(expected.length);
  });

  it("every op has a name, description, scope, and handler", () => {
    for (const op of OPERATIONS.values()) {
      expect(op.name).toBeTruthy();
      expect(op.description).toBeTruthy();
      expect(["read", "write", "admin"]).toContain(op.scope);
      expect(typeof op.handler).toBe("function");
    }
  });

  it("getOperation returns the op by name", () => {
    const op = getOperation("search");
    expect(op).toBeDefined();
    expect(op!.name).toBe("search");
  });

  it("getOperation returns undefined for unknown names", () => {
    expect(getOperation("nonexistent")).toBeUndefined();
  });
});

// ─── hasScope ────────────────────────────────────────────────────────────────

describe("hasScope", () => {
  it("admin scope satisfies any requirement", () => {
    expect(hasScope(["admin"], "read")).toBe(true);
    expect(hasScope(["admin"], "write")).toBe(true);
    expect(hasScope(["admin"], "admin")).toBe(true);
  });

  it("write scope satisfies read + write but not admin", () => {
    expect(hasScope(["write"], "read")).toBe(true);
    expect(hasScope(["write"], "write")).toBe(true);
    expect(hasScope(["write"], "admin")).toBe(false);
  });

  it("read scope satisfies only read", () => {
    expect(hasScope(["read"], "read")).toBe(true);
    expect(hasScope(["read"], "write")).toBe(false);
    expect(hasScope(["read"], "admin")).toBe(false);
  });

  it("empty scopes satisfy read (the authenticated floor)", () => {
    expect(hasScope([], "read")).toBe(true);
    expect(hasScope([], "write")).toBe(false);
  });
});

// ─── Trust boundary ──────────────────────────────────────────────────────────

describe("enforceTrustBoundary", () => {
  function makeOp(scope: OperationScope, localOnly?: boolean): Operation {
    return {
      name: "test_op",
      description: "test",
      scope,
      ...(localOnly ? { localOnly } : {}),
      handler: async () => ({}),
    };
  }

  it("read ops: always allowed (local + remote)", () => {
    const op = makeOp("read");
    expect(() => enforceTrustBoundary(op, makeCtx({ remote: false }))).not.toThrow();
    expect(() => enforceTrustBoundary(op, makeCtx({ remote: true }))).not.toThrow();
  });

  it("write ops: allowed for trusted local (remote === false)", () => {
    const op = makeOp("write");
    expect(() => enforceTrustBoundary(op, makeCtx({ remote: false }))).not.toThrow();
  });

  it("write ops: rejected for remote without write scope", () => {
    const op = makeOp("write");
    expectOpError(() => enforceTrustBoundary(op, makeCtx({ remote: true })), "permission_denied");
  });

  it("write ops: allowed for remote with write scope", () => {
    const op = makeOp("write");
    const ctx = makeCtx({ remote: true, auth: { ...makeCtx().auth, scopes: ["write"] } });
    expect(() => enforceTrustBoundary(op, ctx)).not.toThrow();
  });

  it("write ops: allowed for remote with admin scope", () => {
    const op = makeOp("write");
    const ctx = makeCtx({ remote: true, auth: { ...makeCtx().auth, scopes: ["admin"] } });
    expect(() => enforceTrustBoundary(op, ctx)).not.toThrow();
  });

  it("admin ops: rejected for remote with only write scope", () => {
    const op = makeOp("admin");
    const ctx = makeCtx({ remote: true, auth: { ...makeCtx().auth, scopes: ["write"] } });
    expectOpError(() => enforceTrustBoundary(op, ctx), "permission_denied");
  });

  it("admin ops: allowed for remote with admin scope", () => {
    const op = makeOp("admin");
    const ctx = makeCtx({ remote: true, auth: { ...makeCtx().auth, scopes: ["admin"] } });
    expect(() => enforceTrustBoundary(op, ctx)).not.toThrow();
  });

  it("localOnly ops: rejected for remote regardless of scope", () => {
    const op = makeOp("write", true);
    const ctx = makeCtx({ remote: true, auth: { ...makeCtx().auth, scopes: ["admin"] } });
    expectOpError(() => enforceTrustBoundary(op, ctx), "permission_denied");
  });

  it("localOnly ops: allowed for trusted local", () => {
    const op = makeOp("write", true);
    expect(() => enforceTrustBoundary(op, makeCtx({ remote: false }))).not.toThrow();
  });

  it("fail-closed: undefined remote is treated as untrusted", () => {
    const op = makeOp("write");
    // @ts-expect-error — deliberately omitting remote to test fail-closed.
    const ctx = { ...makeCtx(), remote: undefined };
    expectOpError(() => enforceTrustBoundary(op, ctx), "permission_denied");
  });
});

// ─── dispatch ────────────────────────────────────────────────────────────────

describe("dispatch", () => {
  it("throws unknown_operation for a name not in the registry", async () => {
    const engine = makeMockEngine();
    const deps = makeDispatchDeps(engine);
    await expectOpErrorAsync(() => dispatch("nonexistent", {}, makeCtx(), deps), "unknown_operation");
  });

  it("throws invalid_params when Zod validation fails", async () => {
    const engine = makeMockEngine();
    const deps = makeDispatchDeps(engine);
    // get_page requires a slug.
    await expectOpErrorAsync(() => dispatch("get_page", {}, makeCtx(), deps), "invalid_params");
  });

  it("routes to the handler and returns its output (get_page)", async () => {
    const page = makePage("acme", "Acme Corp");
    const engine = makeMockEngine({ pages: new Map([["acme", page]]) });
    const deps = makeDispatchDeps(engine);
    const result = await dispatch("get_page", { slug: "acme" }, makeCtx(), deps);
    expect(result.page.slug).toBe("acme");
    expect(result.page.title).toBe("Acme Corp");
  });

  it("dry-run short-circuits the handler", async () => {
    const engine = makeMockEngine();
    const deps = makeDispatchDeps(engine);
    const ctx = makeCtx({ dryRun: true });
    const result = await dispatch("get_page", { slug: "acme" }, ctx, deps);
    expect(result).toEqual({ dry_run: true, operation: "get_page" });
  });

  it("write op rejected for remote caller without write scope", async () => {
    const engine = makeMockEngine();
    const deps = makeDispatchDeps(engine);
    const ctx = makeCtx({ remote: true });
    await expectOpErrorAsync(
      () => dispatch("put_page", { slug: "x", content: "y" }, ctx, deps),
      "permission_denied",
    );
  });

  it("write op allowed for remote caller with write scope", async () => {
    const engine = makeMockEngine();
    const deps = makeDispatchDeps(engine);
    const ctx = makeCtx({
      remote: true,
      auth: { ...makeCtx().auth, scopes: ["write"] },
    });
    const result = await dispatch(
      "put_page",
      { slug: "x", content: "some content", skipEmbed: true },
      ctx,
      deps,
    );
    expect(result.page.slug).toBe("x");
  });

  it("throws not_provisioned when the router fails to resolve an engine", async () => {
    const deps: import("../../src/operations").DispatchDeps = {
      router: {
        getEngine: async () => {
          throw new Error("no helix instance");
        },
      },
      gateway: makeDispatchDeps(makeMockEngine()).gateway,
      embeddingService: makeDispatchDeps(makeMockEngine()).embeddingService,
    };
    await expectOpErrorAsync(
      () => dispatch("get_page", { slug: "x" }, makeCtx(), deps),
      "not_provisioned",
    );
  });
});
