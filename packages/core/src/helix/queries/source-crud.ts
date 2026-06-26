// @graphbrain/core — Source CRUD dynamic queries (HelixDB).
//
// Contract (Stage 7 implements against):
//   addSource(client, params)    → Promise<Source>
//   getSource(client, name)      → Promise<Source>  (throws if not found)
//   listSources(client, params)  → Promise<Source[]>

import type { Client, PropertyValueInput, Expr as ExprType } from "@helix-db/helix-db";
import { g, readBatch, writeBatch, NodeRef, Predicate, Expr, Order, PropertyValue } from "@helix-db/helix-db";
import type { Source, CRMode } from "../../types";
import { SOURCE_FIELD_MAP, propertyNames } from "../schema";
import {
  sendRequest,
  extractOne,
  extractRows,
  coerceId,
  coerceDate,
  coerceNumber,
  coerceString,
  coerceObject,
  coerceBool,
  type HelixRow,
} from "./_shared";

export interface AddSourceParams {
  name: string;
  localPath?: string | null;
  config?: Record<string, unknown>;
  chunkerVersion?: number | null;
  contextualRetrievalMode?: CRMode | null;
  trustFrontmatterOverrides?: boolean | null;
}

export interface ListSourcesParams {
  /** Include archived sources. Default false. */
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

const SOURCE_PROPS = ["$id", ...propertyNames("Source")];

function rowToSource(row: HelixRow): Source {
  const get = (camel: keyof Source): unknown => {
    const snake = SOURCE_FIELD_MAP[camel];
    return row[snake];
  };
  return {
    id: coerceId(get("id")),
    name: String(get("name") ?? ""),
    localPath: coerceString(get("localPath")),
    lastCommit: coerceString(get("lastCommit")),
    lastSyncAt: coerceDate(get("lastSyncAt")),
    config: coerceObject(get("config")),
    chunkerVersion: coerceNumber(get("chunkerVersion")),
    archived: coerceBool(get("archived")) ?? false,
    archivedAt: coerceDate(get("archivedAt")),
    archiveExpiresAt: coerceDate(get("archiveExpiresAt")),
    contextualRetrievalMode: coerceString(get("contextualRetrievalMode")) as CRMode | null,
    trustFrontmatterOverrides: coerceBool(get("trustFrontmatterOverrides")) ?? undefined,
    newestContentAt: coerceDate(get("newestContentAt")),
    createdAt: coerceDate(get("createdAt")) ?? new Date(0),
  };
}

// ─── addSource ───────────────────────────────────────────────────────────────

export async function addSource(client: Client, params: AddSourceParams): Promise<Source> {
  const props: Record<string, PropertyValueInput | ExprType> = {
    name: params.name,
    config: PropertyValue.object((params.config ?? {}) as Record<string, PropertyValueInput>),
    archived: false,
    created_at: Expr.datetime(),
  };
  if (params.localPath) props.local_path = params.localPath;
  if (params.chunkerVersion !== undefined && params.chunkerVersion !== null)
    props.chunker_version = params.chunkerVersion;
  if (params.contextualRetrievalMode) props.contextual_retrieval_mode = params.contextualRetrievalMode;
  if (params.trustFrontmatterOverrides !== undefined && params.trustFrontmatterOverrides !== null)
    props.trust_frontmatter_overrides = params.trustFrontmatterOverrides;

  const batch = writeBatch()
    .varAs("created", g().addN("Source", props))
    .varAs("source", g().n(NodeRef.var("created")).valueMap(SOURCE_PROPS))
    .returning(["source"]);
  const res = await sendRequest(client, batch.toDynamicRequest({ queryName: "add_source" }));
  const row = extractOne(res, "source");
  if (!row) throw new Error(`addSource: server returned no row for name="${params.name}"`);
  return rowToSource(row);
}

// ─── getSourceById ───────────────────────────────────────────────────────────
// Stage 7's BrainEngine.getSource(id) contract. The dev HelixDB image uses
// numeric $id, so we resolve via NodeRef.id(Number(id)).hasLabel("Source").
// Production ULIDs would need a string-id lookup path (see schema.ts note 4).

export async function getSourceById(client: Client, id: string): Promise<Source | null> {
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) return null;
  const batch = readBatch()
    .varAs(
      "source",
      g().n(NodeRef.id(numericId)).hasLabel("Source").valueMap(SOURCE_PROPS),
    )
    .returning(["source"]);
  const res = await sendRequest(client, batch.toDynamicRequest({ queryName: "get_source_by_id" }));
  const row = extractOne(res, "source");
  return row ? rowToSource(row) : null;
}

// ─── getSource ───────────────────────────────────────────────────────────────

export async function getSource(client: Client, name: string): Promise<Source> {
  const batch = readBatch()
    .varAs(
      "source",
      g()
        .nWithLabel("Source")
        .where(Predicate.eq("name", name))
        .where(Predicate.neq("archived", true))
        .valueMap(SOURCE_PROPS),
    )
    .returning(["source"]);
  const res = await sendRequest(client, batch.toDynamicRequest({ queryName: "get_source" }));
  const row = extractOne(res, "source");
  if (!row) throw new Error(`getSource: no Source found for name="${name}"`);
  return rowToSource(row);
}

// ─── listSources ─────────────────────────────────────────────────────────────

export async function listSources(client: Client, params: ListSourcesParams = {}): Promise<Source[]> {
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;
  let traversal = g().nWithLabel("Source");
  if (!params.includeArchived) traversal = traversal.where(Predicate.neq("archived", true));
  traversal = traversal.orderBy("created_at", Order.Desc).skip(offset).limit(limit);

  const batch = readBatch()
    .varAs("sources", traversal.valueMap(SOURCE_PROPS))
    .returning(["sources"]);
  const res = await sendRequest(client, batch.toDynamicRequest({ queryName: "list_sources" }));
  return extractRows(res, "sources").map(rowToSource);
}
