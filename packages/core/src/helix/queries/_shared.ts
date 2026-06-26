// @graphbrain/core — shared helpers for the HelixDB dynamic query modules.
//
// The HelixDB dynamic-query response shape (verified against the local Docker
// Compose enterprise-dev image):
//   • read with `valueMap`/`project` → `{ [var]: { properties: Row[] } }`
//   • read with `count`              → `{ [var]: { count: number } }`
//   • write with `addN`              → `{ [var]: { ids: number[] } }`
//   • write with `addE`              → `{ [var]: { edges: EdgeRow[] } }`
//   • write with `createIndex`       → `{ [var]: { ids: [] } }`
//
// A Row is a plain object mapping property names (snake_case, plus `$id`,
// `$label`, `$distance`, `$score` virtuals) to their JSON values. Datetimes
// come back as RFC3339 strings; ids come back as numbers (coerced to string
// here — see schema.ts design note 4).

import type { Client, DynamicQueryRequest } from "@helix-db/helix-db";

/** A raw property row from a HelixDB read response. */
export type HelixRow = Record<string, unknown>;

/** A raw edge row from a HelixDB addE response. */
export interface HelixEdgeRow {
  from: number;
  to: number;
  edge_id: number;
  context?: number;
}

/** The wrapper shape HelixDB wraps each return-var's payload in. */
type VarPayload =
  | { properties: HelixRow[] }
  | { count: number }
  | { ids: number[] }
  | { edges: HelixEdgeRow[] };

type HelixResponse = Record<string, VarPayload>;

/**
 * Send a dynamic request and return the parsed response object keyed by
 * return-var name. Throws the SDK's `HelixError` on non-200.
 */
export async function sendRequest(
  client: Client,
  request: DynamicQueryRequest,
): Promise<HelixResponse> {
  return (await client.query<HelixResponse>().dynamic(request).send()) as HelixResponse;
}

/** Extract the `properties` array for a return-var (read queries). */
export function extractRows(res: HelixResponse, varName: string): HelixRow[] {
  const payload = res[varName];
  if (!payload || !("properties" in payload)) return [];
  return payload.properties;
}

/** Extract the first row for a return-var, or null if empty. */
export function extractOne(res: HelixResponse, varName: string): HelixRow | null {
  const rows = extractRows(res, varName);
  return rows.length > 0 ? rows[0]! : null;
}

/** Extract the `ids` array for a return-var (addN writes). */
export function extractIds(res: HelixResponse, varName: string): number[] {
  const payload = res[varName];
  if (!payload || !("ids" in payload)) return [];
  return payload.ids;
}

/** Extract the `edges` array for a return-var (addE writes). */
export function extractEdges(res: HelixResponse, varName: string): HelixEdgeRow[] {
  const payload = res[varName];
  if (!payload || !("edges" in payload)) return [];
  return payload.edges;
}

// ─── Value coercion helpers ──────────────────────────────────────────────────

/** Coerce a raw `$id` (number or string) to the domain `string` id. */
export function coerceId(value: unknown): string {
  return String(value);
}

/** Parse a datetime field (RFC3339 string or epoch millis) into a Date. */
export function coerceDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  if (typeof value === "number" || typeof value === "bigint") return new Date(Number(value));
  return null;
}

/** Coerce an optional number field. */
export function coerceNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === "number" ? value : Number(value);
}

/** Coerce an optional string field. */
export function coerceString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

/** Coerce an optional boolean field. */
export function coerceBool(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  return typeof value === "boolean" ? value : Boolean(value);
}

/** Coerce an optional object field (frontmatter, config). */
export function coerceObject(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  return typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Coerce an optional vector field (number[]). */
export function coerceVector(value: unknown): number[] | null {
  if (value === null || value === undefined) return null;
  return Array.isArray(value) ? (value as number[]) : null;
}
