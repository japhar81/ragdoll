/**
 * Kubernetes — connection driver (ADR-0024) + completeness-aware
 * list-pull (Phase 3b).
 *
 * The headline feature is NOT pagination — every list-poller does
 * that. The headline is the **completeness signal**: each emitted
 * scan envelope carries `complete: true` only when every page of the
 * paginated sequence succeeded and the snapshot held to the end. If
 * any page returned `410 Gone` (the k8s API server's "your continue
 * token's snapshot got GC'd, you can't trust the rest" signal), or
 * any page errored / timed out, the scan emits with `complete: false`
 * and a `reason`. The items present so far are still emitted — the
 * downstream block (bulwark's append-only diff) reads `complete` to
 * decide whether absences may close edges. A partial list that LOOKS
 * like mass deletion must never reach the close-by-absence logic, or
 * placement history gets shredded.
 *
 * Token auth ONLY this phase (ServiceAccount bearer). Client-cert /
 * OIDC are deferred.
 *
 * What this module deliberately does NOT do:
 *
 *   - No watch / streaming. Frequent list-poll with the completeness
 *     signal is correct for placement capture; watch adds reconnect /
 *     bookmark / RV-drift complexity bulwark has explicitly said it
 *     does not want this phase.
 *   - No diff, no resolution, no retention. Those are stateful spine
 *     mutations bulwark owns; RAGdoll's job ends at "deliver a
 *     complete-or-partial-labelled scan."
 *   - No transform / write. Reuses the existing `transform` plugin
 *     (operator authors the k8s → observation mapping as config) and
 *     `neo4j_write` (already shipped).
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
// Test seam — fetch override (mirrors the wazuh / cartography pattern)
// ---------------------------------------------------------------------------

export type K8sFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    /** undici-style toggle for insecure-skip-tls. The driver sets
     *  this when `insecureSkipTlsVerify` is true OR when a non-system
     *  `caCert` is configured. Per-request — never flips the global
     *  Node TLS flag. */
    rejectUnauthorized?: boolean;
    /** PEM-encoded CA certificate(s). The driver passes this when an
     *  operator pinned a private CA. */
    caCert?: string;
    /** Wall-clock per-request timeout. The list-pull walks this for
     *  each page so a hung server can't stall the whole scan. */
    timeoutMs?: number;
  }
) => Promise<{
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

let activeFetch: K8sFetch | null = null;

/** Test hook — swap fetch. Pass `null` to restore. */
export function __setK8sFetchForTests(f: K8sFetch | null): void {
  activeFetch = f;
}

async function defaultFetch(
  url: string,
  init: Parameters<K8sFetch>[1] = {}
): Promise<Awaited<ReturnType<K8sFetch>>> {
  const fetchOpts: Record<string, unknown> = {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body
  };
  // Per-request undici Agent isolates TLS posture to THIS request, so
  // an insecure dev cluster can't bleed into other drivers in the same
  // worker process.
  if (init.rejectUnauthorized === false || init.caCert) {
    const undici = (await import("undici")) as {
      Agent: new (opts: {
        connect: { rejectUnauthorized?: boolean; ca?: string };
      }) => unknown;
    };
    const connect: { rejectUnauthorized?: boolean; ca?: string } = {};
    if (init.rejectUnauthorized === false) connect.rejectUnauthorized = false;
    if (init.caCert) connect.ca = init.caCert;
    (fetchOpts as { dispatcher?: unknown }).dispatcher = new undici.Agent({
      connect
    });
  }
  if (init.timeoutMs && init.timeoutMs > 0) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), init.timeoutMs);
    (fetchOpts as { signal?: AbortSignal }).signal = controller.signal;
    try {
      const res = await fetch(url, fetchOpts as Parameters<typeof fetch>[1]);
      return {
        status: res.status,
        ok: res.ok,
        json: () => res.json(),
        text: () => res.text()
      };
    } finally {
      clearTimeout(t);
    }
  }
  const res = await fetch(url, fetchOpts as Parameters<typeof fetch>[1]);
  return {
    status: res.status,
    ok: res.ok,
    json: () => res.json(),
    text: () => res.text()
  };
}

function getFetch(): K8sFetch {
  return activeFetch ?? defaultFetch;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

interface K8sConnectionOptions {
  /** Full API server URL — e.g. `https://k8s.acme.com:6443`. */
  apiServerUrl?: string;
  /** Skip TLS verification entirely. Default false. Per-request. */
  insecureSkipTlsVerify?: boolean;
  /** PEM-encoded CA certificate(s) pinning the API server. */
  caCert?: string;
  /** Default per-request timeout for list pages. Applies to every
   *  page the lister walks. Default 30s. */
  requestTimeoutMs?: number;
}

interface K8sCredentials {
  kind: "token";
  token: string;
}

/**
 * Parse the resolved secret into a token credential.
 *
 * Accepts:
 *   - JSON `{"token":"..."}` (canonical)
 *   - raw string (treats the whole value as the token — common when
 *     operators paste a ServiceAccount token in directly)
 *
 * Throws an actionable error naming `secretRefKey` when the secret
 * is missing entirely.
 */
export function parseK8sSecret(secret: string | undefined): K8sCredentials {
  if (!secret || !secret.trim()) {
    throw new Error(
      'k8s: connection has no secret — set secretRefKey on the connection to a managed secret holding `{"token":"<ServiceAccount-bearer>"}` (or the raw token string). Token auth is the only flow this phase.'
    );
  }
  const trimmed = secret.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { token?: string };
      if (typeof parsed.token === "string" && parsed.token.length > 0) {
        return { kind: "token", token: parsed.token };
      }
      throw new Error(
        "k8s: JSON secret must contain a non-empty `token` field"
      );
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      // Fall through — treat as raw token below.
    }
  }
  return { kind: "token", token: trimmed };
}

export function buildK8sApiServerUrl(opts: K8sConnectionOptions): string {
  const raw = (opts.apiServerUrl ?? "").trim();
  if (!raw) throw new Error("k8s: connection options.apiServerUrl is required");
  if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
    throw new Error(
      `k8s: apiServerUrl must include a scheme (http:// or https://). Got: ${raw}`
    );
  }
  return raw.replace(/\/+$/, "");
}

export interface K8sHandle {
  apiServerUrl: string;
  slug: string;
  insecureSkipTlsVerify: boolean;
  caCert?: string;
  requestTimeoutMs: number;
  credentials: K8sCredentials;
  /** Authenticated GET. Returns the parsed body and the HTTP status —
   *  the lister cares about the status to distinguish a 410 (snapshot
   *  GC) from any other non-2xx. */
  get: <T = unknown>(
    path: string
  ) => Promise<{ status: number; body: T | null; bodyText: string }>;
}

async function k8sGet<T>(
  handle: K8sHandle,
  path: string
): Promise<{ status: number; body: T | null; bodyText: string }> {
  const fetcher = getFetch();
  const url = `${handle.apiServerUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetcher(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${handle.credentials.token}`
    },
    rejectUnauthorized: handle.insecureSkipTlsVerify ? false : undefined,
    caCert: handle.caCert,
    timeoutMs: handle.requestTimeoutMs
  });
  // Read the body ONCE and surface it as both parsed + raw — the lister
  // wants the parsed `metadata.continue` etc., and an error path needs
  // a short text tail for the trace.
  const bodyText = await res.text();
  let body: T | null = null;
  try {
    body = bodyText ? (JSON.parse(bodyText) as T) : null;
  } catch {
    /* keep body null; lister will treat non-JSON as a non-success */
  }
  return { status: res.status, body, bodyText: bodyText.slice(0, 256) };
}

export const k8sConnectionDriver = defineConnectionDriverPlugin<K8sHandle>({
  kind: "k8s",
  driver: {
    async create(conn) {
      const opts = (conn.options ?? {}) as K8sConnectionOptions;
      const credentials = parseK8sSecret(conn.secret);
      const apiServerUrl = buildK8sApiServerUrl(opts);
      const handle: K8sHandle = {
        apiServerUrl,
        slug: conn.slug,
        insecureSkipTlsVerify: opts.insecureSkipTlsVerify === true,
        caCert: typeof opts.caCert === "string" ? opts.caCert : undefined,
        requestTimeoutMs:
          typeof opts.requestTimeoutMs === "number" && opts.requestTimeoutMs > 0
            ? Math.floor(opts.requestTimeoutMs)
            : 30_000,
        credentials,
        get: async <T,>(p: string) => k8sGet<T>(handle, p)
      };
      return handle;
    },
    async dispose(client) {
      // No server-side logout for a ServiceAccount token. We blank the
      // local credential so a stale handle returned by a buggy caller
      // never makes an authenticated call by accident.
      client.credentials = { kind: "token", token: "" };
    },
    async probe(client) {
      // `/version` is the cheapest unauthenticated-OR-authenticated
      // endpoint that exercises TLS + reachability. We DO send the
      // token — a token that can't reach /version usually means the
      // SA was bound to a different cluster (the operator hint we want
      // to surface). Returns its own JSON body; we just validate the
      // status.
      const res = await client.get<unknown>("/version");
      if (res.status < 200 || res.status >= 300) {
        throw new Error(
          `k8s: probe GET /version → ${res.status} on connection "${client.slug}": ${res.bodyText}`
        );
      }
    }
  },
  manifest: {
    displayName: "Kubernetes",
    description:
      "Kubernetes API server (token auth). Powers `k8s_list_pull` — the completeness-aware lister whose `scan.complete` flag is the load-bearing signal for any close-by-absence diff downstream. Watch / streaming is deliberately NOT used this phase; frequent list-poll + completeness signalling is the correct shape for placement capture (see ADR-0028).",
    configSchema: {
      type: "object",
      required: ["apiServerUrl"],
      properties: {
        apiServerUrl: {
          type: "string",
          description:
            "Full API server URL including scheme + port (e.g. `https://k8s.acme.com:6443`). The driver refuses values without an http(s):// prefix."
        },
        insecureSkipTlsVerify: {
          type: "boolean",
          default: false,
          description:
            "When true, the driver accepts ANY server certificate (per-request, NOT process-wide). Default false — flip only for dev / kind clusters where you trust the network path."
        },
        caCert: {
          type: "string",
          description:
            "Optional PEM-encoded CA certificate(s) pinning the API server. The driver passes this to undici's TLS context per-request — never installed as a system CA."
        },
        requestTimeoutMs: {
          type: "integer",
          default: 30000,
          description:
            "Per-page wall-clock cap (ms). Each page of a paginated list waits at most this long before timing out and marking the scan partial. Default 30s — lift on slow clusters but understand the runaway cost."
        }
      },
      additionalProperties: false
    },
    secretSchema: {
      type: "string",
      description:
        'JSON `{"token":"<ServiceAccount-bearer>"}` (canonical) OR the raw token string. Token auth is the only flow this phase — client-cert and OIDC are deferred to a follow-up.'
    },
    // Operators bind k8s via the "k8s" binding name on a Dataset; the
    // pull block asks for `kind: k8s` on that binding.
    datasetBindings: ["k8s"],
    transport: "in_process"
  }
});

// ---------------------------------------------------------------------------
// Shared binding helper
// ---------------------------------------------------------------------------

export function requireK8sConnection(
  input: PluginExecutionInput,
  binding: string,
  pluginId: string
): ResolvedExternalConnection {
  const b = input.dataset?.bindings?.[binding];
  if (!b?.connection) {
    const slug = input.dataset?.slug ?? "(no dataset bound)";
    throw new Error(
      `${pluginId} requires a "${binding}" binding on dataset "${slug}". Add a binding named "${binding}" on the Datasets screen pointing at a k8s connection.`
    );
  }
  if (b.connection.kind !== "k8s") {
    throw new Error(
      `${pluginId}: binding "${binding}" resolves to connection kind "${b.connection.kind}", expected "k8s".`
    );
  }
  return b.connection;
}

// ---------------------------------------------------------------------------
// Resource catalog — what kinds the operator can list
// ---------------------------------------------------------------------------

interface ResourceDescriptor {
  /** API path WITHOUT the trailing `?continue=…`. The lister adds the
   *  pagination params and continue token itself. */
  path: string;
  /** Operator-facing kind name surfaced in the scan envelope. Mirrors
   *  the k8s `kind` field on a List response (Pod, Node, …). */
  kindLabel: string;
}

/** Built-in catalog — the workload primitives bulwark needs for the
 *  initial placement graph. CRDs are reachable via the `customResources`
 *  config knob. */
const BUILTIN_RESOURCES: Record<string, ResourceDescriptor> = {
  // Workload primitives — placement / what's running.
  pods: { path: "/api/v1/pods", kindLabel: "Pod" },
  nodes: { path: "/api/v1/nodes", kindLabel: "Node" },
  namespaces: { path: "/api/v1/namespaces", kindLabel: "Namespace" },
  deployments: {
    path: "/apis/apps/v1/deployments",
    kindLabel: "Deployment"
  },
  replicasets: {
    path: "/apis/apps/v1/replicasets",
    kindLabel: "ReplicaSet"
  },
  statefulsets: {
    path: "/apis/apps/v1/statefulsets",
    kindLabel: "StatefulSet"
  },
  daemonsets: {
    path: "/apis/apps/v1/daemonsets",
    kindLabel: "DaemonSet"
  },
  // Exposure + network-control primitives (Phase C1 / AMENDMENT-3).
  // bulwark's correlation engine consumes these as the topology
  // service → endpoint → control. Each kind gets its own scan with
  // its own per-kind `complete` flag (same completeness contract as
  // the workload kinds — a flaky one cannot poison the others).
  // Pure pulls — no transform to observation/endpoint shape here.
  services: { path: "/api/v1/services", kindLabel: "Service" },
  ingresses: {
    // Standard k8s ingress.
    path: "/apis/networking.k8s.io/v1/ingresses",
    kindLabel: "Ingress"
  },
  routes: {
    // OpenShift route — the primary external exposure on OKD; missing
    // it leaves bulwark's correlation blind to anything fronted by
    // OpenShift router. Lives under route.openshift.io, NOT the
    // standard k8s networking group.
    path: "/apis/route.openshift.io/v1/routes",
    kindLabel: "Route"
  },
  networkpolicies: {
    // The k8s network control — both ingress and egress rules.
    path: "/apis/networking.k8s.io/v1/networkpolicies",
    kindLabel: "NetworkPolicy"
  }
};

export const K8S_BUILTIN_RESOURCE_KEYS = Object.keys(BUILTIN_RESOURCES);

interface CustomResourceConfig {
  /** Operator-facing label inserted into the scan envelope. */
  kindLabel?: string;
  /** API group (e.g. `cert-manager.io`). */
  group: string;
  /** API version (e.g. `v1`). */
  version: string;
  /** Plural lowercase resource name (e.g. `certificates`). */
  plural: string;
}

function resolveCustomResource(c: CustomResourceConfig): ResourceDescriptor {
  if (!c.group || !c.version || !c.plural) {
    throw new Error(
      "k8s_list_pull: customResources entries must set { group, version, plural }"
    );
  }
  return {
    path: `/apis/${c.group}/${c.version}/${c.plural}`,
    kindLabel: c.kindLabel ?? c.plural
  };
}

// ---------------------------------------------------------------------------
// k8s_list_pull — completeness-aware lister
// ---------------------------------------------------------------------------

export interface K8sScan {
  /** The `kindLabel` from the resolved descriptor — Pod / Node / Deployment / a CRD label. */
  kind: string;
  /** Items returned by the API server. ALWAYS the items we received,
   *  even on a partial scan — bulwark needs them; `complete:false`
   *  is the gate on absence-based mutation. */
  items: Array<Record<string, unknown>>;
  /** Server-reported resourceVersion at the head of the snapshot
   *  (page 1's `metadata.resourceVersion`). Surfaced so a downstream
   *  block can tag observations with the RV they came from. */
  resourceVersion: string | null;
  /** TRUE iff every page succeeded and the snapshot held. Bulwark's
   *  append-only diff must refuse to close-by-absence unless this is
   *  TRUE. NEVER coerce silently. */
  complete: boolean;
  /** When `complete:false`, a short machine-readable reason
   *  (`"continue_410_gone"`, `"page_status_500"`, `"timeout"`,
   *  `"non_json_body"`). When complete:true, undefined. */
  reason?: string;
  /** Optional human-readable detail to accompany `reason`. Never
   *  carries the bearer token. */
  detail?: string;
  /** Diagnostics for the trace — what got walked. */
  pagesFetched: number;
  /** When the API server returns `metadata.remainingItemCount` on a
   *  page, we surface the latest reported value here. Useful for the
   *  trace, NOT load-bearing for completeness (the count can be
   *  stale; only the consistent-snapshot rule decides completeness). */
  remainingItemCountAtPartial?: number;
}

interface ListResponse {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    resourceVersion?: string;
    continue?: string;
    remainingItemCount?: number;
  };
  items?: Array<Record<string, unknown>>;
}

/** Default per-resource page size. Same as kubectl's default. */
const DEFAULT_LIMIT = 500;
const DEFAULT_MAX_PAGES = 1_000;

export const k8sListPullPlugin: InProcessPlugin = {
  manifest: {
    id: "k8s_list_pull",
    name: "Kubernetes List Pull",
    version: "1.0.0",
    category: "datasource",
    contract: 2,
    requires: [{ binding: "k8s", kind: "k8s" }] as unknown as PluginManifest["requires"],
    description:
      "Lists configured Kubernetes resource kinds via the API server's pagination contract (`?limit=N&continue=<token>`). Per kind, emits a `scan` envelope: `{ kind, items[], resourceVersion, complete, reason? }`. `complete: true` ONLY when every page of the paginated sequence succeeded and the snapshot held; ANY page returning `410 Gone` (the API server's snapshot-GC signal), erroring, or timing out flips the scan to `complete: false` with a short machine-readable `reason`. Items are emitted either way — downstream diff logic (bulwark's append-only spine) keys off `complete` to decide whether the absences in this scan may close edges. NEVER silently returns a truncated list as if whole. NO watch/streaming.",
    configSchema: {
      type: "object",
      properties: {
        resources: {
          type: "array",
          items: {
            type: "string",
            enum: K8S_BUILTIN_RESOURCE_KEYS
          },
          description:
            "Which built-in resource kinds to list this run. Pick from: " +
            K8S_BUILTIN_RESOURCE_KEYS.join(", ") +
            ". Combine with `customResources` for CRDs."
        },
        customResources: {
          type: "array",
          items: {
            type: "object",
            required: ["group", "version", "plural"],
            properties: {
              group: { type: "string" },
              version: { type: "string" },
              plural: { type: "string" },
              kindLabel: { type: "string" }
            }
          },
          description:
            "CRD entries via `/apis/<group>/<version>/<plural>`. `kindLabel` (optional) is what shows up on the scan envelope; defaults to the plural."
        },
        namespace: {
          type: "string",
          description:
            "Optional namespace scope. When set, the path is rewritten to `/api/v1/namespaces/<ns>/<resource>` (or the apis/ equivalent). Leave blank to list cluster-wide."
        },
        limit: {
          type: "integer",
          default: 500,
          description:
            "Page size (`?limit=`). The server's default is 500; values above 500 still work but the server may cap them. Smaller pages = more round-trips but smaller blast radius if a continue token GC's."
        },
        maxPages: {
          type: "integer",
          default: 1000,
          description:
            "Runaway-guard cap on pages walked per resource. When the cap fires, the scan is flagged `complete: false` with `reason: 'max_pages'`. Default 1000 (≈ 500k items at limit=500)."
        }
      },
      additionalProperties: false
    },
    inputPorts: [],
    outputPorts: [
      {
        name: "scans",
        description:
          "Array of `K8sScan` envelopes, one per (resource kind) requested. Each carries items + completeness flag + resourceVersion."
      },
      {
        name: "metadata",
        description:
          "Roll-up diagnostics for the trace: total resources requested, total pages, any partial scans (with reasons)."
      }
    ],
    capabilities: ["query"],
    ui: {
      icon: "box",
      color: "#326ce5",
      paletteGroup: "Sources",
      formHints: {
        resources: { widget: "tags" },
        customResources: { widget: "json" },
        namespace: { widget: "text" }
      }
    }
  },
  async execute(input) {
    const conn = requireK8sConnection(input, "k8s", "k8s_list_pull");
    const client = await acquireClient<K8sHandle>(conn);
    const cfg = input.config as {
      resources?: unknown;
      customResources?: unknown;
      namespace?: unknown;
      limit?: unknown;
      maxPages?: unknown;
    };
    const resources = collectResources(cfg);
    if (resources.length === 0) {
      throw new Error(
        "k8s_list_pull: at least one resource kind must be configured (set `resources` and/or `customResources`)"
      );
    }
    const limit = clampLimit(cfg.limit, DEFAULT_LIMIT);
    const maxPages = clampMaxPages(cfg.maxPages, DEFAULT_MAX_PAGES);
    const namespace =
      typeof cfg.namespace === "string" && cfg.namespace.length > 0
        ? cfg.namespace
        : undefined;

    const scans: K8sScan[] = [];
    let totalPages = 0;

    for (const res of resources) {
      const scan = await pullOneResource(client, res, {
        limit,
        maxPages,
        namespace
      });
      scans.push(scan);
      totalPages += scan.pagesFetched;
    }

    const partials = scans
      .filter((s) => !s.complete)
      .map((s) => ({ kind: s.kind, reason: s.reason, detail: s.detail }));

    return {
      outputs: {
        scans,
        metadata: {
          resourcesRequested: resources.length,
          totalPages,
          partials
        }
      }
    };
  }
};

// ---------------------------------------------------------------------------
// Pagination walker — the load-bearing logic
// ---------------------------------------------------------------------------

interface ResolvedResource {
  /** Key used by the operator (`pods` / `crd:cert-manager.io/v1/certificates`). */
  key: string;
  descriptor: ResourceDescriptor;
}

interface PullOpts {
  limit: number;
  maxPages: number;
  namespace?: string;
}

async function pullOneResource(
  client: K8sHandle,
  res: ResolvedResource,
  opts: PullOpts
): Promise<K8sScan> {
  const basePath = applyNamespace(res.descriptor.path, opts.namespace);
  const items: Array<Record<string, unknown>> = [];
  let continueToken: string | undefined;
  let resourceVersion: string | null = null;
  let remainingItemCount: number | undefined;
  let pages = 0;

  while (pages < opts.maxPages) {
    const params = new URLSearchParams();
    params.set("limit", String(opts.limit));
    if (continueToken) params.set("continue", continueToken);
    const path = `${basePath}?${params.toString()}`;
    let pageResult: Awaited<ReturnType<K8sHandle["get"]>>;
    try {
      pageResult = await client.get<ListResponse>(path);
    } catch (e) {
      // Fetch threw — network error / timeout / abort. The scan is
      // partial; bail with what we have.
      const message = (e as Error).message ?? String(e);
      const reason = /abort/i.test(message) ? "timeout" : "page_fetch_error";
      return partialScan(res, items, resourceVersion, pages, reason, message, remainingItemCount);
    }
    pages += 1;

    // The 410 Gone case — the single most important branch in this
    // entire module. The API server has GC'd the snapshot that backed
    // our continue token. We DO NOT silently re-list from scratch
    // (that would produce a frankenscan from two different RVs which
    // bulwark's diff can't tell apart from a real change). Emit what
    // we have so far with complete:false.
    if (pageResult.status === 410) {
      return partialScan(
        res,
        items,
        resourceVersion,
        pages,
        "continue_410_gone",
        pageResult.bodyText,
        remainingItemCount
      );
    }
    if (pageResult.status < 200 || pageResult.status >= 300) {
      return partialScan(
        res,
        items,
        resourceVersion,
        pages,
        `page_status_${pageResult.status}`,
        pageResult.bodyText,
        remainingItemCount
      );
    }
    const body = pageResult.body as ListResponse | null;
    if (!body || typeof body !== "object") {
      return partialScan(
        res,
        items,
        resourceVersion,
        pages,
        "non_json_body",
        pageResult.bodyText,
        remainingItemCount
      );
    }

    // First page wins for resourceVersion — it's the head of the
    // snapshot. Subsequent pages share the same RV by construction
    // (that's what continue tokens guarantee); recording page 1's RV
    // means a successful complete:true scan is tagged with the
    // exact RV bulwark should anchor observations to.
    if (resourceVersion === null) {
      resourceVersion = body.metadata?.resourceVersion ?? null;
    }
    if (Array.isArray(body.items)) {
      for (const item of body.items) items.push(item);
    }
    if (typeof body.metadata?.remainingItemCount === "number") {
      remainingItemCount = body.metadata.remainingItemCount;
    }
    const next = body.metadata?.continue;
    if (!next) {
      // The snapshot drained — complete iff every page succeeded
      // (which is the case here, since we'd have early-returned
      // above otherwise).
      return {
        kind: res.descriptor.kindLabel,
        items,
        resourceVersion,
        complete: true,
        pagesFetched: pages
      };
    }
    continueToken = next;
  }

  // maxPages cap fired. We don't know if the snapshot was complete —
  // assume not.
  return partialScan(
    res,
    items,
    resourceVersion,
    pages,
    "max_pages",
    `walked maxPages=${opts.maxPages} without exhausting the continue chain`,
    remainingItemCount
  );
}

function partialScan(
  res: ResolvedResource,
  items: Array<Record<string, unknown>>,
  resourceVersion: string | null,
  pages: number,
  reason: string,
  detail: string,
  remainingItemCount: number | undefined
): K8sScan {
  return {
    kind: res.descriptor.kindLabel,
    items,
    resourceVersion,
    complete: false,
    reason,
    detail,
    pagesFetched: pages,
    ...(typeof remainingItemCount === "number"
      ? { remainingItemCountAtPartial: remainingItemCount }
      : {})
  };
}

function applyNamespace(
  path: string,
  namespace: string | undefined
): string {
  if (!namespace) return path;
  // /api/v1/pods -> /api/v1/namespaces/<ns>/pods
  // /apis/apps/v1/deployments -> /apis/apps/v1/namespaces/<ns>/deployments
  if (path.startsWith("/api/v1/")) {
    const tail = path.slice("/api/v1/".length);
    return `/api/v1/namespaces/${encodeURIComponent(namespace)}/${tail}`;
  }
  if (path.startsWith("/apis/")) {
    const parts = path.split("/").filter(Boolean);
    // ["apis", "<group>", "<version>", "<plural>"]
    if (parts.length >= 4) {
      const [, group, version, ...rest] = parts;
      return `/apis/${group}/${version}/namespaces/${encodeURIComponent(namespace)}/${rest.join("/")}`;
    }
  }
  return path;
}

function collectResources(cfg: {
  resources?: unknown;
  customResources?: unknown;
}): ResolvedResource[] {
  const out: ResolvedResource[] = [];
  if (Array.isArray(cfg.resources)) {
    for (const key of cfg.resources as unknown[]) {
      const k = String(key);
      const d = BUILTIN_RESOURCES[k];
      if (!d) {
        throw new Error(
          `k8s_list_pull: unknown built-in resource "${k}". Allowed: ${K8S_BUILTIN_RESOURCE_KEYS.join(", ")}`
        );
      }
      out.push({ key: k, descriptor: d });
    }
  }
  if (Array.isArray(cfg.customResources)) {
    for (const raw of cfg.customResources as unknown[]) {
      if (!raw || typeof raw !== "object") continue;
      const c = raw as CustomResourceConfig;
      out.push({
        key: `crd:${c.group}/${c.version}/${c.plural}`,
        descriptor: resolveCustomResource(c)
      });
    }
  }
  return out;
}

function clampLimit(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? Math.floor(value) : fallback;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 5000); // server-side cap is usually 500; allow headroom
}

function clampMaxPages(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? Math.floor(value) : fallback;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 100_000);
}
