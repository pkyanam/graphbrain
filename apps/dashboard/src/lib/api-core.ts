// Core API client — client-safe (no server-only imports).
//
// The fetch helpers + typed `api` surface, parameterized by a `getToken`
// function. Server components pass a token getter backed by `auth()` (see
// ./api.ts); client components pass one backed by `useAuth()` (see
// ./use-api.ts). This split keeps `@clerk/nextjs/server` (server-only) out of
// the client bundle.
//
// All response/request types are imported from @graphbrain/core.

import type {
  SearchInput,
  SearchOutput,
  GetPageOutput,
  PutPageInput,
  PutPageOutput,
  ListSourcesOutput,
  TenantSettings,
  ClerkApiKey,
} from "@graphbrain/core";

// ─── Error ───────────────────────────────────────────────────────────────────

/**
 * Typed API error. Carries the stable `code` from the API's unified error
 * shape so the UI can branch on it (e.g. `tenant_not_active` → provisioning
 * spinner, `unauthenticated` → redirect to sign-in).
 */
export class ApiError extends Error {
  readonly code: string;
  readonly suggestion?: string;
  readonly status: number;

  constructor(code: string, message: string, status: number, suggestion?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.suggestion = suggestion;
  }
}

// ─── Response shapes (dashboard-specific wrappers) ───────────────────────────

export interface StatsResponse {
  pageCount: number;
  chunkCount: number;
  recentPages: StatsResponsePage[];
}

// The API serializes Page dates as ISO strings over the wire; the dashboard
// treats them as strings (no Date parsing needed for display).
export interface StatsResponsePage {
  id: string;
  slug: string;
  type: string;
  title: string;
  compiledTruth: string;
  frontmatter: Record<string, unknown>;
  pageKind: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface ListPagesParams {
  type?: string;
  limit?: number;
  offset?: number;
  includeDeleted?: boolean;
}

export interface ListPagesOutput {
  pages: StatsResponsePage[];
  count: number;
  offset: number;
}

export interface CreateApiKeyOutput {
  id: string;
  name: string;
  scopes: string[];
  secret: string | null;
}

export interface ListApiKeysOutput {
  keys: ClerkApiKey[];
}

export interface RevokeApiKeyOutput {
  ok: boolean;
}

export interface SettingsResponse {
  settings: TenantSettings;
}

// ─── Token resolver ──────────────────────────────────────────────────────────

/** A function that resolves the Clerk session JWT for the current context. */
export type TokenGetter = () => Promise<string>;

// ─── Core fetch helpers ──────────────────────────────────────────────────────

function baseUrl(): string {
  const url = process.env.NEXT_PUBLIC_API_URL;
  if (!url) {
    throw new ApiError(
      "internal_error",
      "NEXT_PUBLIC_API_URL is not set.",
      500,
    );
  }
  return url.replace(/\/+$/, "");
}

/**
 * Parse a non-2xx response into a typed ApiError. The API's unified error
 * shape is `{ error: { code, message, suggestion? } }`.
 */
async function throwApiError(res: Response): Promise<never> {
  let code = "internal_error";
  let message = `Request failed with status ${res.status}.`;
  let suggestion: string | undefined;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string; suggestion?: string } };
    if (body?.error) {
      if (body.error.code) code = body.error.code;
      if (body.error.message) message = body.error.message;
      suggestion = body.error.suggestion;
    }
  } catch {
    // Non-JSON response — keep the default message.
  }
  throw new ApiError(code, message, res.status, suggestion);
}

/** Build the auth headers for an API request. */
async function authHeaders(
  getToken: TokenGetter,
  extra?: Record<string, string>,
): Promise<Record<string, string>> {
  const token = await getToken();
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...extra,
  };
}

/** GET a JSON endpoint. Throws ApiError on non-2xx. */
export async function apiGet<T>(path: string, getToken: TokenGetter): Promise<T> {
  const headers = await authHeaders(getToken);
  const res = await fetch(`${baseUrl()}${path}`, { method: "GET", headers });
  if (!res.ok) await throwApiError(res);
  return (await res.json()) as T;
}

/** POST a JSON body. Throws ApiError on non-2xx. */
export async function apiPost<T>(path: string, body: unknown, getToken: TokenGetter): Promise<T> {
  const headers = await authHeaders(getToken, { "Content-Type": "application/json" });
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) await throwApiError(res);
  return (await res.json()) as T;
}

/** PUT a JSON body. Throws ApiError on non-2xx. */
export async function apiPut<T>(path: string, body: unknown, getToken: TokenGetter): Promise<T> {
  const headers = await authHeaders(getToken, { "Content-Type": "application/json" });
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) await throwApiError(res);
  return (await res.json()) as T;
}

/** DELETE an endpoint. Throws ApiError on non-2xx. */
export async function apiDelete<T>(path: string, getToken: TokenGetter): Promise<T> {
  const headers = await authHeaders(getToken);
  const res = await fetch(`${baseUrl()}${path}`, { method: "DELETE", headers });
  if (!res.ok) await throwApiError(res);
  return (await res.json()) as T;
}

// ─── Query-string helper ─────────────────────────────────────────────────────

function qs(params?: Record<string, unknown>): string {
  if (!params) return "";
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== "",
  );
  if (entries.length === 0) return "";
  const search = new URLSearchParams();
  for (const [k, v] of entries) {
    search.set(k, typeof v === "boolean" ? String(v) : String(v));
  }
  return `?${search.toString()}`;
}

// ─── Typed API surface ───────────────────────────────────────────────────────

/**
 * Create the typed `api` client bound to a token getter. Server components
 * use the server getter (./api.ts); client components use the `useAuth()`
 * getter (./use-api.ts).
 */
export function createApiClient(getToken: TokenGetter) {
  return {
    /** GET /api/dashboard/stats — page/chunk counts + recent pages. */
    stats: (): Promise<StatsResponse> => apiGet<StatsResponse>("/api/dashboard/stats", getToken),

    /** POST /api/dashboard/search — hybrid search. */
    search: (input: SearchInput): Promise<SearchOutput> =>
      apiPost<SearchOutput>("/api/dashboard/search", input, getToken),

    /** GET /api/dashboard/pages — list pages (paginated, optional type filter). */
    listPages: (params?: ListPagesParams): Promise<ListPagesOutput> =>
      apiGet<ListPagesOutput>(`/api/dashboard/pages${qs(params as Record<string, unknown> | undefined)}`, getToken),

    /** GET /api/dashboard/pages/:slug — page detail (page + chunks + edges). */
    getPage: (slug: string): Promise<GetPageOutput> =>
      apiGet<GetPageOutput>(`/api/dashboard/pages/${encodeURIComponent(slug)}`, getToken),

    /** POST /api/dashboard/pages — create/update a page (put_page). */
    putPage: (input: PutPageInput): Promise<PutPageOutput> =>
      apiPost<PutPageOutput>("/api/dashboard/pages", input, getToken),

    /** GET /api/dashboard/sources — list sources. */
    listSources: (): Promise<ListSourcesOutput> =>
      apiGet<ListSourcesOutput>("/api/dashboard/sources", getToken),

    /** GET /api/dashboard/settings — tenant settings. */
    getSettings: (): Promise<SettingsResponse> =>
      apiGet<SettingsResponse>("/api/dashboard/settings", getToken),

    /** PUT /api/dashboard/settings — merge + persist settings. */
    updateSettings: (settings: Partial<TenantSettings>): Promise<SettingsResponse> =>
      apiPut<SettingsResponse>("/api/dashboard/settings", settings, getToken),

    /** POST /api/dashboard/api-keys — issue a new API key (secret returned once). */
    createApiKey: (input: { name?: string }): Promise<CreateApiKeyOutput> =>
      apiPost<CreateApiKeyOutput>("/api/dashboard/api-keys", input, getToken),

    /** GET /api/dashboard/api-keys — list existing API keys (metadata only). */
    listApiKeys: (): Promise<ListApiKeysOutput> =>
      apiGet<ListApiKeysOutput>("/api/dashboard/api-keys", getToken),

    /** DELETE /api/dashboard/api-keys/:id — revoke an API key. */
    revokeApiKey: (id: string): Promise<RevokeApiKeyOutput> =>
      apiDelete<RevokeApiKeyOutput>(`/api/dashboard/api-keys/${encodeURIComponent(id)}`, getToken),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
