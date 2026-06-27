// Error-handling helper for server-component data fetching.
//
// Dashboard pages call the API in a server component. Common error codes have
// standard responses:
//   • unauthenticated (401) → redirect to /sign-in.
//   • tenant_not_found (403) / tenant_not_active (503) → redirect to /onboarding
//     (the brain isn't ready; onboarding polls + redirects back when it is).
// Other errors propagate (the page renders an ApiErrorView).

import { redirect } from "next/navigation";
import { ApiError } from "./api";

/**
 * Handle an ApiError thrown during server-side data fetching. Returns true if
 * the error was handled (a redirect was issued or it should be swallowed).
 * Throws the original error back if the caller should render an error view.
 */
export function handleApiError(err: unknown): never {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.code === "unauthenticated") {
      redirect("/sign-in");
    }
    if (err.status === 403 || err.status === 503 || err.code === "tenant_not_found" || err.code === "tenant_not_active") {
      redirect("/onboarding");
    }
  }
  throw err;
}
