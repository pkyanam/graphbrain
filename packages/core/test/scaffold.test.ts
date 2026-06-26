// Stage 0 scaffold smoke test — asserts the @graphbrain/core barrel resolves.
import { describe, it, expect } from "bun:test";
import * as core from "../src/index.ts";

describe("scaffold", () => {
  it("imports @graphbrain/core without error", () => {
    expect(core).toBeDefined();
    expect(typeof core).toBe("object");
  });
});
