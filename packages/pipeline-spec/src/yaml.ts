/**
 * Dependency-free YAML subset parser + minimal emitter.
 *
 * Scope: enough of YAML to losslessly read every file under
 * `examples/pipelines/*.yaml` and `examples/configs/*.yaml`, and to round-trip
 * exported pipeline specs back through itself.
 *
 * Supported:
 *  - Block mappings (indentation based), nested arbitrarily deep.
 *  - Block sequences (`- item`), including `- key: value` map items and
 *    nested block mappings/sequences under a `-`.
 *  - Scalars: double/single quoted strings, plain strings, integers, floats,
 *    booleans (`true`/`false`), null (`null`, `~`, empty value).
 *  - `#` line comments and trailing comments on plain (unquoted) scalars.
 *  - Flow collections: `[a, b, c]` and `{a: b, c: d}` (single line, may nest).
 *  - Blank lines.
 *
 * Not supported (none appear in the example corpus): anchors/aliases, tags,
 * multi-document streams, block scalars (`|` / `>`), complex keys, multi-line
 * flow collections.
 */

export class YamlParseError extends Error {
  constructor(message: string, line?: number) {
    super(line === undefined ? message : `${message} (line ${line + 1})`);
    this.name = "YamlParseError";
  }
}

interface PhysicalLine {
  raw: string;
  indent: number;
  content: string;
  lineNo: number;
}

export function parseYaml(text: string): unknown {
  const lines = preprocess(text);
  if (lines.length === 0) return null;
  const [value, next] = parseBlock(lines, 0, lines[0].indent);
  if (next < lines.length) {
    throw new YamlParseError("unexpected content after document", lines[next].lineNo);
  }
  return value;
}

function preprocess(text: string): PhysicalLine[] {
  const out: PhysicalLine[] = [];
  const rawLines = text.split(/\r\n|\r|\n/);
  rawLines.forEach((raw, lineNo) => {
    // Strip a leading document marker / explicit end.
    const trimmedStart = raw.replace(/^﻿/, "");
    if (/^---\s*$/.test(trimmedStart) || /^\.\.\.\s*$/.test(trimmedStart)) return;
    // A line that is only a comment or whitespace is skipped.
    const withoutLeading = trimmedStart.replace(/^\s+/, "");
    if (withoutLeading === "" || withoutLeading.startsWith("#")) return;
    const indent = trimmedStart.length - trimmedStart.replace(/^ */, "").length;
    out.push({
      raw: trimmedStart,
      indent,
      content: trimmedStart.slice(indent),
      lineNo
    });
  });
  return out;
}

/**
 * Parses a block (mapping or sequence) whose items are all at `baseIndent`.
 * Returns the parsed value and the index of the first line not consumed.
 */
function parseBlock(lines: PhysicalLine[], start: number, baseIndent: number): [unknown, number] {
  if (start >= lines.length) return [null, start];
  const first = lines[start];
  if (first.indent < baseIndent) return [null, start];
  if (isSequenceItem(first.content)) {
    return parseSequence(lines, start, baseIndent);
  }
  return parseMapping(lines, start, baseIndent);
}

function isSequenceItem(content: string): boolean {
  return content === "-" || content.startsWith("- ");
}

function parseSequence(lines: PhysicalLine[], start: number, baseIndent: number): [unknown[], number] {
  const items: unknown[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line.indent < baseIndent) break;
    if (line.indent > baseIndent) {
      throw new YamlParseError("unexpected indentation in sequence", line.lineNo);
    }
    if (!isSequenceItem(line.content)) break;

    const afterDash = line.content === "-" ? "" : line.content.slice(2);
    if (afterDash.trim() === "") {
      // Item body is the indented block that follows.
      const [value, next] = parseBlock(lines, index + 1, baseIndent + 1);
      items.push(value);
      index = next;
      continue;
    }

    // Inline content after the dash. It may itself be a mapping entry
    // (`- key: value`) potentially continued by deeper-indented lines, or a
    // scalar / flow collection.
    const inlineIndent = line.indent + (line.content.length - afterDash.length);
    if (looksLikeMappingEntry(afterDash)) {
      // Re-interpret the remainder of the sequence item as a mapping whose
      // first physical line is the text after the dash.
      const synthetic: PhysicalLine = {
        raw: line.raw,
        indent: inlineIndent,
        content: afterDash,
        lineNo: line.lineNo
      };
      const relines = [synthetic, ...lines.slice(index + 1)];
      const [value, consumed] = parseMapping(relines, 0, inlineIndent);
      items.push(value);
      index = index + consumed; // consumed counts synthetic line as 1
      continue;
    }

    items.push(parseScalar(afterDash, line.lineNo));
    index += 1;
  }
  return [items, index];
}

function looksLikeMappingEntry(content: string): boolean {
  return splitMappingKey(content) !== undefined;
}

/**
 * If `content` begins with a YAML mapping key, returns `[key, rest]` where
 * `rest` is the text after the first unquoted top-level `:` followed by space
 * or end-of-line. Otherwise returns undefined.
 */
function splitMappingKey(content: string): [string, string] | undefined {
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") depth -= 1;
    else if (ch === "#" && depth === 0) return undefined; // comment before any colon
    else if (ch === ":" && depth === 0) {
      const next = content[i + 1];
      if (next === undefined || next === " " || next === "\t") {
        const key = content.slice(0, i).trim();
        const rest = content.slice(i + 1).trim();
        return [key, rest];
      }
    }
  }
  return undefined;
}

function parseMapping(lines: PhysicalLine[], start: number, baseIndent: number): [Record<string, unknown>, number] {
  const map: Record<string, unknown> = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line.indent < baseIndent) break;
    if (line.indent > baseIndent) {
      throw new YamlParseError("unexpected indentation in mapping", line.lineNo);
    }
    if (isSequenceItem(line.content)) break;

    const split = splitMappingKey(line.content);
    if (!split) {
      throw new YamlParseError(`expected "key: value" mapping entry, got: ${line.content}`, line.lineNo);
    }
    const [rawKey, rest] = split;
    const key = unquoteKey(rawKey);

    if (rest === "" || rest === undefined) {
      // Value is the nested block (mapping/sequence) below, or null.
      const child = lines[index + 1];
      if (child && child.indent > baseIndent) {
        const [value, next] = parseBlock(lines, index + 1, child.indent);
        map[key] = value;
        index = next;
        continue;
      }
      // A sequence may also be at the SAME indentation as the key.
      if (child && child.indent === baseIndent && isSequenceItem(child.content)) {
        const [value, next] = parseSequence(lines, index + 1, baseIndent);
        map[key] = value;
        index = next;
        continue;
      }
      map[key] = null;
      index += 1;
      continue;
    }

    map[key] = parseScalar(rest, line.lineNo);
    index += 1;
  }
  return [map, index];
}

function unquoteKey(key: string): string {
  if (key.length >= 2) {
    if (key.startsWith('"') && key.endsWith('"')) return parseDoubleQuoted(key);
    if (key.startsWith("'") && key.endsWith("'")) return parseSingleQuoted(key);
  }
  return key;
}

function parseScalar(rawInput: string, lineNo: number): unknown {
  const raw = rawInput.trim();
  if (raw === "") return null;

  if (raw.startsWith('"')) {
    const end = findQuoteEnd(raw, '"');
    return parseDoubleQuoted(raw.slice(0, end + 1));
  }
  if (raw.startsWith("'")) {
    const end = findQuoteEnd(raw, "'");
    return parseSingleQuoted(raw.slice(0, end + 1));
  }
  if (raw.startsWith("[")) return parseFlowSequence(raw, lineNo);
  if (raw.startsWith("{")) return parseFlowMapping(raw, lineNo);

  // Plain scalar: strip a trailing comment (" #...").
  const plain = stripTrailingComment(raw).trim();
  return coercePlainScalar(plain);
}

function stripTrailingComment(value: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === "#" && (i === 0 || value[i - 1] === " " || value[i - 1] === "\t")) {
      return value.slice(0, i);
    }
  }
  return value;
}

function coercePlainScalar(value: string): unknown {
  if (value === "" || value === "~" || value === "null" || value === "Null" || value === "NULL") return null;
  if (value === "true" || value === "True" || value === "TRUE") return true;
  if (value === "false" || value === "False" || value === "FALSE") return false;
  if (/^[-+]?\d+$/.test(value)) {
    const n = Number(value);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(value) && /[.eE]/.test(value)) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return value;
}

function findQuoteEnd(value: string, quote: '"' | "'"): number {
  for (let i = 1; i < value.length; i += 1) {
    const ch = value[i];
    if (quote === '"' && ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === quote) {
      if (quote === "'" && value[i + 1] === "'") {
        i += 1; // escaped single quote
        continue;
      }
      return i;
    }
  }
  throw new YamlParseError(`unterminated ${quote === '"' ? "double" : "single"}-quoted string`);
}

function parseDoubleQuoted(token: string): string {
  const body = token.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "\\") {
      const next = body[i + 1];
      i += 1;
      switch (next) {
        case "n": out += "\n"; break;
        case "t": out += "\t"; break;
        case "r": out += "\r"; break;
        case '"': out += '"'; break;
        case "\\": out += "\\"; break;
        case "/": out += "/"; break;
        case "0": out += "\0"; break;
        case "b": out += "\b"; break;
        case "f": out += "\f"; break;
        case "u": {
          const hex = body.slice(i + 1, i + 5);
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          break;
        }
        default: out += next ?? ""; break;
      }
      continue;
    }
    out += ch;
  }
  return out;
}

function parseSingleQuoted(token: string): string {
  return token.slice(1, -1).replace(/''/g, "'");
}

/**
 * Splits a flow collection body on top-level commas (ignoring nested flow
 * collections and quoted strings).
 */
function splitFlowItems(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let current = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inSingle) {
      current += ch;
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === "\\" && i + 1 < body.length) {
        current += body[i + 1];
        i += 1;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth += 1;
    if (ch === "]" || ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      items.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "" || items.length > 0) items.push(current);
  return items;
}

function parseFlowSequence(raw: string, lineNo: number): unknown[] {
  const close = matchFlowClose(raw, "[", "]");
  const body = raw.slice(1, close).trim();
  if (body === "") return [];
  return splitFlowItems(body).map((item) => parseScalar(item.trim(), lineNo));
}

function parseFlowMapping(raw: string, lineNo: number): Record<string, unknown> {
  const close = matchFlowClose(raw, "{", "}");
  const body = raw.slice(1, close).trim();
  const map: Record<string, unknown> = {};
  if (body === "") return map;
  for (const entry of splitFlowItems(body)) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const split = splitMappingKey(trimmed);
    if (!split) {
      throw new YamlParseError(`invalid flow mapping entry: ${trimmed}`, lineNo);
    }
    map[unquoteKey(split[0])] = parseScalar(split[1], lineNo);
  }
  return map;
}

function matchFlowClose(raw: string, open: string, close: string): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new YamlParseError(`unterminated flow collection (expected '${close}')`);
}

/* --------------------------------- emitter -------------------------------- */

/**
 * Minimal YAML emitter. Output is intentionally conservative (quotes any
 * string that could be ambiguous) so it always round-trips through
 * `parseYaml`.
 */
export function stringifyYaml(value: unknown): string {
  const lines: string[] = [];
  emitNode(value, 0, lines, false);
  return lines.join("\n") + "\n";
}

function emitNode(value: unknown, indent: number, lines: string[], inline: boolean): void {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${pad}[]`);
      return;
    }
    for (const item of value) {
      if (isPlainObject(item) && Object.keys(item).length > 0) {
        const keys = Object.keys(item);
        lines.push(`${pad}- ${formatKey(keys[0])}:${valueSuffix(item[keys[0]], indent + 1, lines)}`);
        for (let k = 1; k < keys.length; k += 1) {
          emitEntry(keys[k], (item as Record<string, unknown>)[keys[k]], indent + 1, lines);
        }
      } else if (Array.isArray(item)) {
        lines.push(`${pad}-`);
        emitNode(item, indent + 1, lines, false);
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
    for (const key of keys) {
      emitEntry(key, (value as Record<string, unknown>)[key], indent, lines);
    }
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
    emitNode(value, indent, lines, false);
    return;
  }
  if (isPlainObject(value)) {
    if (Object.keys(value).length === 0) {
      lines.push(`${pad}${formatKey(key)}: {}`);
      return;
    }
    lines.push(`${pad}${formatKey(key)}:`);
    emitNode(value, indent + 1, lines, false);
    return;
  }
  lines.push(`${pad}${formatKey(key)}: ${formatScalar(value)}`);
}

// Used only for the first key of an inline `- key:` sequence item.
function valueSuffix(value: unknown, indent: number, lines: string[]): string {
  if (Array.isArray(value) || (isPlainObject(value) && Object.keys(value).length > 0)) {
    // Defer: emit as a nested block on following lines.
    const buffer: string[] = [];
    emitNode(value, indent + 1, buffer, false);
    lines.push(...buffer);
    return "";
  }
  if (isPlainObject(value)) return " {}";
  if (Array.isArray(value)) return " []";
  return ` ${formatScalar(value)}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  // Quote anything that the parser might otherwise coerce or misread.
  const needsQuote =
    /^[\s]|[\s]$/.test(str) ||
    /[:#\[\]{}",&*!|>'%@`]/.test(str) ||
    /^[-?]/.test(str) ||
    /^(true|false|null|~|Null|NULL|True|TRUE|False|FALSE)$/.test(str) ||
    /^[-+]?\d+$/.test(str) ||
    /^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(str);
  if (needsQuote) return JSON.stringify(str);
  return str;
}
