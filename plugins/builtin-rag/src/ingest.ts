/**
 * Codebase + docs ingest plugins. Five plugins that together turn a
 * directory tree on disk into a delta-aware ingest pipeline:
 *
 *   filesystem_source → path_classifier → delta_filter → code_chunker
 *                                                     ↘  basic_text_chunker
 *                                                       → provider_embeddings
 *                                                       → qdrant_vector_store / opensearch_output
 *                                                       → (deletions) qdrant_delete / opensearch_delete
 *
 * Authors compose them in the builder; we don't hardwire a pipeline. Every
 * plugin declares input/output ports so the runtime can route documents
 * through named slots instead of the legacy flatten fallback.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { InProcessPlugin } from "../../../packages/plugin-sdk/src/index.ts";
import { pickBackendName, requireBackendConnection } from "./dataset-binding.ts";
import { createVectorStore } from "../../../packages/vector/src/index.ts";
import { createOpenSearchClient } from "../../../packages/opensearch/src/index.ts";

// ===========================================================================
// filesystem_source
// ===========================================================================

/**
 * Minimal glob matcher supporting `**`, `*`, and `?`. Translates the pattern
 * to a regex once per pattern; the result matches against forward-slash
 * paths (`a/b/c.ts`) regardless of platform separators (callers normalise).
 *
 *   - `**` matches zero or more path segments (including separators).
 *   - `*` matches anything except `/`.
 *   - `?` matches a single character except `/`.
 *
 * This is intentionally not a full minimatch implementation — no brace
 * expansion, no character classes — because the simpler grammar keeps the
 * security surface tiny and our use cases (extension globs, prefix globs,
 * exclude globs) don't need more.
 */
export function globToRegExp(pattern: string): RegExp {
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      // `**/` or trailing `**` — eat both stars (and an optional `/`).
      regex += "(?:.*)";
      i += 2;
      if (pattern[i] === "/") i += 1;
    } else if (ch === "*") {
      regex += "[^/]*";
      i += 1;
    } else if (ch === "?") {
      regex += "[^/]";
      i += 1;
    } else if (ch === "{") {
      // Brace alternation: {ts,js,tsx} → (ts|js|tsx).
      const close = pattern.indexOf("}", i + 1);
      if (close === -1) {
        regex += "\\{";
        i += 1;
        continue;
      }
      const inner = pattern
        .slice(i + 1, close)
        .split(",")
        .map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&"))
        .join("|");
      regex += `(?:${inner})`;
      i = close + 1;
    } else if (/[.+^$()|[\]\\]/.test(ch)) {
      regex += "\\" + ch;
      i += 1;
    } else {
      regex += ch;
      i += 1;
    }
  }
  regex += "$";
  return new RegExp(regex);
}

function matchesAny(globRegexes: RegExp[], relPath: string): boolean {
  if (globRegexes.length === 0) return false;
  return globRegexes.some((re) => re.test(relPath));
}

/**
 * Recursively walks `rootAbs` and yields each regular file whose path
 * (relative to root, forward-slashed) is matched by `include` AND not
 * matched by `exclude`. The default exclude list strips common heavy
 * directories so authors don't need to remember every dotfile.
 */
async function* walkFiles(
  rootAbs: string,
  includes: RegExp[],
  excludes: RegExp[]
): AsyncGenerator<{ absPath: string; relPath: string; stat: { mtimeMs: number; size: number } }> {
  const stack: string[] = [rootAbs];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      const relPath = path.relative(rootAbs, absPath).split(path.sep).join("/");
      if (matchesAny(excludes, relPath)) continue;
      if (entry.isDirectory()) {
        stack.push(absPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (includes.length > 0 && !matchesAny(includes, relPath)) continue;
      const s = await fs.stat(absPath);
      yield { absPath, relPath, stat: { mtimeMs: s.mtimeMs, size: s.size } };
    }
  }
}

const DEFAULT_EXCLUDE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.svn/**",
  "**/.hg/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/target/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/.idea/**",
  "**/.vscode/**",
  "**/.DS_Store",
  // Common binary file extensions — these don't decode to useful text and
  // were the source of the "unsupported Unicode escape sequence" failures
  // when the include glob (e.g. "**/*") swept them in. The byte-NUL filter
  // below catches what survives this, but excluding them up front is
  // faster + avoids the failed open.
  "**/*.{png,jpg,jpeg,gif,ico,webp,bmp,tiff,avif}",
  "**/*.{mp3,mp4,mov,avi,webm,wav,flac,ogg}",
  "**/*.{zip,tar,gz,tgz,bz2,xz,7z,rar}",
  "**/*.{so,dylib,dll,exe,a,lib,o,bin}",
  "**/*.{pyc,pyo,class,jar,war}",
  "**/*.{pdf,doc,docx,xls,xlsx,ppt,pptx}",
  "**/*.{woff,woff2,ttf,otf,eot}",
  "**/*.{sqlite,db}",
  "**/*.{pack,idx}"
];

export const filesystemSourcePlugin: InProcessPlugin = {
  manifest: {
    id: "filesystem_source",
    name: "Filesystem Source",
    version: "1.0.0",
    category: "datasource",
    description:
      "Reads a directory tree from the worker filesystem and emits one document per file matching the include globs. Paths are resolved to absolute form and any resolved path outside `rootPath` is rejected to prevent `..` traversal.",
    configSchema: {
      type: "object",
      required: ["rootPath"],
      properties: {
        rootPath: {
          type: "string",
          description: "Absolute path on the worker filesystem to walk."
        },
        include: {
          type: "array",
          items: { type: "string" },
          default: ["**/*"],
          description:
            "Glob patterns (relative to rootPath); a file is included iff it matches at least one. Defaults to all files."
        },
        exclude: {
          type: "array",
          items: { type: "string" },
          description:
            "Glob patterns excluded after include matching. Common heavy directories (.git, node_modules, dist, target, …) are excluded by default; this list is appended."
        },
        maxFileSize: {
          type: "integer",
          default: 1048576,
          description: "Skip files larger than this many bytes (default 1 MiB)."
        },
        encoding: {
          type: "string",
          enum: ["utf8", "utf16le", "latin1"],
          default: "utf8",
          description: "Text encoding used to read file contents."
        },
        computeHash: {
          type: "boolean",
          default: false,
          description:
            "Compute a sha256 of each file's content. Off by default — turn on when downstream `delta_filter` is in `hash` or `mtime+hash` mode."
        }
      },
      additionalProperties: false
    },
    outputPorts: [
      { name: "documents", description: "Array of { docId, path, content, mtime, sha256?, size }." },
      { name: "rootPath", description: "Resolved absolute rootPath, surfaced for downstream auditing." }
    ],
    capabilities: ["ingestion"],
    ui: {
      icon: "folder",
      formHints: {
        include: { widget: "tags" },
        exclude: { widget: "tags" },
        maxFileSize: { widget: "number", min: 1, step: 1024 },
        encoding: { widget: "select" },
        computeHash: { widget: "checkbox" }
      }
    }
  },
  async execute({ config }) {
    const rawRoot = String(config.rootPath ?? "");
    if (!rawRoot) throw new Error("filesystem_source: `rootPath` is required");
    const rootAbs = path.resolve(rawRoot);
    // Sanity check: refuse to crawl the literal filesystem root or env paths.
    if (rootAbs === path.sep || rootAbs === "/") {
      throw new Error("filesystem_source: refusing to walk filesystem root");
    }
    const include = (Array.isArray(config.include) ? (config.include as string[]) : ["**/*"]).map(globToRegExp);
    const excludeList = Array.isArray(config.exclude) ? (config.exclude as string[]) : [];
    const exclude = [...DEFAULT_EXCLUDE, ...excludeList].map(globToRegExp);
    const maxFileSize = Number(config.maxFileSize ?? 1048576);
    const encoding = String(config.encoding ?? "utf8") as BufferEncoding;
    const computeHash = config.computeHash === true;

    const documents: Array<{
      docId: string;
      path: string;
      content: string;
      mtime: string;
      sha256?: string;
      size: number;
    }> = [];

    for await (const entry of walkFiles(rootAbs, include, exclude)) {
      // Defence in depth: even though walkFiles confines to rootAbs, double-
      // check the resolved path is still inside in case symlinks redirected.
      const resolved = path.resolve(entry.absPath);
      if (!resolved.startsWith(rootAbs + path.sep) && resolved !== rootAbs) continue;
      if (entry.stat.size > maxFileSize) continue;
      let content: string;
      try {
        content = await fs.readFile(entry.absPath, { encoding });
      } catch {
        continue;
      }
      // If NULs make up a non-trivial slice of the bytes the file is
      // almost certainly a binary misclassified by the include glob (.so,
      // .pyc, git pack) — skip it. Below that threshold we have ASCII
      // text with a stray NUL in a comment or a string literal; scrub
      // those (and any NUL the OS allowed in the path) so the row stores
      // cleanly. Without this any later JSONB write would 22P02 with
      // "unsupported Unicode escape sequence" and fail the whole run.
      const nulMatches = content.match(/\u0000/g);
      const nulCount = nulMatches ? nulMatches.length : 0;
      if (nulCount > Math.max(8, content.length * 0.01)) continue;
      const sanitizedContent =
        nulCount > 0 ? content.replace(/\u0000/g, "\uFFFD") : content;
      const sanitizedRel = entry.relPath.includes("\u0000")
        ? entry.relPath.replace(/\u0000/g, "\uFFFD")
        : entry.relPath;
      const doc = {
        docId: sanitizedRel,
        path: sanitizedRel,
        content: sanitizedContent,
        mtime: new Date(entry.stat.mtimeMs).toISOString(),
        size: entry.stat.size,
        ...(computeHash
          ? {
              sha256: crypto
                .createHash("sha256")
                .update(sanitizedContent)
                .digest("hex")
            }
          : {})
      };
      documents.push(doc);
    }
    return { outputs: { documents, rootPath: rootAbs } };
  }
};

// ===========================================================================
// jsonl_source
// ===========================================================================

/**
 * Drop-in alternative to `filesystem_source` for JSON Lines corpora. Walks the
 * same way (include/exclude globs, default-exclude list) but reads each matched
 * file LINE BY LINE and emits one document per parsed line. The original line
 * string is preserved on `content` so downstream chunkers / text_parsers keep
 * working; parsed JSON fields are spread alongside so transforms / sinks can
 * reference them directly.
 *
 * Defaults differ from `filesystem_source` in two places:
 *   - `include` defaults to `["**​/*.jsonl"]` (the canonical extension).
 *   - `maxFileSize` defaults to 512 MiB — JSONL corpora routinely run tens
 *     to hundreds of megabytes; the 1 MiB filesystem_source default would
 *     silently skip them.
 */
export const jsonlSourcePlugin: InProcessPlugin = {
  manifest: {
    id: "jsonl_source",
    name: "JSONL Source",
    version: "1.0.0",
    category: "datasource",
    description:
      "Reads a directory tree from the worker filesystem and emits ONE DOCUMENT PER LINE of each matched JSONL file. Each line is parsed as JSON and spread onto the document; the raw line text is also preserved on `content` so downstream chunkers/parsers keep working. Like `filesystem_source` but for newline-delimited JSON corpora (email dumps, log archives, scraped feeds).",
    configSchema: {
      type: "object",
      required: ["rootPath"],
      properties: {
        rootPath: {
          type: "string",
          description: "Absolute path on the worker filesystem to walk."
        },
        include: {
          type: "array",
          items: { type: "string" },
          default: ["**/*.jsonl"],
          description:
            "Glob patterns (relative to rootPath); a file is included iff it matches at least one. Defaults to all .jsonl files."
        },
        exclude: {
          type: "array",
          items: { type: "string" },
          description:
            "Glob patterns excluded after include matching. Common heavy directories (.git, node_modules, dist, target, …) are excluded by default; this list is appended."
        },
        maxFileSize: {
          type: "integer",
          default: 536870912,
          description: "Skip files larger than this many bytes (default 512 MiB)."
        },
        encoding: {
          type: "string",
          enum: ["utf8", "utf16le", "latin1"],
          default: "utf8",
          description: "Text encoding used to read file contents."
        },
        idField: {
          type: "string",
          description:
            "Name of a field on each parsed JSON line to use as `docId`. Falls back to `${relPath}#L${lineNumber}` when the field is missing or empty."
        },
        contentField: {
          type: "string",
          description:
            "When set, the value at this field on each parsed line is copied to the document's top-level `content` (overriding the raw line text). Useful when the field already holds the body (e.g. `body_text` for email dumps) so the downstream chunker indexes the meaningful payload directly."
        },
        dropFields: {
          type: "array",
          items: { type: "string" },
          description:
            "Field names to remove from each parsed line BEFORE emitting. Useful when the corpus carries heavy duplicate fields you don't need downstream (e.g. `body_html` next to `body_text`). Dropping them at the source keeps the documents array small enough that the runtime's per-node trace doesn't hit V8's ~512 MiB string cap on large corpora."
        },
        skipMalformed: {
          type: "boolean",
          default: true,
          description:
            "When a line is not parseable as JSON, skip it (and count it in metadata) instead of failing the run. Turn off to fail loudly on corrupt input."
        },
        maxLinesPerFile: {
          type: "integer",
          description:
            "Optional upper bound on lines read from any single file. Unset = no limit. Useful for sampling huge corpora during pipeline iteration."
        }
      },
      additionalProperties: false
    },
    outputPorts: [
      {
        name: "documents",
        description:
          "Array of { docId, path, line, size, mtime, content, ...parsedFields } — one entry per non-empty line of each matched file."
      },
      { name: "rootPath", description: "Resolved absolute rootPath, surfaced for downstream auditing." }
    ],
    capabilities: ["ingestion"],
    ui: {
      icon: "file-json",
      formHints: {
        include: { widget: "tags" },
        exclude: { widget: "tags" },
        maxFileSize: { widget: "number", min: 1, step: 1024 },
        encoding: { widget: "select" },
        idField: { widget: "text" },
        contentField: { widget: "text" },
        skipMalformed: { widget: "checkbox" },
        maxLinesPerFile: { widget: "number", min: 1, step: 1000 }
      }
    }
  },
  async execute({ config }) {
    const rawRoot = String(config.rootPath ?? "");
    if (!rawRoot) throw new Error("jsonl_source: `rootPath` is required");
    const rootAbs = path.resolve(rawRoot);
    if (rootAbs === path.sep || rootAbs === "/") {
      throw new Error("jsonl_source: refusing to walk filesystem root");
    }
    const include = (Array.isArray(config.include) ? (config.include as string[]) : ["**/*.jsonl"]).map(globToRegExp);
    const excludeList = Array.isArray(config.exclude) ? (config.exclude as string[]) : [];
    const exclude = [...DEFAULT_EXCLUDE, ...excludeList].map(globToRegExp);
    const maxFileSize = Number(config.maxFileSize ?? 536870912);
    const encoding = String(config.encoding ?? "utf8") as BufferEncoding;
    const idField = config.idField ? String(config.idField) : undefined;
    const contentField = config.contentField ? String(config.contentField) : undefined;
    const dropFields = Array.isArray(config.dropFields)
      ? (config.dropFields as unknown[]).filter((f): f is string => typeof f === "string")
      : [];
    const skipMalformed = config.skipMalformed !== false;
    const maxLinesPerFile =
      typeof config.maxLinesPerFile === "number" && config.maxLinesPerFile > 0
        ? Number(config.maxLinesPerFile)
        : undefined;

    const documents: Array<Record<string, unknown>> = [];
    let filesRead = 0;
    let linesRead = 0;
    let malformedLines = 0;

    for await (const entry of walkFiles(rootAbs, include, exclude)) {
      const resolved = path.resolve(entry.absPath);
      if (!resolved.startsWith(rootAbs + path.sep) && resolved !== rootAbs) continue;
      if (entry.stat.size > maxFileSize) continue;
      let raw: string;
      try {
        raw = await fs.readFile(entry.absPath, { encoding });
      } catch {
        continue;
      }
      filesRead += 1;
      const mtime = new Date(entry.stat.mtimeMs).toISOString();
      const lines = raw.split(/\r?\n/);
      const lineCap = maxLinesPerFile !== undefined ? Math.min(lines.length, maxLinesPerFile) : lines.length;
      for (let i = 0; i < lineCap; i += 1) {
        const line = lines[i];
        if (!line || line.trim().length === 0) continue;
        linesRead += 1;
        let parsed: Record<string, unknown> | undefined;
        try {
          const value = JSON.parse(line);
          if (value && typeof value === "object" && !Array.isArray(value)) {
            parsed = value as Record<string, unknown>;
          } else {
            // Scalars / arrays are unusual in JSONL but legal — wrap so the
            // doc still has consistent shape downstream.
            parsed = { value };
          }
        } catch {
          malformedLines += 1;
          if (skipMalformed) continue;
          throw new Error(
            `jsonl_source: malformed JSON at ${entry.relPath}:L${i + 1}` +
              ` (set skipMalformed=true to tolerate)`
          );
        }
        if (dropFields.length > 0) {
          for (const f of dropFields) delete parsed[f];
        }
        const lineNo = i + 1;
        const rawIdValue = idField ? parsed[idField] : undefined;
        const docId =
          typeof rawIdValue === "string" && rawIdValue.length > 0
            ? rawIdValue
            : typeof rawIdValue === "number"
              ? String(rawIdValue)
              : `${entry.relPath}#L${lineNo}`;
        const projectedContent =
          contentField && typeof parsed[contentField] === "string"
            ? (parsed[contentField] as string)
            : line;
        documents.push({
          ...parsed,
          docId,
          path: entry.relPath,
          line: lineNo,
          size: entry.stat.size,
          mtime,
          content: projectedContent
        });
      }
    }

    return {
      outputs: { documents, rootPath: rootAbs },
      metadata: { filesRead, linesRead, malformedLines, emitted: documents.length }
    };
  }
};

// ===========================================================================
// delta_filter
// ===========================================================================

interface DocLike {
  docId?: string;
  path?: string;
  mtime?: string;
  sha256?: string;
  [k: string]: unknown;
}

function docKey(doc: DocLike): string {
  if (typeof doc.docId === "string" && doc.docId) return doc.docId;
  if (typeof doc.path === "string" && doc.path) return doc.path;
  throw new Error("delta_filter: documents must carry `docId` or `path`");
}

export const deltaFilterPlugin: InProcessPlugin = {
  manifest: {
    id: "delta_filter",
    name: "Delta Filter",
    version: "1.0.0",
    category: "transformer",
    description:
      "Compares the current set of input documents against persisted state for `(tenant, pipeline, stateKey)`. Emits new / modified / deleted documents on three independent output ports; downstream branches wired to an empty port are skipped by the runtime.",
    configSchema: {
      type: "object",
      required: ["stateKey"],
      properties: {
        stateKey: {
          type: "string",
          description:
            "State bucket name. Use distinct keys to keep independent ingest paths (e.g. `code` vs `docs`) from colliding."
        },
        compareBy: {
          type: "string",
          enum: ["mtime", "hash", "mtime+hash"],
          default: "mtime",
          description:
            "How to detect modification. `mtime` (default, cheap): re-emit when the file's mtime changed. `hash`: re-emit when the sha256 changed. `mtime+hash`: use mtime as a fast gate, only hashing when mtime moved."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "documents", required: true, description: "Current full set of source documents." }
    ],
    outputPorts: [
      { name: "new", description: "Documents the filter has never recorded before." },
      { name: "modified", description: "Documents whose mtime/hash differs from the recorded state." },
      { name: "deleted", description: "doc_ids in state but missing from this run's input set." },
      { name: "unchanged", description: "Documents whose state matches; usually unused — wire only if you want to count or audit." }
    ],
    capabilities: ["ingestion"],
    ui: {
      icon: "filter",
      formHints: {
        compareBy: { widget: "select" },
        stateKey: { widget: "text" }
      }
    }
  },
  async execute({ inputs, config, ingestStateStore }) {
    const stateKey = String(config.stateKey ?? "");
    if (!stateKey) throw new Error("delta_filter: `stateKey` is required");
    const compareBy = String(config.compareBy ?? "mtime") as "mtime" | "hash" | "mtime+hash";
    const documents = (inputs.documents as DocLike[] | undefined) ?? [];
    if (!Array.isArray(documents)) {
      throw new Error("delta_filter: inputs.documents must be an array");
    }

    const prior = ingestStateStore ? await ingestStateStore.list({ stateKey }) : [];
    const priorById = new Map(prior.map((entry) => [entry.docId, entry]));

    const matches = (doc: DocLike, recorded: { sha256?: string; mtime?: string } | undefined): boolean => {
      if (!recorded) return false;
      if (compareBy === "mtime") return doc.mtime === recorded.mtime;
      if (compareBy === "hash") return doc.sha256 === recorded.sha256;
      // mtime+hash: cheap mtime gate first, then hash when mtime moved.
      if (doc.mtime === recorded.mtime) return true;
      return doc.sha256 !== undefined && doc.sha256 === recorded.sha256;
    };

    const fresh: DocLike[] = [];
    const modified: DocLike[] = [];
    const unchanged: DocLike[] = [];
    const seen = new Set<string>();
    for (const doc of documents) {
      const id = docKey(doc);
      seen.add(id);
      const recorded = priorById.get(id);
      if (!recorded) {
        fresh.push(doc);
      } else if (matches(doc, recorded)) {
        unchanged.push(doc);
      } else {
        modified.push(doc);
      }
    }
    const deleted: Array<{ docId: string }> = [];
    for (const entry of prior) {
      if (!seen.has(entry.docId)) deleted.push({ docId: entry.docId });
    }

    // Persist the new state — entries are the docs we observed this run, with
    // the comparison fingerprint captured. Deleted docs drop off because they
    // aren't in `documents` and we wholesale-replace the bucket.
    if (ingestStateStore) {
      const now = new Date().toISOString();
      const entries = documents.map((doc) => ({
        docId: docKey(doc),
        sha256: typeof doc.sha256 === "string" ? doc.sha256 : undefined,
        mtime: typeof doc.mtime === "string" ? doc.mtime : undefined,
        lastSeen: now
      }));
      await ingestStateStore.replaceAll({ stateKey, entries });
    }

    // Each port emits undefined when its bucket is empty so the runtime's
    // skip-cascading kicks downstream branches off the DAG instead of
    // running them with empty inputs.
    return {
      outputs: {
        new: fresh.length > 0 ? fresh : undefined,
        modified: modified.length > 0 ? modified : undefined,
        deleted: deleted.length > 0 ? deleted : undefined,
        unchanged: unchanged.length > 0 ? unchanged : undefined
      },
      metadata: {
        counts: { new: fresh.length, modified: modified.length, deleted: deleted.length, unchanged: unchanged.length }
      }
    };
  }
};

// ===========================================================================
// code_chunker
// ===========================================================================

/** File-extension → canonical language id. Lowercased. */
const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell"
};

/**
 * Per-language regex anchors. Each pattern matches the START of a top-level
 * construct (function, class, type, etc) at column 0 (anchored with `^` and
 * /m flag set when applied). When multiple patterns match the same line, the
 * earliest-declared wins (so e.g. an `export class` is classified as a class,
 * not a generic identifier).
 *
 * These are heuristic; they don't parse the language. Their job is to find
 * GOOD chunk boundaries so retrieval over code lands hits at function/type
 * granularity instead of mid-statement. The fallback (line-based) is good
 * enough when no anchors match.
 */
type AnchorPattern = { kind: string; rx: RegExp; nameGroup?: number };
const ANCHORS: Record<string, AnchorPattern[]> = {
  typescript: [
    { kind: "function", rx: /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, nameGroup: 1 },
    { kind: "class", rx: /^(?:export\s+(?:default\s+|abstract\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, nameGroup: 1 },
    { kind: "interface", rx: /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, nameGroup: 1 },
    { kind: "type", rx: /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/, nameGroup: 1 },
    { kind: "enum", rx: /^(?:export\s+(?:const\s+)?)?enum\s+([A-Za-z_$][\w$]*)/, nameGroup: 1 },
    { kind: "const-fn", rx: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?\s*=\s*(?:async\s*)?(?:\(|function|<)/, nameGroup: 1 },
    { kind: "namespace", rx: /^(?:export\s+)?(?:namespace|module)\s+([A-Za-z_$][\w$]*)/, nameGroup: 1 }
  ],
  javascript: [
    { kind: "function", rx: /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, nameGroup: 1 },
    { kind: "class", rx: /^(?:export\s+(?:default\s+)?)?class\s+([A-Za-z_$][\w$]*)/, nameGroup: 1 },
    { kind: "const-fn", rx: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/, nameGroup: 1 }
  ],
  python: [
    { kind: "function", rx: /^(?:async\s+)?def\s+([A-Za-z_][\w]*)/, nameGroup: 1 },
    { kind: "class", rx: /^class\s+([A-Za-z_][\w]*)/, nameGroup: 1 }
  ],
  go: [
    { kind: "function", rx: /^func\s+(?:\([^)]*\)\s+)?([A-Za-z_][\w]*)/, nameGroup: 1 },
    { kind: "type", rx: /^type\s+([A-Za-z_][\w]*)\s+(?:struct|interface|=)/, nameGroup: 1 },
    { kind: "var-block", rx: /^var\s+\(/ },
    { kind: "const-block", rx: /^const\s+\(/ }
  ],
  rust: [
    { kind: "function", rx: /^(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_][\w]*)/, nameGroup: 1 },
    { kind: "struct", rx: /^(?:pub(?:\([^)]+\))?\s+)?struct\s+([A-Za-z_][\w]*)/, nameGroup: 1 },
    { kind: "enum", rx: /^(?:pub(?:\([^)]+\))?\s+)?enum\s+([A-Za-z_][\w]*)/, nameGroup: 1 },
    { kind: "trait", rx: /^(?:pub(?:\([^)]+\))?\s+)?trait\s+([A-Za-z_][\w]*)/, nameGroup: 1 },
    { kind: "impl", rx: /^impl(?:<[^>]+>)?\s+(?:[A-Za-z_:<>,\s]+\s+for\s+)?([A-Za-z_][\w]*)/, nameGroup: 1 },
    { kind: "mod", rx: /^(?:pub(?:\([^)]+\))?\s+)?mod\s+([A-Za-z_][\w]*)/, nameGroup: 1 }
  ],
  java: [
    { kind: "class", rx: /^(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:abstract\s+)?class\s+([A-Za-z_][\w]*)/, nameGroup: 1 },
    { kind: "interface", rx: /^(?:public|private|protected)?\s*interface\s+([A-Za-z_][\w]*)/, nameGroup: 1 },
    { kind: "enum", rx: /^(?:public|private|protected)?\s*enum\s+([A-Za-z_][\w]*)/, nameGroup: 1 }
  ],
  kotlin: [
    { kind: "function", rx: /^(?:public|private|protected|internal)?\s*(?:suspend\s+)?fun\s+(?:<[^>]+>\s+)?([A-Za-z_][\w]*)/, nameGroup: 1 },
    { kind: "class", rx: /^(?:public|private|protected|internal)?\s*(?:open\s+|abstract\s+|sealed\s+|data\s+)?class\s+([A-Za-z_][\w]*)/, nameGroup: 1 },
    { kind: "object", rx: /^(?:public|private|protected|internal)?\s*object\s+([A-Za-z_][\w]*)/, nameGroup: 1 },
    { kind: "interface", rx: /^(?:public|private|protected|internal)?\s*interface\s+([A-Za-z_][\w]*)/, nameGroup: 1 }
  ],
  c: [
    { kind: "function", rx: /^[A-Za-z_][\w\s*]+?\s+\**([A-Za-z_][\w]*)\s*\([^;]*\)\s*\{?/, nameGroup: 1 },
    { kind: "struct", rx: /^(?:typedef\s+)?struct\s+([A-Za-z_][\w]*)/, nameGroup: 1 },
    { kind: "typedef", rx: /^typedef\s+/ }
  ],
  cpp: [
    { kind: "function", rx: /^[A-Za-z_][\w:<>,\s*&]+?\s+\**([A-Za-z_][\w:]*)\s*\([^;]*\)\s*(?:const)?\s*\{?/, nameGroup: 1 },
    { kind: "class", rx: /^(?:template\s*<[^>]+>\s*)?class\s+([A-Za-z_][\w]*)/, nameGroup: 1 },
    { kind: "struct", rx: /^(?:template\s*<[^>]+>\s*)?struct\s+([A-Za-z_][\w]*)/, nameGroup: 1 },
    { kind: "namespace", rx: /^namespace\s+([A-Za-z_][\w]*)/, nameGroup: 1 }
  ],
  csharp: [
    { kind: "class", rx: /^\s*(?:public|private|protected|internal)?\s*(?:static\s+|abstract\s+|sealed\s+|partial\s+)*class\s+([A-Za-z_][\w]*)/, nameGroup: 1 },
    { kind: "interface", rx: /^\s*(?:public|private|protected|internal)?\s*interface\s+([A-Za-z_][\w]*)/, nameGroup: 1 },
    { kind: "struct", rx: /^\s*(?:public|private|protected|internal)?\s*struct\s+([A-Za-z_][\w]*)/, nameGroup: 1 },
    { kind: "namespace", rx: /^namespace\s+([A-Za-z_][\w.]*)/, nameGroup: 1 }
  ],
  ruby: [
    { kind: "class", rx: /^class\s+([A-Z][\w:]*)/, nameGroup: 1 },
    { kind: "module", rx: /^module\s+([A-Z][\w:]*)/, nameGroup: 1 },
    { kind: "def", rx: /^\s*def\s+(?:self\.)?([a-z_!?=][\w!?=]*)/, nameGroup: 1 }
  ],
  php: [
    { kind: "function", rx: /^(?:function|public\s+function|private\s+function|protected\s+function|static\s+function)\s+([A-Za-z_][\w]*)/, nameGroup: 1 },
    { kind: "class", rx: /^(?:abstract\s+|final\s+)?class\s+([A-Za-z_][\w]*)/, nameGroup: 1 },
    { kind: "interface", rx: /^interface\s+([A-Za-z_][\w]*)/, nameGroup: 1 },
    { kind: "trait", rx: /^trait\s+([A-Za-z_][\w]*)/, nameGroup: 1 }
  ],
  shell: [
    { kind: "function", rx: /^(?:function\s+)?([A-Za-z_][\w]*)\s*\(\s*\)\s*\{?/, nameGroup: 1 }
  ]
};

/** Detect language from a path; returns undefined if the extension isn't
 *  in our table (caller falls back to line-based chunking). */
export function detectLanguage(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_LANG[ext];
}

interface CodeAnchor {
  line: number;
  kind: string;
  name?: string;
}

/**
 * Scan lines for anchor matches. Returns the line index (0-based) of every
 * top-level construct in declaration order. The first chunk always starts at
 * line 0 even when the first anchor isn't there (preamble like imports).
 */
function findAnchors(lines: string[], language: string): CodeAnchor[] {
  const patterns = ANCHORS[language] ?? [];
  if (patterns.length === 0) return [];
  const anchors: CodeAnchor[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const pat of patterns) {
      const m = line.match(pat.rx);
      if (m) {
        const name = pat.nameGroup && m[pat.nameGroup] ? m[pat.nameGroup] : undefined;
        anchors.push({ line: i, kind: pat.kind, name });
        break;
      }
    }
  }
  return anchors;
}

interface Chunk {
  text: string;
  startLine: number;
  endLine: number;
  language: string;
  path: string;
  symbolKind?: string;
  symbolName?: string;
}

/** Split a too-large chunk on blank lines so individual chunks stay under
 *  `maxChars`. Falls back to slicing at maxChars when no blank lines exist. */
function splitOnBlankLines(chunk: Chunk, maxChars: number): Chunk[] {
  if (chunk.text.length <= maxChars) return [chunk];
  const lines = chunk.text.split("\n");
  const out: Chunk[] = [];
  let buf: string[] = [];
  let bufStart = chunk.startLine;
  let bufLen = 0;
  const flush = (atLine: number): void => {
    if (buf.length === 0) return;
    out.push({
      text: buf.join("\n"),
      startLine: bufStart,
      endLine: atLine - 1,
      language: chunk.language,
      path: chunk.path,
      symbolKind: chunk.symbolKind,
      symbolName: chunk.symbolName
    });
    buf = [];
    bufStart = atLine;
    bufLen = 0;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (bufLen + line.length + 1 > maxChars && buf.length > 0) {
      flush(chunk.startLine + i);
    }
    buf.push(line);
    bufLen += line.length + 1;
    if (line.trim().length === 0 && bufLen >= maxChars / 2) {
      flush(chunk.startLine + i + 1);
    }
  }
  flush(chunk.startLine + lines.length);
  return out;
}

/** Merge tiny adjacent chunks so the retriever sees coherent units, not
 *  three-line dribbles. Only merges when the result stays under maxChars. */
function mergeSmall(chunks: Chunk[], minChars: number, maxChars: number): Chunk[] {
  if (chunks.length === 0) return chunks;
  const out: Chunk[] = [];
  for (const chunk of chunks) {
    const last = out[out.length - 1];
    if (last && last.text.length < minChars && last.text.length + chunk.text.length <= maxChars) {
      last.text = last.text + "\n" + chunk.text;
      last.endLine = chunk.endLine;
      // Don't carry symbol info — the merged chunk no longer represents one
      // symbol cleanly. The first symbol-name + kind is misleading.
      last.symbolKind = undefined;
      last.symbolName = undefined;
    } else {
      out.push({ ...chunk });
    }
  }
  return out;
}

/**
 * Symbol-aware chunker. For supported languages, splits content at top-level
 * construct boundaries. Unsupported languages fall back to a blank-line-
 * respecting line chunker. Chunks larger than `maxChars` are further split on
 * blank lines; adjacent chunks smaller than `minChars` merge.
 */
export function chunkCode(args: {
  content: string;
  filePath: string;
  maxChars: number;
  minChars: number;
}): Chunk[] {
  const { content, filePath, maxChars, minChars } = args;
  const language = detectLanguage(filePath) ?? "text";
  const lines = content.split("\n");
  if (lines.length === 0) return [];

  const anchors = findAnchors(lines, language);
  const chunks: Chunk[] = [];

  if (anchors.length === 0) {
    // Fallback: line-based with blank-line boundaries.
    const single: Chunk = {
      text: content,
      startLine: 0,
      endLine: lines.length - 1,
      language,
      path: filePath
    };
    return mergeSmall(splitOnBlankLines(single, maxChars), minChars, maxChars);
  }

  // Preamble: everything before the first anchor is its own chunk.
  if (anchors[0].line > 0) {
    chunks.push({
      text: lines.slice(0, anchors[0].line).join("\n"),
      startLine: 0,
      endLine: anchors[0].line - 1,
      language,
      path: filePath
    });
  }

  for (let i = 0; i < anchors.length; i += 1) {
    const anchor = anchors[i];
    const nextLine = i + 1 < anchors.length ? anchors[i + 1].line : lines.length;
    chunks.push({
      text: lines.slice(anchor.line, nextLine).join("\n"),
      startLine: anchor.line,
      endLine: nextLine - 1,
      language,
      path: filePath,
      symbolKind: anchor.kind,
      symbolName: anchor.name
    });
  }

  const expanded = chunks.flatMap((c) => splitOnBlankLines(c, maxChars));
  return mergeSmall(expanded, minChars, maxChars);
}

export const codeChunkerPlugin: InProcessPlugin = {
  manifest: {
    id: "code_chunker",
    name: "Code Chunker",
    version: "1.0.0",
    category: "chunker",
    description:
      "Symbol-aware chunker for polyglot codebases. Auto-detects language by extension (TypeScript/JavaScript/Python/Go/Rust/Java/Kotlin/C/C++/C#/Ruby/PHP/Shell). Chunks span top-level constructs (function/class/interface/struct/…); oversize chunks split on blank lines; tiny adjacent chunks merge. Unknown extensions fall back to blank-line-respecting line chunking.",
    configSchema: {
      type: "object",
      properties: {
        maxChars: {
          type: "integer",
          default: 4000,
          description: "Upper bound on chunk size in characters. Chunks larger than this split on blank lines."
        },
        minChars: {
          type: "integer",
          default: 400,
          description: "Lower bound below which adjacent chunks merge (when the merged total is ≤ maxChars)."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "documents", required: true, description: "Source documents with `path` and `content`." }
    ],
    outputPorts: [
      { name: "chunks", description: "Array of { text, path, language, symbolKind?, symbolName?, startLine, endLine, index }." }
    ],
    capabilities: ["ingestion"],
    ui: {
      icon: "code",
      formHints: {
        maxChars: { widget: "number", min: 200, step: 100 },
        minChars: { widget: "number", min: 0, step: 100 }
      }
    }
  },
  async execute({ inputs, config }) {
    const documents = (inputs.documents as DocLike[] | undefined) ?? [];
    const maxChars = Number(config.maxChars ?? 4000);
    const minChars = Number(config.minChars ?? 400);
    const out: Array<Chunk & { index: number; docId: string }> = [];
    for (const doc of documents) {
      const filePath = String(doc.path ?? doc.docId ?? "");
      const content = String((doc as { content?: unknown }).content ?? "");
      const docId = docKey(doc);
      const chunks = chunkCode({ content, filePath, maxChars, minChars });
      chunks.forEach((chunk, i) => out.push({ ...chunk, index: i, docId }));
    }
    return { outputs: { chunks: out } };
  }
};

// ===========================================================================
// qdrant_delete
// ===========================================================================
//
// Naming convention: `qdrant_delete` and `opensearch_delete` are per-backend
// on purpose — they operate on DIFFERENT modalities (vector points vs text
// chunks) and are NOT interchangeable backends behind a single ID. Use both
// in a pipeline that mirrors a corpus into qdrant + opensearch and needs
// deletes to reach both stores. If you want a future "vector_delete" that
// dispatches by resolved backend provider, see the matching note above
// vector_upsert in src/index.ts.

export const qdrantDeletePlugin: InProcessPlugin = {
  manifest: {
    id: "qdrant_delete",
    name: "Qdrant Delete",
    version: "1.0.0",
    category: "sink",
    contract: 2,
    requires: [{ binding: "vectors", kind: "qdrant" }],
    description:
      "Deletes points by id from a Qdrant collection. Pairs with `delta_filter.deleted` for delta-aware ingestion: when source documents disappear from disk, their vector rows go too.",
    configSchema: {
      // PR1 of the requires roll-out: DSN fields gone. Connection is
      // resolved through the dataset.
      type: "object",
      properties: {
        collection: {
          type: "string",
          default: "default",
          description: "Collection to delete from."
        },
        idPrefix: {
          type: "string",
          description: "Prefix combined with each input doc_id to compute the point id (matches the upsert side)."
        }
      },
      additionalProperties: false
    },
    secretsSchema: {
      type: "object",
      properties: {
        apiKey: { type: "string", format: "secret-ref", description: "Qdrant API key." }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "deleted", required: true, description: "Array of { docId } entries to remove." }
    ],
    outputPorts: [
      { name: "deletedCount", description: "Number of point ids passed to the store." }
    ],
    capabilities: ["ingestion"],
    ui: {
      icon: "trash",
      color: "#dc2626",
      formHints: { collection: { widget: "text" }, apiKey: { widget: "secret" } }
    }
  },
  async execute(input) {
    const { inputs, config, secrets, context } = input;
    const { url } = requireBackendConnection(input, "vector", {
      pluginId: "qdrant_delete",
      defaultPort: 6333
    });
    const store = createVectorStore({
      url,
      apiKey: secrets.apiKey ? String(secrets.apiKey) : undefined
    });
    const collection = String(
      pickBackendName(input, "vector") ??
        context.resolvedConfig.values["vector.collection"]?.value ??
        "default"
    );
    const entries = (inputs.deleted as Array<{ docId?: string }> | undefined) ?? [];
    if (!Array.isArray(entries) || entries.length === 0) {
      return { outputs: { deletedCount: 0 } };
    }
    const docIds = entries
      .map((e) => (typeof e.docId === "string" && e.docId ? e.docId : undefined))
      .filter((id): id is string => !!id);
    if (docIds.length === 0) return { outputs: { deletedCount: 0 } };
    try {
      // Tenant scoping is mandatory at this layer (defense against a
      // docId collision across tenants — every chunk payload carries
      // tenantId so the underlying delete-by-filter requires a match).
      // This single call removes every chunk for every supplied docId.
      await store.deleteByDocIds(collection, context.tenantId, docIds);
    } catch (err) {
      // The Qdrant js client throws bare `Error: Bad Request` (or
      // similar status text) without including the response body or
      // the operation context. Enrich here so the operator sees the
      // collection + docId-list-preview needed to actually diagnose.
      throw enrichQdrantError(err, {
        operation: "delete",
        collection,
        ids: docIds
      });
    }
    return { outputs: { deletedCount: docIds.length } };
  }
};

/**
 * Add operation + collection + first-few-ids to a Qdrant client error.
 * Pure error transform — no I/O — so it's safe to call from any plugin
 * that wraps a qdrant call. The original error is kept as `cause` so
 * stack traces stay intact.
 */
export function enrichQdrantError(
  err: unknown,
  ctx: { operation: string; collection: string; ids?: string[]; dim?: number; count?: number }
): Error {
  const baseMsg = err instanceof Error ? err.message : String(err);
  // The qdrant-js client surfaces server detail on `err.data` (REST
  // wrapper) and sometimes `err.body`. We try both and stringify a
  // compact preview if either is present.
  const e = err as { data?: unknown; body?: unknown; status?: unknown };
  let detail = "";
  for (const candidate of [e.data, e.body]) {
    if (candidate && typeof candidate === "object") {
      try {
        const text = JSON.stringify(candidate);
        if (text && text !== "{}") {
          detail = ` — server: ${text.slice(0, 300)}`;
          break;
        }
      } catch {
        /* ignore */
      }
    }
  }
  const status = typeof e.status === "number" ? ` (HTTP ${e.status})` : "";
  const idsPreview =
    ctx.ids && ctx.ids.length > 0
      ? ` ids[${ctx.ids.length}]=${JSON.stringify(ctx.ids.slice(0, 5))}${ctx.ids.length > 5 ? "…" : ""}`
      : "";
  const sizeInfo =
    ctx.count !== undefined ? ` count=${ctx.count}` : "";
  const dimInfo = ctx.dim !== undefined ? ` dim=${ctx.dim}` : "";
  const enriched = new Error(
    `qdrant ${ctx.operation} on "${ctx.collection}"${status}: ${baseMsg}${dimInfo}${sizeInfo}${idsPreview}${detail}`
  );
  // Preserve the cause chain so stack inspection still leads back to
  // the qdrant client call.
  (enriched as { cause?: unknown }).cause = err;
  return enriched;
}

// ===========================================================================
// opensearch_delete
// ===========================================================================

export const opensearchDeletePlugin: InProcessPlugin = {
  manifest: {
    id: "opensearch_delete",
    name: "OpenSearch Delete",
    version: "1.0.0",
    category: "sink",
    contract: 2,
    requires: [{ binding: "text", kind: "opensearch" }],
    description:
      "Deletes every chunk for the given docIds from an OpenSearch index (filter by docId + tenantId on the doc body — the upsert side sets `_id` per-chunk so the caller doesn't know the chunk count to recompute the per-chunk ids). Tenant-scoped: the filter requires the indexed doc's `tenantId` field to match the executing tenant, defense against a docId collision across tenants. Pairs with `delta_filter.deleted` for delta-aware ingestion.",
    configSchema: {
      type: "object",
      properties: {
        index: { type: "string", default: "default", description: "Target index." }
      },
      additionalProperties: false
    },
    secretsSchema: {
      type: "object",
      properties: {
        username: { type: "string", format: "secret-ref", description: "OpenSearch basic-auth username." },
        password: { type: "string", format: "secret-ref", description: "OpenSearch basic-auth password." },
        authorization: { type: "string", format: "secret-ref", description: "Raw Authorization header value." }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "deleted", required: true, description: "Array of { docId } entries to remove." }
    ],
    outputPorts: [
      { name: "deletedCount", description: "Number of source docIds submitted (one input docId may match many indexed chunks)." }
    ],
    capabilities: ["ingestion"],
    ui: {
      icon: "trash",
      color: "#dc2626",
      formHints: { index: { widget: "text" } }
    }
  },
  async execute(input) {
    const { inputs, secrets, context } = input;
    const { url: endpoint } = requireBackendConnection(input, "text", {
      pluginId: "opensearch_delete",
      defaultPort: 9200
    });
    const client = createOpenSearchClient({
      endpoint,
      username: secrets.username,
      password: secrets.password,
      authorization: secrets.authorization
    });
    if (!client) throw new Error("opensearch_delete: endpoint not configured");
    const index = String(pickBackendName(input, "keyword") ?? "default");
    const entries = (inputs.deleted as Array<{ docId?: string }> | undefined) ?? [];
    if (!Array.isArray(entries) || entries.length === 0) {
      return { outputs: { deletedCount: 0 } };
    }
    const docIds = entries
      .map((e) => (typeof e.docId === "string" && e.docId ? e.docId : undefined))
      .filter((id): id is string => !!id);
    if (docIds.length === 0) return { outputs: { deletedCount: 0 } };
    // Tenant scope is mandatory at this layer — same defense-in-depth
    // posture as qdrant_delete + the pgvector + InMemory paths. The
    // filter removes every chunk for any of the supplied source docIds
    // in one delete_by_query call.
    await client.deleteByQuery(index, {
      bool: {
        must: [
          { term: { tenantId: context.tenantId } },
          { terms: { docId: docIds } }
        ]
      }
    });
    return { outputs: { deletedCount: docIds.length } };
  }
};

// ===========================================================================
// path_classifier
// ===========================================================================

/**
 * Routes documents to one of N output ports based on per-port glob patterns.
 * The port set is fixed (docs/code/tests/config/other) so the plugin's
 * declared `outputPorts` is static, matching the manifest contract — pick
 * the names that fit your repo and leave the others unwired. Each document
 * is delivered to the FIRST port whose pattern matches, in declaration
 * order; documents matching no port land on `other`.
 */
export const pathClassifierPlugin: InProcessPlugin = {
  manifest: {
    id: "path_classifier",
    name: "Path Classifier",
    version: "1.0.0",
    category: "router",
    description:
      "Splits an input documents array onto multiple named output ports based on per-port glob patterns matched against each document's `path`. Useful for fanning a single filesystem source out to a docs branch (opensearch) and a code branch (qdrant) without two pipelines.",
    configSchema: {
      type: "object",
      properties: {
        docs: { type: "string", description: "Glob for docs route (e.g. `docs/**/*.md`)." },
        code: { type: "string", description: "Glob for code route (e.g. `**/*.{ts,py,go}`)." },
        tests: { type: "string", description: "Glob for tests route (e.g. `**/{tests,__tests__}/**`)." },
        config: { type: "string", description: "Glob for configuration files (e.g. `**/*.{json,yaml,toml}`)." },
        other: {
          type: "string",
          default: "**/*",
          description: "Catch-all glob; receives anything not claimed by a more-specific port."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "documents", required: true, description: "Source documents to classify." }
    ],
    outputPorts: [
      { name: "docs", description: "Documents matching the docs glob." },
      { name: "code", description: "Documents matching the code glob." },
      { name: "tests", description: "Documents matching the tests glob." },
      { name: "config", description: "Documents matching the config glob." },
      { name: "other", description: "Documents matching none of the more-specific globs." }
    ],
    capabilities: ["ingestion"],
    ui: {
      icon: "git-branch",
      formHints: {
        docs: { widget: "text" },
        code: { widget: "text" },
        tests: { widget: "text" },
        config: { widget: "text" }
      }
    }
  },
  async execute({ inputs, config }) {
    const documents = (inputs.documents as DocLike[] | undefined) ?? [];
    if (!Array.isArray(documents)) {
      throw new Error("path_classifier: inputs.documents must be an array");
    }
    // Precedence order is the declaration order of the output ports; an
    // earlier match wins. `other` is the catch-all and defaults to **/*.
    const routes = ["docs", "code", "tests", "config", "other"] as const;
    const compiled = routes.map((name) => {
      const pattern = config[name];
      if (typeof pattern === "string" && pattern.length > 0) {
        return { name, rx: globToRegExp(pattern) };
      }
      // `other` defaults to **/* when unset; everything else is opt-in.
      if (name === "other") return { name, rx: globToRegExp("**/*") };
      return { name, rx: null as RegExp | null };
    });

    const buckets: Record<string, DocLike[]> = { docs: [], code: [], tests: [], config: [], other: [] };
    for (const doc of documents) {
      const p = String(doc.path ?? doc.docId ?? "");
      for (const route of compiled) {
        if (route.rx && route.rx.test(p)) {
          buckets[route.name].push(doc);
          break;
        }
      }
    }
    // Empty buckets emit `undefined` so downstream branches wired to that
    // port are skipped by the runtime instead of running with empty inputs.
    return {
      outputs: {
        docs: buckets.docs.length > 0 ? buckets.docs : undefined,
        code: buckets.code.length > 0 ? buckets.code : undefined,
        tests: buckets.tests.length > 0 ? buckets.tests : undefined,
        config: buckets.config.length > 0 ? buckets.config : undefined,
        other: buckets.other.length > 0 ? buckets.other : undefined
      },
      metadata: {
        counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]))
      }
    };
  }
};
