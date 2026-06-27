// DashboardShell — the authenticated layout shell (sidebar nav + Clerk widgets).
//
// Wraps the /dashboard/* pages with a consistent sidebar: the Clerk
// OrganizationSwitcher + UserButton + nav links. Server component (the Clerk
// widgets + DashboardNav are client-island components).

import Link from "next/link";
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import { DashboardNav } from "./DashboardNav";

export interface DashboardShellProps {
  children: React.ReactNode;
}

export function DashboardShell({ children }: DashboardShellProps): React.JSX.Element {
  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-white">
        <div className="border-b border-neutral-200 p-4">
          <Link href="/dashboard" className="text-lg font-bold text-neutral-900">
            Graphbrain
          </Link>
        </div>
        <div className="border-b border-neutral-200 p-3">
          <OrganizationSwitcher
            hidePersonal
            afterSelectOrganizationUrl="/onboarding"
            afterCreateOrganizationUrl="/onboarding"
          />
        </div>
        <DashboardNav />
        <div className="border-t border-neutral-200 p-3">
          <UserButton />
        </div>
      </aside>
      <main className="flex-1 overflow-x-hidden">
        <div className="mx-auto max-w-4xl px-6 py-8">{children}</div>
      </main>
    </div>
  );
}
