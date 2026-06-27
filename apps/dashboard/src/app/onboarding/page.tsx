// Onboarding — new-tenant setup flow.
//
// Detects if the signed-in user has a Clerk org with a Graphbrain tenant:
//   1. No Clerk org selected → prompt to create/select an org (Clerk's
//      CreateOrganization component). Creating the org triggers the Clerk
//      organization.created webhook (Stage 4) → provisions HelixDB.
//   2. Org selected → poll GET /api/dashboard/stats until 200 (brain ready).
//      The API returns 403 (tenant_not_found) when no tenant exists, and 503
//      (tenant_not_active) while provisioning. A 200 means ready → redirect
//      to /dashboard.
//
// This is a server component that branches on `auth().orgId`; the polling UI
// is the client-side ProvisioningSpinner.

import { CreateOrganization, OrganizationSwitcher } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { ProvisioningSpinner } from "@/components/ProvisioningSpinner";

// Depends on the Clerk session — never statically prerender.
export const dynamic = "force-dynamic";

export default async function OnboardingPage(): Promise<React.JSX.Element> {
  const session = await auth();

  // Not signed in — Clerk middleware should have caught this, but guard anyway.
  if (!session.userId) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4 text-sm text-neutral-500">
        Please sign in to continue.
      </div>
    );
  }

  // No org selected yet — prompt to create or select one.
  if (!session.orgId) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-4">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-neutral-900">
            Create your organization
          </h1>
          <p className="mt-2 max-w-md text-sm text-neutral-500">
            Each Graphbrain brain belongs to an organization. Create one to
            provision your dedicated knowledge brain.
          </p>
        </div>
        <div className="w-full max-w-sm rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
          <CreateOrganization />
          <div className="mt-4 border-t border-neutral-200 pt-4">
            <p className="mb-2 text-xs font-medium text-neutral-500">
              Already have an organization?
            </p>
            <OrganizationSwitcher hidePersonal />
          </div>
        </div>
      </div>
    );
  }

  // Org selected — poll for brain readiness.
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-8 shadow-sm">
        <h1 className="text-center text-xl font-bold text-neutral-900">
          Setting up your brain
        </h1>
        <p className="mt-1 text-center text-sm text-neutral-500">
          We&apos;re provisioning your dedicated HelixDB instance. This usually
          takes a minute or two.
        </p>
        <ProvisioningSpinner />
      </div>
    </div>
  );
}
