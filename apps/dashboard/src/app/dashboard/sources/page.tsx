// Sources — list sources (GET /api/dashboard/sources works). The sync action
// (POST /api/dashboard/sources/sync) is a Phase 2 stub (501), so the sync
// button is gated with a "Coming in Phase 2" note.

import { ApiError, api } from "@/lib/api";
import { handleApiError } from "@/lib/handle-error";
import { ApiErrorView } from "@/components/ApiErrorView";

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "Never";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default async function SourcesPage(): Promise<React.JSX.Element> {
  let output = null;
  let error: ApiError | null = null;

  try {
    output = await api.listSources();
  } catch (err) {
    try {
      handleApiError(err);
    } catch (e) {
      error = e as ApiError;
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900">Sources</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Repositories and feeds connected to your brain.
          </p>
        </div>
        <div className="relative">
          <button
            type="button"
            disabled
            className="cursor-not-allowed rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-2 text-sm font-medium text-neutral-400"
            title="Coming in Phase 2"
          >
            Sync all
          </button>
        </div>
      </div>

      <p className="rounded-lg bg-neutral-100 px-3 py-2 text-xs text-neutral-500">
        Source sync is coming in Phase 2. The list below reflects sources
        already connected.
      </p>

      {error && <ApiErrorView error={error} />}

      {output && (
        <div className="overflow-hidden rounded-lg border border-neutral-200">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Path</th>
                <th className="px-4 py-2">Last sync</th>
                <th className="px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 bg-white">
              {output.sources.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-neutral-500">
                    No sources connected.
                  </td>
                </tr>
              ) : (
                output.sources.map((s) => (
                  <tr key={s.id}>
                    <td className="px-4 py-2 font-medium text-neutral-900">
                      {s.name}
                    </td>
                    <td className="px-4 py-2 text-neutral-600">
                      {s.localPath ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-neutral-500">
                      {formatDate(s.lastSyncAt as unknown as string)}
                    </td>
                    <td className="px-4 py-2">
                      {s.archived ? (
                        <span className="text-neutral-400">Archived</span>
                      ) : (
                        <span className="text-green-600">Active</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
