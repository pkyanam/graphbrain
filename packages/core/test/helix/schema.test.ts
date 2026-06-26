// Unit tests for the HelixDB schema definition (packages/core/src/helix/schema.ts).
//
// These are pure in-process checks — no HelixDB instance required. They verify:
//   • NODE_LABELS contains exactly Page, Chunk, Source.
//   • Each node label has a property map matching the schema.sql columns.
//   • Required Page fields (slug, type, title, compiled_truth, created_at,
//     updated_at) are present and non-optional.
//   • Required Chunk fields (page_id, chunk_index, content, created_at) are
//     present; embedding is optional.
//   • snake_case ↔ camelCase field maps are consistent inverses.
//   • EDGE_LABELS matches TYPED_EDGE_LABELS from types.ts.
//   • propertyNames() returns the snake_case names for each label.

import { describe, it, expect } from "bun:test";
import {
  NODE_LABELS,
  EDGE_LABELS,
  PAGE_PROPERTIES,
  CHUNK_PROPERTIES,
  SOURCE_PROPERTIES,
  NODE_PROPERTY_MAP,
  propertyNames,
  PAGE_FIELD_MAP,
  CHUNK_FIELD_MAP,
  SOURCE_FIELD_MAP,
  PAGE_SNAKE_TO_CAMEL,
  CHUNK_SNAKE_TO_CAMEL,
  SOURCE_SNAKE_TO_CAMEL,
  PAGE_TO_PAGE_EDGES,
  HAS_CHUNK_EDGE,
  CONTAINS_EDGE,
} from "../../src/helix/schema.ts";
import { TYPED_EDGE_LABELS } from "../../src/types.ts";

describe("helix/schema — node labels", () => {
  it("NODE_LABELS contains exactly Page, Chunk, Source", () => {
    expect(NODE_LABELS).toEqual(["Page", "Chunk", "Source"]);
  });

  it("NODE_PROPERTY_MAP has an entry for every NODE_LABEL", () => {
    for (const label of NODE_LABELS) {
      expect(NODE_PROPERTY_MAP[label]).toBeDefined();
      expect(NODE_PROPERTY_MAP[label].length).toBeGreaterThan(0);
    }
  });
});

describe("helix/schema — Page properties", () => {
  const names = PAGE_PROPERTIES.map((p) => p.name);

  it("includes all required fields from schema.sql", () => {
    for (const required of [
      "slug",
      "type",
      "title",
      "compiled_truth",
      "frontmatter",
      "page_kind",
      "created_at",
      "updated_at",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("marks created_at and updated_at as required (non-optional)", () => {
    const createdAt = PAGE_PROPERTIES.find((p) => p.name === "created_at");
    const updatedAt = PAGE_PROPERTIES.find((p) => p.name === "updated_at");
    expect(createdAt?.optional).toBeFalsy();
    expect(updatedAt?.optional).toBeFalsy();
  });

  it("marks deleted_at as optional (soft-delete)", () => {
    const deletedAt = PAGE_PROPERTIES.find((p) => p.name === "deleted_at");
    expect(deletedAt?.optional).toBe(true);
  });

  it("includes the temporal/effective fields from PLAN.md", () => {
    expect(names).toContain("effective_date");
    expect(names).toContain("effective_date_source");
  });
});

describe("helix/schema — Chunk properties", () => {
  const names = CHUNK_PROPERTIES.map((p) => p.name);

  it("includes page_id, chunk_index, content, created_at as required", () => {
    for (const required of ["page_id", "chunk_index", "content", "created_at"]) {
      expect(names).toContain(required);
    }
  });

  it("marks embedding as optional (chunks may not be embedded yet)", () => {
    const embedding = CHUNK_PROPERTIES.find((p) => p.name === "embedding");
    expect(embedding?.optional).toBe(true);
    expect(embedding?.type).toBe("f32array");
  });

  it("includes the multimodal embedding variants", () => {
    expect(names).toContain("embedding_voyage");
    expect(names).toContain("embedding_image");
  });

  it("includes code-symbol fields for code chunks", () => {
    expect(names).toContain("symbol_name");
    expect(names).toContain("symbol_type");
    expect(names).toContain("start_line");
    expect(names).toContain("end_line");
  });
});

describe("helix/schema — Source properties", () => {
  const names = SOURCE_PROPERTIES.map((p) => p.name);

  it("includes name, config, archived, created_at", () => {
    for (const required of ["name", "config", "archived", "created_at"]) {
      expect(names).toContain(required);
    }
  });

  it("marks archived as a bool, archived_at as optional", () => {
    const archived = SOURCE_PROPERTIES.find((p) => p.name === "archived");
    expect(archived?.type).toBe("bool");
    const archivedAt = SOURCE_PROPERTIES.find((p) => p.name === "archived_at");
    expect(archivedAt?.optional).toBe(true);
  });
});

describe("helix/schema — edge labels", () => {
  it("EDGE_LABELS matches TYPED_EDGE_LABELS", () => {
    expect(EDGE_LABELS).toEqual(TYPED_EDGE_LABELS);
  });

  it("PAGE_TO_PAGE_EDGES is a non-empty subset of EDGE_LABELS", () => {
    expect(PAGE_TO_PAGE_EDGES.length).toBeGreaterThan(0);
    for (const e of PAGE_TO_PAGE_EDGES) {
      expect(EDGE_LABELS).toContain(e);
    }
  });

  it("HAS_CHUNK_EDGE and CONTAINS_EDGE are the structural edge labels", () => {
    expect(HAS_CHUNK_EDGE).toBe("HAS_CHUNK");
    expect(CONTAINS_EDGE).toBe("CONTAINS");
  });
});

describe("helix/schema — propertyNames()", () => {
  it("returns snake_case names for Page (no $id)", () => {
    const names = propertyNames("Page");
    expect(names).toContain("slug");
    expect(names).toContain("compiled_truth");
    expect(names).not.toContain("$id");
  });

  it("returns snake_case names for Chunk", () => {
    const names = propertyNames("Chunk");
    expect(names).toContain("page_id");
    expect(names).toContain("chunk_index");
  });

  it("returns snake_case names for Source", () => {
    const names = propertyNames("Source");
    expect(names).toContain("local_path");
    expect(names).toContain("last_commit");
  });
});

describe("helix/schema — snake_case ↔ camelCase maps", () => {
  it("PAGE_SNAKE_TO_CAMEL is the inverse of PAGE_FIELD_MAP", () => {
    for (const [camel, snake] of Object.entries(PAGE_FIELD_MAP)) {
      expect(PAGE_SNAKE_TO_CAMEL[snake]).toBe(camel);
    }
  });

  it("CHUNK_SNAKE_TO_CAMEL is the inverse of CHUNK_FIELD_MAP", () => {
    for (const [camel, snake] of Object.entries(CHUNK_FIELD_MAP)) {
      expect(CHUNK_SNAKE_TO_CAMEL[snake]).toBe(camel);
    }
  });

  it("SOURCE_SNAKE_TO_CAMEL is the inverse of SOURCE_FIELD_MAP", () => {
    for (const [camel, snake] of Object.entries(SOURCE_FIELD_MAP)) {
      expect(SOURCE_SNAKE_TO_CAMEL[snake]).toBe(camel);
    }
  });

  it("maps $id to id for all three node types", () => {
    expect(PAGE_FIELD_MAP.id).toBe("$id");
    expect(CHUNK_FIELD_MAP.id).toBe("$id");
    expect(SOURCE_FIELD_MAP.id).toBe("$id");
  });

  it("maps the compound-name fields correctly (compiled_truth → compiledTruth)", () => {
    expect(PAGE_FIELD_MAP.compiledTruth).toBe("compiled_truth");
    expect(PAGE_FIELD_MAP.pageKind).toBe("page_kind");
    expect(PAGE_FIELD_MAP.effectiveDate).toBe("effective_date");
  });
});
