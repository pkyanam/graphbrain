// @graphbrain/core — Page CRUD dynamic queries (HelixDB).
//
// Signatures are the contract Stage 7's HelixEngine implements against:
//   addPage(client, params)      → Promise<Page>
//   getPageBySlug(client, slug)  → Promise<Page>   (throws if not found)
//   updatePage(client, params)   → Promise<Page>   (throws if not found)
//   softDeletePage(client, slug) → Promise<void>   (throws if not found)
//   listPages(client, params)    → Promise<Page[]>
//
// Each function builds a dynamic query (writeBatch/readBatch + g().nWithLabel),
// sends it via the SDK Client, and maps the snake_case response row to the
// camelCase `Page` domain type. Not-found surfaces as a plain Error with a
// clear message (Stage 7/10 wraps it in OperationError — see Stage 5 note 4).

import type { Client, PropertyValueInput, Expr as ExprType, Traversal, TraversalState, MutationMode } from "@helix-db/helix-db";
import { g, readBatch, writeBatch, NodeRef, Predicate, Expr, Order, PropertyValue, DateTime } from "@helix-db/helix-db";
import type { Page, PageInput, PageType, PageKind, CRMode, EffectiveDateSource } from "../../types";
import {
  PAGE_FIELD_MAP,
  PAGE_SNAKE_TO_CAMEL,
  propertyNames,
} from "../schema";
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

/** Input for addPage (subset of PageInput; server stamps created/updated_at). */
export interface AddPageParams {
  slug: string;
  type: PageType;
  title: string;
  compiledTruth: string;
  frontmatter?: Record<string, unknown>;
  pageKind?: PageKind;
  contentHash?: string | null;
  emotionalWeight?: number | null;
  effectiveDate?: Date | null;
  effectiveDateSource?: EffectiveDateSource | null;
  importFilename?: string | null;
  contextualRetrievalMode?: CRMode | null;
}

/** Patch for updatePage (partial; only provided fields are written). */
export interface UpdatePagePatch {
  title?: string;
  type?: PageType;
  compiledTruth?: string;
  frontmatter?: Record<string, unknown>;
  pageKind?: PageKind;
  contentHash?: string | null;
  emotionalWeight?: number | null;
  effectiveDate?: Date | null;
  effectiveDateSource?: EffectiveDateSource | null;
  importFilename?: string | null;
  contextualRetrievalMode?: CRMode | null;
}

export interface UpdatePageParams {
  slug: string;
  patch: UpdatePagePatch;
}

export interface ListPagesParams {
  type?: PageType;
  limit?: number;
  offset?: number;
  /** Include soft-deleted pages (deleted_at != null). Default false. */
  includeDeleted?: boolean;
}

// All Page property names for valueMap projections (includes $id).
const PAGE_PROPS = ["$id", ...propertyNames("Page")];

// ─── Row → Page mapping ──────────────────────────────────────────────────────

function rowToPage(row: HelixRow): Page {
  const get = (camel: keyof Page): unknown => {
    const snake = PAGE_FIELD_MAP[camel];
    return row[snake];
  };
  return {
    id: coerceId(get("id")),
    slug: String(get("slug") ?? ""),
    type: String(get("type") ?? ""),
    title: String(get("title") ?? ""),
    compiledTruth: String(get("compiled_truth" as keyof Page) ?? get("compiledTruth") ?? ""),
    frontmatter: coerceObject(get("frontmatter")),
    pageKind: (coerceString(get("pageKind")) as PageKind) ?? "markdown",
    contentHash: coerceString(get("contentHash")),
    emotionalWeight: coerceNumber(get("emotionalWeight")),
    effectiveDate: coerceDate(get("effectiveDate")),
    effectiveDateSource: coerceString(get("effectiveDateSource")) as EffectiveDateSource | null,
    importFilename: coerceString(get("importFilename")),
    salienceTouchedAt: coerceDate(get("salienceTouchedAt")),
    lastRetrievedAt: coerceDate(get("lastRetrievedAt")),
    linksExtractedAt: coerceDate(get("linksExtractedAt")),
    contextualRetrievalMode: coerceString(get("contextualRetrievalMode")) as CRMode | null,
    corpusGeneration: coerceString(get("corpusGeneration")),
    generation: coerceNumber(get("generation")),
    deletedAt: coerceDate(get("deletedAt")),
    createdAt: coerceDate(get("createdAt")) ?? new Date(0),
    updatedAt: coerceDate(get("updatedAt")) ?? new Date(0),
  };
}

// ─── addPage ─────────────────────────────────────────────────────────────────

export async function addPage(client: Client, params: AddPageParams): Promise<Page> {
  const props: Record<string, PropertyValueInput | ExprType> = {
    slug: params.slug,
    type: params.type,
    title: params.title,
    compiled_truth: params.compiledTruth,
    frontmatter: PropertyValue.object((params.frontmatter ?? {}) as Record<string, PropertyValueInput>),
    page_kind: params.pageKind ?? "markdown",
    created_at: Expr.datetime(),
    updated_at: Expr.datetime(),
  };
  if (params.contentHash !== undefined && params.contentHash !== null)
    props.content_hash = params.contentHash;
  if (params.emotionalWeight !== undefined && params.emotionalWeight !== null)
    props.emotional_weight = params.emotionalWeight;
  if (params.effectiveDate) props.effective_date = DateTime.fromMillis(params.effectiveDate.getTime());
  if (params.effectiveDateSource) props.effective_date_source = params.effectiveDateSource;
  if (params.importFilename) props.import_filename = params.importFilename;
  if (params.contextualRetrievalMode) props.contextual_retrieval_mode = params.contextualRetrievalMode;

  // addN then read-back the created node (gets server-stamped timestamps + id).
  const batch = writeBatch()
    .varAs("created", g().addN("Page", props))
    .varAs("page", g().n(NodeRef.var("created")).valueMap(PAGE_PROPS))
    .returning(["page"]);
  const res = await sendRequest(client, batch.toDynamicRequest({ queryName: "add_page" }));
  const row = extractOne(res, "page");
  if (!row) throw new Error(`addPage: server returned no row for slug="${params.slug}"`);
  return rowToPage(row);
}

// ─── getPageBySlug ───────────────────────────────────────────────────────────

export async function getPageBySlug(
  client: Client,
  slug: string,
  opts?: { includeDeleted?: boolean },
): Promise<Page> {
  let traversal = g().nWithLabel("Page").where(Predicate.eq("slug", slug));
  if (!opts?.includeDeleted) traversal = traversal.where(Predicate.isNull("deleted_at"));
  const batch = readBatch()
    .varAs("page", traversal.valueMap(PAGE_PROPS))
    .returning(["page"]);
  const res = await sendRequest(client, batch.toDynamicRequest({ queryName: "get_page_by_slug" }));
  const row = extractOne(res, "page");
  if (!row) throw new Error(`getPageBySlug: no Page found for slug="${slug}"`);
  return rowToPage(row);
}

// ─── updatePage ──────────────────────────────────────────────────────────────

export async function updatePage(client: Client, params: UpdatePageParams): Promise<Page> {
  const { slug, patch } = params;
  // Look up the node, then setProperty per patched field, then read back.
  // The traversal: nWithLabel(Page).where(slug=).limit(1) → setProperty(...) per
  // field → setProperty(updated_at, datetime()) → valueMap.
  let traversal: Traversal<TraversalState, MutationMode> = g()
    .nWithLabel("Page")
    .where(Predicate.eq("slug", slug))
    .where(Predicate.isNull("deleted_at"))
    .limit(1);

  const setIf = (snake: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (value instanceof Date) {
      traversal = traversal.setProperty(snake, DateTime.fromMillis(value.getTime()));
      return;
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      traversal = traversal.setProperty(snake, PropertyValue.object(value as Record<string, PropertyValueInput>));
      return;
    }
    traversal = traversal.setProperty(snake, value as PropertyValueInput);
  };
  setIf("title", patch.title);
  setIf("type", patch.type);
  setIf("compiled_truth", patch.compiledTruth);
  setIf("frontmatter", patch.frontmatter);
  setIf("page_kind", patch.pageKind);
  setIf("content_hash", patch.contentHash);
  setIf("emotional_weight", patch.emotionalWeight);
  setIf("effective_date", patch.effectiveDate);
  setIf("effective_date_source", patch.effectiveDateSource);
  setIf("import_filename", patch.importFilename);
  setIf("contextual_retrieval_mode", patch.contextualRetrievalMode);
  // Always bump updated_at.
  traversal = traversal.setProperty("updated_at", Expr.datetime());

  const batch = writeBatch()
    .varAs("page", traversal.valueMap(PAGE_PROPS))
    .returning(["page"]);
  const res = await sendRequest(client, batch.toDynamicRequest({ queryName: "update_page" }));
  const row = extractOne(res, "page");
  if (!row) throw new Error(`updatePage: no Page found for slug="${slug}"`);
  return rowToPage(row);
}

// ─── softDeletePage ──────────────────────────────────────────────────────────

export async function softDeletePage(client: Client, slug: string): Promise<void> {
  // Set deleted_at = now() on the matching node. Verify it existed first via
  // a read in the same batch (so we can throw a clear not-found).
  const batch = writeBatch()
    .varAs("found", g().nWithLabel("Page").where(Predicate.eq("slug", slug)).limit(1).valueMap(["$id"]))
    .varAs(
      "updated",
      g()
        .nWithLabel("Page")
        .where(Predicate.eq("slug", slug))
        .setProperty("deleted_at", Expr.datetime())
        .setProperty("updated_at", Expr.datetime()),
    )
    .returning(["found"]);
  const res = await sendRequest(client, batch.toDynamicRequest({ queryName: "soft_delete_page" }));
  const row = extractOne(res, "found");
  if (!row) throw new Error(`softDeletePage: no Page found for slug="${slug}"`);
}

// ─── listPages ───────────────────────────────────────────────────────────────

export async function listPages(client: Client, params: ListPagesParams = {}): Promise<Page[]> {
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;
  let traversal = g().nWithLabel("Page");
  if (params.type) traversal = traversal.where(Predicate.eq("type", params.type));
  if (!params.includeDeleted) traversal = traversal.where(Predicate.isNull("deleted_at"));
  traversal = traversal.orderBy("updated_at", Order.Desc).skip(offset).limit(limit);

  const batch = readBatch()
    .varAs("pages", traversal.valueMap(PAGE_PROPS))
    .returning(["pages"]);
  const res = await sendRequest(client, batch.toDynamicRequest({ queryName: "list_pages" }));
  return extractRows(res, "pages").map(rowToPage);
}

// Re-export the snake→camel map so Stage 7 can inspect raw rows if needed.
export { PAGE_SNAKE_TO_CAMEL };
