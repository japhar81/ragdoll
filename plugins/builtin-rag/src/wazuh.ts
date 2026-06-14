/**
 * Wazuh — connection driver (ADR-0024) + host/agent layer pull plugins.
 *
 * Wazuh is a record-source we pull from on a cadence (the opposite shape
 * of Cartography, which is a batch orchestrator) — exactly what the
 * connection-driver + binding + delta-filter machinery exists for. We
 * ship:
 *
 *   - `wazuh` connection driver (this file). Owns the Wazuh server-API
 *     base URL, the JWT lifecycle (obtain on first use, refresh on
 *     401 / expiry), and the optional TLS-verify toggle for self-signed
 *     test instances. Cached per `connection.id` like every other
 *     driver. Surfaced in the Builder's Type dropdown via ADR-0024.
 *
 *   - `wazuh_agents_pull` (this file). Pulls the agent registry off
 *     `GET /agents`. Supports `select` / `q` / pagination so a
 *     bulwark-shaped pipeline can fetch just the dimensions it needs.
 *
 *   - `wazuh_syscollector_pull` (this file). Per-agent enrichment off
 *     `GET /syscollector/<agentId>/{hardware|os|netiface|netaddr}`.
 *     Tolerates empty / missing per-agent inventory: a 404 / empty
 *     `affected_items` for an agent doesn't fail the batch — the row
 *     is skipped and surfaced in the node's `metadata.missingAgents`.
 *
 * What this module deliberately does NOT do:
 *
 *   - No transform/map of Wazuh shapes into observation shapes.
 *     That's bulwark's pipeline-config concern.
 *   - No findings / vulns / packages / logs / compliance / processes
 *     pulls. Host/agent layer ONLY in this pass (the OCSF-findings
 *     pass is deferred).
 *   - No delta-filter, no neo4j_write, no transform plugin. Those
 *     already exist (Cartography pass) and bulwark composes them.
 *
 * Wazuh API facts the implementation depends on:
 *   - `POST /security/user/authenticate` (basic creds → bearer token,
 *     TTL ~15 min). Refresh on 401.
 *   - `GET /agents` returns `{data:{affected_items: [...], total_affected_items}}`.
 *     `select`, `offset`, `limit`, `sort`, `q` are supported query params.
 *   - `GET /syscollector/{agent_id}/{table}` returns the same envelope.
 *     `affected_items` is `[]` (or 404) when the agent DB isn't filled
 *     out yet — the registry POST/probe path may still report the agent.
 *
 * Test-only override seams kept tiny: `__setWazuhFetchForTests` replaces
 * the fetch function, mirroring `__setCartographySpawnerForTests`.
 */

import type {
  InProcessPlugin,
  PluginExecutionInput,
  PluginManifest
} from "../../../packages/plugin-sdk/src/index.ts";
import {
  defineConnectionDriverPlugin,
  acquireClient
} from "../../../packages/external-connections/src/index.ts";
import type { ResolvedExternalConnection } from "../../../packages/external-connections/src/index.ts";

// ---------------------------------------------------------------------------
// Test seam — fetch override
// ---------------------------------------------------------------------------

/** Same fetch signature node's global uses; lets the driver-and-plugin
 *  tests intercept HTTP without spawning a real Wazuh. */
export type WazuhFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    // node-fetch / undici-style toggle for self-signed certs. Driver
    // sets this when verifyTls is false.
    rejectUnauthorized?: boolean;
  }
) => Promise<{
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

let activeFetch: WazuhFetch | null = null;

/** Test hook — swap the fetch implementation. Pass `null` to restore. */
export function __setWazuhFetchForTests(f: WazuhFetch | null): void {
  activeFetch = f;
}

/** The actual fetch we use at run-time. Falls back to the global node
 *  fetch; tests override via `__setWazuhFetchForTests`.
 *
 *  Self-signed Wazuh installs (the common dev case) require us to
 *  honour `verifyTls=false`. Node's fetch reads
 *  `NODE_TLS_REJECT_UNAUTHORIZED`, but that flips it process-wide and
 *  bleeds across other drivers. We use undici's `Agent` per-request via
 *  the `dispatcher` field — kept inside the driver and never exposed
 *  to callers.
 */
async function defaultFetch(
  url: string,
  init: Parameters<WazuhFetch>[1] = {}
): Promise<Awaited<ReturnType<WazuhFetch>>> {
  const opts: Record<string, unknown> = {
    method: init.method,
    headers: init.headers,
    body: init.body
  };
  if (init.rejectUnauthorized === false) {
    // undici Agent with tls.rejectUnauthorized=false isolates the
    // self-signed-cert allowance to THIS request. Imported lazily so
    // the import cost only lands when an operator opts in.
    const undici = (await import("undici")) as {
      Agent: new (opts: { connect: { rejectUnauthorized: boolean } }) => unknown;
    };
    const agent = new undici.Agent({ connect: { rejectUnauthorized: false } });
    (opts as { dispatcher?: unknown }).dispatcher = agent;
  }
  const res = await fetch(url, opts as Parameters<typeof fetch>[1]);
  return {
    status: res.status,
    ok: res.ok,
    json: () => res.json(),
    text: () => res.text()
  };
}

function getFetch(): WazuhFetch {
  return activeFetch ?? defaultFetch;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

interface WazuhConnectionOptions {
  /** Hostname or full base URL. We accept either; build the canonical
   *  URL inside `urlFor`. */
  baseUrl?: string;
  /** Server API port. Wazuh's default is 55000; some installs proxy. */
  port?: number;
  /** When false, accept self-signed TLS. Default true. */
  verifyTls?: boolean;
}

/** What `_parseWazuhSecret` returns — either a long-lived bearer token
 *  (operator-supplied) or username+password we use to call
 *  `/security/user/authenticate`. */
type WazuhCredentials =
  | { kind: "token"; token: string }
  | { kind: "basic"; username: string; password: string };

/**
 * Parse the resolved secret into either a static bearer or basic creds.
 * Accepts (in priority order):
 *   - JSON `{"token":"..."}` → kind=token
 *   - JSON `{"username":"...","password":"..."}` → kind=basic
 *   - `username:password` → kind=basic
 *   - any other non-empty string → kind=token (treats the raw value as
 *     a bearer; rare but supported for operator convenience)
 */
export function parseWazuhSecret(secret: string | undefined): WazuhCredentials {
  if (!secret) {
    throw new Error(
      "wazuh: connection has no secret — set secretRefKey on the connection to a managed secret holding either `{\"username\":\"...\",\"password\":\"...\"}` or `{\"token\":\"...\"}`"
    );
  }
  const trimmed = secret.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as {
        token?: string;
        username?: string;
        password?: string;
      };
      if (parsed.token) return { kind: "token", token: parsed.token };
      if (parsed.username && parsed.password) {
        return { kind: "basic", username: parsed.username, password: parsed.password };
      }
      throw new Error(
        "wazuh: JSON secret must contain either `token` OR both `username` and `password`"
      );
    } catch (e) {
      if (e instanceof SyntaxError) {
        // Fall through to user:pass parse below.
      } else {
        throw e;
      }
    }
  }
  if (trimmed.includes(":") && !trimmed.startsWith("http")) {
    const idx = trimmed.indexOf(":");
    return {
      kind: "basic",
      username: trimmed.slice(0, idx),
      password: trimmed.slice(idx + 1)
    };
  }
  // Last-resort: treat as raw token.
  return { kind: "token", token: trimmed };
}

/**
 * Build the canonical server-API base URL. The operator can supply:
 *   - a full URL ("https://wazuh.acme.com:55000") — used verbatim
 *   - a hostname ("wazuh.acme.com") — combined with `port` (default
 *     55000) under https
 * We always force https for production hygiene; an operator hitting
 * an http-only test rig can supply the full URL.
 */
export function buildWazuhBaseUrl(opts: WazuhConnectionOptions): string {
  const raw = (opts.baseUrl ?? "").trim();
  if (!raw) throw new Error("wazuh: connection options.baseUrl is required");
  const port = typeof opts.port === "number" && opts.port > 0 ? opts.port : 55000;
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    // Strip any trailing slash so urlFor can splice cleanly.
    return raw.replace(/\/+$/, "");
  }
  return `https://${raw}:${port}`;
}

export interface WazuhHandle {
  /** Canonical base URL — `https://host:port`, no trailing slash. */
  baseUrl: string;
  slug: string;
  /** Whether the server's certificate is verified. Surfaced in diagnostics. */
  verifyTls: boolean;
  /** Current bearer token. Set lazily by `ensureToken`; refreshed on 401. */
  token: string | null;
  /** Token expiry timestamp (epoch ms). Refresh proactively just before
   *  this fires so an in-flight request doesn't 401 mid-pull. */
  tokenExpiresAt: number | null;
  credentials: WazuhCredentials;
  /** Exposed for tests to read; production callers use `request()`. */
  authenticate: () => Promise<void>;
  request: <T = unknown>(path: string) => Promise<T>;
}

/** Default token lifetime when the server doesn't report `exp`. Wazuh
 *  defaults to 900s (15 min) — we refresh a minute early. */
const TOKEN_DEFAULT_TTL_MS = 14 * 60 * 1000;

interface AuthenticateResponse {
  data?: { token?: string };
}

async function authenticateOnce(handle: WazuhHandle): Promise<void> {
  const fetcher = getFetch();
  const url = `${handle.baseUrl}/security/user/authenticate`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (handle.credentials.kind === "basic") {
    const b64 = Buffer.from(
      `${handle.credentials.username}:${handle.credentials.password}`,
      "utf8"
    ).toString("base64");
    headers.authorization = `Basic ${b64}`;
  } else {
    // Static token — skip the authenticate hop entirely.
    handle.token = handle.credentials.token;
    handle.tokenExpiresAt = null; // operator owns rotation
    return;
  }
  const res = await fetcher(url, {
    method: "POST",
    headers,
    rejectUnauthorized: handle.verifyTls
  });
  if (!res.ok) {
    // Pull a short error body for the trace — never log creds.
    const body = await safeReadShortBody(res);
    throw new Error(
      `wazuh: authenticate ${res.status} on connection "${handle.slug}": ${body}`
    );
  }
  const json = (await res.json()) as AuthenticateResponse;
  const token = json.data?.token;
  if (!token) {
    throw new Error(
      `wazuh: authenticate succeeded but no token in response.data.token`
    );
  }
  handle.token = token;
  handle.tokenExpiresAt = Date.now() + TOKEN_DEFAULT_TTL_MS;
}

async function safeReadShortBody(res: {
  text: () => Promise<string>;
}): Promise<string> {
  try {
    const body = await res.text();
    return body.length > 256 ? body.slice(0, 256) + "…" : body;
  } catch {
    return "<unreadable>";
  }
}

async function ensureToken(handle: WazuhHandle): Promise<void> {
  const now = Date.now();
  if (
    handle.token &&
    (handle.tokenExpiresAt === null || handle.tokenExpiresAt > now)
  ) {
    return;
  }
  await handle.authenticate();
}

/**
 * Authenticated GET against the server API. Refreshes on 401 ONCE,
 * then re-tries (covers the "token expired while we held it" race).
 * Returns the parsed JSON body; throws on non-2xx (with a short
 * snippet of the body for the trace).
 */
async function authedRequest<T>(handle: WazuhHandle, path: string): Promise<T> {
  await ensureToken(handle);
  const fetcher = getFetch();
  const url = `${handle.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${handle.token}`
  };
  let res = await fetcher(url, {
    method: "GET",
    headers,
    rejectUnauthorized: handle.verifyTls
  });
  if (res.status === 401) {
    // Token expired between our local check and the server's check.
    // Re-authenticate ONCE and retry; if it 401s again, bubble up.
    handle.token = null;
    await handle.authenticate();
    headers.authorization = `Bearer ${handle.token}`;
    res = await fetcher(url, {
      method: "GET",
      headers,
      rejectUnauthorized: handle.verifyTls
    });
  }
  if (!res.ok) {
    const body = await safeReadShortBody(res);
    const err = new Error(
      `wazuh: GET ${path} -> ${res.status} on connection "${handle.slug}": ${body}`
    );
    (err as { status?: number }).status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

export const wazuhConnectionDriver = defineConnectionDriverPlugin<WazuhHandle>({
  kind: "wazuh",
  driver: {
    async create(conn) {
      const opts = (conn.options ?? {}) as WazuhConnectionOptions;
      const credentials = parseWazuhSecret(conn.secret);
      const baseUrl = buildWazuhBaseUrl(opts);
      const verifyTls = opts.verifyTls !== false; // default true
      const handle: WazuhHandle = {
        baseUrl,
        slug: conn.slug,
        verifyTls,
        token: null,
        tokenExpiresAt: null,
        credentials,
        // Bound back to the handle so the test harness can call
        // handle.authenticate() directly to exercise the JWT flow.
        authenticate: async () => {
          // Re-bind `handle` inside the closure so `this` isn't needed.
          await authenticateOnce(handle);
        },
        request: async <T,>(p: string) => authedRequest<T>(handle, p)
      };
      return handle;
    },
    async dispose(client) {
      // Drop the token — there's no server-side logout endpoint that
      // helps here (Wazuh tokens expire on their own); we just clear
      // local state so a stale token from a previous client never
      // shows up in a new request.
      client.token = null;
      client.tokenExpiresAt = null;
    },
    async probe(client) {
      // The cheapest call that exercises both auth + reachability:
      // /agents?limit=1. If basic-auth or TLS-verify is wrong it 401s
      // / TLS-errors; if the server is reachable but empty it still
      // returns `{data:{affected_items: [], total_affected_items: 0}}`.
      await client.request<{ data?: { affected_items?: unknown[] } }>(
        "/agents?limit=1"
      );
    }
  },
  manifest: {
    displayName: "Wazuh",
    description:
      "Wazuh server API (https://documentation.wazuh.com/current/_static/server-api-spec/). Used as a leaf record-source — bulwark composes pipelines around `wazuh_agents_pull` / `wazuh_syscollector_pull`. The driver owns JWT auth + refresh; the per-request `verifyTls` toggle lets a self-signed dev install through without flipping global Node TLS.",
    configSchema: {
      type: "object",
      required: ["baseUrl"],
      properties: {
        baseUrl: {
          type: "string",
          description:
            "Hostname or full server-API URL (e.g. `wazuh.acme.com` or `https://wazuh.acme.com:55000`). Hostnames get https:// + the configured port; full URLs are used verbatim."
        },
        port: {
          type: "integer",
          default: 55000,
          description:
            "Server API port. Default 55000 matches the upstream install — override only when running behind a proxy."
        },
        verifyTls: {
          type: "boolean",
          default: true,
          description:
            "When false, the driver accepts self-signed certificates (per-request, NOT process-wide). Default true — flip only for test installs."
        }
      },
      additionalProperties: false
    },
    secretSchema: {
      type: "string",
      description:
        "Either `{\"username\":\"...\",\"password\":\"...\"}` for the basic-auth + JWT flow (recommended), or `{\"token\":\"...\"}` for a long-lived operator-supplied bearer (the driver skips authenticate() entirely). Plain `user:pass` is also accepted."
    },
    // Wazuh is a tool source, not a dataset backend — operators bind
    // it via the new "wazuh" binding name on a Dataset, and the pull
    // plugins ask for `kind: wazuh` on that binding. Surface it in the
    // dataset binding picker.
    datasetBindings: ["wazuh"],
    transport: "in_process"
  }
});

// ---------------------------------------------------------------------------
// Shared binding helper (mirrors requireNeo4jConnection)
// ---------------------------------------------------------------------------

/** Resolve the named binding's connection. Same shape neo4j_query uses —
 *  throws an actionable error when the binding isn't wired or its kind
 *  isn't `wazuh`. */
export function requireWazuhConnection(
  input: PluginExecutionInput,
  binding: string,
  pluginId: string
): ResolvedExternalConnection {
  const b = input.dataset?.bindings?.[binding];
  if (!b?.connection) {
    const slug = input.dataset?.slug ?? "(no dataset bound)";
    throw new Error(
      `${pluginId} requires a "${binding}" binding on dataset "${slug}". Add a binding named "${binding}" on the Datasets screen pointing at a wazuh connection.`
    );
  }
  if (b.connection.kind !== "wazuh") {
    throw new Error(
      `${pluginId}: binding "${binding}" resolves to connection kind "${b.connection.kind}", expected "wazuh".`
    );
  }
  return b.connection;
}

// ---------------------------------------------------------------------------
// Wazuh-freshness provenance contract (Phase 5.2)
// ---------------------------------------------------------------------------
//
// Every wazuh pull stamps its metadata envelope with `pullId` + `pulledAt`
// — the wazuh-side analogue of the cartography crawl provenance contract
// (ADR-0030). Same shape, same requestId-as-id pattern: bulwark's
// transform stamps each emitted row with `inputs.metadata.pullId` /
// `inputs.metadata.pulledAt`, and bulwark's gated windowed close-by-
// absence pairs "agents/CVEs that didn't carry pullId N this run = absent
// since pullId N." A patched CVE missing from the next pull is the
// load-bearing signal for CVE close-by-absence.
//
// `pullId` derives from `RuntimeContext.requestId` — RAGdoll's per-
// pipeline-execution identifier, already on PluginExecutionInput.context.
// Falls back to a synthetic per-call id when the runtime context omits
// requestId (dev / harness only — production callers always have it).
//
// ADR-0031 documents the contract end-to-end; the wazuh-vuln pull was
// the trigger that established it, but every wazuh pull emits it so
// downstream bulwark transforms can use the SAME stamp shape regardless
// of which wazuh node produced the row.
interface WazuhProvenance {
  pullId: string;
  pulledAt: string;
}

function deriveWazuhProvenance(input: PluginExecutionInput): WazuhProvenance {
  const ctx = input.context as { requestId?: unknown } | undefined;
  const requestId = typeof ctx?.requestId === "string" ? ctx.requestId : "";
  return {
    // When requestId is absent (tests, dev runs without a real runtime
    // context), fall back to a synthetic id that's at least stable
    // within this invocation — downstream rows still all carry the
    // SAME pullId even though it won't correlate with a RAGdoll
    // execution row.
    pullId: requestId || `wazuh-pull-${Date.now()}`,
    pulledAt: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// wazuh_agents_pull — paginated registry read
// ---------------------------------------------------------------------------

interface AgentsResponse {
  data?: {
    affected_items?: Array<Record<string, unknown>>;
    total_affected_items?: number;
  };
  message?: string;
}

/** Default page size. Wazuh caps `limit` at 500 server-side; 500 is
 *  the sweet spot for fewest round-trips on a large fleet. */
const DEFAULT_LIMIT = 500;

/** Maximum pages we'll fetch in one execute() to prevent a runaway pull
 *  against a misconfigured `q` filter. Operator can lift via `maxPages`. */
const DEFAULT_MAX_PAGES = 200;

export const wazuhAgentsPullPlugin: InProcessPlugin = {
  manifest: {
    id: "wazuh_agents_pull",
    name: "Wazuh Agents Pull",
    version: "1.0.0",
    category: "datasource",
    contract: 2,
    // Cast through unknown — PluginManifest.requires still types the
    // legacy `{modality, provider}` shape even though the validator
    // already accepts the ADR-0023 `{binding, kind}` form. Same trick
    // every other binding-shaped plugin uses.
    requires: [{ binding: "wazuh", kind: "wazuh" }] as unknown as PluginManifest["requires"],
    description:
      "Pulls the Wazuh agent registry via `GET /agents`. Each page is at most 500 rows; the plugin walks pagination until exhausted (or `maxPages` is hit). Emits the raw agent rows as `agents` so downstream nodes can map fields independently — RAGdoll's responsibility ends at the row; the Wazuh→observation mapping is the pipeline author's.",
    configSchema: {
      type: "object",
      properties: {
        select: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of Wazuh agent fields to return (passed as `?select=` on the request). Reduces row size on a large fleet."
        },
        q: {
          type: "string",
          description:
            "Optional Wazuh filter expression (e.g. `status=active`, `dateAdd>2024-01-01`). Passed through verbatim — operator owns the syntax."
        },
        sort: {
          type: "string",
          description:
            "Optional sort spec (`+field` ascending, `-field` descending). Default: server default (typically by id)."
        },
        limit: {
          type: "integer",
          default: 500,
          description:
            "Page size. Wazuh caps at 500; values above that are clamped server-side."
        },
        maxPages: {
          type: "integer",
          default: 200,
          description:
            "Hard ceiling on pages walked in one execute() — runaway guard against a misconfigured `q`. Default 200 (= 100k agents). Lift only for genuine megafleets."
        }
      },
      additionalProperties: false
    },
    inputPorts: [],
    outputPorts: [
      {
        name: "agents",
        description:
          "Array of agent rows. Each row is whatever Wazuh's `/agents` endpoint returned for the configured `select` (e.g. id, name, ip, os, status, lastKeepAlive, dateAdd, node_name)."
      },
      {
        name: "metadata",
        description:
          "Diagnostic envelope: { pages, total, fetched, truncated }. `truncated:true` when we hit `maxPages` before draining."
      }
    ],
    capabilities: ["query"],
    ui: {
      icon: "shield",
      color: "#1f6feb",
      paletteGroup: "Sources",
      formHints: {
        select: { widget: "tags" },
        q: { widget: "text" },
        sort: { widget: "text" }
      }
    }
  },
  async execute(input) {
    const conn = requireWazuhConnection(input, "wazuh", "wazuh_agents_pull");
    const client = await acquireClient<WazuhHandle>(conn);
    const cfg = input.config as {
      select?: unknown;
      q?: unknown;
      sort?: unknown;
      limit?: unknown;
      maxPages?: unknown;
    };
    const limit = clampLimit(cfg.limit, DEFAULT_LIMIT);
    const maxPages = clampMaxPages(cfg.maxPages, DEFAULT_MAX_PAGES);
    const select = Array.isArray(cfg.select)
      ? (cfg.select as unknown[]).map((v) => String(v)).join(",")
      : undefined;
    const q = typeof cfg.q === "string" ? cfg.q : undefined;
    const sort = typeof cfg.sort === "string" ? cfg.sort : undefined;

    const agents: Array<Record<string, unknown>> = [];
    let pages = 0;
    let offset = 0;
    let total = 0;
    let truncated = false;

    while (pages < maxPages) {
      const params = new URLSearchParams();
      params.set("offset", String(offset));
      params.set("limit", String(limit));
      if (select) params.set("select", select);
      if (q) params.set("q", q);
      if (sort) params.set("sort", sort);
      const path = `/agents?${params.toString()}`;
      const json = await client.request<AgentsResponse>(path);
      pages += 1;
      const items = json.data?.affected_items ?? [];
      total = json.data?.total_affected_items ?? total;
      for (const row of items) agents.push(row);
      offset += items.length;
      // Stop conditions: server gave us fewer than we asked for, OR we've
      // drained the reported total. Either signals end-of-stream.
      if (items.length < limit) break;
      if (total > 0 && agents.length >= total) break;
    }
    if (pages >= maxPages && total > agents.length) truncated = true;

    const prov = deriveWazuhProvenance(input);
    return {
      outputs: {
        agents,
        metadata: {
          // Phase 5.2 wazuh-freshness provenance — same shape every
          // wazuh pull emits so bulwark's transform stamps each row
          // via `$$.metadata.pullId` / `$$.metadata.pulledAt`.
          pullId: prov.pullId,
          pulledAt: prov.pulledAt,
          pages,
          total,
          fetched: agents.length,
          truncated
        }
      }
    };
  }
};

// ---------------------------------------------------------------------------
// wazuh_syscollector_pull — per-agent enrichment
// ---------------------------------------------------------------------------

/** Inventory items we know how to pull. Keep small — host/agent layer
 *  only this pass. Packages / processes / etc. land in the OCSF pass. */
const SYSCOLLECTOR_ITEMS = ["hardware", "os", "netiface", "netaddr"] as const;
type SyscollectorItem = (typeof SYSCOLLECTOR_ITEMS)[number];

interface SyscollectorResponse {
  data?: {
    affected_items?: Array<Record<string, unknown>>;
  };
  // Wazuh returns a 1760 "agent_id_not_found" via `error` on the envelope
  // for some installs; we treat that as "no inventory for this agent."
  error?: number;
  message?: string;
}

interface EnrichmentRow {
  agentId: string;
  /** Map of item → its `affected_items` (usually 0 or 1 entries). */
  inventory: Partial<Record<SyscollectorItem, Array<Record<string, unknown>>>>;
  /** When the server returned `scan_time` for any item, the latest one
   *  surfaces here as the delta watermark for downstream filters. */
  scanTime?: string;
}

function pickScanTime(
  inventory: EnrichmentRow["inventory"]
): string | undefined {
  let latest: string | undefined;
  for (const items of Object.values(inventory)) {
    for (const row of items ?? []) {
      const s = (row as { scan_time?: unknown }).scan_time;
      if (typeof s === "string" && (!latest || s > latest)) latest = s;
    }
  }
  return latest;
}

export const wazuhSyscollectorPullPlugin: InProcessPlugin = {
  manifest: {
    id: "wazuh_syscollector_pull",
    name: "Wazuh Syscollector Pull",
    version: "1.0.0",
    category: "datasource",
    contract: 2,
    requires: [{ binding: "wazuh", kind: "wazuh" }] as unknown as PluginManifest["requires"],
    description:
      "For each agent id in `inputs.agentIds`, fetches the per-agent inventory items configured under `items` (host/agent layer: hardware / os / netiface / netaddr). Tolerates an empty / missing inventory per agent — skip-and-continue, with the gap surfaced in `metadata.missingAgents`. Carries `scan_time` from the inventory rows so downstream delta filters have a watermark.",
    configSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          default: ["hardware", "os", "netiface", "netaddr"],
          items: { type: "string", enum: [...SYSCOLLECTOR_ITEMS] },
          description:
            "Which inventory items to pull per agent. Host/agent layer only — packages / processes / etc. land in the OCSF pass."
        },
        agentIdField: {
          type: "string",
          default: "id",
          description:
            "When `inputs.agents` is supplied (the natural chain from wazuh_agents_pull), pull each agent's id from this field. Defaults to `id` (matches Wazuh's `/agents` response shape)."
        },
        maxAgents: {
          type: "integer",
          default: 10000,
          description:
            "Hard ceiling on agents enriched in one execute(). Guard against a runaway upstream — operator can lift for megafleets."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      {
        name: "agentIds",
        description:
          "Array of agent id strings. Optional — when omitted, the plugin reads `inputs.agents` and pulls ids from `config.agentIdField` (defaults to chain directly off wazuh_agents_pull)."
      },
      {
        name: "agents",
        description:
          "Optional fallback when agentIds isn't piped: array of agent rows. The plugin reads each row's `config.agentIdField` field for the id."
      }
    ],
    outputPorts: [
      {
        name: "enrichment",
        description:
          "Array of `{ agentId, inventory: {hardware,os,netiface,netaddr?}, scanTime? }` rows. Agents whose inventory was empty / missing entirely DO NOT appear here — they're surfaced in `metadata.missingAgents` instead."
      },
      {
        name: "metadata",
        description:
          "Diagnostic envelope: { fetched, missingAgents: string[], items, perItemErrors }. perItemErrors carries non-fatal per-(agent,item) failures (e.g. one item 404s while others succeed)."
      }
    ],
    capabilities: ["query"],
    ui: {
      icon: "info",
      color: "#1f6feb",
      paletteGroup: "Sources",
      formHints: {
        items: { widget: "tags" }
      }
    }
  },
  async execute(input) {
    const conn = requireWazuhConnection(
      input,
      "wazuh",
      "wazuh_syscollector_pull"
    );
    const client = await acquireClient<WazuhHandle>(conn);
    const cfg = input.config as {
      items?: unknown;
      agentIdField?: unknown;
      maxAgents?: unknown;
    };
    const items: SyscollectorItem[] = Array.isArray(cfg.items)
      ? (cfg.items as unknown[]).flatMap((v) =>
          (SYSCOLLECTOR_ITEMS as readonly string[]).includes(String(v))
            ? [String(v) as SyscollectorItem]
            : []
        )
      : [...SYSCOLLECTOR_ITEMS];
    if (items.length === 0) {
      throw new Error(
        "wazuh_syscollector_pull: at least one inventory item must be configured (hardware / os / netiface / netaddr)"
      );
    }
    const idField =
      typeof cfg.agentIdField === "string" ? cfg.agentIdField : "id";
    const maxAgents =
      typeof cfg.maxAgents === "number" && cfg.maxAgents > 0
        ? Math.floor(cfg.maxAgents)
        : 10_000;

    const prov = deriveWazuhProvenance(input);
    const agentIds = pickAgentIds(input.inputs, idField);
    if (agentIds.length === 0) {
      return {
        outputs: {
          enrichment: [],
          metadata: {
            pullId: prov.pullId,
            pulledAt: prov.pulledAt,
            fetched: 0,
            missingAgents: [],
            items,
            perItemErrors: []
          }
        }
      };
    }
    const trimmed = agentIds.slice(0, maxAgents);

    const enrichment: EnrichmentRow[] = [];
    const missingAgents: string[] = [];
    const perItemErrors: Array<{
      agentId: string;
      item: SyscollectorItem;
      status?: number;
      message: string;
    }> = [];

    for (const agentId of trimmed) {
      const inventory: EnrichmentRow["inventory"] = {};
      let anyData = false;
      for (const item of items) {
        try {
          const path = `/syscollector/${encodeURIComponent(agentId)}/${item}`;
          const json = await client.request<SyscollectorResponse>(path);
          const rows = json.data?.affected_items ?? [];
          if (rows.length > 0) {
            inventory[item] = rows;
            anyData = true;
          }
        } catch (e) {
          const err = e as { status?: number; message?: string };
          // 404 = agent has no entries for this item. That's the
          // "empty inventory" scenario the scope brief explicitly
          // calls out — skip-and-continue, surface the gap.
          if (err.status === 404) {
            continue;
          }
          perItemErrors.push({
            agentId,
            item,
            status: err.status,
            message: err.message ?? String(e)
          });
        }
      }
      if (anyData) {
        const scanTime = pickScanTime(inventory);
        enrichment.push({
          agentId,
          inventory,
          ...(scanTime ? { scanTime } : {})
        });
      } else {
        missingAgents.push(agentId);
      }
    }

    return {
      outputs: {
        enrichment,
        metadata: {
          // Phase 5.2 wazuh-freshness provenance — see deriveWazuhProvenance.
          pullId: prov.pullId,
          pulledAt: prov.pulledAt,
          fetched: enrichment.length,
          missingAgents,
          items,
          perItemErrors,
          // When the upstream provided more ids than we'd enrich, flag
          // it so the trace UI surfaces "we capped at maxAgents."
          truncated: agentIds.length > trimmed.length
        }
      }
    };
  }
};

// ---------------------------------------------------------------------------
// wazuh_vulns_pull — per-agent CVE findings (the deferred OCSF pull)
// ---------------------------------------------------------------------------
//
// Pulls per-agent CVE findings as evidence. Pure pull — no transform
// into observation/CWE/ATT&CK shape; bulwark owns the mapping from
// raw Wazuh vuln rows to its observation schema.
//
// Wazuh exposes vulnerabilities on TWO different surfaces depending
// on the deployed version, and they're NOT interchangeable:
//
//   4.x server API:  `GET /vulnerability/{agent_id}` — same JWT-
//                    auth, same `data.affected_items` envelope as the
//                    syscollector endpoints. This is what the wazuh
//                    driver already speaks.
//   4.8+ indexer:    Vulnerabilities moved out of the server API
//                    into the Wazuh indexer (Open/Elastic search) —
//                    queried via `POST /wazuh-states-vulnerabilities-
//                    <node>/_search` with a JSON DSL body. Different
//                    auth surface, different envelope, different host
//                    (the indexer port, not 55000).
//
// Operators pick which surface to hit via `config.apiVariant`. Default
// is `server-api` (the 4.x flow already wired through the driver). The
// `indexer` variant uses the same JWT bearer if the indexer accepts it
// (default Wazuh deploys share the cert chain); operators on a split
// install can override the indexer host via `config.indexerBaseUrl`.
//
// We DELIBERATELY don't auto-detect the variant — auto-detection would
// burn a probe call per pull and could pick the wrong surface during a
// rolling upgrade. The operator who knows their cluster picks once at
// pipeline-config time.

type WazuhVulnApiVariant = "server-api" | "indexer";

interface VulnerabilityResponse {
  data?: {
    affected_items?: Array<Record<string, unknown>>;
    total_affected_items?: number;
  };
  error?: number;
}

interface IndexerHit {
  _source?: Record<string, unknown>;
  _index?: string;
  _id?: string;
}

interface IndexerSearchResponse {
  hits?: {
    hits?: IndexerHit[];
    total?: { value?: number } | number;
  };
}

interface AgentVulnRow {
  agentId: string;
  vulns: Array<Record<string, unknown>>;
  /** This agent's set hit the indexer result window (>10k CVEs) — INCOMPLETE.
   *  bulwark floor-labels it and never absence-sweeps it. The common case is
   *  `false` (pagination drained the whole set). */
  truncated?: boolean;
}

export const wazuhVulnsPullPlugin: InProcessPlugin = {
  manifest: {
    id: "wazuh_vulns_pull",
    name: "Wazuh Vulnerabilities Pull",
    version: "1.0.0",
    category: "datasource",
    contract: 2,
    requires: [{ binding: "wazuh", kind: "wazuh" }] as unknown as PluginManifest["requires"],
    description:
      "Per-agent CVE findings. Operator picks the Wazuh API surface via `config.apiVariant`: `server-api` (4.x — `GET /vulnerability/{agent_id}`, JWT-authed through the existing driver) or `indexer` (4.8+ — `POST /<indexPattern>/_search` against the OpenSearch indexer on `:9200`, **HTTP Basic** auth from the same connection secret; NOT the server-API JWT). The two surfaces require different auth and usually run on different hosts/ports — when the indexer is split from the server API, supply its URL via `config.indexerBaseUrl` (e.g. `https://wazuh-indexer.acme.com:9200`). Emits raw CVE rows keyed by agent — NO transform into observation / CWE / ATT&CK shape; bulwark maps the rows. Tolerates empty/missing per-agent inventory like wazuh_syscollector_pull: 404 / empty hits → agent lands in `metadata.missingAgents`, batch keeps going. Stamps `metadata.pullId` + `metadata.pulledAt` (Phase 5.2 wazuh-freshness provenance — ADR-0031) so bulwark's windowed close-by-absence can compute 'patched CVE absent from this pull' against the prior pull's stamp.",
    configSchema: {
      type: "object",
      properties: {
        apiVariant: {
          type: "string",
          enum: ["server-api", "indexer"],
          default: "server-api",
          description:
            "Which Wazuh surface to query. `server-api`: 4.x's GET /vulnerability/{agent_id}. `indexer`: 4.8+'s indexer search (wazuh-states-vulnerabilities-*). Pick once at pipeline-config time — auto-detect would burn a probe call per pull AND could pick the wrong surface during a rolling upgrade."
        },
        indexerBaseUrl: {
          type: "string",
          description:
            "URL of the Wazuh indexer (OpenSearch) for the `apiVariant=indexer` path. Accepts a full URL like `https://wazuh-indexer.acme.com:9200` or a bare hostname (defaults to `https://<host>:9200`). The indexer almost always runs on a different port (9200) than the server API (55000), and often a different host — this knob exists because the proven topology is split. When unset, the plugin falls back to the connection's `baseUrl`, which is only correct in the rare same-host-same-port case."
        },
        indexerIndexPattern: {
          type: "string",
          default: "wazuh-states-vulnerabilities-*",
          description:
            "Indexer index/alias pattern to search. Wazuh's default is `wazuh-states-vulnerabilities-<node>` per cluster node — the wildcard covers a multi-node install."
        },
        agentIdField: {
          type: "string",
          default: "id",
          description:
            "When `inputs.agents` is supplied (the natural chain from wazuh_agents_pull), pull each agent's id from this field."
        },
        maxAgents: {
          type: "integer",
          default: 10000,
          description:
            "Hard ceiling on agents per execute(). Guard against a runaway upstream — operator can lift for megafleets."
        },
        limitPerAgent: {
          type: "integer",
          default: 500,
          description:
            "Page size for the server-api variant (`?limit=`). The indexer variant uses this as its `size` parameter. Wazuh's server-side caps at 500."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      {
        name: "agentIds",
        description:
          "Array of agent id strings. Optional — when omitted, the plugin reads `inputs.agents` and pulls ids from `config.agentIdField` (defaults to chain directly off wazuh_agents_pull)."
      },
      {
        name: "agents",
        description:
          "Optional fallback when agentIds isn't piped: array of agent rows. The plugin reads each row's `config.agentIdField` field for the id."
      }
    ],
    outputPorts: [
      {
        name: "vulns",
        description:
          "Array of `{ agentId, vulns: [<raw Wazuh CVE row>, ...] }` entries. Agents whose vuln inventory is empty / missing entirely DO NOT appear here — they're in `metadata.missingAgents` instead. Raw row shape mirrors Wazuh's `data.affected_items` envelope (server-api) or `_source` hits (indexer) verbatim — bulwark normalises."
      },
      {
        name: "metadata",
        description:
          "Diagnostic envelope: { pullId, pulledAt, apiVariant, fetched, missingAgents, perAgentErrors, totalVulns }. `pullId` + `pulledAt` are the Phase 5.2 wazuh-freshness provenance contract — bulwark stamps each emitted row via `$$.metadata.pullId` / `$$.metadata.pulledAt`."
      }
    ],
    capabilities: ["query"],
    ui: {
      icon: "shield-alert",
      color: "#dc2626",
      paletteGroup: "Sources",
      formHints: {
        apiVariant: { widget: "select" }
      }
    }
  },
  async execute(input) {
    const conn = requireWazuhConnection(input, "wazuh", "wazuh_vulns_pull");
    const client = await acquireClient<WazuhHandle>(conn);
    const cfg = input.config as {
      apiVariant?: unknown;
      indexerBaseUrl?: unknown;
      indexerIndexPattern?: unknown;
      agentIdField?: unknown;
      maxAgents?: unknown;
      limitPerAgent?: unknown;
    };
    const apiVariant: WazuhVulnApiVariant =
      cfg.apiVariant === "indexer" ? "indexer" : "server-api";
    const idField =
      typeof cfg.agentIdField === "string" ? cfg.agentIdField : "id";
    const maxAgents =
      typeof cfg.maxAgents === "number" && cfg.maxAgents > 0
        ? Math.floor(cfg.maxAgents)
        : 10_000;
    const limitPerAgent = clampLimit(cfg.limitPerAgent, 500);
    const indexerIndexPattern =
      typeof cfg.indexerIndexPattern === "string" && cfg.indexerIndexPattern
        ? cfg.indexerIndexPattern
        : "wazuh-states-vulnerabilities-*";
    // Resolved lazily — only used on the indexer path, but computing
    // once outside the per-agent loop keeps the call site clean.
    const indexerBaseUrl =
      apiVariant === "indexer"
        ? resolveIndexerBaseUrl(cfg.indexerBaseUrl, client)
        : "";

    const prov = deriveWazuhProvenance(input);
    const agentIds = pickAgentIds(input.inputs, idField);
    if (agentIds.length === 0) {
      return {
        outputs: {
          vulns: [],
          metadata: {
            pullId: prov.pullId,
            pulledAt: prov.pulledAt,
            apiVariant,
            fetched: 0,
            totalVulns: 0,
            missingAgents: [],
            perAgentErrors: []
          }
        }
      };
    }
    const trimmed = agentIds.slice(0, maxAgents);

    const vulns: AgentVulnRow[] = [];
    const missingAgents: string[] = [];
    const perAgentErrors: Array<{
      agentId: string;
      status?: number;
      message: string;
    }> = [];

    for (const agentId of trimmed) {
      try {
        // Indexer paginates the FULL per-agent set (truncated only past the 10k
        // window). Server-api returns one clamped page → never truncated here.
        const res =
          apiVariant === "indexer"
            ? await fetchAgentVulnsViaIndexer(
                client,
                agentId,
                indexerBaseUrl,
                indexerIndexPattern,
                limitPerAgent
              )
            : { rows: await fetchAgentVulnsViaServerApi(client, agentId, limitPerAgent), truncated: false };
        if (res.rows.length > 0) {
          vulns.push({ agentId, vulns: res.rows, truncated: res.truncated });
        } else {
          missingAgents.push(agentId);
        }
      } catch (e) {
        const err = e as { status?: number; message?: string };
        if (err.status === 404) {
          // 404 = no entry for this agent (e.g. 4.x agent doesn't
          // have the vulnerability detector enabled). Mirror the
          // syscollector empty-tolerance: surface in missingAgents
          // and keep going.
          missingAgents.push(agentId);
          continue;
        }
        perAgentErrors.push({
          agentId,
          status: err.status,
          message: err.message ?? String(e)
        });
      }
    }

    const totalVulns = vulns.reduce((acc, row) => acc + row.vulns.length, 0);

    return {
      outputs: {
        vulns,
        metadata: {
          pullId: prov.pullId,
          pulledAt: prov.pulledAt,
          apiVariant,
          fetched: vulns.length,
          totalVulns,
          missingAgents,
          perAgentErrors,
          truncated: agentIds.length > trimmed.length
        }
      }
    };
  }
};

/**
 * Walk the 4.x server-API pagination contract for a single agent's
 * vuln inventory. Mirrors the same envelope syscollector uses.
 */
async function fetchAgentVulnsViaServerApi(
  client: WazuhHandle,
  agentId: string,
  limit: number
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let offset = 0;
  // Cap total pages per agent — defensive against a runaway server
  // returning oddly-shaped continuation. 100 pages × 500 limit = 50k
  // CVEs per agent, far above any real fleet.
  for (let page = 0; page < 100; page++) {
    const params = new URLSearchParams();
    params.set("offset", String(offset));
    params.set("limit", String(limit));
    const path = `/vulnerability/${encodeURIComponent(agentId)}?${params.toString()}`;
    const json = await client.request<VulnerabilityResponse>(path);
    const items = json.data?.affected_items ?? [];
    for (const row of items) out.push(row);
    offset += items.length;
    if (items.length < limit) break;
    if (
      typeof json.data?.total_affected_items === "number" &&
      out.length >= json.data.total_affected_items
    ) {
      break;
    }
  }
  return out;
}

/**
 * Query the 4.8+ Wazuh indexer (OpenSearch) for a single agent's
 * vulnerabilities. The indexer surface is intentionally NOT routed
 * through `authedRequest` / `ensureToken` — the server-API JWT does
 * NOT work against the indexer.
 *
 * Contract proved against the live indexer (bulwark direct-pull,
 * 1917 CVEs, per-agent counts ~36-1632 of the proven magnitude):
 *
 *   - **Endpoint:** OpenSearch on `:9200` (NOT the server API on
 *     `:55000`). When the indexer is co-located, the URL is the
 *     same host with a different port; when split, the operator
 *     supplies `config.indexerBaseUrl`.
 *   - **Auth:** HTTP Basic with the connection's parsed
 *     `{username, password}` on EVERY request. `POST
 *     /security/user/authenticate` returns 400 on the indexer
 *     (server-API endpoint doesn't exist there) — using the
 *     JWT bearer that flow returns is exactly the bug this
 *     function used to ship with.
 *   - **Request:** `POST /<indexPattern>/_search` with a JSON DSL
 *     body. GET-with-`q=` is unreliable on the wildcarded index
 *     pattern (Lucene parser interprets the colon in the field
 *     name unevenly across OpenSearch versions) — POST + `term`
 *     filter is the unambiguous wire contract bulwark uses.
 *
 * `_source` of each hit is the CVE row Wazuh wrote to the indexer
 * verbatim (id, severity, package, condition, detected_at, etc.).
 * Surface it as-is so bulwark's normaliser doesn't have to thread
 * through index metadata.
 */
/** OpenSearch `from + size` is bounded by `index.max_result_window` (default
 *  10000). Page through the full per-agent set up to that ceiling — pagination is
 *  the DEFAULT so a heavy host (1600+ CVEs) is captured WHOLE, not clipped at one
 *  page. `truncated` is the edge case: a host with MORE than the ceiling. The
 *  caller threads `truncated` so bulwark never absence-sweeps an incomplete set. */
const INDEXER_RESULT_WINDOW = 10000;

async function fetchAgentVulnsViaIndexer(
  handle: WazuhHandle,
  agentId: string,
  indexerBaseUrl: string,
  indexPattern: string,
  pageSize: number
): Promise<{ rows: Array<Record<string, unknown>>; total: number; truncated: boolean }> {
  const page = Math.min(Math.max(pageSize, 1), 1000);
  const rows: Array<Record<string, unknown>> = [];
  let from = 0;
  let total = 0;
  for (;;) {
    const size = Math.min(page, INDEXER_RESULT_WINDOW - from);
    if (size <= 0) break;
    const json = await indexerSearch<IndexerSearchResponse>(handle, indexerBaseUrl, indexPattern, {
      from,
      size,
      // Deterministic page order so `from`-paging doesn't skip/dup across requests.
      sort: [{ _doc: "asc" }],
      query: { term: { "agent.id": agentId } }
    });
    const hits = json.hits?.hits ?? [];
    total = typeof json.hits?.total === "number" ? json.hits.total : json.hits?.total?.value ?? total;
    for (const h of hits) if (h._source) rows.push(h._source);
    from += hits.length;
    if (hits.length < size) break; // drained the matching set
    if (from >= INDEXER_RESULT_WINDOW) break; // hit the from+size ceiling
  }
  // Truncated only when the host genuinely has MORE than we could page (the rare
  // edge case) — NOT the default. bulwark floor-labels + never absence-sweeps it.
  return { rows, total, truncated: total > rows.length };
}

/**
 * POST a search body against the Wazuh indexer (OpenSearch). Scoped
 * to the indexer variant — see `fetchAgentVulnsViaIndexer` for the
 * proven-contract docblock. Returns the parsed JSON body; throws on
 * non-2xx with a short snippet for the trace (creds never logged).
 *
 * Lives outside the driver's `request()` because the driver's GET-
 * only path is correct for the server API and we deliberately don't
 * widen its surface for one variant. The indexer's auth shape is
 * different (Basic per-request, NOT the server-API JWT) so keeping
 * the two paths separate also keeps the contracts honest.
 */
async function indexerSearch<T>(
  handle: WazuhHandle,
  indexerBaseUrl: string,
  indexPattern: string,
  body: Record<string, unknown>
): Promise<T> {
  if (handle.credentials.kind !== "basic") {
    // The indexer needs Basic — a `{token:"..."}` secret was set up
    // for the server-API surface and is meaningless here. Refuse
    // loudly rather than ship 401s that look like an auth flake.
    throw new Error(
      `wazuh: indexer variant requires HTTP Basic credentials on the connection "${handle.slug}" — got a static-token secret. Set the secret to \`{"username":"...","password":"..."}\` (the Wazuh indexer / OpenSearch does NOT honor the server-API JWT).`
    );
  }
  const fetcher = getFetch();
  const b64 = Buffer.from(
    `${handle.credentials.username}:${handle.credentials.password}`,
    "utf8"
  ).toString("base64");
  const url = `${indexerBaseUrl}/${encodeURIComponent(indexPattern)}/_search`;
  const res = await fetcher(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Basic ${b64}`
    },
    body: JSON.stringify(body),
    rejectUnauthorized: handle.verifyTls
  });
  if (!res.ok) {
    const snippet = await safeReadShortBody(res);
    const err = new Error(
      `wazuh: indexer POST ${url} -> ${res.status} on connection "${handle.slug}": ${snippet}`
    );
    (err as { status?: number }).status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

/**
 * Resolve the indexer base URL. When `config.indexerBaseUrl` is set,
 * accept either a full `https://host:9200` URL or a bare hostname
 * (defaults to `https://<host>:9200`). When unset, fall back to the
 * driver's `baseUrl` (only correct for the rare case where the
 * indexer is co-located on the same host AND port as the server
 * API; the common topology is split — see the ADR-0031 indexer
 * amendment).
 */
function resolveIndexerBaseUrl(
  raw: unknown,
  handle: WazuhHandle
): string {
  if (typeof raw === "string" && raw.trim()) {
    const v = raw.trim();
    if (v.startsWith("http://") || v.startsWith("https://")) {
      return v.replace(/\/+$/, "");
    }
    return `https://${v}:9200`;
  }
  return handle.baseUrl;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampLimit(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? Math.floor(value) : fallback;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  // Wazuh caps server-side at 500 anyway; we mirror it so a misconfig
  // doesn't waste round-trips with a clamped response.
  return Math.min(n, 500);
}

function clampMaxPages(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? Math.floor(value) : fallback;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 10_000);
}

function pickAgentIds(
  inputs: Record<string, unknown>,
  idField: string
): string[] {
  const direct = inputs.agentIds;
  if (Array.isArray(direct)) {
    return direct
      .map((v) =>
        typeof v === "string"
          ? v
          : typeof v === "number"
            ? String(v)
            : null
      )
      .filter((v): v is string => typeof v === "string" && v.length > 0);
  }
  const agents = inputs.agents;
  if (Array.isArray(agents)) {
    return agents.flatMap((row) => {
      if (!row || typeof row !== "object") return [];
      const v = (row as Record<string, unknown>)[idField];
      if (typeof v === "string" && v.length > 0) return [v];
      if (typeof v === "number") return [String(v)];
      return [];
    });
  }
  return [];
}

/**
 * Index `inputs.agents` (the natural output of `wazuh_agents_pull`) by
 * agentId. Lets the ruleset pull read the `group` field straight from
 * the chain instead of refetching `/agents?agents_list=<id>` for the
 * memberships. Returns `{}` when no `agents` input is wired — the
 * caller falls back to the `/agents` lookup.
 */
function indexAgentRowsByIdField(
  inputs: Record<string, unknown>,
  idField: string
): Record<string, Record<string, unknown>> {
  const agents = inputs.agents;
  if (!Array.isArray(agents)) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const row of agents) {
    if (!row || typeof row !== "object") continue;
    const v = (row as Record<string, unknown>)[idField];
    const id =
      typeof v === "string" && v.length > 0
        ? v
        : typeof v === "number"
          ? String(v)
          : null;
    if (id) out[id] = row as Record<string, unknown>;
  }
  return out;
}

// ---------------------------------------------------------------------------
// wazuh_ruleset_pull
//
// Per-agent posture read for the Wazuh control. The deployed control
// is currently inferred from enrollment ("the agent exists, therefore
// covered") in bulwark's projection — that mints `Control.mode=block`
// and `Control.fidelity=authoritative` from zero evidence. This pull
// READS what the API exposes (rule groups + active-response posture +
// effective group config) so bulwark can mint mode + fidelity from
// configuration, not assumption. Detect-only reality (active-response
// disabled or empty commands) becomes visible.
//
// Wazuh server-API surface — NOT the indexer. JWT-authed through the
// existing driver via authedRequest(). Endpoints used (Wazuh 4.x
// server-API spec, also present on 4.8+ — only the vulnerability
// detector moved to the indexer on 4.8+; ruleset stayed):
//
//   - `GET /agents?agents_list=<id>` — agent record (group memberships
//     live on `data.affected_items[0].group: string[]`). Skipped when
//     the upstream `inputs.agents` row already carries `group`.
//   - `GET /groups/{group_id}/configuration` — agent.conf JSON for a
//     group. Deduped across agents that share a group.
//   - `GET /agents/{agent_id}/config/com/active-response` — live
//     active-response section delivered to that agent's wazuh-execd.
//     Requires the agent to be connected; if the agent is offline,
//     the manager returns a Wazuh error code (1707 / 1715) which we
//     surface as `activeResponse.readable=false` AND mark the row
//     `fidelity=partial`. We do NOT pretend a posture we couldn't read.
//   - `GET /rules?status=enabled&limit=500` — manager-wide rule list,
//     fetched ONCE per execute and aggregated into a coarse rule-group
//     summary in metadata (count + maxLevel per group).
//
// Pure pull — emits raw shapes verbatim. Bulwark maps `Control.mode`
// (block-capable when any non-disabled active-response command is
// present; detect-only otherwise) and `Control.fidelity` (authoritative
// when both group config + active-response read; partial when AR
// unreadable; unreadable agents go to `missingAgents`).
// ---------------------------------------------------------------------------

interface AgentRecordResponse {
  data?: {
    affected_items?: Array<{
      id?: string;
      group?: string[];
      [k: string]: unknown;
    }>;
  };
}

interface GroupConfigResponse {
  data?: {
    affected_items?: Array<Record<string, unknown>>;
  };
}

interface ActiveResponseConfigResponse {
  data?: {
    affected_items?: Array<{
      "active-response"?: Array<Record<string, unknown>>;
      [k: string]: unknown;
    }>;
  };
  error?: number;
  message?: string;
}

interface RulesResponse {
  data?: {
    affected_items?: Array<{
      id?: number;
      level?: number;
      groups?: string[];
      file?: string;
      [k: string]: unknown;
    }>;
    total_affected_items?: number;
  };
}

interface ActiveResponseCommand {
  command: string;
  disabled: boolean;
  level?: string;
  rulesId?: string;
  location?: string;
  timeout?: string;
  [k: string]: unknown;
}

interface ActiveResponsePosture {
  readable: boolean;
  enabledCount: number;
  disabledCount: number;
  commands: ActiveResponseCommand[];
  error?: string;
  errorStatus?: number;
}

interface GroupConfigRead {
  readable: boolean;
  config?: Record<string, unknown>;
  error?: string;
  errorStatus?: number;
}

interface RulesetRow {
  agentId: string;
  groups: string[];
  activeResponse: ActiveResponsePosture;
  groupConfigs: Record<string, GroupConfigRead>;
  // Honesty signal — bulwark decides the final Control.fidelity rating.
  // - authoritative: groups + active-response + all referenced group
  //   configs read successfully
  // - partial: groups read, but at least one of {active-response,
  //   group config} could NOT be read
  // Agents whose groups themselves couldn't be read go to
  // metadata.missingAgents — they do NOT appear here.
  fidelity: "authoritative" | "partial";
  // Where the posture data came from — `agent-config` when the live
  // per-agent active-response was readable (decisive); `group-config`
  // when only the group-level config was readable; `mixed` when both.
  configSource: "agent-config" | "group-config" | "mixed";
}

interface RulesetGroupSummary {
  group: string;
  count: number;
  maxLevel: number;
}

interface RulesetSummary {
  readable: boolean;
  totalRules: number;
  groups: RulesetGroupSummary[];
  error?: string;
  truncated?: boolean;
}

export const wazuhRulesetPullPlugin: InProcessPlugin = {
  manifest: {
    id: "wazuh_ruleset_pull",
    name: "Wazuh Ruleset & Posture Pull",
    version: "1.0.0",
    category: "datasource",
    contract: 2,
    requires: [
      { binding: "wazuh", kind: "wazuh" }
    ] as unknown as PluginManifest["requires"],
    description:
      "Per-agent posture READ from the Wazuh server-API: group memberships, the effective active-response section delivered to each agent, the agent.conf for each group, and a manager-wide rule-group inventory. The control's mode (`detect` vs `block`) and fidelity (`authoritative` / `partial`) become legible to bulwark — detect-only reality (active-response disabled / empty commands) shows up here rather than getting minted as `block` from enrollment alone. Server-API surface (JWT through the existing driver — NOT the indexer). Chains off `wazuh_agents_pull` (reads `inputs.agents` and pulls each row's `group` directly, no per-agent lookup needed). Pure pull — NO observation/control transform; bulwark maps the raw rows. Honors the wazuh-pull empty-tolerance: agents whose memberships can't be read land in `metadata.missingAgents`, batch keeps going. Stamps `metadata.pullId` + `metadata.pulledAt` (Phase 5.2 wazuh-freshness provenance — ADR-0031).",
    configSchema: {
      type: "object",
      properties: {
        agentIdField: {
          type: "string",
          default: "id",
          description:
            "When `inputs.agents` is supplied, pull each agent's id from this field (and `group` for the membership shortcut)."
        },
        maxAgents: {
          type: "integer",
          default: 10000,
          description:
            "Hard ceiling on agents per execute(). Defensive against a runaway upstream — operator can lift for megafleets."
        },
        rulesetMaxRules: {
          type: "integer",
          default: 5000,
          description:
            "Cap on manager-wide rules fetched for the `rulesetSummary`. The default covers a stock Wazuh install (≈3.5k enabled rules) with margin; raise for installs that have loaded large custom rule packs."
        },
        skipActiveResponse: {
          type: "boolean",
          default: false,
          description:
            "When true, the plugin does NOT call `/agents/{id}/config/com/active-response`. Useful when the operator knows every agent is offline and wants to avoid per-agent 1707/1715 errors — every row gets `activeResponse.readable=false` and `fidelity=partial`."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      {
        name: "agents",
        description:
          "Array of agent rows (natural chain from `wazuh_agents_pull`). Each row's `id` + `group` are read directly; if `group` is missing the plugin re-fetches it via `/agents?agents_list=<id>`."
      },
      {
        name: "agentIds",
        description:
          "Fallback when `agents` isn't wired — array of agent id strings. Membership for each id is fetched via `/agents?agents_list=<id>`."
      }
    ],
    outputPorts: [
      {
        name: "ruleset",
        description:
          "Array of `{ agentId, groups, activeResponse, groupConfigs, fidelity, configSource }`. Bulwark maps `Control.mode` from `activeResponse.commands` (any non-disabled command → block-capable; empty/all-disabled → detect-only) and `Control.fidelity` from the `fidelity` field. Raw shapes (active-response command rows, group config JSON) are surfaced verbatim — bulwark normalises."
      },
      {
        name: "metadata",
        description:
          "Diagnostic envelope: `{ pullId, pulledAt, fetched, missingAgents, perAgentErrors, rulesetSummary }`. `rulesetSummary` is the manager-wide rule-group inventory (`{ readable, totalRules, groups:[{group,count,maxLevel}], truncated? }`) — fetched ONCE per execute (not per agent). `pullId` + `pulledAt` ride the Phase 5.2 wazuh-freshness contract (ADR-0031) the other wazuh pulls use."
      }
    ],
    capabilities: ["query"],
    ui: {
      icon: "shield-check",
      color: "#dc2626",
      paletteGroup: "Sources"
    }
  },
  async execute(input) {
    const conn = requireWazuhConnection(input, "wazuh", "wazuh_ruleset_pull");
    const client = await acquireClient<WazuhHandle>(conn);
    const cfg = input.config as {
      agentIdField?: unknown;
      maxAgents?: unknown;
      rulesetMaxRules?: unknown;
      skipActiveResponse?: unknown;
    };
    const idField =
      typeof cfg.agentIdField === "string" ? cfg.agentIdField : "id";
    const maxAgents =
      typeof cfg.maxAgents === "number" && cfg.maxAgents > 0
        ? Math.floor(cfg.maxAgents)
        : 10_000;
    const rulesetMaxRules =
      typeof cfg.rulesetMaxRules === "number" && cfg.rulesetMaxRules > 0
        ? Math.floor(cfg.rulesetMaxRules)
        : 5_000;
    const skipActiveResponse = cfg.skipActiveResponse === true;

    const prov = deriveWazuhProvenance(input);
    const agentIds = pickAgentIds(input.inputs, idField);
    const agentRowsById = indexAgentRowsByIdField(input.inputs, idField);

    // Manager-wide rule-group summary — one fetch per execute, shared
    // across all rows. Failure here doesn't kill the batch; bulwark
    // can still consume per-agent rows and treat the rule-group
    // dimension as unreadable.
    const rulesetSummary = await fetchManagerRulesetSummary(
      client,
      rulesetMaxRules
    );

    if (agentIds.length === 0) {
      return {
        outputs: {
          ruleset: [],
          metadata: {
            pullId: prov.pullId,
            pulledAt: prov.pulledAt,
            fetched: 0,
            missingAgents: [],
            perAgentErrors: [],
            rulesetSummary
          }
        }
      };
    }
    const trimmed = agentIds.slice(0, maxAgents);

    // Group config is the same value for every agent in a given group
    // — fetch ONCE and cache. Cache stores `null` for groups whose
    // config we tried but failed to read, so we don't re-hit the
    // endpoint twice and so the row carries the {readable:false,error}
    // shape consistently.
    const groupConfigCache = new Map<string, GroupConfigRead>();

    const ruleset: RulesetRow[] = [];
    const missingAgents: string[] = [];
    const perAgentErrors: Array<{
      agentId: string;
      stage: string;
      status?: number;
      message: string;
    }> = [];

    for (const agentId of trimmed) {
      // ----- groups (the load-bearing read; failure → missing) -----
      let groups: string[] | null = null;
      const cached = agentRowsById[agentId];
      const cachedGroup = cached?.group;
      if (Array.isArray(cachedGroup)) {
        groups = cachedGroup.filter(
          (g): g is string => typeof g === "string" && g.length > 0
        );
      } else if (typeof cachedGroup === "string" && cachedGroup.length > 0) {
        // Some Wazuh responses serialize `group` as a comma-separated
        // string rather than an array — normalise.
        groups = cachedGroup
          .split(",")
          .map((g) => g.trim())
          .filter((g) => g.length > 0);
      }
      if (groups === null) {
        try {
          groups = await fetchAgentGroups(client, agentId);
        } catch (e) {
          const err = e as { status?: number; message?: string };
          if (err.status === 404) {
            missingAgents.push(agentId);
            continue;
          }
          perAgentErrors.push({
            agentId,
            stage: "agent-record",
            status: err.status,
            message: err.message ?? String(e)
          });
          missingAgents.push(agentId);
          continue;
        }
      }
      // Empty group set is a legitimate Wazuh state (a freshly-
      // enrolled agent before being assigned) — surface in
      // missingAgents because there's no posture to read.
      if (groups.length === 0) {
        missingAgents.push(agentId);
        continue;
      }

      // ----- per-group config (deduped via cache) -----
      const groupConfigs: Record<string, GroupConfigRead> = {};
      let anyGroupConfigUnreadable = false;
      for (const groupId of groups) {
        if (!groupConfigCache.has(groupId)) {
          const result = await safeFetchGroupConfig(client, groupId);
          groupConfigCache.set(groupId, result);
        }
        const result = groupConfigCache.get(groupId)!;
        groupConfigs[groupId] = result;
        if (!result.readable) anyGroupConfigUnreadable = true;
      }

      // ----- per-agent active-response (the decisive detect/block read) -----
      let activeResponse: ActiveResponsePosture;
      if (skipActiveResponse) {
        activeResponse = {
          readable: false,
          enabledCount: 0,
          disabledCount: 0,
          commands: [],
          error: "skipActiveResponse=true — operator opted out of per-agent live config"
        };
      } else {
        activeResponse = await fetchAgentActiveResponsePosture(client, agentId);
      }

      // ----- compose fidelity + configSource -----
      const fidelity: "authoritative" | "partial" =
        activeResponse.readable && !anyGroupConfigUnreadable
          ? "authoritative"
          : "partial";
      const configSource: RulesetRow["configSource"] =
        activeResponse.readable && !anyGroupConfigUnreadable
          ? "mixed"
          : activeResponse.readable
            ? "agent-config"
            : "group-config";

      ruleset.push({
        agentId,
        groups,
        activeResponse,
        groupConfigs,
        fidelity,
        configSource
      });
    }

    return {
      outputs: {
        ruleset,
        metadata: {
          pullId: prov.pullId,
          pulledAt: prov.pulledAt,
          fetched: ruleset.length,
          missingAgents,
          perAgentErrors,
          rulesetSummary,
          truncated: agentIds.length > trimmed.length
        }
      }
    };
  }
};

// ---------------------------------------------------------------------------
// Helpers — wazuh_ruleset_pull
//
// Each helper either returns the raw payload (success) OR a structured
// "unreadable" shape (failure). Per-agent failures don't throw out of
// the pull — they downgrade `fidelity` to `partial` on that row.
// ---------------------------------------------------------------------------

async function fetchAgentGroups(
  client: WazuhHandle,
  agentId: string
): Promise<string[]> {
  const path = `/agents?agents_list=${encodeURIComponent(agentId)}&select=id,group`;
  const json = await client.request<AgentRecordResponse>(path);
  const items = json.data?.affected_items ?? [];
  if (items.length === 0) {
    const err = new Error(
      `wazuh: agent ${agentId} not found via /agents?agents_list`
    );
    (err as { status?: number }).status = 404;
    throw err;
  }
  const group = items[0]?.group;
  if (Array.isArray(group)) {
    return group.filter(
      (g): g is string => typeof g === "string" && g.length > 0
    );
  }
  return [];
}

async function safeFetchGroupConfig(
  client: WazuhHandle,
  groupId: string
): Promise<GroupConfigRead> {
  try {
    // `/groups/{group_id}/configuration` returns the agent.conf as
    // structured JSON (default in 4.x server-API; the `raw=true`
    // variant returns XML which we don't need).
    const path = `/groups/${encodeURIComponent(groupId)}/configuration`;
    const json = await client.request<GroupConfigResponse>(path);
    const item = json.data?.affected_items?.[0];
    return {
      readable: true,
      config: item ?? {}
    };
  } catch (e) {
    const err = e as { status?: number; message?: string };
    return {
      readable: false,
      error: err.message ?? String(e),
      errorStatus: err.status
    };
  }
}

async function fetchAgentActiveResponsePosture(
  client: WazuhHandle,
  agentId: string
): Promise<ActiveResponsePosture> {
  try {
    const path = `/agents/${encodeURIComponent(agentId)}/config/com/active-response`;
    const json = await client.request<ActiveResponseConfigResponse>(path);
    const item = json.data?.affected_items?.[0];
    const raw = Array.isArray(item?.["active-response"])
      ? (item!["active-response"] as Array<Record<string, unknown>>)
      : [];
    const commands: ActiveResponseCommand[] = raw.map((r) => {
      // Wazuh serializes `disabled` as the string "yes"/"no" — normalise
      // to a boolean so bulwark doesn't have to encode the convention.
      // EVERYTHING else passes through verbatim (level, rules_id, etc.).
      const rawDisabled = r.disabled;
      const disabled =
        typeof rawDisabled === "boolean"
          ? rawDisabled
          : typeof rawDisabled === "string"
            ? rawDisabled.toLowerCase() === "yes"
            : false;
      return {
        ...r,
        command:
          typeof r.command === "string" ? r.command : String(r.command ?? ""),
        disabled
      } as ActiveResponseCommand;
    });
    const enabledCount = commands.filter((c) => !c.disabled).length;
    const disabledCount = commands.length - enabledCount;
    return {
      readable: true,
      enabledCount,
      disabledCount,
      commands
    };
  } catch (e) {
    // Per-agent active-response config requires the agent to be
    // connected; Wazuh returns 1707 (agent disconnected) / 1715
    // (component not requestable) when not. Report unreadable rather
    // than pretend a posture we couldn't read — bulwark downgrades
    // Control.fidelity from authoritative to partial on this signal.
    const err = e as { status?: number; message?: string };
    return {
      readable: false,
      enabledCount: 0,
      disabledCount: 0,
      commands: [],
      error: err.message ?? String(e),
      errorStatus: err.status
    };
  }
}

async function fetchManagerRulesetSummary(
  client: WazuhHandle,
  maxRules: number
): Promise<RulesetSummary> {
  try {
    // /rules returns the loaded manager-side rules. Paginate up to
    // maxRules — the server-API caps `limit` at 500, so we walk.
    const pageLimit = Math.min(500, maxRules);
    let offset = 0;
    let collected = 0;
    const groupCount = new Map<string, number>();
    const groupMaxLevel = new Map<string, number>();
    let total = 0;
    let truncated = false;
    while (collected < maxRules) {
      const remaining = maxRules - collected;
      const limit = Math.min(pageLimit, remaining);
      const path = `/rules?status=enabled&offset=${offset}&limit=${limit}`;
      const json = await client.request<RulesResponse>(path);
      const items = json.data?.affected_items ?? [];
      total = json.data?.total_affected_items ?? total;
      for (const r of items) {
        const groups = Array.isArray(r.groups) ? r.groups : [];
        const level = typeof r.level === "number" ? r.level : 0;
        for (const g of groups) {
          if (typeof g !== "string" || g.length === 0) continue;
          groupCount.set(g, (groupCount.get(g) ?? 0) + 1);
          if (level > (groupMaxLevel.get(g) ?? -Infinity)) {
            groupMaxLevel.set(g, level);
          }
        }
      }
      collected += items.length;
      if (items.length < limit) break;
      offset += items.length;
      if (collected >= maxRules && total > collected) truncated = true;
    }
    const groups: RulesetGroupSummary[] = Array.from(groupCount.entries())
      .map(([group, count]) => ({
        group,
        count,
        maxLevel: groupMaxLevel.get(group) ?? 0
      }))
      .sort((a, b) => b.count - a.count);
    return {
      readable: true,
      totalRules: total || collected,
      groups,
      ...(truncated ? { truncated: true } : {})
    };
  } catch (e) {
    const err = e as { status?: number; message?: string };
    return {
      readable: false,
      totalRules: 0,
      groups: [],
      error: err.message ?? String(e)
    };
  }
}
