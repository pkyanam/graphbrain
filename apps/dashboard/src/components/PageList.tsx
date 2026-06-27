// PageList — a list of pages (slug, title, type, updated date).

import Link from "next/link";

export interface PageListItem {
  id: string;
  slug: string;
  type: string;
  title: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface PageListProps {
  pages: PageListItem[];
  emptyMessage?: string;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

export function PageList({ pages, emptyMessage = "No pages yet." }: PageListProps): React.JSX.Element {
  if (pages.length === 0) {
    return <p className="text-sm text-neutral-500">{emptyMessage}</p>;
  }
  return (
    <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white">
      {pages.map((p) => (
        <li key={p.id}>
          <Link
            href={`/dashboard/pages/${encodeURIComponent(p.slug)}`}
            className="flex items-center justify-between px-4 py-3 transition hover:bg-neutral-50"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-neutral-900">
                {p.title}
                {p.deletedAt && (
                  <span className="ml-2 text-xs font-normal text-neutral-400">
                    (deleted)
                  </span>
                )}
              </p>
              <p className="truncate text-xs text-neutral-500">{p.slug}</p>
            </div>
            <div className="ml-4 flex shrink-0 items-center gap-3">
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">
                {p.type}
              </span>
              <span className="text-xs text-neutral-400">
                {formatDate(p.updatedAt)}
              </span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
