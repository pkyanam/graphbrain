// Dashboard overview — stats (page count, chunk count) + recent pages + search bar.
//
// Server component: calls GET /api/dashboard/stats using the Clerk session JWT.

import { ApiError, api } from "@/lib/api";
import { handleApiError } from "@/lib/handle-error";
import { StatCard } from "@/components/StatCard";
import { PageList } from "@/components/PageList";
import { SearchBar } from "@/components/SearchBar";
import { ApiErrorView } from "@/components/ApiErrorView";

export default async function OverviewPage(): Promise<React.JSX.Element> {
  let stats;
  try {
    stats = await api.stats();
  } catch (err) {
    try {
      handleApiError(err);
    } catch (e) {
      return <ApiErrorView error={e as ApiError} />;
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900">Overview</h1>
        <p className="mt-1 text-sm text-neutral-500">
          A snapshot of your brain.
        </p>
      </div>

      <SearchBar />

      <div className="grid grid-cols-2 gap-4">
        <StatCard label="Pages" value={stats!.pageCount} />
        <StatCard label="Chunks" value={stats!.chunkCount} />
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Recent pages
        </h2>
        <PageList
          pages={stats!.recentPages}
          emptyMessage="No pages yet. Add one via the API or MCP."
        />
      </div>
    </div>
  );
}
