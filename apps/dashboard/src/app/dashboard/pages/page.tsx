// Page browser — GET /api/dashboard/pages → paginated list. Optional type filter.

import Link from "next/link";
import { ApiError, api } from "@/lib/api";
import { handleApiError } from "@/lib/handle-error";
import { PageList } from "@/components/PageList";
import { ApiErrorView } from "@/components/ApiErrorView";

interface PagesPageProps {
  searchParams: Promise<{ type?: string; limit?: string; offset?: string }>;
}

export default async function PagesPage({
  searchParams,
}: PagesPageProps): Promise<React.JSX.Element> {
  const params = await searchParams;
  const type = params.type?.trim() || undefined;
  const limit = params.limit ? Number(params.limit) : undefined;
  const offset = params.offset ? Number(params.offset) : undefined;

  let output = null;
  let error: ApiError | null = null;

  try {
    output = await api.listPages({ type, limit, offset });
  } catch (err) {
    try {
      handleApiError(err);
    } catch (e) {
      error = e as ApiError;
    }
  }

  const currentOffset = output?.offset ?? offset ?? 0;
  const nextOffset = currentOffset + (output?.pages.length ?? 0);
  const hasMore = output && output.pages.length >= (limit ?? 50);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900">Pages</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Browse all pages in your brain.
          </p>
        </div>
        {type && (
          <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
            type: {type}
          </span>
        )}
      </div>

      {error && <ApiErrorView error={error} />}

      {output && (
        <>
          <PageList
            pages={output.pages}
            emptyMessage="No pages yet. Add one via the API or MCP."
          />
          {(currentOffset > 0 || hasMore) && (
            <div className="flex items-center justify-between">
              {currentOffset > 0 ? (
                <Link
                  href={`/dashboard/pages?offset=${Math.max(0, currentOffset - (limit ?? 50))}${type ? `&type=${type}` : ""}`}
                  className="text-sm font-medium text-neutral-600 hover:text-neutral-900"
                >
                  ← Previous
                </Link>
              ) : (
                <span />
              )}
              {hasMore && (
                <Link
                  href={`/dashboard/pages?offset=${nextOffset}${type ? `&type=${type}` : ""}`}
                  className="text-sm font-medium text-neutral-600 hover:text-neutral-900"
                >
                  Next →
                </Link>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
