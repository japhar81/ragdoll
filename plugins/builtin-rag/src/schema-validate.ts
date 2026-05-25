/**
 * Phase 13 follow-up: tiny JSON-schema-subset validator used by the
 * v2 storage primitives (dataset_upsert) to enforce a Dataset's
 * chunk_schema at write time.
 *
 * We deliberately don't pull in a full JSON-schema implementation —
 * the chunk_schema field in `packages/core` Dataset is typed as
 * `Record<string, unknown>` and the platform consistently uses the
 * `JsonSchemaLike` subset (`type`, `properties`, `required`, `items`,
 * `additionalProperties`, `enum`). This validator covers exactly that
 * subset. Empty / non-object schemas pass everything (back-compat with
 * Datasets that were minted before strict validation existed).
 */

export interface SchemaValidationError {
  /** JSON-pointer-ish path into the record, e.g. `/payload/sourceId`. */
  path: string;
  message: string;
}

export function validateAgainstSchema(
  record: unknown,
  schema: unknown
): SchemaValidationError[] {
  if (!schema || typeof schema !== "object") return [];
  return walk("", record, schema as Record<string, unknown>);
}

function walk(
  path: string,
  value: unknown,
  schema: Record<string, unknown>
): SchemaValidationError[] {
  const errors: SchemaValidationError[] = [];
  // The schema is permissive by default — only enforce what's
  // explicitly declared. `Record<string,unknown>` records without a
  // declared `type` are treated as opaque blobs.
  const declaredType = typeof schema.type === "string" ? schema.type : undefined;
  if (declaredType && !matchesType(value, declaredType)) {
    errors.push({
      path: path || "/",
      message: `expected type ${declaredType}, got ${describeType(value)}`
    });
    // Don't recurse when the top-level type is wrong — child errors
    // would just be noise.
    return errors;
  }
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value as never)) {
      errors.push({
        path: path || "/",
        message: `value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`
      });
      return errors;
    }
  }
  if (declaredType === "object" || schema.properties) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return errors;
    }
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    const required = Array.isArray(schema.required)
      ? (schema.required as string[])
      : [];
    for (const key of required) {
      if (record[key] === undefined || record[key] === null) {
        errors.push({
          path: path ? `${path}/${key}` : `/${key}`,
          message: "required field missing"
        });
      }
    }
    for (const [key, subSchema] of Object.entries(properties)) {
      if (record[key] === undefined) continue;
      errors.push(
        ...walk(
          path ? `${path}/${key}` : `/${key}`,
          record[key],
          subSchema as Record<string, unknown>
        )
      );
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) {
          errors.push({
            path: path ? `${path}/${key}` : `/${key}`,
            message: "unknown property (additionalProperties: false)"
          });
        }
      }
    }
  } else if (declaredType === "array" && schema.items) {
    if (!Array.isArray(value)) return errors;
    value.forEach((item, i) => {
      errors.push(
        ...walk(
          `${path}/${i}`,
          item,
          schema.items as Record<string, unknown>
        )
      );
    });
  }
  return errors;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      // Unknown types pass — the schema author opted for something we
      // don't understand and we don't want to mass-reject silently.
      return true;
  }
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
