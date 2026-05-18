/**
 * Pure, DOM-free schema-to-form helpers. Turns a JsonSchemaLike + the current
 * config value into an ordered list of field descriptors, and applies a single
 * field edit back into the config object immutably (coercing types).
 *
 * No React / DOM imports so this is unit-testable with `node --test`, zero
 * install. The widget layer (ConfigForm.tsx) consumes these descriptors.
 */

/**
 * The subset of JSON Schema the server publishes per plugin. Mirrors the
 * SHARED CONTRACT exactly; every field is optional so we degrade gracefully
 * when the server is older / omits something.
 */
export interface JsonSchemaLike {
  type?: string;
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  items?: JsonSchemaLike;
  additionalProperties?: boolean;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  format?: string;
}

export type FieldKind =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "enum"
  | "array-string"
  | "object"
  | "unknown";

export interface FieldDescriptor {
  /** Dotted path into the config object, e.g. "retrieval.top_k". */
  key: string;
  /** Human label derived from the key leaf (description shown separately). */
  label: string;
  kind: FieldKind;
  required: boolean;
  description?: string;
  default?: unknown;
  enumValues?: unknown[];
  format?: string;
  /** Raw current value at this path (undefined if unset). */
  value: unknown;
  /**
   * True when the current value is a `${config.*}` / `${secret.*}` template
   * string. The widget shows it as a plain text "bound" field instead of a
   * typed input so we never fight a power user's binding.
   */
  bound: boolean;
}

const BIND_RE = /^\$\{(config|secret)\.[^}]+\}$/;

/** Whether a value is a bound `${config.*}` / `${secret.*}` expression. */
export function isBoundExpression(value: unknown): value is string {
  return typeof value === "string" && BIND_RE.test(value.trim());
}

/** "retrieval.top_k" -> "top_k" -> "Top k" (Title-ish, underscore aware). */
export function labelFromKey(key: string): string {
  const leaf = key.split(".").pop() ?? key;
  const words = leaf.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  if (!words) return leaf;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Get a value at a dotted path, tolerating missing intermediate objects. */
export function getAtPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Immutably set a value at a dotted path, creating intermediate objects. */
export function setAtPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): Record<string, unknown> {
  const parts = path.split(".");
  const [head, ...rest] = parts;
  const next: Record<string, unknown> = { ...obj };
  if (rest.length === 0) {
    next[head] = value;
    return next;
  }
  const child =
    obj[head] && typeof obj[head] === "object" && !Array.isArray(obj[head])
      ? (obj[head] as Record<string, unknown>)
      : {};
  next[head] = setAtPath(child, rest.join("."), value);
  return next;
}

function kindForSchema(schema: JsonSchemaLike): FieldKind {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return "enum";
  switch (schema.type) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "integer":
      return "integer";
    case "boolean":
      return "boolean";
    case "array":
      // Only flat string arrays get a friendly widget; anything else is
      // edited as JSON.
      if (schema.items && (schema.items.type === "string" || schema.items.enum)) {
        return "array-string";
      }
      return "unknown";
    case "object":
      return "object";
    default:
      return "unknown";
  }
}

/**
 * Derive an ordered list of field descriptors from a schema + current value.
 *
 * Nested objects are flattened ONE level: a top-level `object` property with
 * its own `properties` contributes `parent.child` fields. Deeper / untyped /
 * complex subtrees collapse to a single `object` (JSON-edited) field so the
 * power user always has an escape hatch and we never lose data.
 */
export function deriveFields(
  schema: JsonSchemaLike | undefined,
  value: Record<string, unknown> | undefined
): FieldDescriptor[] {
  if (!schema || !schema.properties) return [];
  const cfg = value ?? {};
  const out: FieldDescriptor[] = [];
  const topRequired = new Set(schema.required ?? []);

  for (const [key, propSchema] of Object.entries(schema.properties)) {
    const kind = kindForSchema(propSchema);
    const current = getAtPath(cfg, key);

    if (
      kind === "object" &&
      propSchema.properties &&
      Object.keys(propSchema.properties).length > 0
    ) {
      // Flatten one level of nested object properties.
      const childRequired = new Set(propSchema.required ?? []);
      for (const [childKey, childSchema] of Object.entries(propSchema.properties)) {
        const path = `${key}.${childKey}`;
        const childValue = getAtPath(cfg, path);
        out.push(makeDescriptor(path, childSchema, childValue, childRequired.has(childKey)));
      }
      continue;
    }

    out.push(makeDescriptor(key, propSchema, current, topRequired.has(key)));
  }
  return out;
}

function makeDescriptor(
  key: string,
  schema: JsonSchemaLike,
  value: unknown,
  required: boolean
): FieldDescriptor {
  const kind = kindForSchema(schema);
  return {
    key,
    label: labelFromKey(key),
    kind,
    required,
    description: schema.description,
    default: schema.default,
    enumValues: Array.isArray(schema.enum) ? schema.enum : undefined,
    format: schema.format,
    value,
    bound: isBoundExpression(value)
  };
}

/**
 * Coerce a raw widget value into the type the field expects. Bound expressions
 * and empty strings pass through untouched (empty -> undefined so we don't
 * persist blank required fields). Unparseable JSON for object/array fields is
 * left as the raw string so the user can keep typing.
 */
export function coerceFieldValue(field: FieldDescriptor, raw: unknown): unknown {
  if (isBoundExpression(raw)) return raw;
  if (raw === "" || raw === undefined || raw === null) return undefined;

  switch (field.kind) {
    case "number":
    case "integer": {
      if (typeof raw === "number") return raw;
      const n = Number(raw);
      if (Number.isNaN(n)) return raw;
      return field.kind === "integer" ? Math.trunc(n) : n;
    }
    case "boolean":
      if (typeof raw === "boolean") return raw;
      return raw === "true" || raw === "on" || raw === "1";
    case "enum":
      return raw;
    case "array-string": {
      if (Array.isArray(raw)) return raw;
      const s = String(raw).trim();
      if (s.startsWith("[")) {
        try {
          return JSON.parse(s);
        } catch {
          return raw;
        }
      }
      // comma / newline separated convenience syntax
      return s
        .split(/[\n,]/)
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
    }
    case "object": {
      if (typeof raw === "object") return raw;
      try {
        return JSON.parse(String(raw));
      } catch {
        return raw;
      }
    }
    default:
      return raw;
  }
}

/**
 * Apply a single field edit immutably into the config object, coercing the
 * raw widget value to the field's type. `undefined` results delete the key so
 * cleared optional fields don't persist as empties.
 */
export function applyFieldEdit(
  config: Record<string, unknown> | undefined,
  field: FieldDescriptor,
  raw: unknown
): Record<string, unknown> {
  const base = config ?? {};
  const coerced = coerceFieldValue(field, raw);
  if (coerced === undefined) return deleteAtPath(base, field.key);
  return setAtPath(base, field.key, coerced);
}

/** Immutably delete a value at a dotted path; prunes emptied parent objects. */
export function deleteAtPath(
  obj: Record<string, unknown>,
  path: string
): Record<string, unknown> {
  const parts = path.split(".");
  const [head, ...rest] = parts;
  if (!(head in obj)) return obj;
  const next: Record<string, unknown> = { ...obj };
  if (rest.length === 0) {
    delete next[head];
    return next;
  }
  const child = obj[head];
  if (!child || typeof child !== "object" || Array.isArray(child)) {
    delete next[head];
    return next;
  }
  const pruned = deleteAtPath(child as Record<string, unknown>, rest.join("."));
  if (Object.keys(pruned).length === 0) delete next[head];
  else next[head] = pruned;
  return next;
}

/**
 * The fallback decision: should ConfigForm render structured widgets, or fall
 * straight back to the raw-JSON editor (current behavior)? We render the form
 * only when the schema describes at least one property.
 */
export function hasUsableSchema(schema: JsonSchemaLike | undefined): boolean {
  return !!schema && !!schema.properties && Object.keys(schema.properties).length > 0;
}

/** The `${config.<path>}` expression a "bind" toggle writes for a field. */
export function bindExpressionFor(field: FieldDescriptor): string {
  return `\${config.${field.key}}`;
}
