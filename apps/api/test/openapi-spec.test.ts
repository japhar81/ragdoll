/**
 * OpenAPI contract guard — keeps `docs/api/openapi.yaml` clean, valid, and in
 * sync with the actual routes on every push.
 *
 * Failure modes it catches (all have bitten us):
 *   - YAML that doesn't parse (a `string[]` unquoted in a flow scalar, a
 *     duplicated response key) — the editor.swagger.io "Unable to render"
 *     class of bug.
 *   - Structural rot: missing openapi/info, an operation with no responses, a
 *     `$ref` that points at a component that was renamed or deleted, a path
 *     template `{id}` with no matching path parameter.
 *   - Drift: a new `api.route(...)` shipped without a doc entry, or a doc
 *     entry for a route that no longer exists.
 *
 * Route↔doc matching is path-PARAMETER-NAME agnostic on purpose: the router
 * uses `:id` where the spec may say `{pipeline_id}`. Both are valid; we compare
 * method + path SHAPE (`{}` for every param), not the param spelling.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const SPEC_PATH = join(REPO_ROOT, "docs/api/openapi.yaml");
const ROUTES_DIR = join(REPO_ROOT, "apps/api/src");

/** HTTP methods an OpenAPI Path Item may carry. */
const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "options", "head", "trace"];

/**
 * Endpoints served OUTSIDE the `api.route(...)` registry (mounted by a bespoke
 * handler), so the source scan below can't see them. They are legitimately
 * documented; list them here so the reverse "documented-but-no-route" check
 * doesn't flag them. Keep this list SHORT and justified.
 */
const NON_ROUTER_ENDPOINTS = new Set([
  "POST /mcp" // MCP JSON-RPC endpoint, mounted directly in apps/api/src/mcp.ts
]);

/** Collapse every `{param}` to `{}` so param spelling doesn't affect matching. */
function shape(path: string): string {
  return path.replace(/{[^}]+}/g, "{}");
}

// ---------------------------------------------------------------------------
// Parse ONCE, strictly. Duplicate keys + tag errors surface as document errors.
// ---------------------------------------------------------------------------

const SRC = readFileSync(SPEC_PATH, "utf8");
const PARSED = YAML.parseAllDocuments(SRC, { uniqueKeys: true, strict: true });

test("openapi.yaml parses with no YAML errors or warnings", () => {
  assert.equal(PARSED.length, 1, "expected exactly one YAML document");
  const doc = PARSED[0];
  const errs = doc.errors.map((e) => e.message);
  const warns = doc.warnings.map((w) => w.message);
  assert.deepEqual(errs, [], `YAML errors:\n${errs.join("\n")}`);
  assert.deepEqual(warns, [], `YAML warnings:\n${warns.join("\n")}`);
});

/** The parsed spec as a plain object — safe to use below since the parse test
 *  fails first if it's malformed. */
const spec = PARSED[0].toJS() as {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, Record<string, unknown>>;
  components?: Record<string, unknown>;
};

test("has a valid OpenAPI 3.x envelope (openapi + info + paths)", () => {
  assert.match(spec.openapi ?? "", /^3\./, `openapi must be 3.x, got ${spec.openapi}`);
  assert.ok(spec.info?.title, "info.title is required");
  assert.ok(spec.info?.version, "info.version is required");
  assert.ok(spec.paths && Object.keys(spec.paths).length > 0, "paths must be non-empty");
});

/** Resolve an internal `#/...` JSON-pointer against the parsed spec. */
function resolveRef(ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined; // only internal refs are used
  let node: unknown = spec;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node && typeof node === "object") node = (node as Record<string, unknown>)[key];
    else return undefined;
  }
  return node;
}

test("every internal $ref resolves to an existing node", () => {
  const dangling: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}/${i}`));
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === "$ref" && typeof v === "string") {
          if (resolveRef(v) === undefined) dangling.push(`${v} (at ${path})`);
        } else {
          walk(v, `${path}/${k}`);
        }
      }
    }
  };
  walk(spec.paths, "paths");
  walk(spec.components, "components");
  assert.deepEqual(dangling, [], `dangling $refs:\n${dangling.join("\n")}`);
});

test("every operation declares responses, and path params are declared", () => {
  const problems: string[] = [];
  for (const [p, item] of Object.entries(spec.paths ?? {})) {
    const templated = [...p.matchAll(/{([^}]+)}/g)].map((m) => m[1]);
    const itemParams = (item.parameters as unknown[] | undefined) ?? [];
    for (const method of HTTP_METHODS) {
      const op = item[method] as Record<string, unknown> | undefined;
      if (!op) continue;
      const responses = op.responses as Record<string, unknown> | undefined;
      if (!responses || Object.keys(responses).length === 0) {
        problems.push(`no responses: ${method.toUpperCase()} ${p}`);
      }
      const opParams = (op.parameters as unknown[] | undefined) ?? [];
      const declared = new Set<string>();
      for (const raw of [...itemParams, ...opParams]) {
        // Params may be inline OR a $ref to components/parameters (e.g. the
        // shared PipelineRef). Resolve the ref so its `name` counts.
        const ref = (raw as { $ref?: string }).$ref;
        const pr = (ref ? resolveRef(ref) : raw) as
          | { in?: string; name?: string }
          | undefined;
        if (pr?.in === "path" && pr.name) declared.add(pr.name);
      }
      for (const t of templated) {
        if (!declared.has(t)) {
          problems.push(`path param {${t}} undeclared: ${method.toUpperCase()} ${p}`);
        }
      }
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("operationIds (where present) are unique", () => {
  const seen = new Map<string, string>();
  const dupes: string[] = [];
  for (const [p, item] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = item[method] as { operationId?: string } | undefined;
      const id = op?.operationId;
      if (!id) continue;
      const where = `${method.toUpperCase()} ${p}`;
      if (seen.has(id)) dupes.push(`${id}: ${seen.get(id)} & ${where}`);
      else seen.set(id, where);
    }
  }
  assert.deepEqual(dupes, [], `duplicate operationIds:\n${dupes.join("\n")}`);
});

// ---------------------------------------------------------------------------
// Drift: routes ⇄ documented paths (method + path SHAPE).
// ---------------------------------------------------------------------------

/** Scan apps/api/src for `api.route("METHOD", "/path", …)` registrations. */
function collectRoutes(): Set<string> {
  const out = new Set<string>();
  const routeRe = /\.route\(\s*["'`]([A-Z]+)["'`]\s*,\s*["'`]([^"'`]+)["'`]/g;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        const src = readFileSync(full, "utf8");
        let m: RegExpExecArray | null;
        while ((m = routeRe.exec(src))) {
          const routePath = m[2].replace(/:([A-Za-z0-9_]+)/g, "{$1}");
          out.add(`${m[1]} ${shape(routePath)}`);
        }
      }
    }
  };
  walk(ROUTES_DIR);
  return out;
}

function collectDocumented(): Set<string> {
  const out = new Set<string>();
  for (const [p, item] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      if (item[method]) out.add(`${method.toUpperCase()} ${shape(p)}`);
    }
  }
  return out;
}

const ROUTES = collectRoutes();
const DOCUMENTED = collectDocumented();

test("every api.route is documented in openapi.yaml", () => {
  const undocumented = [...ROUTES].filter((r) => !DOCUMENTED.has(r)).sort();
  assert.deepEqual(
    undocumented,
    [],
    `routes missing from openapi.yaml (add a path entry):\n${undocumented.join("\n")}`
  );
});

test("every documented path maps to a real route (no stale docs)", () => {
  const stale = [...DOCUMENTED]
    .filter((d) => !ROUTES.has(d) && !NON_ROUTER_ENDPOINTS.has(d))
    .sort();
  assert.deepEqual(
    stale,
    [],
    `documented endpoints with no matching route (remove or fix):\n${stale.join("\n")}`
  );
});

test("route scan found a plausible number of routes (guard against a broken scan)", () => {
  // If the regex/dir ever breaks, the drift tests would pass vacuously. Anchor
  // a floor so a scan that suddenly finds ~nothing fails loudly instead.
  assert.ok(ROUTES.size >= 100, `only ${ROUTES.size} routes scanned — scan likely broken`);
});
