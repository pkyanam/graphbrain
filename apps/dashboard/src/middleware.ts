// Clerk route protection (Next.js middleware).
//
// Protects /dashboard/* routes (require auth). The /onboarding route also
// requires auth (the user must be signed in to create an org) but does NOT
// require a tenant yet — onboarding is where provisioning happens. Public
// routes: /, /sign-in, /sign-up.

import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isProtectedRoute = createRouteMatcher(["/dashboard(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  // Skip Next.js middleware for static assets + Next internals.
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
