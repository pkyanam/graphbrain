// Round-trip tests for every Zod schema in @graphbrain/core.
//
// Each test: parse a valid fixture → serialize (JSON) → parse again → assert
// the second parse equals the first. This catches both validation bugs and
// serialization drift (e.g. Date → string → Date round-trip).

import { describe, it, expect } from "bun:test";
import {
  TenantSchema,
  TenantSettingsSchema,
  PageSchema,
  PageInputSchema,
  ChunkSchema,
  SourceSchema,
  LinkSchema,
  FactSchema,
  TakeSchema,
  TimelineEntrySchema,
  FileSchema,
  SearchResultSchema,
  HybridSearchMetaSchema,
  AuthInfoSchema,
  OperationContextSchema,
  EdgeLabelSchema,
  type Tenant,
  type Page,
  type OperationContext,
} from "../src/index.ts";

const iso = (d: string) => new Date(d);

// ─── Tenant ──────────────────────────────────────────────────────────────────

describe("TenantSettingsSchema", () => {
  it("accepts an empty object (all fields optional)", () => {
    const r = TenantSettingsSchema.parse({});
    expect(r).toEqual({});
  });

  it("round-trips a fully-populated settings object", () => {
    const input = {
      chatModel: "anthropic:claude-sonnet-4-6",
      embeddingModel: "voyage:voyage-3-large",
      embeddingDimensions: 1024,
      searchMode: "balanced" as const,
      monthlyCostCapUsd: 100,
      rerankerEnabled: true,
      contextualRetrievalMode: "title" as const,
      features: { experimental: true },
    };
    const parsed = TenantSettingsSchema.parse(input);
    const roundTripped = TenantSettingsSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });

  it("rejects an invalid search mode", () => {
    const r = TenantSettingsSchema.safeParse({ searchMode: "turbo" });
    expect(r.success).toBe(false);
  });

  it("rejects out-of-range embedding dimensions", () => {
    const r = TenantSettingsSchema.safeParse({ embeddingDimensions: 99999 });
    expect(r.success).toBe(false);
  });
});

describe("TenantSchema", () => {
  const validTenant = {
    id: "01HZK9X8F4J7QZ3V1Y6N8M5B2X",
    clerkOrgId: "org_2abc123",
    name: "Acme Co",
    slug: "acme-co",
    helixInstanceUrl: null,
    helixApiKeyEncrypted: null,
    coolifyAppId: null,
    tier: "free",
    status: "pending",
    settings: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("round-trips a pending tenant (nulls for unprovisioned fields)", () => {
    const parsed = TenantSchema.parse(validTenant);
    expect(parsed.helixInstanceUrl).toBeNull();
    expect(parsed.tier).toBe("free");
    const roundTripped = TenantSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });

  it("round-trips an active tenant with provisioned HelixDB", () => {
    const active = {
      ...validTenant,
      status: "active",
      helixInstanceUrl: "http://helix-acme-co.internal:8080",
      helixApiKeyEncrypted: "base64ciphertext==",
      coolifyAppId: "app_xyz",
      settings: { searchMode: "tokenmax", monthlyCostCapUsd: 250 },
    };
    const parsed = TenantSchema.parse(active) as Tenant;
    expect(parsed.status).toBe("active");
    expect(parsed.settings.searchMode).toBe("tokenmax");
    const roundTripped = TenantSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });

  it("rejects an invalid tier", () => {
    const r = TenantSchema.safeParse({ ...validTenant, tier: "ultra" });
    expect(r.success).toBe(false);
  });

  it("rejects a missing required field", () => {
    const { clerkOrgId: _omit, ...missing } = validTenant;
    const r = TenantSchema.safeParse(missing);
    expect(r.success).toBe(false);
  });
});

// ─── Page ────────────────────────────────────────────────────────────────────

describe("PageSchema", () => {
  const validPage = {
    id: "01HZK9X8F4J7QZ3V1Y6N8M5B2X",
    slug: "wiki/acme-co",
    type: "company",
    title: "Acme Co",
    compiledTruth: "Acme Co is a widget manufacturer.",
    frontmatter: { founded: 2019, investors: ["fund-a", "fund-b"] },
    pageKind: "markdown",
    contentHash: "sha256:abc123",
    emotionalWeight: 0.42,
    effectiveDate: "2026-01-15T00:00:00.000Z",
    effectiveDateSource: "published",
    importFilename: "2026-01-15-acme-co",
    salienceTouchedAt: null,
    lastRetrievedAt: null,
    linksExtractedAt: null,
    contextualRetrievalMode: null,
    corpusGeneration: null,
    generation: 1,
    deletedAt: null,
    createdAt: "2026-01-15T10:00:00.000Z",
    updatedAt: "2026-01-15T10:00:00.000Z",
  };

  it("round-trips a markdown page", () => {
    const parsed = PageSchema.parse(validPage) as Page;
    expect(parsed.pageKind).toBe("markdown");
    expect(parsed.effectiveDate).toBeInstanceOf(Date);
    const roundTripped = PageSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });

  it("round-trips a code page with open page type", () => {
    const codePage = {
      ...validPage,
      slug: "code/src/index.ts",
      type: "code",
      pageKind: "code",
      compiledTruth: "export const foo = 1;",
    };
    const parsed = PageSchema.parse(codePage);
    expect(parsed.pageKind).toBe("code");
    const roundTripped = PageSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });

  it("rejects an invalid pageKind", () => {
    const r = PageSchema.safeParse({ ...validPage, pageKind: "audio" });
    expect(r.success).toBe(false);
  });

  it("rejects emotionalWeight out of [0,1]", () => {
    const r = PageSchema.safeParse({ ...validPage, emotionalWeight: 1.5 });
    expect(r.success).toBe(false);
  });
});

describe("PageInputSchema", () => {
  it("accepts a minimal input (only required fields)", () => {
    const r = PageInputSchema.safeParse({
      slug: "wiki/test",
      type: "concept",
      title: "Test",
      compiledTruth: "body",
    });
    expect(r.success).toBe(true);
  });
});

// ─── Chunk ───────────────────────────────────────────────────────────────────

describe("ChunkSchema", () => {
  const validChunk = {
    id: "01HZK9X8F4J7QZ3V1Y6N8M5B2X",
    pageId: "01HZK9X8F4J7QZ3V1Y6N8M5B2X",
    chunkIndex: 0,
    content: "Acme Co is a widget manufacturer.",
    chunkSource: "compiled_truth",
    modality: "text",
    embedding: [0.1, 0.2, 0.3],
    embeddingVoyage: null,
    embeddingImage: undefined,
    model: "voyage:voyage-3-large",
    tokenCount: 8,
    language: null,
    symbolName: null,
    symbolType: null,
    startLine: null,
    endLine: null,
    embeddedAt: "2026-01-15T10:00:00.000Z",
    createdAt: "2026-01-15T10:00:00.000Z",
  };

  it("round-trips a text chunk with embedding", () => {
    const parsed = ChunkSchema.parse(validChunk);
    expect(parsed.embedding).toEqual([0.1, 0.2, 0.3]);
    const roundTripped = ChunkSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });

  it("round-trips an image chunk with multimodal embedding", () => {
    const imageChunk = {
      ...validChunk,
      chunkSource: "image_asset",
      modality: "image",
      embedding: null,
      embeddingImage: [0.4, 0.5],
    };
    const parsed = ChunkSchema.parse(imageChunk);
    expect(parsed.modality).toBe("image");
    expect(parsed.embeddingImage).toEqual([0.4, 0.5]);
    const roundTripped = ChunkSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });
});

// ─── Source ──────────────────────────────────────────────────────────────────

describe("SourceSchema", () => {
  it("round-trips a source", () => {
    const valid = {
      id: "01HZK9X8F4J7QZ3V1Y6N8M5B2X",
      name: "wiki",
      localPath: "/data/wiki",
      lastCommit: "abc123",
      lastSyncAt: "2026-01-15T10:00:00.000Z",
      config: { branch: "main" },
      chunkerVersion: 2,
      archived: false,
      archivedAt: null,
      archiveExpiresAt: null,
      contextualRetrievalMode: "none",
      trustFrontmatterOverrides: true,
      newestContentAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const parsed = SourceSchema.parse(valid);
    expect(parsed.archived).toBe(false);
    const roundTripped = SourceSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });
});

// ─── Link ────────────────────────────────────────────────────────────────────

describe("EdgeLabelSchema", () => {
  it("accepts a known typed edge label", () => {
    expect(EdgeLabelSchema.safeParse("INVESTED_IN").success).toBe(true);
    expect(EdgeLabelSchema.safeParse("MENTIONS").success).toBe(true);
  });

  it("accepts a pack-declared custom edge label", () => {
    expect(EdgeLabelSchema.safeParse("PARTNERS_WITH").success).toBe(true);
  });
});

describe("LinkSchema", () => {
  it("round-trips a typed link", () => {
    const valid = {
      id: "01HZK9X8F4J7QZ3V1Y6N8M5B2X",
      fromSlug: "wiki/acme-co",
      toSlug: "wiki/fund-a",
      type: "INVESTED_IN",
      origin: "frontmatter",
      context: "investors",
      originSlug: "wiki/acme-co",
      originField: "investors",
      createdAt: "2026-01-15T10:00:00.000Z",
    };
    const parsed = LinkSchema.parse(valid);
    expect(parsed.type).toBe("INVESTED_IN");
    const roundTripped = LinkSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });
});

// ─── Fact / Take / TimelineEntry / File ──────────────────────────────────────

describe("FactSchema", () => {
  it("round-trips a fact", () => {
    const valid = {
      id: "01HZK9X8F4J7QZ3V1Y6N8M5B2X",
      pageId: "01HZK9X8F4J7QZ3V1Y6N8M5B2X",
      rowNum: 0,
      claim: "Acme Co raised $10M Series A.",
      kind: "metric",
      confidence: 0.9,
      visibility: "public",
      notability: "high",
      validFrom: "2026-01-15T00:00:00.000Z",
      validUntil: null,
      source: "techcrunch",
      context: null,
      createdAt: "2026-01-15T10:00:00.000Z",
    };
    const parsed = FactSchema.parse(valid);
    expect(parsed.kind).toBe("metric");
    const roundTripped = FactSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });

  it("rejects confidence out of [0,1]", () => {
    const r = FactSchema.safeParse({
      id: "x", pageId: "x", rowNum: 0, claim: "c", kind: "fact",
      confidence: 2, visibility: "public", notability: "high",
      validFrom: "2026-01-15", source: "s", createdAt: "2026-01-15",
    });
    expect(r.success).toBe(false);
  });
});

describe("TakeSchema", () => {
  it("round-trips a take", () => {
    const valid = {
      id: "01HZK9X8F4J7QZ3V1Y6N8M5B2X",
      pageId: "01HZK9X8F4J7QZ3V1Y6N8M5B2X",
      rowNum: 0,
      claim: "Acme Co will reach $50M ARR by 2027.",
      kind: "prediction",
      who: "world",
      weight: 0.7,
      since: "2026-01-15",
      source: "essay-2026-01",
      resolvedQuality: null,
      resolvedOutcome: null,
      resolvedEvidence: null,
      createdAt: "2026-01-15T10:00:00.000Z",
    };
    const parsed = TakeSchema.parse(valid);
    expect(parsed.kind).toBe("prediction");
    const roundTripped = TakeSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });
});

describe("TimelineEntrySchema", () => {
  it("round-trips a timeline entry", () => {
    const valid = {
      id: "01HZK9X8F4J7QZ3V1Y6N8M5B2X",
      pageId: "01HZK9X8F4J7QZ3V1Y6N8M5B2X",
      date: "2026-01-15",
      event: "Series A announced",
      source: "techcrunch",
      createdAt: "2026-01-15T10:00:00.000Z",
    };
    const parsed = TimelineEntrySchema.parse(valid);
    const roundTripped = TimelineEntrySchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });
});

describe("FileSchema", () => {
  it("round-trips a file attachment", () => {
    const valid = {
      id: "01HZK9X8F4J7QZ3V1Y6N8M5B2X",
      pageId: "01HZK9X8F4J7QZ3V1Y6N8M5B2X",
      storagePath: "tenants/acme-co/files/pitch-deck.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1048576,
      sha256: "abc123def456",
      createdAt: "2026-01-15T10:00:00.000Z",
    };
    const parsed = FileSchema.parse(valid);
    const roundTripped = FileSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });
});

// ─── Search ──────────────────────────────────────────────────────────────────

describe("SearchResultSchema", () => {
  it("round-trips a search result with page + chunks + citations", () => {
    const valid = {
      page: {
        id: "01HZK9X8F4J7QZ3V1Y6N8M5B2X",
        slug: "wiki/acme-co",
        type: "company",
        title: "Acme Co",
        compiledTruth: "Acme Co is a widget manufacturer.",
        frontmatter: {},
        pageKind: "markdown",
        createdAt: "2026-01-15T10:00:00.000Z",
        updatedAt: "2026-01-15T10:00:00.000Z",
      },
      chunks: [
        {
          id: "01HZK9X8F4J7QZ3V1Y6N8M5B2X",
          pageId: "01HZK9X8F4J7QZ3V1Y6N8M5B2X",
          chunkIndex: 0,
          content: "Acme Co is a widget manufacturer.",
          chunkSource: "compiled_truth",
          modality: "text",
          embedding: null,
          createdAt: "2026-01-15T10:00:00.000Z",
        },
      ],
      score: 0.87,
      sources: ["vector", "lexical"],
      citations: [
        { chunkId: "01HZK9X8F4J7QZ3V1Y6N8M5B2X", slug: "wiki/acme-co", stream: "vector", snippet: "Acme Co is..." },
      ],
      rank: 0,
      evidence: "high_vector_match",
      createSafety: "exists",
    };
    const parsed = SearchResultSchema.parse(valid);
    expect(parsed.score).toBe(0.87);
    expect(parsed.sources).toEqual(["vector", "lexical"]);
    const roundTripped = SearchResultSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });
});

describe("HybridSearchMetaSchema", () => {
  it("round-trips a full meta object", () => {
    const valid = {
      vectorEnabled: true,
      detailResolved: "medium",
      expansionApplied: false,
      intent: "entity",
      mode: "balanced",
      embeddingColumn: "embedding",
      tokenBudget: { budget: 12000, used: 8000, kept: 5, dropped: 2 },
      cache: { status: "miss" },
      relational: { enabled: true, seed: "wiki/acme-co", hops: 2, candidates: 12 },
    };
    const parsed = HybridSearchMetaSchema.parse(valid);
    const roundTripped = HybridSearchMetaSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });

  it("accepts a minimal meta object", () => {
    const r = HybridSearchMetaSchema.safeParse({
      vectorEnabled: false,
      detailResolved: null,
      expansionApplied: false,
    });
    expect(r.success).toBe(true);
  });
});

// ─── Auth + OperationContext ─────────────────────────────────────────────────

describe("AuthInfoSchema", () => {
  it("round-trips a JWT auth", () => {
    const valid = {
      mode: "jwt",
      orgId: "org_2abc",
      orgSlug: "acme-co",
      userId: "user_xyz",
      scopes: ["read", "write"],
    };
    const parsed = AuthInfoSchema.parse(valid);
    const roundTripped = AuthInfoSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });

  it("round-trips an API-key auth", () => {
    const valid = {
      mode: "apikey",
      orgId: "org_2abc",
      orgSlug: "acme-co",
      scopes: ["read"],
      allowedSources: ["wiki"],
    };
    const parsed = AuthInfoSchema.parse(valid);
    expect(parsed.allowedSources).toEqual(["wiki"]);
    const roundTripped = AuthInfoSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });
});

describe("OperationContextSchema", () => {
  const validCtx = {
    tenant: {
      id: "01HZK9X8F4J7QZ3V1Y6N8M5B2X",
      clerkOrgId: "org_2abc",
      name: "Acme Co",
      slug: "acme-co",
      helixInstanceUrl: "http://helix-acme-co.internal:8080",
      helixApiKeyEncrypted: "base64==",
      coolifyAppId: "app_xyz",
      tier: "pro",
      status: "active",
      settings: { searchMode: "balanced" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    auth: {
      mode: "jwt",
      orgId: "org_2abc",
      orgSlug: "acme-co",
      userId: "user_xyz",
      scopes: ["read", "write"],
    },
    remote: false,
    sourceId: "wiki",
    dryRun: false,
    correlationId: "req_abc",
  };

  it("round-trips a trusted-local context (remote: false)", () => {
    const parsed = OperationContextSchema.parse(validCtx) as OperationContext;
    expect(parsed.remote).toBe(false);
    expect(parsed.tenant.tier).toBe("pro");
    const roundTripped = OperationContextSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });

  it("round-trips a remote context (remote: true)", () => {
    const remoteCtx = { ...validCtx, remote: true };
    const parsed = OperationContextSchema.parse(remoteCtx);
    expect(parsed.remote).toBe(true);
    const roundTripped = OperationContextSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });

  it("rejects a context missing the required `remote` field", () => {
    const { remote: _omit, ...missing } = validCtx;
    const r = OperationContextSchema.safeParse(missing);
    expect(r.success).toBe(false);
  });
});
