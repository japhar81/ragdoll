/**
 * Dependency-free, conservative YAML emitter + minimal parser for the web
 * console's local Import/Export of pipeline specs. Kept deliberately small and
 * aligned with packages/pipeline-spec/src/yaml.ts so exported text round-trips
 * through the server's parser. Pure (no React/DOM), so it is unit-testable.
 */

export function stringifyYaml(value: unknown): string {
  const lines: string[] = [];
  emitNode(value, 0, lines);
  return lines.join("\n") + "\n";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emitNode(value: unknown, indent: number, lines: string[]): void {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${pad}[]`);
      return;
    }
    for (const item of value) {
      if (isPlainObject(item) && Object.keys(item).length > 0) {
        const keys = Object.keys(item);
        const first = item[keys[0]];
        if (Array.isArray(first) || (isPlainObject(first) && Object.keys(first).length > 0)) {
          lines.push(`${pad}- ${formatKey(keys[0])}:`);
          emitNode(first, indent + 2, lines);
        } else if (isPlainObject(first)) {
          lines.push(`${pad}- ${formatKey(keys[0])}: {}`);
        } else {
          lines.push(`${pad}- ${formatKey(keys[0])}: ${formatScalar(first)}`);
        }
        for (let k = 1; k < keys.length; k += 1) {
          emitEntry(keys[k], item[keys[k]], indent + 1, lines);
        }
      } else if (Array.isArray(item)) {
        lines.push(`${pad}-`);
        emitNode(item, indent + 1, lines);
      } else {
        lines.push(`${pad}- ${formatScalar(item)}`);
      }
    }
    return;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      lines.push(`${pad}{}`);
      return;
    }
    for (const key of keys) emitEntry(key, value[key], indent, lines);
    return;
  }
  lines.push(`${pad}${formatScalar(value)}`);
}

function emitEntry(key: string, value: unknown, indent: number, lines: string[]): void {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${pad}${formatKey(key)}: []`);
      return;
    }
    lines.push(`${pad}${formatKey(key)}:`);
    emitNode(value, indent, lines);
    return;
  }
  if (isPlainObject(value)) {
    if (Object.keys(value).length === 0) {
      lines.push(`${pad}${formatKey(key)}: {}`);
      return;
    }
    lines.push(`${pad}${formatKey(key)}:`);
    emitNode(value, indent + 1, lines);
    return;
  }
  lines.push(`${pad}${formatKey(key)}: ${formatScalar(value)}`);
}

function formatKey(key: string): string {
  if (/^[A-Za-z0-9_][A-Za-z0-9_.\-/]*$/.test(key)) return key;
  return JSON.stringify(key);
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  const str = String(value);
  if (str === "") return '""';
  const needsQuote =
    /^[\s]|[\s]$/.test(str) ||
    /[:#[\]{}",&*!|>'%@`]/.test(str) ||
    /^[-?]/.test(str) ||
    /^(true|false|null|~|Null|NULL|True|TRUE|False|FALSE)$/.test(str) ||
    /^[-+]?\d+$/.test(str) ||
    /^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(str);
  if (needsQuote) return JSON.stringify(str);
  return str;
}
