// @graphbrain/core — link (edge) operations (Stage 10).
//
// Link-facing operations that delegate to BrainEngine (Stage 7):
//   • `get_links`      — outgoing edges from a page. Read scope.
//   • `get_backlinks`  — incoming edges to a page. Read scope.
//   • `add_link`       — add a typed or generic edge between two pages.
//                        Write scope.
//
// Edges are the typed-edge graph (MENTIONS, WORKS_AT, FOUNDED, etc.). The
// engine looks up pages by slug and throws if either is missing.

import { z } from "zod";
import type { Link, EdgeLabel } from "../types";
import { TYPED_EDGE_LABELS } from "../types";
import { OperationError } from "./types";
import type { Operation } from "./types";

// ─── get_links ───────────────────────────────────────────────────────────────

export const GetLinksInputSchema = z.object({
  slug: z.string().min(1),
  edgeTypes: z.array(z.string()).optional(),
});

export type GetLinksInput = z.infer<typeof GetLinksInputSchema>;

export interface GetLinksOutput {
  links: Link[];
  count: number;
}

/**
 * `get_links` — outgoing edges from a page (by slug). Read scope. Optionally
 * filter by edge label.
 */
export const getLinksOp: Operation<GetLinksInput, GetLinksOutput> = {
  name: "get_links",
  description:
    "Get outgoing edges (links) from a page by slug. Optionally filter by " +
    "edge label(s).",
  scope: "read",
  inputSchema: GetLinksInputSchema,
  handler: async (input, _ctx, deps) => {
    const links = await deps.engine.getOutEdges(
      input.slug,
      input.edgeTypes as EdgeLabel[] | undefined,
    );
    return { links, count: links.length };
  },
};

// ─── get_backlinks ───────────────────────────────────────────────────────────

export const GetBacklinksInputSchema = z.object({
  slug: z.string().min(1),
  edgeTypes: z.array(z.string()).optional(),
});

export type GetBacklinksInput = z.infer<typeof GetBacklinksInputSchema>;

export interface GetBacklinksOutput {
  backlinks: Link[];
  count: number;
}

/**
 * `get_backlinks` — incoming edges to a page (by slug). Read scope.
 */
export const getBacklinksOp: Operation<GetBacklinksInput, GetBacklinksOutput> = {
  name: "get_backlinks",
  description:
    "Get incoming edges (backlinks) to a page by slug. Optionally filter " +
    "by edge label(s).",
  scope: "read",
  inputSchema: GetBacklinksInputSchema,
  handler: async (input, _ctx, deps) => {
    const backlinks = await deps.engine.getInEdges(
      input.slug,
      input.edgeTypes as EdgeLabel[] | undefined,
    );
    return { backlinks, count: backlinks.length };
  },
};

// ─── add_link ────────────────────────────────────────────────────────────────

export const AddLinkInputSchema = z.object({
  fromSlug: z.string().min(1),
  toSlug: z.string().min(1),
  type: z.enum(TYPED_EDGE_LABELS as unknown as [string, ...string[]]).or(z.string()),
  origin: z.enum(["auto", "manual", "typed-link", "markdown", "frontmatter"]).optional(),
  context: z.string().optional(),
  originSlug: z.string().optional(),
  originField: z.string().optional(),
});

export type AddLinkInput = z.infer<typeof AddLinkInputSchema>;

export interface AddLinkOutput {
  link: Link;
}

/**
 * `add_link` — add a typed or generic edge between two pages (by slug).
 * Write scope. The engine throws if either page is missing; the op wraps
 * that as a `page_not_found` OperationError for consistent error handling.
 */
export const addLinkOp: Operation<AddLinkInput, AddLinkOutput> = {
  name: "add_link",
  description:
    "Add a typed or generic edge between two pages (looked up by slug). " +
    "The edge label is `type` (e.g. MENTIONS, WORKS_AT, FOUNDED); `origin` " +
    "records how the edge was created (default: manual).",
  scope: "write",
  inputSchema: AddLinkInputSchema,
  handler: async (input, _ctx, deps) => {
    try {
      const link = await deps.engine.addEdge({
        fromSlug: input.fromSlug,
        toSlug: input.toSlug,
        type: input.type as EdgeLabel,
        origin: input.origin ?? "manual",
        ...(input.context !== undefined ? { context: input.context } : {}),
        ...(input.originSlug !== undefined ? { originSlug: input.originSlug } : {}),
        ...(input.originField !== undefined ? { originField: input.originField } : {}),
      });
      return { link };
    } catch (err) {
      // The engine throws on missing pages — surface as page_not_found.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("not found") || msg.toLowerCase().includes("missing")) {
        throw new OperationError("page_not_found", msg);
      }
      throw err;
    }
  },
};
