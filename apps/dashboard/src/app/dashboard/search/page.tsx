// Search interface — reads ?q= from the URL, calls POST /api/dashboard/search,
// renders results with citations.

import { ApiError, api } from "@/lib/api";
import { handleApiError } from "@/lib/handle-error";
import { SearchBar } from "@/components/SearchBar";
import { SearchResultCard } from "@/components/SearchResultCard";
import { ApiErrorView } from "@/components/ApiErrorView";

interface SearchPageProps {
  searchParams: Promise<{ q?: string }>;
}

export default async function SearchPage({
  searchParams,
}: SearchPageProps): Promise<React.JSX.Element> {
  const params = await searchParams;
  const q = params.q?.trim() ?? "";

  let results = null;
  let error: ApiError | null = null;

  if (q) {
    try {
      const output = await api.search({ query: q });
      results = output.results;
    } catch (err) {
      try {
        handleApiError(err);
      } catch (e) {
        error = e as ApiError;
      }
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900">Search</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Hybrid retrieval over your brain.
        </p>
      </div>

      <SearchBar initialValue={q} />

      {error && <ApiErrorView error={error} />}

      {q && !error && (
        <div>
          {results && results.length > 0 ? (
            <div className="space-y-3">
              <p className="text-sm text-neutral-500">
                {results.length} result{results.length === 1 ? "" : "s"} for
                &quot;{q}&quot;
              </p>
              {results.map((r, i) => (
                <SearchResultCard key={r.page.id} result={r} rank={i} />
              ))}
            </div>
          ) : (
            !error && (
              <p className="text-sm text-neutral-500">
                No results for &quot;{q}&quot;.
              </p>
            )
          )}
        </div>
      )}

      {!q && (
        <p className="text-sm text-neutral-500">
          Enter a query above to search your brain.
        </p>
      )}
    </div>
  );
}
