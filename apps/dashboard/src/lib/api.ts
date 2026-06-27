// Server-side API client entry — uses Clerk's `auth()` (server-only) to
// resolve the session JWT.
//
// This module imports `@clerk/nextjs/server` which is server-only. Server
// components import `api` / `ApiError` from here. Client components MUST NOT
// import from this file — they use `./use-api.ts` instead (which backs the
// token getter with `useAuth()`).

import "server-only";
import { auth } from "@clerk/nextjs/server";
import {
  ApiError,
  createApiClient,
  type ApiClient,
  type TokenGetter,
} from "./api-core";

export { ApiError } from "./api-core";
export type {
  StatsResponse,
  StatsResponsePage,
  ListPagesParams,
  ListPagesOutput,
  CreateApiKeyOutput,
  ListApiKeysOutput,
  RevokeApiKeyOutput,
  SettingsResponse,
} from "./api-core";

/**
 * Resolve the Clerk session JWT for the current server request. Throws
 * ApiError('unauthenticated') if no session is available.
 */
async function serverGetToken(): Promise<string> {
  const session = await auth();
  const token = await session?.getToken();
  if (!token) {
    throw new ApiError(
      "unauthenticated",
      "No Clerk session token available. Sign in to continue.",
      401,
    );
  }
  return token;
}

/**
 * The typed API client for server components. Bound to the server-side token
 * getter (Clerk `auth()`).
 */
export const api: ApiClient = createApiClient(serverGetToken as TokenGetter);
