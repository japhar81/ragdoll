# ADR 0025: Neo4j connection driver + property-graph plugins

## Status

**Accepted + implemented** (commit follows this ADR). Fills the
graph-driver gap beside `dgraph` so consumers (notably the bulwark
security workbench, which uses RAGdoll as its ingestion / orchestration
substrate) can wire Neo4j-backed working-graphs without reaching for a
sidecar.

Companion: [ADR 0024 — Connection Drivers as Plugins](./0024-connection-drivers-as-plugins.md).

## Context

ADR-0024 established that connection drivers ship as plugin manifests
loaded through the standard module scan. Today the catalog covers
postgres / mongodb / clickhouse / qdrant / opensearch / dgraph. **Neo4j
was absent**, leaving the only property-graph driver (Dgraph) usable
for graph-shaped use cases. Two concrete pulls forced the fill:

1. **bulwark composition.** bulwark's infrastructure-crawl pipeline
   needs a "working-graph" Cartography populates (Cartography natively
   targets Neo4j) and a "spine graph" where mapped observations land.
   Both are property-graph workloads — Dgraph's typed predicates +
   reverse edges aren't the right ergonomics.
2. **Graph diversity.** Operators already running Neo4j shouldn't have
   to stand up Dgraph to use RAGdoll for graph retrieval / ingest. The
   plugin contract is binding-shaped (ADR-0023 §3), so a parallel
   driver family slots in without touching anything that consumes
   `binding: graph`.

## Proposal

### 1. `neo4j` connection driver

`category: connection_driver`, `kind: neo4j`, shipped as a
`ConnectionDriverPlugin` discovered by the loader scan. Same lifecycle
contract as the other drivers:

- `configSchema` — non-secret per-row config: `uri` (Bolt URI,
  required), `database?`, `encrypted?`, `username?` (default `neo4j`).
- `secretSchema` — the credential. Accepted shapes: a raw password
  string (username defaults to `options.username` or `neo4j`), OR a
  JSON `{"username":"…","password":"…"}` blob. No-auth installs are
  legal (empty secret).
- `probe(client)` — `driver.verifyConnectivity()`. The canonical Bolt
  liveness check; surfaces auth / DNS / TLS errors.
- `acquire(connection)` — lazy-imports `neo4j-driver` (added to root
  `package.json` deps; unit tests stay install-free because the import
  only fires when `acquire()` is actually called), builds a Driver
  with the parsed credentials, and returns a `Neo4jHandle` (driver +
  default database).
- `dispose(client)` — `driver.close()`.

The driver's `datasetBindings: ["graph", "target"]` lets the dataset
binding picker offer `neo4j` wherever those binding names appear on a
Dataset — `graph` for the read/write plugins below, `target` for the
Cartography crawler.

### 2. `neo4j_query` — read tool

`category: retriever`, `contract: 2`,
`requires: [{ binding: "graph", kind: "neo4j" }]`.

- `configSchema`: `cypher` (required), `params?` (default parameters),
  `database?` (per-call override).
- `inputPorts.params` is merged onto `config.params` (input wins).
- Parameters are bound via the Bolt driver's positional-binding —
  values never reach the Cypher source text. The plugin's only
  string-splicing is the (validated) per-call `database` name.
- `outputPorts.rows` — array of plain objects keyed by RETURN names.
  Neo4j Integer values unwrap to JS numbers when safe; Nodes /
  Relationships surface as their `properties` map (internal ids
  dropped, since they leak the local-store index and aren't portable).

### 3. `neo4j_write` — idempotent batched upsert

`category: sink`, `contract: 2`,
`requires: [{ binding: "graph", kind: "neo4j" }]`.

The wire shape is one batched MERGE per call:

```cypher
UNWIND $rows AS row
MERGE (n:`<label>` { `<keyField>`: row[$keyField] })
SET n += row
```

- `label` + `keyField` are validated against
  `/^[A-Za-z_][A-Za-z0-9_]*$/` BEFORE any Cypher is sent — the only
  splice path is closed against injection.
- Rows are sent as bound parameters (`$rows`); no row data appears in
  the source text.
- Up-front per-row validation: every row MUST carry the configured
  `keyField` with a non-null, non-empty value, OR the call is refused
  with the offending row index. Without this guard a NULL key would
  silently MERGE everything together — loud here.
- Re-running with byte-identical input is a no-op at the storage
  layer (the MERGE de-dupes on the configured key) — that's the
  idempotency contract bulwark composes against.

### 4. `cartography_crawl` — third crawler block

Sibling to the two web crawlers (`crawl4ai_crawler`, `scrapy_spider`).
`category: datasource`, `contract: 2`,
`requires: [{ binding: "target", kind: "neo4j" }]`.

Launches [Cartography](https://github.com/cartography-cncf/cartography)
against the bound Neo4j connection. The plugin owns:

- Binding resolution (the target Neo4j the operator chose at compose
  time — bulwark wires `target=working-graph` per their composition).
- Secret resolution for the cloud credentials (`credsSecretRef` →
  `input.secrets.<ref>`; falls back to `input.secrets.creds`).
- Argv assembly for the `cartography` CLI: `sync --selected-modules
  <list>` + per-module account selectors mapped to `--<module>-<flag>`
  pairs + `--update-tag <ts>` when `incremental: true`.
- Env injection — `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` (so
  Cartography reads its target connection without seeing secrets via
  argv) + `CARTOGRAPHY_CREDS` carrying the resolved cloud creds.
- Subprocess lifecycle (`spawn` with bounded stdout/stderr capture,
  `SIGTERM` on timeout).

Two runners:
- `subprocess` (default) — spawns `cartography` inside the
  python-plugins sidecar (ADR-0026), where cartography is installed as
  a Python dep. The Node plugin is now a thin manifest + external
  registration; the actual handler lives in
  `services/python-plugins/app/plugins/cartography_crawl_plugin.py`.
- `dry-run` — returns synthetic metadata for each requested module;
  doesn't touch Neo4j or invoke the binary. Used by the offline e2e
  test and by the Builder's preview affordance.

The Node side **never bundles Cartography**: the binary lives in the
python-plugins image (declared in
`services/python-plugins/pyproject.toml`). If the sidecar isn't
reachable or the binary is missing, the handler raises an actionable
error and the node fails loudly — see ADR-0026 §#2 for the rationale
(previous behaviour silently swallowed the spawn failure).

**Wiring cloud credentials (operators read this).** Cloud credentials
need TWO things on the spec node — `config.credsSecretRef` alone is
not enough:

```jsonc
{
  "id": "crawl",
  "plugin": { "category": "datasource", "id": "cartography_crawl", "version": "1.0.0" },
  "dataset": { "slug": "<a dataset with a neo4j binding on `target`>" },
  "config": {
    "modules": ["aws"],
    "credsSecretRef": "aws-prod"   // logical name the plugin reads from input.secrets
  },
  "secrets": {                      // THIS is what makes the runtime resolve it
    "aws-prod": { "scope": "tenant", "key": "AWS_PROD_CREDS" }
  }
}
```

Without the `node.secrets` block, the runtime's SecretProvider never
resolves anything for this node, `input.secrets` arrives empty, the
plugin can't find the entry named by `credsSecretRef`, cartography
runs with no cloud env vars, boto3's default credential chain finds
nothing, and cartography exits 0 silently having done zero work.

The plugin surfaces this gap on the execution trace as
`metadata.credsWarning`, alongside a generic
`metadata.warning` whenever the cartography stdout/stderr shows no
sync activity (no `Syncing X for account Y` lines). The full output
tails come back as `metadata.cartographyStdoutTail` and
`metadata.cartographyStderrTail` (capped at 2KB each) so the operator
can confirm what cartography itself reported.

The secret value is a `.env`-style block (one `KEY=VALUE` per line);
the plugin parses each line and exports it into cartography's
subprocess environment. For AWS:

```
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_DEFAULT_REGION=us-east-1
```

A real cartography sync of a populated account takes minutes — a 7s
"success" is the canonical "no creds reached the subprocess" signal.

### 5. Destructive-sync posture

Cartography sets a sync tag and deletes nodes that weren't seen on the
current run. **The plugin must never be pointed at a graph holding
non-Cartography data** — but enforcing that is the caller's binding
choice; the block just writes where bound. The composition pattern
bulwark uses (per their spec): Cartography → working-graph (dedicated,
destructive-sync owned by the crawler); query+map → spine graph (the
caller's long-lived state). Two bindings, two graphs, two roles.

## Migration / back-compat

- New code only. Nothing renamed; no existing manifest's `requires`
  shape changes.
- The `neo4j-driver` npm dep is added at the root. Lazy-imported on
  first `acquire()` so it has no impact on unit tests / startup until
  an operator actually mints a neo4j connection.
- ADR-0023's binding shape is the contract; `binding: graph` matches
  any `kind` declared on the Dataset's `graph` binding, so a dataset
  author can swap a dgraph-backed Dataset for a neo4j-backed one
  without touching pipeline specs.

## Alternatives considered

1. **Reuse the dgraph driver.** Dgraph speaks DQL; Neo4j speaks
   Cypher. Different query languages, different SDK shapes, different
   typed-edge semantics. Reuse isn't on the table.
2. **External sidecar.** The other crawlers (crawl4ai, scrapy) ship as
   Connect-RPC sidecars because they're heavyweight Python tools.
   `neo4j-driver` is a 3 MB npm package and stays in-process for the
   same reason `mongodb` does — a sidecar would add a network hop
   between the worker and the driver for no obvious benefit. The same
   `transport: "external"` option remains available for operators who
   want to host Neo4j-talking plugins out-of-process later.
3. **Bundle Cartography.** Cartography is ~150 MB of Python deps with
   its own release cadence; bundling it would balloon the worker
   image and create a versioning footgun for operators who already
   have a pinned Cartography deployment. The contract instead is
   "Cartography lives on the worker PATH; the plugin orchestrates
   it." Same pattern as a future `terraform_plan` plugin.

## Consequences

- Operators with existing Neo4j get RAGdoll graph retrieval / ingest
  for free.
- bulwark's composition (`cartography_crawl(target=working) →
  neo4j_query(graph=working) → transform → neo4j_write(graph=spine)`)
  is supported by leaves RAGdoll ships; bulwark owns the wiring +
  schedule + mapping config.
- The graph-driver list grows from one (dgraph) to two — plugin docs +
  the dataset binding picker now route real choice through the same
  `binding: graph` slot.
- `neo4j-driver` joins `mongodb` and `@clickhouse/client` as
  per-family-lazy-imported deps; unit-test install footprint
  unchanged.
- Cartography integration is in-tree but operationally external: the
  binary is the operator's responsibility, the orchestration is ours.

## References

- ADR 0019 — Plugin Contract v2.
- ADR 0022 — Connect RPC plugin transport.
- ADR 0023 — Unified Connections Registry (binding shape).
- ADR 0024 — Connection Drivers as Plugins (driver-loading side).
- Cartography — https://github.com/cartography-cncf/cartography.
