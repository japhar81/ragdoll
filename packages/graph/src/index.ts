/**
 * Graph-store abstraction. Mirrors `packages/vector` in shape:
 *  - a `GraphStore` interface with mutate / query / delete-by-tenant;
 *  - an `InMemoryGraphStore` for tests + offline mode;
 *  - a `DgraphStore` for the production backend (HTTP API, lazy fetch).
 *
 * Why HTTP and not gRPC: Dgraph's HTTP API covers everything we need
 * (mutate / query / alter) and keeps us in the same fetch-only world
 * the vector + opensearch adapters use. gRPC would pull in
 * @dgraph-io/dgraph-js-http or grpc-js — not worth the dep weight
 * for a v1.
 *
 * Multi-tenant isolation: every node we write carries `tenant_id` as
 * an indexed predicate. Reads are expected to filter on it; writes
 * stamp it automatically. `deleteByTenant(collection, tenantId)`
 * issues a DQL `delete` over all nodes with that predicate.
 */

/** One node we want stored or matched. `uid` may be "_:something" to
 *  request Dgraph mints a fresh uid, or a real uid for upserts. */
export interface GraphNode {
  uid?: string;
  /** Node-type label; persisted as `dgraph.type` so queries can use
   *  `type(<T>)` filtering. */
  type?: string;
  /** Free-form properties. Reserved keys: `uid`, `dgraph.type`,
   *  `tenant_id`. Edges are encoded as nested-object arrays under
   *  the predicate name (Dgraph's native shape). */
  [key: string]: unknown;
}

/** Loose typing for DQL query responses — Dgraph returns whatever the
 *  query named, so callers cast on demand. */
export type GraphQueryResult = Record<string, unknown>;

export interface GraphStore {
  /** Apply a JSON schema fragment via `/alter`. Idempotent on Dgraph
   *  itself; callers can call this at boot or skip it entirely. */
  alterSchema?(schema: string): Promise<void>;
  /** Mutate-then-commit. Every node gets `tenant_id` stamped before
   *  the request. Returns the uid map Dgraph allocated for any
   *  `_:foo` blank-node references. */
  mutate(args: {
    tenantId: string;
    setJson?: GraphNode[];
    deleteJson?: GraphNode[];
  }): Promise<{ uids: Record<string, string> }>;
  /** Run a DQL query. The caller passes the full query string + any
   *  GraphQL-style variables; the store forwards the response. */
  query(args: {
    tenantId: string;
    query: string;
    vars?: Record<string, string>;
  }): Promise<GraphQueryResult>;
  /** Wipe every node carrying `tenant_id = <tenantId>`. Used on
   *  tenant delete + tests that want a clean slate. */
  deleteByTenant(tenantId: string): Promise<void>;
}

interface DgraphConfig {
  url?: string;
  /** Bearer auth for Dgraph Cloud-style deployments; optional. */
  authToken?: string;
  /** Injectable for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

/** Production Dgraph adapter. Talks plain HTTP at `${url}/{mutate,
 *  query, alter}`; no SDK dependency. */
export class DgraphStore implements GraphStore {
  private url: string;
  private fetchImpl: typeof fetch;
  private authToken?: string;

  constructor(config: DgraphConfig = {}) {
    this.url = (config.url ?? "http://localhost:8080").replace(/\/$/, "");
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.authToken = config.authToken;
  }

  private headers(contentType: string): Record<string, string> {
    const h: Record<string, string> = { "content-type": contentType };
    if (this.authToken) h["X-Auth-Token"] = this.authToken;
    return h;
  }

  async alterSchema(schema: string): Promise<void> {
    const res = await this.fetchImpl(`${this.url}/alter`, {
      method: "POST",
      headers: this.headers("application/dql"),
      body: schema
    });
    if (!res.ok) {
      throw new Error(`dgraph alter failed: HTTP ${res.status} ${await res.text()}`);
    }
  }

  async mutate(args: {
    tenantId: string;
    setJson?: GraphNode[];
    deleteJson?: GraphNode[];
  }): Promise<{ uids: Record<string, string> }> {
    // Stamp tenant_id on every `set` node — defence-in-depth so a
    // plugin that forgets to set it still produces correctly-scoped
    // rows. Deletes pass through unmodified; callers must scope.
    const set = (args.setJson ?? []).map((n) => ({
      ...n,
      tenant_id: args.tenantId
    }));
    const body: Record<string, unknown> = {};
    if (set.length > 0) body.set = set;
    if (args.deleteJson && args.deleteJson.length > 0) body.delete = args.deleteJson;
    if (Object.keys(body).length === 0) return { uids: {} };
    const res = await this.fetchImpl(`${this.url}/mutate?commitNow=true`, {
      method: "POST",
      headers: this.headers("application/json"),
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      throw new Error(`dgraph mutate failed: HTTP ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as {
      data?: { uids?: Record<string, string> };
    };
    return { uids: json.data?.uids ?? {} };
  }

  async query(args: {
    tenantId: string;
    query: string;
    vars?: Record<string, string>;
  }): Promise<GraphQueryResult> {
    // Surface the tenantId as a `$tenant_id` variable so DQL queries
    // can filter on it without the plugin having to interpolate.
    const vars = { ...(args.vars ?? {}), $tenant_id: args.tenantId };
    const body = { query: args.query, variables: vars };
    const res = await this.fetchImpl(`${this.url}/query`, {
      method: "POST",
      headers: this.headers("application/json"),
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      throw new Error(`dgraph query failed: HTTP ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { data?: GraphQueryResult; errors?: unknown };
    if (json.errors) {
      throw new Error(`dgraph query errors: ${JSON.stringify(json.errors)}`);
    }
    return json.data ?? {};
  }

  async deleteByTenant(tenantId: string): Promise<void> {
    // DQL: select every uid bound to the tenant, then delete each one.
    // Done in one round-trip via an upsert mutation block.
    const upsert = {
      query: `{ all(func: eq(tenant_id, "${tenantId.replace(/"/g, '\\"')}")) { v as uid } }`,
      mutations: [{ delete: [{ uid: "uid(v)" }] }]
    };
    const res = await this.fetchImpl(`${this.url}/mutate?commitNow=true`, {
      method: "POST",
      headers: this.headers("application/json"),
      body: JSON.stringify(upsert)
    });
    if (!res.ok) {
      throw new Error(
        `dgraph deleteByTenant failed: HTTP ${res.status} ${await res.text()}`
      );
    }
  }
}

/**
 * Process-wide in-memory store for tests + offline mode. The shape
 * is intentionally minimal — we model nodes as a map and edges as
 * arrays under predicate names. DQL is NOT implemented; the
 * `query()` method accepts a tiny custom matcher language sufficient
 * for our offline test paths (see plugin tests).
 */
export class InMemoryGraphStore implements GraphStore {
  private nextId = 1;
  private nodes = new Map<string, GraphNode>();
  /** Stash blank-node aliases assigned per mutate call, so tests can
   *  reference them in subsequent queries. */
  private aliases = new Map<string, string>();

  async mutate(args: {
    tenantId: string;
    setJson?: GraphNode[];
    deleteJson?: GraphNode[];
  }): Promise<{ uids: Record<string, string> }> {
    const uids: Record<string, string> = {};
    for (const node of args.setJson ?? []) {
      let uid = node.uid;
      if (!uid) {
        uid = `0x${(this.nextId++).toString(16)}`;
      } else if (uid.startsWith("_:")) {
        const alias = uid.slice(2);
        const existing = this.aliases.get(alias);
        if (existing) {
          uid = existing;
        } else {
          const fresh = `0x${(this.nextId++).toString(16)}`;
          this.aliases.set(alias, fresh);
          uids[alias] = fresh;
          uid = fresh;
        }
      }
      this.nodes.set(uid, { ...node, uid, tenant_id: args.tenantId });
    }
    for (const node of args.deleteJson ?? []) {
      if (node.uid) this.nodes.delete(node.uid);
    }
    return { uids };
  }

  async query(args: {
    tenantId: string;
    query: string;
    vars?: Record<string, string>;
  }): Promise<GraphQueryResult> {
    // Mini-DQL: only supports `{ <name>(func: type(<T>)) { <preds> } }`
    // or `{ <name>(func: eq(<pred>, "<val>")) { <preds> } }` shapes —
    // enough to test plugin wiring without a real Dgraph. Real
    // queries hit the DgraphStore in production.
    const match = args.query.match(
      /\{\s*(\w+)\s*\(\s*func:\s*(?:type\((\w+)\)|eq\((\w+),\s*"([^"]+)"\))\s*\)\s*\{([^}]+)\}\s*\}/
    );
    if (!match) {
      // Unknown query shape — return empty to keep tests deterministic.
      void args.vars;
      return {};
    }
    const [, name, type, eqPred, eqVal, fieldsBlock] = match;
    const fields = fieldsBlock
      .split(/\s+/)
      .filter(Boolean)
      .map((f) => f.trim());
    const rows: Record<string, unknown>[] = [];
    for (const node of this.nodes.values()) {
      if (node.tenant_id !== args.tenantId) continue;
      if (type && node["dgraph.type"] !== type) continue;
      if (eqPred && node[eqPred] !== eqVal) continue;
      const row: Record<string, unknown> = {};
      for (const f of fields) row[f] = node[f];
      rows.push(row);
    }
    return { [name]: rows };
  }

  async deleteByTenant(tenantId: string): Promise<void> {
    for (const [uid, node] of this.nodes) {
      if (node.tenant_id === tenantId) this.nodes.delete(uid);
    }
  }

  /** Test-only: total node count under a tenant. */
  size(tenantId?: string): number {
    if (tenantId === undefined) return this.nodes.size;
    let n = 0;
    for (const node of this.nodes.values()) {
      if (node.tenant_id === tenantId) n += 1;
    }
    return n;
  }
}

/** Factory mirroring `createVectorStore`. Picks the in-memory store
 *  when:
 *   - the URL is unset, or
 *   - the URL starts with `memory:` (the test escape hatch — plugin
 *     unit tests bind a fake connection whose host is `memory` so the
 *     plugin's hard-fail-on-missing-connection path is still exercised
 *     end to end while the store side stays in-process).
 *  Otherwise the HTTP-backed store talks to a real Dgraph alpha. */
export function createGraphStore(config: DgraphConfig = {}): GraphStore {
  const url = config.url ?? process.env.DGRAPH_URL;
  if (!url || url.startsWith("http://memory") || url.startsWith("memory:")) {
    return new InMemoryGraphStore();
  }
  return new DgraphStore({ ...config, url });
}
