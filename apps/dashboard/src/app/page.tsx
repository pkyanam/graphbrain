// Root page — redirects to /onboarding (signed in) or /sign-in (signed out).
//
// Onboarding detects whether the brain is provisioned and redirects to
// /dashboard once ready. This keeps the entry point simple: one redirect,
// no data fetching here.

import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";

// Depends on the Clerk session — never statically prerender.
export const dynamic = "force-dynamic";

export default async function HomePage(): Promise<React.JSX.Element> {
  const session = await auth();
  if (!session.userId) {
    redirect("/sign-in");
  }
  redirect("/onboarding");
}
