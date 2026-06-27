"use client";

// DashboardNav — the sidebar nav links with active highlighting.
// Client component so it can read the current pathname via usePathname.

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_LINKS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/search", label: "Search" },
  { href: "/dashboard/pages", label: "Pages" },
  { href: "/dashboard/sources", label: "Sources" },
  { href: "/dashboard/graph", label: "Graph" },
  { href: "/dashboard/jobs", label: "Jobs" },
  { href: "/dashboard/api-keys", label: "API Keys" },
  { href: "/dashboard/settings", label: "Settings" },
  { href: "/dashboard/eval", label: "Eval" },
  { href: "/dashboard/billing", label: "Billing" },
];

export function DashboardNav(): React.JSX.Element {
  const pathname = usePathname();
  return (
    <nav className="flex-1 space-y-0.5 p-3">
      {NAV_LINKS.map((link) => {
        const isActive =
          link.href === "/dashboard"
            ? pathname === "/dashboard"
            : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={
              isActive
                ? "block rounded-md bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900"
                : "block rounded-md px-3 py-2 text-sm font-medium text-neutral-600 transition hover:bg-neutral-50 hover:text-neutral-900"
            }
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
