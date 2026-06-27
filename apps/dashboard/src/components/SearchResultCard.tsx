// SearchResultCard — one search result (page + snippets + score + citations).

import Link from "next/link";
import type { SearchResult } from "@graphbrain/core";

export interface SearchResultCardProps {
  result: SearchResult;
  rank: number;
}

export function SearchResultCard({ result, rank }: SearchResultCardProps): React.JSX.Element {
  const { page, chunks, score, sources, citations } = result;
  const snippet =
    citations[0]?.snippet ?? chunks[0]?.content ?? page.compiledTruth ?? "";

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={`/dashboard/pages/${encodeURIComponent(page.slug)}`}
            className="text-sm font-semibold text-neutral-900 hover:underline"
          >
            {page.title}
          </Link>
          <p className="mt-0.5 text-xs text-neutral-500">{page.slug}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs font-medium tabular-nums text-neutral-400">
            #{rank + 1}
          </span>
          <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium tabular-nums text-neutral-600">
            {score.toFixed(3)}
          </span>
        </div>
      </div>
      {snippet && (
        <p className="mt-2 line-clamp-3 text-sm text-neutral-600">{snippet}</p>
      )}
      {sources.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {sources.map((s) => (
            <span
              key={s}
              className="rounded bg-neutral-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-400"
            >
              {s}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
