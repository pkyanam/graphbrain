// Dashboard layout — wraps every /dashboard/* page in the shell (sidebar +
// Clerk widgets). Server component.

import { DashboardShell } from "@/components/DashboardShell";

// Every dashboard page reads the Clerk session + calls the API, so they must
// be dynamically rendered (never statically prerendered at build time).
export const dynamic = "force-dynamic";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return <DashboardShell>{children}</DashboardShell>;
}
