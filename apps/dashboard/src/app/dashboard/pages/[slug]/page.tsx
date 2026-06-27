// Page detail — GET /api/dashboard/pages/:slug → render the page content
// (compiled_truth), its chunks, outgoing links, and backlinks. Show frontmatter
// as a metadata table.

import Link from "next/link";
import { notFound } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import { handleApiError } from "@/lib/handle-error";
import { ApiErrorView } from "@/components/ApiErrorView";

interface PageDetailProps {
  params: Promise<{ slug: string }>;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default async function PageDetailPage({
  params,
}: PageDetailProps): Promise<React.JSX.Element> {
  const { slug } = await params;
  const decodedSlug = decodeURIComponent(slug);

  let page = null;
  let chunks = null;
  let outEdges = null;
  let inEdges = null;
  let error: ApiError | null = null;

  try {
    const result = await api.getPage(decodedSlug);
    page = result.page;
    chunks = result.chunks;
    outEdges = result.outEdges;
    inEdges = result.inEdges;
  } catch (err) {
    if (err instanceof ApiError && err.code === "page_not_found") {
      notFound();
    }
    try {
      handleApiError(err);
    } catch (e) {
      error = e as ApiError;
    }
  }

  if (error) return <ApiErrorView error={error} />;
  if (!page) return <ApiErrorView error={new ApiError("internal_error", "No page data.", 500)} />;

  const frontmatterEntries = Object.entries(page.frontmatter ?? {});

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/dashboard/pages"
          className="text-sm text-neutral-500 hover:text-neutral-900"
        >
          ← Back to pages
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-neutral-900">{page.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
          <span className="rounded-full bg-neutral-100 px-2 py-0.5 font-medium text-neutral-600">
            {page.type}
          </span>
          <span className="font-mono">{page.slug}</span>
          <span>Updated {formatDate(page.updatedAt as unknown as string)}</span>
        </div>
      </div>

      {/* Compiled truth */}
      {page.compiledTruth && (
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Compiled truth
          </h2>
          <div className="whitespace-pre-wrap rounded-lg border border-neutral-200 bg-white p-4 text-sm text-neutral-700">
            {page.compiledTruth}
          </div>
        </div>
      )}

      {/* Frontmatter */}
      {frontmatterEntries.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Frontmatter
          </h2>
          <div className="overflow-hidden rounded-lg border border-neutral-200">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-neutral-200 bg-white">
                {frontmatterEntries.map(([key, value]) => (
                  <tr key={key}>
                    <td className="w-1/3 px-4 py-2 font-medium text-neutral-500">
                      {key}
                    </td>
                    <td className="px-4 py-2 text-neutral-900">
                      {typeof value === "object"
                        ? JSON.stringify(value)
                        : String(value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Chunks */}
      {chunks && chunks.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Chunks ({chunks.length})
          </h2>
          <div className="space-y-2">
            {chunks.map((c) => (
              <div
                key={c.id}
                className="rounded border border-neutral-200 bg-white p-3"
              >
                <p className="mb-1 text-xs text-neutral-400">
                  Chunk #{c.chunkIndex} · {c.chunkSource} · {c.modality}
                </p>
                <p className="whitespace-pre-wrap text-sm text-neutral-700">
                  {c.content}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Outgoing links */}
      {outEdges && outEdges.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Outgoing links ({outEdges.length})
          </h2>
          <ul className="space-y-1">
            {outEdges.map((e) => (
              <li key={e.id} className="text-sm">
                <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs font-medium text-neutral-600">
                  {e.type}
                </span>{" "}
                <Link
                  href={`/dashboard/pages/${encodeURIComponent(e.toSlug)}`}
                  className="text-neutral-900 hover:underline"
                >
                  {e.toSlug}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Backlinks */}
      {inEdges && inEdges.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Backlinks ({inEdges.length})
          </h2>
          <ul className="space-y-1">
            {inEdges.map((e) => (
              <li key={e.id} className="text-sm">
                <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs font-medium text-neutral-600">
                  {e.type}
                </span>{" "}
                <Link
                  href={`/dashboard/pages/${encodeURIComponent(e.fromSlug)}`}
                  className="text-neutral-900 hover:underline"
                >
                  {e.fromSlug}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
