// @graphbrain/core — 4-layer dedup pipeline + compiled truth guarantee (Stage 9).
//
// 1. By page: top 3 chunks per page by score
// 2. By text similarity: remove chunks >0.85 Jaccard-similar to kept results
// 3. By type: no page type exceeds 60% of results
// 4. By page: max N chunks per page (default 2)
// 5. Compiled truth guarantee: ensure at least 1 compiled_truth chunk per page
//
// Ported from _reference/gbrain/src/core/search/dedup.ts. Adapted to
// Graphbrain's SearchResult shape:
//   - GBrain dedups chunk-level rows keyed by (source_id, slug). Graphbrain
//     is single-source per tenant, so the page key is just `slug`.
//   - GBrain's SearchResult is flat (slug, title, chunk_text, chunk_source
//     on the top level). Graphbrain's SearchResult nests page + chunks:
//     `result.page.slug`, `result.page.type`, `result.chunks[].content`,
//     `result.chunks[].chunkSource`. The dedup operates on the chunk level
//     within each result — a result with multiple chunks is treated as
//     multiple dedup candidates (one per chunk), then re-grouped by page.
//
// The hybridSearch pipeline calls dedup AFTER fusing retrieval streams into
// per-page SearchResult rows (each row = one page + its matching chunks).
// dedup then trims the chunk list per page + removes near-duplicate chunk
// text across pages.

import type { SearchResult, Chunk } from "../types";

const COSINE_DEDUP_THRESHOLD = 0.85;
const MAX_TYPE_RATIO = 0.6;
const MAX_PER_PAGE = 2;
/** Top chunks per page kept by layer 1 (before further reduction). */
const TOP_CHUNKS_PER_PAGE = 3;

/**
 * Page key. Graphbrain is single-source per tenant (Phase 1), so the key
 * is just the slug. The helper exists so a future multi-source extension
 * changes one line.
 */
function pageKey(r: SearchResult): string {
  return r.page.slug;
}

export function dedupResults(
  results: SearchResult[],
  opts?: {
    cosineThreshold?: number;
    maxTypeRatio?: number;
    maxPerPage?: number;
  },
): SearchResult[] {
  const threshold = opts?.cosineThreshold ?? COSINE_DEDUP_THRESHOLD;
  const maxRatio = opts?.maxTypeRatio ?? MAX_TYPE_RATIO;
  const maxPerPage = opts?.maxPerPage ?? MAX_PER_PAGE;

  // Preserve pre-dedup input for compiled truth guarantee.
  const preDedup = results;

  let deduped = results;

  // Layer 1: Top 3 chunks per page by score.
  deduped = dedupByTopChunksPerPage(deduped);

  // Layer 2: Text similarity dedup (Jaccard on word sets) across chunk text.
  deduped = dedupByTextSimilarity(deduped, threshold);

  // Layer 3: Type diversity (no page type exceeds 60%).
  deduped = enforceTypeDiversity(deduped, maxRatio);

  // Layer 4: Cap chunks per page.
  deduped = capChunksPerPage(deduped, maxPerPage);

  // Final pass: guarantee compiled_truth representation.
  deduped = guaranteeCompiledTruth(deduped, preDedup);

  return deduped;
}

/**
 * Layer 1: Keep top 3 chunks per page (by chunk score — the result's score
 * is the page-level RRF score; chunks inherit it for sorting). Later layers
 * (text similarity, cap per page) handle further reduction.
 */
function dedupByTopChunksPerPage(results: SearchResult[]): SearchResult[] {
  const out: SearchResult[] = [];
  for (const r of results) {
    if (r.chunks.length <= TOP_CHUNKS_PER_PAGE) {
      out.push(r);
      continue;
    }
    // Sort chunks by a stable proxy (chunkIndex) — the page-level score is
    // the same for all chunks of one page, so we keep the first N by index
    // (which is the insertion order from the retrieval streams).
    const kept = [...r.chunks]
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .slice(0, TOP_CHUNKS_PER_PAGE);
    out.push({ ...r, chunks: kept });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Layer 2: Remove chunks that are too similar to already-kept chunks
 * (across all pages). Uses Jaccard similarity on word sets as a proxy for
 * cosine similarity. Operates per-chunk: a result with N chunks may keep
 * a subset.
 */
function dedupByTextSimilarity(results: SearchResult[], threshold: number): SearchResult[] {
  const keptChunkTexts: string[] = [];
  const out: SearchResult[] = [];

  for (const r of results) {
    const keptChunks: Chunk[] = [];
    for (const c of r.chunks) {
      const rWords = new Set(c.content.toLowerCase().split(/\s+/));
      let tooSimilar = false;
      for (const k of keptChunkTexts) {
        const kWords = new Set(k.toLowerCase().split(/\s+/));
        const intersection = new Set([...rWords].filter((w) => kWords.has(w)));
        const union = new Set([...rWords, ...kWords]);
        const jaccard = union.size === 0 ? 0 : intersection.size / union.size;
        if (jaccard > threshold) {
          tooSimilar = true;
          break;
        }
      }
      if (!tooSimilar) {
        keptChunkTexts.push(c.content);
        keptChunks.push(c);
      }
    }
    out.push({ ...r, chunks: keptChunks });
  }

  // Drop results that lost all their chunks (unless chunkless — keep
  // chunkless entity pages from the relational arm).
  return out.filter((r) => r.chunks.length > 0 || r.sources.includes("relational"));
}

/**
 * Layer 3: No page type exceeds maxRatio of total results.
 */
function enforceTypeDiversity(results: SearchResult[], maxRatio: number): SearchResult[] {
  const maxPerType = Math.max(1, Math.ceil(results.length * maxRatio));
  const typeCounts = new Map<string, number>();
  const kept: SearchResult[] = [];

  for (const r of results) {
    const count = typeCounts.get(r.page.type) ?? 0;
    if (count < maxPerType) {
      kept.push(r);
      typeCounts.set(r.page.type, count + 1);
    }
  }

  return kept;
}

/**
 * Layer 4: Cap chunks per page (default 2). Operates on the already-trimmed
 * chunk lists from layers 1+2.
 */
function capChunksPerPage(results: SearchResult[], maxPerPage: number): SearchResult[] {
  const out: SearchResult[] = [];
  for (const r of results) {
    // Chunkless entity pages (relational arm) pass through unchanged.
    if (r.chunks.length === 0) {
      out.push(r);
      continue;
    }
    if (r.chunks.length <= maxPerPage) {
      out.push(r);
      continue;
    }
    const kept = [...r.chunks]
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .slice(0, maxPerPage);
    out.push({ ...r, chunks: kept });
  }
  return out;
}

/**
 * Final pass: for each page in results that has no compiled_truth chunk,
 * swap in the best compiled_truth chunk from the pre-dedup set (if one
 * exists). This guarantees every page contributes its canonical summary.
 */
function guaranteeCompiledTruth(
  results: SearchResult[],
  preDedup: SearchResult[],
): SearchResult[] {
  // Index pre-dedup compiled_truth chunks by page slug.
  const compiledByPage = new Map<string, Chunk[]>();
  for (const r of preDedup) {
    for (const c of r.chunks) {
      if (c.chunkSource === "compiled_truth") {
        let list = compiledByPage.get(r.page.slug);
        if (!list) {
          list = [];
          compiledByPage.set(r.page.slug, list);
        }
        list.push(c);
      }
    }
  }

  const output = [...results];
  for (let i = 0; i < output.length; i++) {
    const r = output[i]!;
    // Chunkless entity pages (relational arm) have no chunks to swap.
    if (r.chunks.length === 0) continue;
    const hasCompiledTruth = r.chunks.some((c) => c.chunkSource === "compiled_truth");
    if (hasCompiledTruth) continue;

    const candidates = compiledByPage.get(r.page.slug);
    if (!candidates || candidates.length === 0) continue;

    // Swap: replace the lowest-index chunk (a proxy for lowest-scored —
    // chunks are insertion-ordered by retrieval stream) with the best
    // compiled_truth candidate.
    const candidate = candidates[0]!;
    const swapIdx = r.chunks.findIndex((c) => c.chunkSource !== "compiled_truth");
    if (swapIdx !== -1) {
      const newChunks = [...r.chunks];
      newChunks[swapIdx] = candidate;
      output[i] = { ...r, chunks: newChunks };
    }
  }
  return output;
}
