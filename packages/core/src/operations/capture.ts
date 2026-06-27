// @graphbrain/core — capture operation (Stage 10).
//
// `capture` — quick capture: infer a page type from the content, wrap the
// content as a markdown page, and delegate to the put_page handler for
// chunking + embedding + writing. Write scope.
//
// This is the agent-facing "jot this down" op: the caller provides a freeform
// note + an optional slug/type, and capture handles the rest. Ported from
// GBrain's capture op (simplified for Phase 1 — no source-kind provenance
// stamping, no file-as-input binary guard; those are Phase 2/3).

import { z } from "zod";
import type { OperationContext } from "../types";
import type { ResolvedDeps, Operation } from "./types";
import { putPageOp, type PutPageOutput } from "./pages";

// ─── capture ─────────────────────────────────────────────────────────────────

export const CaptureInputSchema = z.object({
  /** Freeform note content (markdown). */
  content: z.string().min(1),
  /** Optional slug (defaults to a timestamped slug). */
  slug: z.string().optional(),
  /** Optional page type (defaults to "note"; capture infers from content if omitted). */
  type: z.string().optional(),
  /** Optional title (defaults to the first line of content or the slug). */
  title: z.string().optional(),
  /** Skip chunk embedding (passed through to put_page). */
  skipEmbed: z.boolean().optional(),
});

export type CaptureInput = z.infer<typeof CaptureInputSchema>;

export type CaptureOutput = PutPageOutput;

/**
 * Infer a page type from freeform content. Phase 1 heuristic: very light —
 * checks for meeting-ish / conversation-ish / note-ish keywords. Full
 * inference (GBrain's schema-pack-aware inferType) is Phase 3.
 */
export function inferCaptureType(content: string): string {
  const lower = content.toLowerCase();
  if (/^(meeting|notes?:|sync|standup|1:1|1-on-1)/.test(lower)) return "meeting";
  if (/^(slack|dm|conversation|chat|transcript)/.test(lower)) return "conversation";
  if (/^(idea|hypothesis|theory)/.test(lower)) return "concept";
  return "note";
}

/**
 * Generate a timestamped slug when the caller doesn't provide one.
 * Format: `notes/YYYY-MM-DD-HHMMSS-<rand>`.
 */
export function generateCaptureSlug(now: Date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  const date = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
  const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const rand = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
  return `notes/${date}-${time}-${rand}`;
}

/**
 * `capture` — quick capture. Write scope.
 *
 * Infers a type (if not provided), generates a slug (if not provided),
 * derives a title (first line of content or the slug), and delegates to the
 * put_page handler for chunking + embedding + writing.
 */
export const captureOp: Operation<CaptureInput, CaptureOutput> = {
  name: "capture",
  description:
    "Quick capture: jot a freeform note. Infers a page type, generates a " +
    "slug (if not provided), and writes the page via put_page (chunks + " +
    "embeds). The agent-facing 'jot this down' op.",
  scope: "write",
  inputSchema: CaptureInputSchema,
  handler: async (input, ctx, deps) => {
    const slug = input.slug ?? generateCaptureSlug();
    const type = input.type ?? inferCaptureType(input.content);
    const title = input.title ?? extractTitle(input.content, slug);

    // Delegate to put_page. We call the handler directly (same deps + ctx)
    // rather than going through dispatch to avoid re-resolving the engine.
    return putPageOp.handler(
      {
        slug,
        content: input.content,
        type,
        title,
        ...(input.skipEmbed !== undefined ? { skipEmbed: input.skipEmbed } : {}),
      },
      ctx,
      deps,
    );
  },
};

/**
 * Derive a title from the content: the first non-empty line after any
 * frontmatter block, stripped of markdown heading markers. Falls back to
 * the slug.
 */
function extractTitle(content: string, fallback: string): string {
  // Strip a leading frontmatter block (--- ... ---) if present.
  const fmMatch = content.match(/^---\s*\n[\s\S]*?\n---\s*\n?/);
  const body = fmMatch ? content.slice(fmMatch[0].length) : content;
  const lines = body.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // Strip leading markdown heading markers.
    const headingMatch = trimmed.match(/^#+\s+(.*)$/);
    if (headingMatch) return headingMatch[1]!.trim();
    return trimmed;
  }
  return fallback;
}

// Re-export Operation type for convenience (so callers can import from one place).
export type { Operation, OperationContext, ResolvedDeps };
