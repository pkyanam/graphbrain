// Tests for the source CRUD operations (Stage 10).
//
// Uses mock BrainEngine. No real DB. Verifies:
//   - list_sources: lists sources with pagination.
//   - get_source: by id or name; throws source_not_found on miss.
//   - add_source: adds a source and returns it.

import { describe, it, expect } from "bun:test";
import { listSourcesOp, getSourceOp, addSourceOp } from "../../src/operations";
import {
  makeCtx,
  makeResolvedDeps,
  makeMockEngine,
  makeSource,
  expectOpErrorAsync,
} from "./_helpers";

describe("list_sources op", () => {
  it("lists sources in the tenant's brain", async () => {
    const sources = [makeSource("wiki"), makeSource("essays"), makeSource("code")];
    const engine = makeMockEngine({ sources });
    const deps = makeResolvedDeps(engine);

    const result = await listSourcesOp.handler({}, makeCtx(), deps);
    expect(result.count).toBe(3);
    expect(result.sources.map((s) => s.name)).toEqual(["wiki", "essays", "code"]);
  });

  it("supports pagination", async () => {
    const sources = [makeSource("a"), makeSource("b"), makeSource("c")];
    const engine = makeMockEngine({ sources });
    const deps = makeResolvedDeps(engine);

    const result = await listSourcesOp.handler({ limit: 2, offset: 1 }, makeCtx(), deps);
    expect(result.count).toBe(2);
    expect(result.offset).toBe(1);
    expect(result.sources.map((s) => s.name)).toEqual(["b", "c"]);
  });
});

describe("get_source op", () => {
  it("fetches a source by id", async () => {
    const src = makeSource("wiki");
    const engine = makeMockEngine({ sources: [src] });
    const deps = makeResolvedDeps(engine);

    const result = await getSourceOp.handler({ id: src.id }, makeCtx(), deps);
    expect(result.source.id).toBe(src.id);
    expect(result.source.name).toBe("wiki");
  });

  it("fetches a source by name", async () => {
    const src = makeSource("wiki");
    const engine = makeMockEngine({ sources: [src] });
    const deps = makeResolvedDeps(engine);

    const result = await getSourceOp.handler({ name: "wiki" }, makeCtx(), deps);
    expect(result.source.name).toBe("wiki");
  });

  it("throws source_not_found when neither id nor name resolves", async () => {
    const engine = makeMockEngine({});
    const deps = makeResolvedDeps(engine);

    await expectOpErrorAsync(
      () => getSourceOp.handler({ name: "missing" }, makeCtx(), deps),
      "source_not_found",
    );
  });
});

describe("add_source op", () => {
  it("adds a source and returns it", async () => {
    const engine = makeMockEngine();
    const deps = makeResolvedDeps(engine);

    const result = await addSourceOp.handler(
      { name: "wiki", localPath: "/repo/wiki", config: { branch: "main" } },
      makeCtx(),
      deps,
    );
    expect(result.source.name).toBe("wiki");
    expect(result.source.localPath).toBe("/repo/wiki");
    expect(result.source.config).toEqual({ branch: "main" });
    expect(result.source.archived).toBe(false);
  });
});
