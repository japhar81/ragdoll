/**
 * Storage-backend driver registrations for the unified Connections registry
 * (ADR-0023 + ADR-0024).
 *
 * The mongo / clickhouse / postgres-core drivers register themselves
 * next to their plugin families. Qdrant / OpenSearch / Dgraph don't
 * have a single co-located plugin family — they're consumed by
 * `retrieval-v2.ts`, the dgraph_* plugins, and dataset bindings — so
 * their driver registrations live here, side-effect-imported by
 * `plugins/builtin-rag/src/index.ts`.
 *
 * Each driver declares:
 *   - `configSchema` { host, port, scheme } so the Connections form
 *     renders without per-kind TSX,
 *   - `datasetBindings` so the dataset picker can filter by which
 *     bindings a kind can fill,
 *   - `probe` doing an HTTP liveness check against the backend's
 *     canonical health endpoint (no auth required, no SDK weight).
 *
 * The `create()` factories return real typed clients so existing
 * plugins can migrate to `acquireClient()` incrementally — today,
 * retrieval-v2 still constructs its own clients, but probe + the
 * Connections "test" button work off these registrations.
 */

import { registerConnectionDriver } from "../../../../packages/external-connections/src/index.ts";

interface HttpEndpointOptions {
  host?: string;
  port?: number;
  scheme?: string;
  /** Some seeds carry a pre-baked URL; honor it when present. */
  url?: string;
}

function endpointUrl(opts: HttpEndpointOptions, defaultPort: number): string {
  if (opts.url) return String(opts.url).replace(/\/$/, "");
  if (!opts.host) {
    throw new Error("missing host (or url) — connection config must include at least options.host");
  }
  const scheme = opts.scheme ?? "http";
  const port = opts.port ?? defaultPort;
  return `${scheme}://${opts.host}:${port}`;
}

async function httpProbe(url: string, path: string, label: string): Promise<void> {
  // No-auth GET against the backend's canonical liveness endpoint.
  // AbortSignal.timeout keeps a hung backend from holding the probe
  // sweep open — 5s is generous; healthy installs respond in ms.
  const res = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) {
    throw new Error(`${label} probe HTTP ${res.status} at ${path}`);
  }
}

// ===========================================================================
// Qdrant
// ===========================================================================

interface QdrantClient {
  url: string;
  apiKey?: string;
}

registerConnectionDriver<QdrantClient>(
  "qdrant",
  {
    async create(conn) {
      const opts = (conn.options ?? {}) as HttpEndpointOptions & { apiKey?: string };
      const url = endpointUrl(opts, 6333);
      // Resolved secret takes priority over inline options.apiKey when present.
      const apiKey = conn.secret ?? opts.apiKey;
      return { url, apiKey };
    },
    async probe(client) {
      // /readyz returns "all shards are ready" on a healthy Qdrant.
      // /healthz works on older builds; try /readyz first, fall back.
      try {
        await httpProbe(client.url, "/readyz", "qdrant");
      } catch {
        await httpProbe(client.url, "/healthz", "qdrant");
      }
    }
  },
  {
    displayName: "Qdrant",
    description: "Vector database. Consumed by retrieval / ingest plugins via Datasets.",
    configSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Hostname or service alias (e.g. ragdoll-qdrant)." },
        port: { type: "integer", default: 6333, description: "REST API port. Defaults to 6333." },
        scheme: {
          type: "string",
          default: "http",
          description: "URL scheme — http or https.",
          enum: ["http", "https"]
        },
        url: {
          type: "string",
          description: "Pre-baked URL — wins over host/port/scheme when set."
        }
      },
      required: ["host"],
      additionalProperties: false
    },
    secretSchema: {
      type: "string",
      description: "Qdrant API key. Optional — bundled installs run without auth."
    },
    datasetBindings: ["vectors"],
    transport: "in_process"
  }
);

// ===========================================================================
// OpenSearch
// ===========================================================================

interface OpenSearchClientHandle {
  url: string;
  username?: string;
  password?: string;
}

registerConnectionDriver<OpenSearchClientHandle>(
  "opensearch",
  {
    async create(conn) {
      const opts = (conn.options ?? {}) as HttpEndpointOptions & { username?: string };
      const url = endpointUrl(opts, 9200);
      // Secret can be either a raw password OR a JSON `{username,password}`
      // blob. Best-effort parse — falls back to treating it as a password.
      let username = opts.username;
      let password: string | undefined = conn.secret;
      if (conn.secret && conn.secret.trim().startsWith("{")) {
        try {
          const parsed = JSON.parse(conn.secret) as { username?: string; password?: string };
          if (parsed.username) username = parsed.username;
          if (parsed.password) password = parsed.password;
        } catch {
          /* leave as raw password */
        }
      }
      return { url, username, password };
    },
    async probe(client) {
      const headers: Record<string, string> = {};
      if (client.username && client.password) {
        headers["authorization"] =
          "Basic " + Buffer.from(`${client.username}:${client.password}`).toString("base64");
      }
      // /_cluster/health returns 200 even on yellow status — that's the
      // canonical "alive and accepting requests" check for OpenSearch.
      const res = await fetch(`${client.url}/_cluster/health`, {
        headers,
        signal: AbortSignal.timeout(5_000)
      });
      if (!res.ok) {
        throw new Error(`opensearch probe HTTP ${res.status} at /_cluster/health`);
      }
    }
  },
  {
    displayName: "OpenSearch",
    description:
      "Full-text + vector search. Used by opensearch_* retrievers and dataset keyword bindings.",
    configSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Hostname (e.g. ragdoll-bundledopensearch)." },
        port: { type: "integer", default: 9200, description: "REST port. Defaults to 9200." },
        scheme: {
          type: "string",
          default: "http",
          description: "http or https.",
          enum: ["http", "https"]
        },
        username: {
          type: "string",
          description: "Username for basic auth. Password lives in the secret ref."
        },
        url: {
          type: "string",
          description: "Pre-baked URL — wins over host/port/scheme when set."
        }
      },
      required: ["host"],
      additionalProperties: false
    },
    secretSchema: {
      type: "string",
      description:
        "Password for the configured username — OR a JSON `{\"username\":...,\"password\":...}` blob."
    },
    datasetBindings: ["text", "vectors"],
    transport: "in_process"
  }
);

// ===========================================================================
// Dgraph
// ===========================================================================

interface DgraphClientHandle {
  url: string;
  authToken?: string;
}

registerConnectionDriver<DgraphClientHandle>(
  "dgraph",
  {
    async create(conn) {
      const opts = (conn.options ?? {}) as HttpEndpointOptions;
      const url = endpointUrl(opts, 8080);
      return { url, authToken: conn.secret };
    },
    async probe(client) {
      const headers: Record<string, string> = {};
      if (client.authToken) headers["X-Auth-Token"] = client.authToken;
      // /health returns a JSON array describing each alpha node.
      const res = await fetch(`${client.url}/health`, {
        headers,
        signal: AbortSignal.timeout(5_000)
      });
      if (!res.ok) {
        throw new Error(`dgraph probe HTTP ${res.status} at /health`);
      }
    }
  },
  {
    displayName: "Dgraph",
    description: "Knowledge graph. Used by dgraph_upsert / dgraph_query / dgraph_delete.",
    configSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Hostname (e.g. ragdoll-dgraph)." },
        port: { type: "integer", default: 8080, description: "Alpha HTTP port. Defaults to 8080." },
        scheme: {
          type: "string",
          default: "http",
          description: "http or https.",
          enum: ["http", "https"]
        },
        url: {
          type: "string",
          description: "Pre-baked URL — wins over host/port/scheme when set."
        }
      },
      required: ["host"],
      additionalProperties: false
    },
    secretSchema: {
      type: "string",
      description: "Dgraph Cloud-style bearer token. Optional — bundled installs run without auth."
    },
    datasetBindings: ["graph"],
    transport: "in_process"
  }
);
