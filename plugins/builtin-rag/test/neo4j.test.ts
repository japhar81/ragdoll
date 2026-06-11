/**
 * Neo4j family unit tests (ADR-0025). Offline: no real Neo4j needed —
 * the `neo4j-driver` import is replaced by a stub Driver registered
 * directly into the connection-driver registry so we exercise the
 * plugin code paths end-to-end (manifest validation, binding
 * resolution, parameter binding, idempotency-via-Cypher-shape,
 * identifier-injection refusal).
 *
 * What we don't cover here: real Bolt protocol exchange. That lives in
 * the gated e2e test (tests/e2e/neo4j-stub-pipeline.e2e.test.ts) and
 * is skipped when NEO4J_TEST_URI is unset.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  neo4jConnectionDriver,
  neo4jQueryPlugin,
  neo4jWritePlugin,
  validateCypherIdentifier,
  buildUpsertCypher,
  unwrapNeo4jValue
} from "../src/neo4j.ts";
import {
  registerConnectionDriver,
  resetConnectionRegistry,
  type ResolvedExternalConnection
} from "../../../packages/external-connections/src/index.ts";
import type {
  PluginExecutionInput,
  PluginExecutionOutput,
  ResolvedDataset
} from "../../../packages/plugin-sdk/src/index.ts";
import type { RuntimeContext } from "../../../packages/core/src/index.ts";

// ---------------------------------------------------------------------------
// Stub Driver — mimics the neo4j-driver shape we touch (session().run()).
// ---------------------------------------------------------------------------

interface FakeRecord {
  keys: string[];
  values: Record<string, unknown>;
}

interface FakeRunCall {
  cypher: string;
  params: Record<string, unknown>;
  database?: string;
}

class FakeDriver {
  closed = false;
  verifyCalls = 0;
  runCalls: FakeRunCall[] = [];
  // Map of `cypher → records` so tests can pre-seed deterministic
  // responses without simulating real Neo4j semantics.
  responses = new Map<string, FakeRecord[]>();

  session(opts: { database?: string }): {
    run: (cypher: string, params: Record<string, unknown>) => Promise<{ records: Array<{ keys: string[]; get: (k: string) => unknown }> }>;
    close: () => Promise<void>;
  } {
    const driver = this;
    return {
      async run(cypher, params) {
        driver.runCalls.push({ cypher, params, database: opts.database });
        const records = (driver.responses.get(cypher) ?? []).map((r) => ({
          keys: r.keys,
          get: (k: string) => r.values[k]
        }));
        return { records };
      },
      async close() {
        /* no-op */
      }
    };
  }

  async verifyConnectivity(): Promise<void> {
    this.verifyCalls += 1;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function registerStubNeo4jDriver(driver: FakeDriver): void {
  registerConnectionDriver(
    "neo4j",
    {
      async create() {
        return { driver, database: "stub-db" };
      },
      async dispose(client) {
        const c = client as { driver: FakeDriver };
        await c.driver.close();
      },
      async probe(client) {
        const c = client as { driver: FakeDriver };
        await c.driver.verifyConnectivity();
      }
    },
    {
      displayName: "Neo4j (stub)",
      configSchema: { type: "object", properties: {}, additionalProperties: true },
      datasetBindings: ["graph", "target"],
      transport: "in_process"
    }
  );
}

function fakeContext(tenantId = "t-1"): RuntimeContext {
  return {
    requestId: "r",
    executionId: "e-1",
    tenantId,
    pipelineId: "p",
    pipelineVersionId: "v1",
    environment: "dev",
    resolvedConfig: {
      pipelineId: "p",
      tenantId,
      environment: "dev",
      violations: [],
      values: {}
    }
  };
}

function fakeNeo4jConn(slug = "test-neo4j"): ResolvedExternalConnection {
  return {
    id: `conn-${slug}`,
    slug,
    kind: "neo4j",
    options: { uri: "bolt://stub:7687", database: "stub-db" },
    cascadeReason: "tenant"
  };
}

function fakeNeo4jDataset(binding: string, opts: { wrongKind?: boolean } = {}): ResolvedDataset {
  const conn = opts.wrongKind
    ? { ...fakeNeo4jConn(), kind: "qdrant" }
    : fakeNeo4jConn();
  return {
    id: "ds-test",
    slug: "test",
    scope: "global",
    embeddingProfile: {},
    chunkSchema: {},
    version: { id: "v1", versionLabel: "v1", status: "ready" },
    bindings: {
      [binding]: {
        connectionSlug: conn.slug,
        connectionKind: conn.kind,
        connectionHost: "stub",
        connectionPort: 7687,
        cascadeReason: "tenant",
        connection: conn
      }
    }
  };
}

function runPlugin(
  plugin: typeof neo4jQueryPlugin,
  args: {
    inputs?: Record<string, unknown>;
    config?: Record<string, unknown>;
    dataset?: ResolvedDataset;
  } = {}
): Promise<PluginExecutionOutput> {
  const input: PluginExecutionInput = {
    context: fakeContext(),
    node: {
      id: "n",
      plugin: {
        category: plugin.manifest.category,
        id: plugin.manifest.id,
        version: "1.0.0"
      }
    },
    inputs: args.inputs ?? {},
    config: args.config ?? {},
    secrets: {},
    dataset: args.dataset
  };
  return plugin.execute(input);
}

// ---------------------------------------------------------------------------
// Manifest-shape sanity checks (cheap, catches drift)
// ---------------------------------------------------------------------------

test("neo4jConnectionDriver: manifest declares kind, schema-driven form, and the right binding slots", () => {
  assert.equal(neo4jConnectionDriver.kind, "neo4j");
  assert.equal(neo4jConnectionDriver.manifest.category, "connection_driver");
  assert.equal(neo4jConnectionDriver.driverManifest.displayName, "Neo4j");
  assert.deepEqual(
    neo4jConnectionDriver.driverManifest.datasetBindings,
    ["graph", "target"],
    "graph for neo4j_query/write, target for cartography_crawl"
  );
  // configSchema requires the URI so the Connections form can't save a
  // half-configured driver row.
  const cfg = neo4jConnectionDriver.driverManifest.configSchema as { required?: string[] };
  assert.ok(cfg.required?.includes("uri"));
});

test("neo4j_query: manifest declares binding requirement + Cypher form hint", () => {
  const m = neo4jQueryPlugin.manifest;
  assert.equal(m.id, "neo4j_query");
  assert.equal(m.category, "retriever");
  assert.equal(m.contract, 2);
  assert.deepEqual(m.requires, [{ binding: "graph", kind: "neo4j" }]);
  // configSchema requires cypher; host/port/url fields must NOT appear
  // (ADR-0023: connection is dataset-bound).
  const cfg = m.configSchema as { properties?: Record<string, unknown>; required?: string[] };
  assert.ok(cfg.required?.includes("cypher"));
  assert.equal(cfg.properties?.uri, undefined);
  assert.equal(cfg.properties?.host, undefined);
});

test("neo4j_write: manifest declares idempotent contract via label + keyField", () => {
  const m = neo4jWritePlugin.manifest;
  assert.equal(m.id, "neo4j_write");
  assert.equal(m.category, "sink");
  assert.deepEqual(m.requires, [{ binding: "graph", kind: "neo4j" }]);
  const cfg = m.configSchema as { required?: string[] };
  assert.deepEqual(cfg.required?.sort(), ["keyField", "label"]);
});

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit-test reach.
// ---------------------------------------------------------------------------

test("validateCypherIdentifier: refuses anything outside Cypher's bare-identifier grammar", () => {
  // Legal.
  assert.equal(validateCypherIdentifier("Observation", "label", "neo4j_write"), "Observation");
  assert.equal(validateCypherIdentifier("snake_case_42", "keyField", "neo4j_write"), "snake_case_42");
  assert.equal(validateCypherIdentifier("_leading_underscore", "label", "neo4j_write"), "_leading_underscore");
  // Illegal — every injection vector we care about.
  for (const bad of [
    "0LeadingDigit",
    "with space",
    "with-dash",
    "back`tick",
    "quoted'name",
    "ends; DROP TABLE foo",
    "",
    "a\nb"
  ]) {
    assert.throws(
      () => validateCypherIdentifier(bad, "label", "neo4j_write"),
      /invalid label/,
      `expected "${bad}" to be rejected`
    );
  }
});

test("buildUpsertCypher: emits a single UNWIND/MERGE with backticked identifiers", () => {
  const cypher = buildUpsertCypher("Observation", "id");
  assert.match(cypher, /UNWIND \$rows AS row/);
  assert.match(cypher, /MERGE \(n:`Observation` \{ `id`: row\[\$keyField\] \}\)/);
  assert.match(cypher, /SET n \+= row/);
  // Crucially: ZERO occurrences of the row data itself in the source text.
  // Everything user-supplied flows via parameters.
  assert.equal(cypher.includes("$rows"), true);
  assert.equal(cypher.includes("$keyField"), true);
});

test("unwrapNeo4jValue: collapses Neo4j Integer / Node into JS-native shapes", () => {
  // Neo4j Integer
  assert.equal(unwrapNeo4jValue({ low: 42, high: 0, toNumber: () => 42 }), 42);
  // Neo4j Node
  assert.deepEqual(
    unwrapNeo4jValue({ identity: 7, properties: { name: "x", count: { low: 3, high: 0, toNumber: () => 3 } } }),
    { name: "x", count: 3 }
  );
  // Nested arrays.
  assert.deepEqual(unwrapNeo4jValue([1, { low: 2, high: 0, toNumber: () => 2 }, "x"]), [1, 2, "x"]);
  // Plain values pass through.
  assert.equal(unwrapNeo4jValue("hello"), "hello");
  assert.equal(unwrapNeo4jValue(null), null);
  assert.equal(unwrapNeo4jValue(undefined), undefined);
});

// ---------------------------------------------------------------------------
// neo4j_query — binding resolution + parameter binding
// ---------------------------------------------------------------------------

test("neo4j_query: refuses to run without a graph binding (clear, actionable error)", async () => {
  resetConnectionRegistry();
  registerStubNeo4jDriver(new FakeDriver());
  await assert.rejects(
    runPlugin(neo4jQueryPlugin, {
      config: { cypher: "RETURN 1" },
      dataset: undefined
    }),
    /requires a "graph" binding/
  );
});

test("neo4j_query: refuses to run when the binding's connection kind isn't neo4j", async () => {
  resetConnectionRegistry();
  registerStubNeo4jDriver(new FakeDriver());
  await assert.rejects(
    runPlugin(neo4jQueryPlugin, {
      config: { cypher: "RETURN 1" },
      dataset: fakeNeo4jDataset("graph", { wrongKind: true })
    }),
    /expected "neo4j"/
  );
});

test("neo4j_query: refuses to run without a cypher string", async () => {
  resetConnectionRegistry();
  registerStubNeo4jDriver(new FakeDriver());
  await assert.rejects(
    runPlugin(neo4jQueryPlugin, { config: {}, dataset: fakeNeo4jDataset("graph") }),
    /cypher` is required/
  );
});

test("neo4j_query: binds params (config + input merged) and emits rows mapped from records", async () => {
  resetConnectionRegistry();
  const driver = new FakeDriver();
  driver.responses.set("MATCH (n:Person {name: $name}) RETURN n.name AS name, n.age AS age", [
    { keys: ["name", "age"], values: { name: "Ada", age: 36 } },
    { keys: ["name", "age"], values: { name: "Grace", age: 85 } }
  ]);
  registerStubNeo4jDriver(driver);

  const result = await runPlugin(neo4jQueryPlugin, {
    inputs: { params: { name: "Ada" } }, // input wins
    config: {
      cypher: "MATCH (n:Person {name: $name}) RETURN n.name AS name, n.age AS age",
      params: { name: "WILL-BE-OVERRIDDEN" }
    },
    dataset: fakeNeo4jDataset("graph")
  });

  assert.deepEqual(result.outputs.rows, [
    { name: "Ada", age: 36 },
    { name: "Grace", age: 85 }
  ]);
  // Parameter binding: the run call carries `name: "Ada"`, the input value.
  assert.equal(driver.runCalls.length, 1);
  assert.deepEqual(driver.runCalls[0].params, { name: "Ada" });
});

test("neo4j_query: returns [] when the cypher matches nothing (no throw on empty result)", async () => {
  resetConnectionRegistry();
  registerStubNeo4jDriver(new FakeDriver());
  const result = await runPlugin(neo4jQueryPlugin, {
    config: { cypher: "MATCH (n:Nothing) RETURN n" },
    dataset: fakeNeo4jDataset("graph")
  });
  assert.deepEqual(result.outputs.rows, []);
});

// ---------------------------------------------------------------------------
// neo4j_write — idempotency + identifier hardening
// ---------------------------------------------------------------------------

test("neo4j_write: empty rows returns writtenCount=0 and issues NO cypher", async () => {
  resetConnectionRegistry();
  const driver = new FakeDriver();
  registerStubNeo4jDriver(driver);
  const result = await runPlugin(neo4jWritePlugin, {
    inputs: { rows: [] },
    config: { label: "Observation", keyField: "id" },
    dataset: fakeNeo4jDataset("graph")
  });
  assert.equal(result.outputs.writtenCount, 0);
  assert.equal(driver.runCalls.length, 0);
});

test("neo4j_write: invalid label / keyField are refused BEFORE any cypher fires", async () => {
  resetConnectionRegistry();
  const driver = new FakeDriver();
  registerStubNeo4jDriver(driver);
  await assert.rejects(
    runPlugin(neo4jWritePlugin, {
      inputs: { rows: [{ id: "x" }] },
      config: { label: "DROP TABLE x", keyField: "id" },
      dataset: fakeNeo4jDataset("graph")
    }),
    /invalid label/
  );
  await assert.rejects(
    runPlugin(neo4jWritePlugin, {
      inputs: { rows: [{ id: "x" }] },
      config: { label: "Observation", keyField: "key`field" },
      dataset: fakeNeo4jDataset("graph")
    }),
    /invalid keyField/
  );
  assert.equal(driver.runCalls.length, 0, "no cypher should have been sent");
});

test("neo4j_write: rows missing the keyField are rejected up-front (per-row index in error)", async () => {
  resetConnectionRegistry();
  const driver = new FakeDriver();
  registerStubNeo4jDriver(driver);
  await assert.rejects(
    runPlugin(neo4jWritePlugin, {
      inputs: { rows: [{ id: "a" }, { name: "no-id" }] },
      config: { label: "Observation", keyField: "id" },
      dataset: fakeNeo4jDataset("graph")
    }),
    /rows\[1\] is missing required keyField "id"/
  );
  // Empty/null keys are also refused — defends against NULL-MERGE-merges-everything.
  await assert.rejects(
    runPlugin(neo4jWritePlugin, {
      inputs: { rows: [{ id: "a" }, { id: "" }] },
      config: { label: "Observation", keyField: "id" },
      dataset: fakeNeo4jDataset("graph")
    }),
    /rows\[1\]\.id is empty/
  );
  assert.equal(driver.runCalls.length, 0);
});

test("neo4j_write: issues ONE UNWIND/MERGE Cypher carrying rows as bound parameters", async () => {
  resetConnectionRegistry();
  const driver = new FakeDriver();
  registerStubNeo4jDriver(driver);
  const rows = [
    { id: "obs-1", title: "first" },
    { id: "obs-2", title: "second" }
  ];
  const result = await runPlugin(neo4jWritePlugin, {
    inputs: { rows },
    config: { label: "Observation", keyField: "id" },
    dataset: fakeNeo4jDataset("graph")
  });
  assert.equal(result.outputs.writtenCount, 2);
  assert.equal(driver.runCalls.length, 1, "exactly one batched call");
  const call = driver.runCalls[0];
  assert.match(call.cypher, /UNWIND \$rows AS row/);
  assert.match(call.cypher, /MERGE \(n:`Observation`/);
  // The whole row set is parameter-bound — the cypher source text has
  // none of the row data inlined.
  assert.deepEqual(call.params, { rows, keyField: "id" });
  assert.equal(call.cypher.includes("first"), false);
  assert.equal(call.cypher.includes("obs-1"), false);
});

test("neo4j_write idempotency: running the SAME rows twice produces the same observable behaviour", async () => {
  // Real Neo4j's MERGE is idempotent by definition; the plugin's
  // responsibility is to (a) issue the right MERGE shape every time and
  // (b) return a deterministic writtenCount. Both runs hit the stub
  // driver with byte-identical cypher + params, which is what the runtime
  // contract guarantees.
  resetConnectionRegistry();
  const driver = new FakeDriver();
  registerStubNeo4jDriver(driver);
  const rows = [
    { id: "obs-1", title: "first" },
    { id: "obs-2", title: "second" }
  ];
  const first = await runPlugin(neo4jWritePlugin, {
    inputs: { rows },
    config: { label: "Observation", keyField: "id" },
    dataset: fakeNeo4jDataset("graph")
  });
  const second = await runPlugin(neo4jWritePlugin, {
    inputs: { rows },
    config: { label: "Observation", keyField: "id" },
    dataset: fakeNeo4jDataset("graph")
  });
  assert.equal(first.outputs.writtenCount, second.outputs.writtenCount);
  assert.equal(driver.runCalls.length, 2);
  // Byte-identical cypher + params → real Neo4j's MERGE de-dupes
  // automatically (idempotent contract).
  assert.equal(driver.runCalls[0].cypher, driver.runCalls[1].cypher);
  assert.deepEqual(driver.runCalls[0].params, driver.runCalls[1].params);
});

// ---------------------------------------------------------------------------
// Driver lifecycle — probe / dispose
// ---------------------------------------------------------------------------

test("neo4jConnectionDriver: probe routes through verifyConnectivity (driver-shape sanity)", async () => {
  resetConnectionRegistry();
  const driver = new FakeDriver();
  registerStubNeo4jDriver(driver);
  // Trigger the registry's probe path via the same code the periodic
  // probe sweep uses: acquire then call probe on the registered factory.
  const { probeConnection } = await import("../../../packages/external-connections/src/index.ts");
  const conn = fakeNeo4jConn();
  const result = await probeConnection(conn);
  assert.equal(result.ok, true);
  assert.equal(driver.verifyCalls, 1);
});

test("neo4jConnectionDriver: secret-present → basic auth, secret-absent → Bolt no-auth (community + NEO4J_AUTH=none)", async () => {
  // The bug bulwark hit: connection rows with no secretRefKey produced
  // `auth.basic("neo4j", "")`, which neither an auth-enabled server
  // nor a no-auth community server accepts cleanly. The fix routes
  // through `auth.custom("","","" ,"none")` (the canonical no-auth
  // handshake) when the connection has no resolved secret.
  //
  // We exercise the REAL driver factory (not the FakeDriver stub) by
  // calling its `create()` and inspecting the constructed handle's
  // `hasSecret` flag — same flag the diagnostic wrapper branches on.
  const { neo4jConnectionDriver } = await import("../src/neo4j.ts");
  const withSecret = await neo4jConnectionDriver.driver.create({
    id: "c-1",
    slug: "with-secret",
    kind: "neo4j",
    secret: "hunter2",
    options: { uri: "bolt://stub:7687" },
    cascadeReason: "tenant"
  });
  assert.equal((withSecret as { hasSecret: boolean }).hasSecret, true);
  const withoutSecret = await neo4jConnectionDriver.driver.create({
    id: "c-2",
    slug: "no-secret",
    kind: "neo4j",
    // no `secret` — neo4j-community with NEO4J_AUTH=none scenario
    options: { uri: "bolt://stub:7687" },
    cascadeReason: "tenant"
  });
  assert.equal((withoutSecret as { hasSecret: boolean }).hasSecret, false);
  // Sanity-check the auth shape we picked is the one neo4j-driver
  // recognises as NoAuth. Done once via the real package, not via the
  // dynamic import in the driver factory.
  const neo4j = (await import("neo4j-driver")) as {
    auth: { custom: (p: string, c: string, r: string, s: string) => unknown };
  };
  const token = neo4j.auth.custom("", "", "", "none");
  assert.deepEqual(
    token,
    { scheme: "none", principal: "" },
    "auth.custom('','','' ,'none') must produce the canonical Bolt NoAuthToken"
  );
});

test("neo4jConnectionDriver: dispose closes the underlying driver", async () => {
  resetConnectionRegistry();
  const driver = new FakeDriver();
  registerStubNeo4jDriver(driver);
  const { acquireClient, closeClient } = await import("../../../packages/external-connections/src/index.ts");
  const conn = fakeNeo4jConn("disposeable");
  await acquireClient(conn);
  await closeClient(conn.id);
  assert.equal(driver.closed, true);
});
