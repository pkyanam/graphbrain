// @graphbrain/core — Coolify REST API client.
//
// Wraps the Coolify REST API (`/api/v1/applications`) to manage the lifecycle
// of per-tenant HelixDB containers: provision, start, stop, delete, status,
// backup. All requests carry `Authorization: Bearer ${COOLIFY_API_TOKEN}`.
//
// Config is read lazily INSIDE each function (via `getConfig()`), not at
// module top level, so importing `@graphbrain/core` does not require a valid
// `.env` (Stage 2 note #1). The Coolify base URL, token, and server uuid come
// from `getConfig()` (`COOLIFY_API_URL`, `COOLIFY_API_TOKEN`,
// `COOLIFY_SERVER_UUID`).
//
// The docker-compose template is the HelixDB instance template from
// PLAN.md (lines 401–429), with `<tenant-slug>`, the generated
// `HELIX_API_KEY`, and MinIO creds from config substituted in. The
// substituted YAML is validated to (a) have no leftover placeholders and
// (b) parse structurally (via the `yaml` package) before it is sent to
// Coolify, so a malformed substitution fails loudly here instead of
// producing a broken container.

import { parse as parseYaml } from "yaml";
import { getConfig } from "../config";

/** Exposed port for the HelixDB container (matches the compose template). */
const HELIX_PORT = "8080";

/** Result of provisioning a new HelixDB instance via Coolify. */
export interface ProvisionedInstance {
  /** Coolify application uuid — stored on the tenant row as `coolify_app_id`. */
  appId: string;
  /** Reachable URL for the HelixDB instance (used for `/health` polling + routing). */
  url: string;
  /** The generated HelixDB API key (plaintext; caller encrypts before storing). */
  apiKey: string;
}

/** Coarse-grained lifecycle status mapped from Coolify's status strings. */
export type InstanceStatus = "running" | "stopped" | "pending" | "error";

// ─── Docker-compose template ─────────────────────────────────────────────────

/**
 * HelixDB instance docker-compose template (PLAN.md lines 401–429).
 *
 * Placeholders (substituted by `buildHelixComposeYaml`):
 *   <tenant-slug>     — tenant slug (used in container name, bucket, volume)
 *   <api-key>         — generated per-tenant HELIX_API_KEY
 *   <s3-endpoint>     — MinIO endpoint (from config)
 *   <s3-access-key>   — MinIO access key (from config)
 *   <s3-secret-key>   — MinIO secret key (from config)
 *
 * Deviation from PLAN.md: the dynamic env values (api key + MinIO creds) are
 * double-quoted so a value containing `:`, `#`, or other YAML-significant
 * characters cannot break the compose file. The bucket name
 * `helix-<tenant-slug>` stays unquoted (slugs are restricted to URL-safe
 * characters). The substituted YAML is parsed + structurally validated before
 * being sent to Coolify, so any breakage surfaces here.
 */
const HELIX_COMPOSE_TEMPLATE = `services:
  helixdb:
    image: ghcr.io/helixdb/enterprise-dev:latest
    ports:
      - "8080"
    environment:
      - HELIX_API_KEY="<api-key>"
      - HELIX_STORAGE=disk
      - HELIX_S3_ENDPOINT="<s3-endpoint>"
      - HELIX_S3_BUCKET=helix-<tenant-slug>
      - HELIX_S3_ACCESS_KEY="<s3-access-key>"
      - HELIX_S3_SECRET_KEY="<s3-secret-key>"
    volumes:
      - helix-<tenant-slug>-data:/data
    deploy:
      resources:
        limits:
          memory: 2G
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  helix-<tenant-slug>-data:
`;

/**
 * Build the HelixDB docker-compose YAML for a tenant by substituting the
 * slug, generated API key, and MinIO creds (from config) into the template.
 *
 * Validates that no placeholder is left unsubstituted and that the result
 * parses as YAML with the expected `services.helixdb` structure. Exposed for
 * the provision flow + tests.
 */
export function buildHelixComposeYaml(tenantSlug: string, apiKey: string): string {
  const config = getConfig();
  const yaml = HELIX_COMPOSE_TEMPLATE
    .replaceAll("<tenant-slug>", tenantSlug)
    .replaceAll("<api-key>", apiKey)
    .replaceAll("<s3-endpoint>", config.minioEndpoint)
    .replaceAll("<s3-access-key>", config.minioAccessKey)
    .replaceAll("<s3-secret-key>", config.minioSecretKey);

  // No leftover placeholders (catches a missed substitution or a slug that
  // itself contains `<...>`).
  if (/<[a-z-]+>/.test(yaml)) {
    throw new Error(
      `buildHelixComposeYaml: unsubstituted placeholder remaining in compose YAML for slug="${tenantSlug}"`,
    );
  }

  const parsed = parseYaml(yaml) as unknown;
  if (!isHelixComposeShape(parsed)) {
    throw new Error(
      `buildHelixComposeYaml: generated compose YAML is structurally invalid for slug="${tenantSlug}"`,
    );
  }
  return yaml;
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

/** Coolify base URL with any trailing slashes stripped. */
function coolifyBase(): string {
  return getConfig().coolifyApiUrl.replace(/\/+$/, "");
}

/** Standard auth + JSON headers for every Coolify request. */
function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getConfig().coolifyApiToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/**
 * Issue a request against the Coolify REST API. Merges auth headers with any
 * caller-supplied headers (caller headers win on conflict).
 */
async function coolifyFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = `${coolifyBase()}${path}`;
  const headers: Record<string, string> = { ...authHeaders() };
  if (init.headers) {
    const incoming = init.headers as Record<string, string>;
    for (const [k, v] of Object.entries(incoming)) headers[k] = v;
  }
  return fetch(url, { ...init, headers });
}

/** Read the response body as text, never throwing (for error messages). */
async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Provision a new HelixDB instance for a tenant via Coolify.
 *
 * POSTs the substituted docker-compose template to `/api/v1/applications`
 * with the configured server uuid, application name `helix-<tenant-slug>`,
 * and exposed port `8080`. Returns the Coolify application uuid, a reachable
 * URL, and the (plaintext) API key.
 *
 * The URL is taken from the Coolify response's `fqdn`/`domains` field when
 * present; otherwise it falls back to the routing convention
 * `https://helix-<tenant-slug>.internal` (PLAN.md "Routing"). The caller
 * (Stage 4 webhook) is responsible for encrypting `apiKey` and writing
 * `{ helixInstanceUrl, helixApiKeyEncrypted, coolifyAppId, status }` onto
 * the tenant row.
 */
export async function provisionHelixInstance(
  tenantSlug: string,
  apiKey: string,
): Promise<ProvisionedInstance> {
  const config = getConfig();
  const dockerCompose = buildHelixComposeYaml(tenantSlug, apiKey);
  const body = {
    server_uuid: config.coolifyServerUuid,
    docker_compose: dockerCompose,
    name: `helix-${tenantSlug}`,
    ports_exposes: HELIX_PORT,
  };
  const res = await coolifyFetch("/api/v1/applications", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `provisionHelixInstance: Coolify POST /applications failed (${res.status}): ${await safeText(res)}`,
    );
  }
  const json = (await res.json()) as Record<string, unknown>;
  const appId = (json.uuid ?? json.id ?? json.application_uuid) as string | undefined;
  if (!appId || typeof appId !== "string") {
    throw new Error(
      `provisionHelixInstance: Coolify response missing application uuid for slug="${tenantSlug}"`,
    );
  }
  const fqdn = (json.fqdn ?? json.domains) as string | undefined;
  const url = fqdn ? normalizeUrl(fqdn) : `https://helix-${tenantSlug}.internal`;
  return { appId, url, apiKey };
}

/** Start a provisioned instance. */
export async function startInstance(appId: string): Promise<void> {
  await postAction(`/api/v1/applications/${appId}/start`, "startInstance", appId);
}

/** Stop a provisioned instance (volume retained — used for suspended tenants). */
export async function stopInstance(appId: string): Promise<void> {
  await postAction(`/api/v1/applications/${appId}/stop`, "stopInstance", appId);
}

/** Trigger a volume snapshot/backup for a provisioned instance. */
export async function backupInstance(appId: string): Promise<void> {
  await postAction(`/api/v1/applications/${appId}/backup`, "backupInstance", appId);
}

/**
 * Delete a provisioned instance. A 404 is treated as success (already gone),
 * so deprovision is idempotent.
 */
export async function deleteInstance(appId: string): Promise<void> {
  const res = await coolifyFetch(`/api/v1/applications/${appId}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new Error(
      `deleteInstance: Coolify DELETE /applications/${appId} failed (${res.status}): ${await safeText(res)}`,
    );
  }
}

/**
 * Get the coarse-grained lifecycle status of a provisioned instance.
 * Maps Coolify's status string onto the four-state lifecycle used by the
 * control plane.
 */
export async function getInstanceStatus(appId: string): Promise<InstanceStatus> {
  const res = await coolifyFetch(`/api/v1/applications/${appId}`, { method: "GET" });
  if (!res.ok) {
    throw new Error(
      `getInstanceStatus: Coolify GET /applications/${appId} failed (${res.status}): ${await safeText(res)}`,
    );
  }
  const json = (await res.json()) as Record<string, unknown>;
  return mapStatus(json.status);
}

// ─── Internals ───────────────────────────────────────────────────────────────

/**
 * Structural check for the substituted compose YAML: must be a mapping with
 * a `services.helixdb` mapping. Keeps the validation cast-safe under
 * `noUncheckedIndexedAccess` + `unknown`.
 */
function isHelixComposeShape(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const root = parsed as Record<string, unknown>;
  const services = root.services;
  if (!services || typeof services !== "object") return false;
  const helixdb = (services as Record<string, unknown>).helixdb;
  return !!helixdb && typeof helixdb === "object";
}

/** POST to a Coolify action endpoint (start/stop/backup); throw on non-2xx. */
async function postAction(path: string, label: string, appId: string): Promise<void> {
  const res = await coolifyFetch(path, { method: "POST" });
  if (!res.ok) {
    throw new Error(
      `${label}: Coolify POST ${path} failed (${res.status}): ${await safeText(res)}`,
    );
  }
  void appId; // appId is part of `path`; kept in the signature for readability.
}

/**
 * Map a Coolify status string onto the four-state lifecycle. Coolify uses
 * a variety of status strings across versions; this maps the common ones
 * and falls back to `error` for anything unrecognized (fail-closed).
 */
function mapStatus(raw: unknown): InstanceStatus {
  if (typeof raw !== "string") return "error";
  const s = raw.toLowerCase();
  if (s === "running" || s === "online" || s === "healthy" || s === "ready") {
    return "running";
  }
  if (s === "stopped" || s === "exited" || s === "paused" || s === "off" || s === "down") {
    return "stopped";
  }
  if (
    s === "pending" ||
    s === "starting" ||
    s === "deploying" ||
    s === "restarting" ||
    s === "creating" ||
    s === "building"
  ) {
    return "pending";
  }
  return "error";
}

/**
 * Normalize a Coolify `fqdn`/`domains` value into a single base URL.
 * Coolify may return a comma-separated list (multiple domains) or a single
 * domain; we take the first. Ensures the result has a scheme.
 */
function normalizeUrl(fqdn: string): string {
  const first = fqdn.split(",")[0]!.trim();
  if (!first) return first;
  if (/^https?:\/\//i.test(first)) return first.replace(/\/+$/, "");
  return `https://${first}`.replace(/\/+$/, "");
}
