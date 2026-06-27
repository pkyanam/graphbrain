// Tests for the link (edge) operations (Stage 10).
//
// Uses mock BrainEngine. No real DB. Verifies:
//   - get_links: outgoing edges, optionally filtered by edge type.
//   - get_backlinks: incoming edges.
//   - add_link: adds an edge between two pages; wraps engine errors as
//     page_not_found when a page is missing.

import { describe, it, expect } from "bun:test";
import { getLinksOp, getBacklinksOp, addLinkOp } from "../../src/operations";
import {
  makeCtx,
  makeResolvedDeps,
  makeMockEngine,
  makePage,
  makeLink,
  expectOpErrorAsync,
} from "./_helpers";

describe("get_links op", () => {
  it("returns outgoing edges from a page", async () => {
    const acme = makePage("acme");
    const stripe = makePage("stripe");
    const mentions = makeLink("acme", "stripe", "MENTIONS");
    const worksAt = makeLink("acme", "stripe", "WORKS_AT");
    const engine = makeMockEngine({
      pages: new Map([["acme", acme], ["stripe", stripe]]),
      outEdges: new Map([["acme", [mentions, worksAt]]]),
    });
    const deps = makeResolvedDeps(engine);

    const result = await getLinksOp.handler({ slug: "acme" }, makeCtx(), deps);
    expect(result.count).toBe(2);
    expect(result.links[0]!.type).toBe("MENTIONS");
  });

  it("filters by edge type", async () => {
    const acme = makePage("acme");
    const stripe = makePage("stripe");
    const mentions = makeLink("acme", "stripe", "MENTIONS");
    const worksAt = makeLink("acme", "stripe", "WORKS_AT");
    const engine = makeMockEngine({
      pages: new Map([["acme", acme], ["stripe", stripe]]),
      outEdges: new Map([["acme", [mentions, worksAt]]]),
    });
    const deps = makeResolvedDeps(engine);

    const result = await getLinksOp.handler(
      { slug: "acme", edgeTypes: ["WORKS_AT"] },
      makeCtx(),
      deps,
    );
    expect(result.count).toBe(1);
    expect(result.links[0]!.type).toBe("WORKS_AT");
  });

  it("returns empty for a page with no edges", async () => {
    const engine = makeMockEngine({});
    const deps = makeResolvedDeps(engine);
    const result = await getLinksOp.handler({ slug: "lonely" }, makeCtx(), deps);
    expect(result.count).toBe(0);
    expect(result.links).toEqual([]);
  });
});

describe("get_backlinks op", () => {
  it("returns incoming edges to a page", async () => {
    const acme = makePage("acme");
    const stripe = makePage("stripe");
    const link = makeLink("acme", "stripe", "MENTIONS");
    const engine = makeMockEngine({
      pages: new Map([["acme", acme], ["stripe", stripe]]),
      inEdges: new Map([["stripe", [link]]]),
    });
    const deps = makeResolvedDeps(engine);

    const result = await getBacklinksOp.handler({ slug: "stripe" }, makeCtx(), deps);
    expect(result.count).toBe(1);
    expect(result.backlinks[0]!.fromSlug).toBe("acme");
  });
});

describe("add_link op", () => {
  it("adds an edge between two existing pages", async () => {
    const acme = makePage("acme");
    const stripe = makePage("stripe");
    const engine = makeMockEngine({
      pages: new Map([["acme", acme], ["stripe", stripe]]),
    });
    const deps = makeResolvedDeps(engine);

    const result = await addLinkOp.handler(
      { fromSlug: "acme", toSlug: "stripe", type: "MENTIONS" },
      makeCtx(),
      deps,
    );
    expect(result.link.fromSlug).toBe("acme");
    expect(result.link.toSlug).toBe("stripe");
    expect(result.link.type).toBe("MENTIONS");
    expect(result.link.origin).toBe("manual");
  });

  it("defaults origin to manual", async () => {
    const acme = makePage("acme");
    const stripe = makePage("stripe");
    const engine = makeMockEngine({
      pages: new Map([["acme", acme], ["stripe", stripe]]),
    });
    const deps = makeResolvedDeps(engine);

    const result = await addLinkOp.handler(
      { fromSlug: "acme", toSlug: "stripe", type: "FOUNDED" },
      makeCtx(),
      deps,
    );
    expect(result.link.origin).toBe("manual");
  });

  it("throws page_not_found when a page is missing", async () => {
    const engine = makeMockEngine({});
    const deps = makeResolvedDeps(engine);

    await expectOpErrorAsync(
      () =>
        addLinkOp.handler(
          { fromSlug: "missing", toSlug: "also-missing", type: "MENTIONS" },
          makeCtx(),
          deps,
        ),
      "page_not_found",
    );
  });
});
