/**
 * Pure helpers for the Builder's per-node Docs tab. Walks a plugin's
 * configSchema / secretsSchema (JsonSchemaLike) and produces:
 *
 *   - a flat field summary the tab renders as a table,
 *   - a sample config object built from each field's `default`,
 *   - the list of required-field keys.
 *
 * Kept DOM-free so it is unit-testable with `node --test` and reusable from
 * CLI / docs-export scripts if we ever need those.
 */
import type { JsonSchemaLike } from "./schemaForm.ts";

export interface FieldSummary {
  /** Property name (top-level key). Nested objects appear as their parent only. */
  key: string;
  /** Lowercase JSON-Schema type, falling back to "unknown" / "enum". */
  type: string;
  required: boolean;
  description?: string;
  default?: unknown;
  format?: string;
  enum?: unknown[];
}

/**
 * Flattens a top-level `{ properties }` object into a stable, sorted list of
 * fields for table rendering. Required fields come first, then alphabetical.
 * Nested-object properties are surfaced as a single row (the inspector keeps
 * the nested editor; the docs table just tells you the shape).
 */
export function summarizeSchema(schema?: JsonSchemaLike): FieldSummary[] {
  const props = schema?.properties;
  if (!props) return [];
  const required = new Set(schema?.required ?? []);
  const out: FieldSummary[] = [];
  for (const [key, prop] of Object.entries(props)) {
    const summary: FieldSummary = {
      key,
      type: derivedType(prop),
      required: required.has(key)
    };
    if (prop.description !== undefined) summary.description = prop.description;
    if (prop.default !== undefined) summary.default = prop.default;
    if (prop.format !== undefined) summary.format = prop.format;
    if (Array.isArray(prop.enum)) summary.enum = prop.enum;
    out.push(summary);
  }
  out.sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    return a.key.localeCompare(b.key);
  });
  return out;
}

/**
 * Returns property names listed in the schema's `required` array. Stable
 * helper used by the docs tab even when `summarizeSchema` would yield the
 * same info — call sites read better.
 */
export function requiredFields(schema?: JsonSchemaLike): string[] {
  return [...(schema?.required ?? [])];
}

/**
 * Builds a sample config object from each property's `default`, dropping
 * properties that have no default. The result is JSON-serializable and
 * intended to be shown as a copy-paste block in the docs tab.
 *
 * Enum-typed properties without an explicit default fall back to the first
 * enum value (so the sample is non-empty / actually a valid config).
 */
export function buildSampleConfig(schema?: JsonSchemaLike): Record<string, unknown> {
  const props = schema?.properties;
  if (!props) return {};
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(props)) {
    if (prop.default !== undefined) {
      out[key] = prop.default;
    } else if (Array.isArray(prop.enum) && prop.enum.length > 0) {
      out[key] = prop.enum[0];
    }
  }
  return out;
}

function derivedType(prop: JsonSchemaLike): string {
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return "enum";
  if (prop.type === "array") {
    const items = prop.items?.type;
    return items ? `array<${items}>` : "array";
  }
  return prop.type ?? "unknown";
}
