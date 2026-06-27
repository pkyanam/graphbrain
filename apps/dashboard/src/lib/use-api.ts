"use client";

// Client-side API hook — backs the token getter with Clerk's `useAuth()`.
//
// Client components call `const api = useApi()` then use `api.stats()` etc.
// The token is resolved from the Clerk client session via `useAuth().getToken`.

import { useAuth } from "@clerk/nextjs";
import { useMemo } from "react";
import { createApiClient, type ApiClient, type TokenGetter } from "./api-core";

export { ApiError } from "./api-core";

/**
 * Returns a typed API client bound to the current Clerk client session's
 * token getter. Use in Client Components only.
 */
export function useApi(): ApiClient {
  const { getToken } = useAuth();
  return useMemo(() => {
    const getter: TokenGetter = async () => {
      const token = await getToken();
      if (!token) {
        throw new Error("No Clerk session token available. Sign in to continue.");
      }
      return token;
    };
    return createApiClient(getter);
  }, [getToken]);
}
