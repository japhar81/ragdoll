/**
 * Neo4j family — connection driver + read/write plugins (ADR-0025).
 *
 * Fills the graph-driver gap beside `dgraph`. Same shape as the other
 * graph-storage families:
 *
 *   - `neo4jConnectionDriver` (ADR-0024) — driver-as-plugin manifest the
 *     loader picks up on its standard module scan. Lazy-imports the
 *     `neo4j-driver` npm package so unit tests stay install-free and the
 *     module itself loads on any worker (the import only fails when an
 *     actual connection is acquired, by which point the operator has
 *     opted in to the dep).
 *
 *   - `neo4j_query` — read tool (category retriever). `requires` a graph
 *     binding pointing at a neo4j connection; parameterised Cypher;
 *     emits rows. Params are bound, never string-interpolated.
 *
 *   - `neo4j_write` — write tool (category sink). Idempotent batched
 *     UNWIND/MERGE on a caller-supplied `keyField`; param-as-data only.
 *     The label + keyField are validated identifiers before they're
 *     spliced into Cypher (everything else stays in $rows).
 *
 * The plugins resolve via the dataset binding contract (ADR-0023): each
 * declares `requires: [{binding: "graph", kind: "neo4j"}]`, reads
 * `input.dataset.bindings.graph.connection`, and hands it to
 * `acquireClient()` so a per-(connection.id) Driver is pooled across
 * pipelines that share the connection slug.
 *
 * Cypher safety posture: every user-supplied data value is bound as a
 * Cypher parameter ($name / row[$keyField] etc.) — the only operator-
 * supplied strings we splice into the query text are the node label and
 * the property key, and both are validated against
 * /^[A-Za-z_][A-Za-z0-9_]*$/ before the splice. There is NO path where
 * user data reaches the Cypher source text.
 */

import type { InProcessPlugin, PluginExecutionInput } from "../../../packages/plugin-sdk/src/index.ts";
import { defineConnectionDriverPlugin, acquireClient } from "../../../packages/external-connections/src/index.ts";
import type { ResolvedExternalConnection } from "../../../packages/external-connections/src/index.ts";

// ---------------------------------------------------------------------------
// Connection driver (ADR-0024 manifest)
// ---------------------------------------------------------------------------

/**
 * What the driver factory returns + caches per (connection.id). The
 * `driver` is a real neo4j Driver instance (from `neo4j-driver`); the
 * stored `database` is the default we'll open a session against when
 * the plugin's config doesn't override it.
 */
export interface Neo4jHandle {
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  driver: any;
  database: string;
  /** Connection slug — surfaced in error messages so an auth/connectivity
   *  failure says WHICH connection failed (vs a bare "auth failure"). */
  slug: string;
  /** Whether a non-empty secret was attached when the driver was built.
   *  Distinguishes "the password is wrong" from "the binding's
   *  secretRefKey is missing/unresolvable" — both yield the same
   *  neo4j-driver auth error otherwise. */
  hasSecret: boolean;
  /** Username we used to build the driver — useful in the diagnostic
   *  envelope so the operator can see which account auth was tried as. */
  username: string;
}

/**
 * Wrap a neo4j-driver call so the bare "client unauthorized" error
 * grows actionable context. Matches the auth-failure shape Bolt emits
 * (code "Neo.ClientError.Security.Unauthorized" / message starts
 * with "The client is unauthorized") so we don't accidentally
 * rewrite unrelated server-side errors.
 */
async function withNeo4jDiagnostics<T>(
  client: Neo4jHandle,
  op: () => Promise<T>
): Promise<T> {
  try {
    return await op();
  } catch (err) {
    const e = err as { code?: string; message?: string };
    const looksAuth =
      e?.code === "Neo.ClientError.Security.Unauthorized" ||
      /unauthor[iz]ed|authentication failure/i.test(e?.message ?? "");
    if (!looksAuth) throw err;
    const secretHint = client.hasSecret
      ? `password resolved through SecretProvider as user="${client.username}" but neo4j rejected it — verify the secret value matches the server's credentials`
      : `no secret was attached, so we tried Bolt's no-auth handshake — the server is refusing it, which means it requires authentication. Set secretRefKey on connection "${client.slug}" to the logical key of a managed secret holding the password (or a {"username","password"} JSON blob), or relaunch neo4j with NEO4J_AUTH=none for an anonymous install`;
    const wrapped = new Error(
      `neo4j auth failed on connection "${client.slug}": ${e.message ?? "unknown"}. ${secretHint}`
    );
    (wrapped as { cause?: unknown }).cause = err;
    throw wrapped;
  }
}

interface Neo4jConnectionOptions {
  uri?: string;
  database?: string;
  encrypted?: boolean;
  username?: string;
}

/** Parse the resolved secret into (username, password). The secret can be:
 *   - a raw password string (username defaults to `neo4j` or `options.username`)
 *   - a JSON `{"username":"...","password":"..."}` blob
 * No throw on malformed JSON — fall back to treating the raw value as a
 * password (matches the OpenSearch driver's accommodating posture).
 */
function parseNeo4jCredentials(
  secret: string | undefined,
  defaultUsername: string
): { username: string; password: string } {
  if (!secret) return { username: defaultUsername, password: "" };
  const trimmed = secret.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { username?: string; password?: string };
      return {
        username: parsed.username ?? defaultUsername,
        password: parsed.password ?? ""
      };
    } catch {
      /* fall through to raw-password */
    }
  }
  return { username: defaultUsername, password: trimmed };
}

export const neo4jConnectionDriver = defineConnectionDriverPlugin<Neo4jHandle>({
  kind: "neo4j",
  driver: {
    async create(conn) {
      const opts = (conn.options ?? {}) as Neo4jConnectionOptions;
      if (!opts.uri) {
        throw new Error(
          `neo4j connection "${conn.slug}" missing options.uri (e.g. bolt://host:7687)`
        );
      }
      const defaultUsername = opts.username ?? "neo4j";
      const hasSecret =
        typeof conn.secret === "string" && conn.secret.trim().length > 0;
      const { username, password } = hasSecret
        ? parseNeo4jCredentials(conn.secret, defaultUsername)
        : { username: defaultUsername, password: "" };
      const mod = (await import("neo4j-driver")) as {
        driver: (
          uri: string,
          authToken: unknown,
          config?: Record<string, unknown>
        ) => unknown;
        auth: {
          basic: (u: string, p: string) => unknown;
          // neo4j-driver doesn't expose a dedicated `none()` factory —
          // the canonical NoAuthToken is built via custom() with
          // scheme="none" (matches what the server expects for
          // anonymous Bolt handshakes against an auth-disabled
          // community instance).
          custom: (
            principal: string,
            credentials: string,
            realm: string,
            scheme: string
          ) => unknown;
        };
      };
      // No secret on the connection row → use Bolt's NoAuthToken.
      // This is the correct handshake for a neo4j-community instance
      // launched with `NEO4J_AUTH=none`. The previous behaviour sent
      // `auth.basic("neo4j", "")` which neither a no-auth server nor
      // an auth-enabled server accepts cleanly (auth-enabled rejects
      // empty password; some no-auth configs reject the basic scheme
      // outright). When the operator HAS set secretRefKey, we still
      // use basic auth — auth-enabled servers require it; no-auth
      // servers ignore it.
      const authToken = hasSecret
        ? mod.auth.basic(username, password)
        : mod.auth.custom("", "", "", "none");
      const driverInstance = mod.driver(
        opts.uri,
        authToken,
        opts.encrypted !== undefined
          ? { encrypted: opts.encrypted ? "ENCRYPTION_ON" : "ENCRYPTION_OFF" }
          : undefined
      );
      // Tag the handle with what we know about the credential
      // resolution so the run-time wrapper can re-throw auth failures
      // with actionable context ("server requires auth but no secret
      // was attached" vs "password is wrong").
      return {
        driver: driverInstance,
        database: opts.database ?? "neo4j",
        slug: conn.slug,
        hasSecret,
        username
      };
    },
    async dispose(client) {
      await client.driver.close().catch(() => undefined);
    },
    async probe(client) {
      // verifyConnectivity opens a session, runs a no-op handshake, and
      // throws on auth / DNS / TLS errors. It's the canonical liveness
      // check for the Bolt driver.
      await client.driver.verifyConnectivity();
    }
  },
  manifest: {
    displayName: "Neo4j",
    description:
      "Property-graph database. Bolt protocol via the official `neo4j-driver`. Used by neo4j_query / neo4j_write and (as the target binding) by cartography_crawl.",
    configSchema: {
      type: "object",
      required: ["uri"],
      properties: {
        uri: {
          type: "string",
          description:
            "Bolt URI, e.g. bolt://host:7687, neo4j://host:7687, or neo4j+s://host (encrypted). Required."
        },
        database: {
          type: "string",
          default: "neo4j",
          description: "Default database to open sessions against. Per-call override via plugin config."
        },
        encrypted: {
          type: "boolean",
          description:
            "Force TLS regardless of the URI scheme. Leave unset to let the URI decide (neo4j+s => on, bolt => off)."
        },
        username: {
          type: "string",
          default: "neo4j",
          description: "Default username (overridden when the resolved secret is a {username, password} JSON blob)."
        }
      },
      additionalProperties: false
    },
    secretSchema: {
      type: "string",
      description:
        "Password OR a JSON `{\"username\":\"...\",\"password\":\"...\"}` blob. Optional — no-auth installs are accepted."
    },
    // neo4j fills the "graph" binding for read/write plugins and the "target"
    // binding for cartography_crawl (which writes a working-graph). The
    // picker UI offers neo4j wherever those binding names appear on a
    // Dataset.
    datasetBindings: ["graph", "target"],
    transport: "in_process"
  }
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const CYPHER_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Defense against operator-supplied label/key being used to inject
 *  Cypher. The character class matches Cypher's unescaped identifier
 *  grammar; anything else is refused at execute-time.
 *
 *  Exported for unit tests.
 */
export function validateCypherIdentifier(value: string, role: string, pluginId: string): string {
  if (typeof value !== "string" || !CYPHER_IDENT.test(value)) {
    throw new Error(
      `${pluginId}: invalid ${role} "${value}" — must match /^[A-Za-z_][A-Za-z0-9_]*$/`
    );
  }
  return value;
}

/** Resolve the graph binding's `ResolvedExternalConnection` so the
 *  driver registry can hand back a pooled client. Throws a clear,
 *  actionable error when the dataset isn't bound or the binding's
 *  connection kind doesn't match. */
export function requireNeo4jConnection(
  input: PluginExecutionInput,
  binding: string,
  pluginId: string
): ResolvedExternalConnection {
  const b = input.dataset?.bindings?.[binding];
  if (!b?.connection) {
    const slug = input.dataset?.slug ?? "(no dataset bound)";
    throw new Error(
      `${pluginId} requires a "${binding}" binding on dataset "${slug}". ` +
        `Add a binding named "${binding}" on the Datasets screen pointing at a neo4j connection.`
    );
  }
  if (b.connection.kind !== "neo4j") {
    throw new Error(
      `${pluginId}: binding "${binding}" resolves to connection kind "${b.connection.kind}", expected "neo4j".`
    );
  }
  return b.connection;
}

/** Convert a neo4j-driver record to a plain JS object keyed by RETURN names.
 *
 *  Recursively unwraps Neo4j Integer (`{low, high}`) into JS numbers when
 *  they fit a 53-bit safe range, and Nodes/Relationships into their
 *  `properties` map (drop internal ids — they're not portable). Pure;
 *  exported for unit-test reach.
 */
export function unwrapNeo4jValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  // Neo4j Integer: {low: number, high: number, toNumber(), toString()}.
  const maybeInt = value as { low?: unknown; high?: unknown; toNumber?: () => number; toString?: () => string };
  if (
    typeof maybeInt.low === "number" &&
    typeof maybeInt.high === "number" &&
    typeof maybeInt.toNumber === "function"
  ) {
    try {
      return maybeInt.toNumber();
    } catch {
      return String(maybeInt);
    }
  }
  // Neo4j Node / Relationship: surface `properties` (drop element/identity
  // ids which leak the local index).
  const maybeEntity = value as { properties?: Record<string, unknown> };
  if (maybeEntity.properties && typeof maybeEntity.properties === "object") {
    return Object.fromEntries(
      Object.entries(maybeEntity.properties).map(([k, v]) => [k, unwrapNeo4jValue(v)])
    );
  }
  if (Array.isArray(value)) {
    return value.map(unwrapNeo4jValue);
  }
  const obj = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, unwrapNeo4jValue(v)])
  );
}

// ---------------------------------------------------------------------------
// neo4j_query — parameterised Cypher read
// ---------------------------------------------------------------------------

export const neo4jQueryPlugin: InProcessPlugin = {
  manifest: {
    id: "neo4j_query",
    name: "Neo4j Query",
    version: "1.0.0",
    category: "retriever",
    contract: 2,
    requires: [{ binding: "graph", kind: "neo4j" }],
    description:
      "Runs a parameterised Cypher query against a Neo4j connection and emits rows. Parameters are bound, never interpolated. The plugin resolves its driver via the dataset's `graph` binding (ADR-0023); no host/port appears in config.",
    configSchema: {
      type: "object",
      required: ["cypher"],
      properties: {
        cypher: {
          type: "string",
          description: "Cypher query. Use $name placeholders for parameters; do NOT concatenate user data."
        },
        params: {
          type: "object",
          description: "Default parameters merged with inputs.params (input wins). Each value is bound, never spliced."
        },
        database: {
          type: "string",
          description: "Optional database override — defaults to the connection's configured database."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      {
        name: "params",
        description: "Optional map of Cypher parameters merged onto config.params (input wins)."
      }
    ],
    outputPorts: [
      {
        name: "rows",
        description: "Array of records — each is a plain object keyed by RETURN names. Neo4j Integers unwrap to JS numbers; Nodes/Relationships surface as their properties map."
      }
    ],
    capabilities: ["query"],
    ui: {
      icon: "search",
      color: "#018bff",
      paletteGroup: "Graph",
      formHints: {
        cypher: { widget: "code" },
        params: { widget: "json" }
      }
    }
  },
  async execute(input) {
    const conn = requireNeo4jConnection(input, "graph", "neo4j_query");
    const client = await acquireClient<Neo4jHandle>(conn);
    const cypher = String((input.config as { cypher?: unknown }).cypher ?? "");
    if (!cypher.trim()) throw new Error("neo4j_query: `cypher` is required");
    const configParams =
      input.config.params && typeof input.config.params === "object"
        ? (input.config.params as Record<string, unknown>)
        : {};
    const inputParams =
      input.inputs.params && typeof input.inputs.params === "object"
        ? (input.inputs.params as Record<string, unknown>)
        : {};
    const params = { ...configParams, ...inputParams };
    const database = String(
      (input.config as { database?: unknown }).database ?? client.database
    );
    const session = client.driver.session({ database });
    try {
      const result = (await withNeo4jDiagnostics(
        client,
        () => session.run(cypher, params)
      )) as { records?: unknown };
      const records = (result.records ?? []) as Array<{
        keys: string[];
        get: (key: string) => unknown;
      }>;
      const rows = records.map((r) => {
        const obj: Record<string, unknown> = {};
        for (const key of r.keys) obj[key] = unwrapNeo4jValue(r.get(key));
        return obj;
      });
      return { outputs: { rows } };
    } finally {
      await session.close().catch(() => undefined);
    }
  }
};

// ---------------------------------------------------------------------------
// neo4j_write — idempotent batched MERGE
// ---------------------------------------------------------------------------

/** Build the upsert Cypher statement for a given (label, keyField). Pure +
 *  exported so unit tests can assert the wire shape without standing up
 *  Neo4j. Uses backticks around the validated identifiers so any future
 *  expansion of the allowed character set (e.g. Unicode) doesn't require
 *  more escaping.
 */
export function buildUpsertCypher(label: string, keyField: string): string {
  // Identifiers are validated up-front; backticks here are belt-and-braces
  // not a security measure.
  return (
    `UNWIND $rows AS row\n` +
    `MERGE (n:\`${label}\` { \`${keyField}\`: row[$keyField] })\n` +
    `SET n += row`
  );
}

export const neo4jWritePlugin: InProcessPlugin = {
  manifest: {
    id: "neo4j_write",
    name: "Neo4j Write",
    version: "1.0.0",
    category: "sink",
    contract: 2,
    requires: [{ binding: "graph", kind: "neo4j" }],
    description:
      "Idempotent upsert into Neo4j via UNWIND $rows + MERGE on a caller-supplied keyField. Re-running with the same rows is a no-op (no duplicate nodes). Rows are sent as bound parameters — Cypher is never string-concatenated with caller data.",
    configSchema: {
      type: "object",
      required: ["label", "keyField"],
      properties: {
        label: {
          type: "string",
          description:
            "Node label to MERGE under (e.g. `Observation`). Validated identifier — only [A-Za-z_][A-Za-z0-9_]* accepted to defend against Cypher injection."
        },
        keyField: {
          type: "string",
          description:
            "Property name to MERGE on. MUST be present on every row in the input — empty/missing values are rejected up front so a NULL key doesn't silently MERGE everything together."
        },
        database: {
          type: "string",
          description: "Optional database override — defaults to the connection's configured database."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      {
        name: "rows",
        required: true,
        description:
          "Array of records to upsert. Each MUST carry the configured keyField (non-null, non-empty); remaining fields are SET on the matched/created node via `SET n += row`."
      }
    ],
    outputPorts: [
      {
        name: "writtenCount",
        description: "Number of rows processed (created + matched). A re-run with identical input returns the same count and creates zero new nodes."
      }
    ],
    capabilities: ["sink"],
    ui: {
      icon: "database",
      color: "#018bff",
      paletteGroup: "Graph",
      formHints: {
        label: { widget: "text" },
        keyField: { widget: "text" }
      }
    }
  },
  async execute(input) {
    const conn = requireNeo4jConnection(input, "graph", "neo4j_write");
    const label = validateCypherIdentifier(
      String((input.config as { label?: unknown }).label ?? ""),
      "label",
      "neo4j_write"
    );
    const keyField = validateCypherIdentifier(
      String((input.config as { keyField?: unknown }).keyField ?? ""),
      "keyField",
      "neo4j_write"
    );
    const rows = Array.isArray(input.inputs.rows)
      ? (input.inputs.rows as Array<Record<string, unknown>>)
      : [];
    if (rows.length === 0) return { outputs: { writtenCount: 0 } };
    // Up-front validation: every row carries the key, non-empty. Cheaper
    // to fail loudly here than to send a 100k batch and let Neo4j silently
    // skip every row whose key is missing.
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(row, keyField)) {
        throw new Error(
          `neo4j_write: rows[${i}] is missing required keyField "${keyField}".`
        );
      }
      const v = row[keyField];
      if (v === null || v === undefined || v === "") {
        throw new Error(
          `neo4j_write: rows[${i}].${keyField} is empty — refusing to MERGE on a null key.`
        );
      }
    }
    const client = await acquireClient<Neo4jHandle>(conn);
    const database = String(
      (input.config as { database?: unknown }).database ?? client.database
    );
    const cypher = buildUpsertCypher(label, keyField);
    const session = client.driver.session({ database });
    try {
      await withNeo4jDiagnostics(client, () => session.run(cypher, { rows, keyField }));
      return { outputs: { writtenCount: rows.length } };
    } finally {
      await session.close().catch(() => undefined);
    }
  }
};
