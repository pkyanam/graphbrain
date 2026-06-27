// @graphbrain/core — source CRUD operations (Stage 10).
//
// Source-facing operations that delegate to BrainEngine (Stage 7):
//   • `list_sources`  — list sources in the tenant's brain. Read scope.
//   • `get_source`    — fetch a source by id or name. Read scope.
//   • `add_source`    — add a source (repo / folder / feed). Write scope.
//
// A Source represents a repo / folder / feed inside a tenant's brain. Pages
// belong to a source via the CONTAINS edge. Phase 1: single-source default;
// Phase 2 adds federated reads across sources.

import { z } from "zod";
import type { Source } from "../types";
import { OperationError } from "./types";
import type { Operation } from "./types";

// ─── list_sources ────────────────────────────────────────────────────────────

export const ListSourcesInputSchema = z.object({
  includeArchived: z.boolean().optional(),
  limit: z.number().int().positive().max(100).optional(),
  offset: z.number().int().nonnegative().optional(),
});

export type ListSourcesInput = z.infer<typeof ListSourcesInputSchema>;

export interface ListSourcesOutput {
  sources: Source[];
  count: number;
  offset: number;
}

/**
 * `list_sources` — list sources in the tenant's brain. Read scope.
 */
export const listSourcesOp: Operation<ListSourcesInput, ListSourcesOutput> = {
  name: "list_sources",
  description:
    "List sources (repos / folders / feeds) in the tenant's brain. " +
    "Supports limit/offset pagination and an includeArchived flag.",
  scope: "read",
  inputSchema: ListSourcesInputSchema,
  handler: async (input, _ctx, deps) => {
    const sources = await deps.engine.listSources({
      includeArchived: input.includeArchived,
      limit: input.limit,
      offset: input.offset,
    });
    return {
      sources,
      count: sources.length,
      offset: input.offset ?? 0,
    };
  },
};

// ─── get_source ──────────────────────────────────────────────────────────────

export const GetSourceInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
}).refine((v) => v.id !== undefined || v.name !== undefined, {
  message: "Either id or name must be provided",
});

export type GetSourceInput = z.infer<typeof GetSourceInputSchema>;

export interface GetSourceOutput {
  source: Source;
}

/**
 * `get_source` — fetch a source by id or name. Read scope. Throws
 * `source_not_found` if neither resolves.
 */
export const getSourceOp: Operation<GetSourceInput, GetSourceOutput> = {
  name: "get_source",
  description:
    "Fetch a source by id or name. Pass exactly one of `id` or `name`.",
  scope: "read",
  inputSchema: GetSourceInputSchema,
  handler: async (input, _ctx, deps) => {
    let source: Source | null = null;
    if (input.id) {
      source = await deps.engine.getSource(input.id);
    }
    if (!source && input.name) {
      source = await deps.engine.getSourceByName(input.name);
    }
    if (!source) {
      throw new OperationError(
        "source_not_found",
        `Source not found: ${input.id ?? input.name}`,
      );
    }
    return { source };
  },
};

// ─── add_source ──────────────────────────────────────────────────────────────

export const AddSourceInputSchema = z.object({
  name: z.string().min(1),
  localPath: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  chunkerVersion: z.number().int().nonnegative().optional(),
  contextualRetrievalMode: z.enum(["none", "title", "per_chunk_synopsis"]).optional(),
  trustFrontmatterOverrides: z.boolean().optional(),
});

export type AddSourceInput = z.infer<typeof AddSourceInputSchema>;

export interface AddSourceOutput {
  source: Source;
}

/**
 * `add_source` — add a source (repo / folder / feed) to the tenant's brain.
 * Write scope. Delegates to `engine.addSource`.
 */
export const addSourceOp: Operation<AddSourceInput, AddSourceOutput> = {
  name: "add_source",
  description:
    "Add a source (repo / folder / feed) to the tenant's brain. Pages " +
    "belong to a source via the CONTAINS edge.",
  scope: "write",
  inputSchema: AddSourceInputSchema,
  handler: async (input, _ctx, deps) => {
    const source = await deps.engine.addSource({
      name: input.name,
      localPath: input.localPath ?? null,
      config: input.config ?? {},
      chunkerVersion: input.chunkerVersion ?? null,
      contextualRetrievalMode: input.contextualRetrievalMode ?? null,
      trustFrontmatterOverrides: input.trustFrontmatterOverrides ?? null,
    });
    return { source };
  },
};
