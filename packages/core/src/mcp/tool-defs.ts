// @graphbrain/core — MCP tool definitions (Stage 11).
//
// Generates MCP tool definitions (`{ name, description, inputSchema }`) from
// the Stage 10 operation registry. The single `OPERATIONS` map is the source
// of truth — adding an operation in Stage 10 automatically extends the MCP
// tool list. No manual tool registration.
//
// Ported from _reference/gbrain/src/mcp/tool-defs.ts (the McpToolDef shape +
// buildToolDefs iteration), but GBrain uses a hand-rolled `ParamDef` registry
// with a `paramDefToSchema` mapper. Graphbrain uses Zod schemas on every
// Operation, so we convert via Zod 4's native `z.toJSONSchema()` instead. Do
// NOT port GBrain's `paramDefToSchema` — it is ParamDef-specific.
//
// NOTE on library choice: the Stage 11 spec suggested `zod-to-json-schema`,
// but that library is broken under Zod 4 (it returns `{}` for Zod 4 schemas
// — its README explicitly says "As of November 2025, this project will no
// longer be actively maintained. Zod v4 natively supports generating JSON
// schemas, so I recommend you switch to the new major"). Zod 4 ships a
// native `z.toJSONSchema()` that produces the correct JSON Schema, so we use
// that. The `zod-to-json-schema` dependency is NOT added to packages/core.
//
// `localOnly` ops are excluded from the remote tool list: remote MCP callers
// (stdio + HTTP) can never invoke them (the dispatcher's trust boundary
// rejects them), so advertising them would be misleading. None of the Phase 1
// ops are localOnly, but the filter is kept for future ops.

import { z, type ZodType } from "zod";
import { OPERATIONS, OPERATION_NAMES } from "../operations";

/**
 * An MCP tool definition. Matches the `Tool` shape from the MCP spec
 * (modelcontextprotocol.io): `name`, `description`, and `inputSchema` as a
 * JSON Schema object describing the tool's arguments.
 */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

/**
 * Convert a Zod object schema to the MCP tool inputSchema shape
 * (`{ type: 'object', properties, required }`).
 *
 * Zod 4's native `z.toJSONSchema()` emits a JSON Schema object; for a
 * `z.object(...)` the top-level shape is
 * `{ type: 'object', properties: {...}, required: [...] }`. We normalize to
 * that exact shape so the MCP SDK + clients see a clean object schema (no
 * `$schema` noise).
 */
function zodObjectToToolSchema(schema: ZodType): McpToolDef["inputSchema"] {
  // Zod 4's `z.toJSONSchema()` throws on `z.date()` / `z.coerce.date()`
  // ("Date cannot be represented in JSON Schema") because JSON Schema has no
  // native date type. Several Phase 1 op schemas (put_page, create_page,
  // add_source) carry `z.coerce.date()` fields. We pass `unrepresentable:
  // "any"` so dates degrade to `{}` (any) instead of throwing, then an
  // `override` rewrites every date field to
  // `{ type: "string", format: "date-time" }` (the conventional JSON Schema
  // representation for ISO-8601 datetimes).
  const raw = z.toJSONSchema(schema, {
    unrepresentable: "any",
    override: ({ zodSchema, jsonSchema }) => {
      const def = (zodSchema as { _zod?: { def: { type?: string } } })._zod?.def;
      if (def?.type === "date") {
        jsonSchema.type = "string";
        jsonSchema.format = "date-time";
      }
    },
  }) as Record<string, unknown>;
  const properties = (raw.properties as Record<string, unknown> | undefined) ?? {};
  const required = Array.isArray(raw.required) ? (raw.required as string[]) : [];
  return {
    type: "object",
    properties,
    required,
  };
}

/**
 * Generate MCP tool definitions from the operation registry.
 *
 * Iterates `OPERATION_NAMES` (deterministic order) and emits one `McpToolDef`
 * per non-`localOnly` operation. Operations without an `inputSchema` get an
 * empty object schema (`{ type: 'object', properties: {}, required: [] }`).
 *
 * @param includeLocalOnly  When true, also emit `localOnly` ops (used by the
 *   trusted local CLI path, which is allowed to call them). Defaults to false
 *   — remote MCP callers (stdio + HTTP) never see localOnly tools.
 */
export function generateToolDefs(includeLocalOnly = false): McpToolDef[] {
  const defs: McpToolDef[] = [];
  for (const name of OPERATION_NAMES) {
    const op = OPERATIONS.get(name);
    if (!op) continue;
    if (op.localOnly && !includeLocalOnly) continue;
    defs.push({
      name: op.name,
      description: op.description,
      inputSchema: op.inputSchema
        ? zodObjectToToolSchema(op.inputSchema)
        : { type: "object", properties: {}, required: [] },
    });
  }
  return defs;
}
