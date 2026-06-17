# ADR 0033: CloudQuery as a transport plugin — RAGdoll pulls, bulwark maps

## Status

**Accepted + implemented (Z6a).** `cloudquery_aws_sync` source plugin
shipped as an external, out-of-process plugin in the python-plugins
sidecar; the AWS source plugin's rows land in the existing Postgres
target via cloudquery's native sink. Companion changes on bulwark's
side (Z4 adapter + Z6 merge) author the pipeline + read the rows back.

Companions:
- [ADR 0022 — Connect-RPC plugin transport (the wire this rides)](./0022-connect-rpc-plugin-transport.md)
- [ADR 0024 — Connection drivers as plugins](./0024-connection-drivers-as-plugins.md)
- [ADR 0025 — Neo4j driver + cartography in the python sidecar (the
  prior external-plugin example this mirrors)](./0025-neo4j-driver.md)

## Context

bulwark's Z6 ("Route exists?") correlation needs AWS route-table
evidence. The proven way to land per-account, per-region, vendor-
schema-stable route data into the bulwark-owned Postgres is
**cloudquery** — its AWS source plugin emits exactly the shape Z4's
adapter wants, and its native Postgres destination plugin owns the
destination DDL. Both halves are battle-tested upstream.

The temptation when wiring a new data source is to write a bespoke
ingestion plugin in Node, reach for the AWS SDK, and shape the rows
to whatever the consumer wants. We are deliberately NOT doing that.
The reasons:

1. **Seam.** bulwark AUTHORS pipeline definitions and owns the
   canonical mapping (`aws_ec2_route_tables` rows → RouteTable
   nodes — Z4) and the multi-source merge (`Route exists?` — Z6).
   RAGdoll is just the transport — pipeline executor + plugin
   registry + plumbing. If RAGdoll started reasoning about route
   tables, we'd have two systems with overlapping authority over
   the same domain, and any drift between them becomes a bug class
   that's invisible until prod.
2. **Schema stability.** cloudquery's AWS source plugin tracks
   AWS's API surface as part of its maintenance — that's its job.
   Reproducing it in-house means owning a moving target.
3. **Image hygiene.** cloudquery is a Go binary. Pulling it (or a
   Go bridge) into the Node worker conflates the worker's
   responsibilities, inflates the image, and pulls Go-specific
   surface into the runtime. We already have a clean place for
   CLI-shaped data sources — the python-plugins sidecar where
   cartography lives.

## Decisions

### 1. Transport-only plugin (RAGdoll's role)

`cloudquery_aws_sync` is a **source plugin** whose responsibility
ends at "rows are in Postgres." Concretely it:

- runs `cloudquery sync <spec>` (CloudQuery's AWS source → Postgres
  destination) with the operator-supplied scope (tables, regions,
  account),
- parses per-table row counts from cloudquery's structured log
  output,
- reports a sync envelope on `outputs.metadata` (table counts,
  duration, exit code, stdout/stderr tails for the trace).

It does NOT:

- transform rows into RouteTable / Route / canonical-node shapes —
  bulwark's Z4 adapter maps from cloudquery's native schema
  directly,
- merge across sources (the cartography-vs-cloudquery comparison
  that drives "Route exists?") — bulwark's Z6,
- write anything to the output stream beyond telemetry. The
  load-bearing assertion `set(outputs.keys()) == {"metadata"}` in
  the handler tests pins this.

If a future contributor finds themselves reaching for
`outputs.routes` or row reshaping inside this plugin, the seam is
being crossed — push it back to bulwark.

### 2. External transport (out-of-process)

`mode: "external"`, registered via the same
`registerExternalPlugins()` pass cartography uses. The handler
lives in
`services/python-plugins/app/plugins/cloudquery_aws_sync_plugin.py`;
the wire is connect-rpc through `plugin-sdk/transport`. The
cloudquery CLI is installed at `/opt/cloudquery/cloudquery` in the
sidecar Dockerfile as a single curl + chmod layer (the source +
destination plugins are downloaded by cloudquery itself on first
sync, pinned to versions the handler embeds in the spec YAML).

The Node worker bundle is unaffected — cloudquery's Go binary +
its plugin downloads never enter the Node runtime. Same image-
hygiene argument ADR-0022 §"Transport subpath" makes for
`@connectrpc` not being import-reachable from `pipeline-spec`.

### 3. Postgres destination via dataset binding (not raw config)

The plugin declares
`requires: [{binding: "destination", kind: "postgres"}]`. Per the
`PluginManifest.requires` contract, a plugin that declares
`requires` MUST NOT also expose host / port / URL fields in its
`configSchema` — the dataset connection is the single source of
truth. The handler reads the resolved DSN from
`request.dataset.bindings.destination.connection.secret` (postgres
uses DSN-as-the-secret per `postgres-core.ts`) and hands it
straight to cloudquery's `postgresql` destination plugin's
`connection_string` spec field.

This means an operator wires the plugin by selecting a Postgres
dataset/connection from the Builder picker — no DSN paste, no
secret leaking into config trace, no two-sources-of-truth.

### 4. AWS credentials via secret-ref (no raw values in config)

`config.credsSecretRef` is a `format: "secret-ref"` field — the UI
renders a secret picker and the value never leaves the server. The
runtime's SecretProvider resolves it to a `.env`-style block which
the handler parses and exports into cloudquery's subprocess env.
Raw values never appear in argv, the execution trace, or the logs.

The same dual-declaration trap cartography_crawl shipped with
applies (`config.credsSecretRef` alone is not enough — the spec
node must ALSO declare `node.secrets: { <name>: <secret-ref> }`
for the runtime to resolve it). The handler surfaces a
`credsWarning` on the metadata envelope when this gap is detected
so the operator sees the cause of a 0-row sync without digging.

### 5. Scope — route-table tables by default, additive

`config.tables` defaults to `["aws_ec2_route_tables", "aws_ec2_routes"]`
— the Z6a headline scope. Operators can opt into additional tables
from a constrained allowlist (`CLOUDQUERY_AWS_ALLOWED_TABLES`)
that's restricted to the network / exposure surface bulwark
consumes in Z6: VPC / subnet / gateways / VPC peering / VPC
endpoints / ELBv2 + listeners + target groups.

Adding a wholly new shape (IAM rows, CloudTrail events, S3
buckets, etc.) belongs in a **sibling** plugin (e.g.
`cloudquery_aws_iam_sync`), not in this one's scope. The seam
between "transport for the Z6a shape" and "transport for some
other domain" stays sharp; per-plugin allowlists make the line
visible in code.

### 6. Streaming progress, full envelope on completion

The manifest declares `streaming: true` so the runtime routes
through `ExecuteServerStream` when the caller provides an
`onToken` sink — operators see the sync progressing on the trace
UI instead of watching a 30-minute spinner. The handler still
returns the full envelope on completion; streaming is additive,
not the only delivery shape.

## What lands where (the wire contract)

- **cloudquery → Postgres**: cloudquery's destination plugin owns
  the destination DDL. It CREATEs the tables
  (`aws_ec2_route_tables`, `aws_ec2_routes`, …) and writes rows
  with cloudquery's native column shape (snake_case fields,
  `_cq_id` / `_cq_sync_time` provenance columns).
- **bulwark ← Postgres**: bulwark's Z4 adapter reads those tables
  verbatim. A bulwark schema bump that needs a new column maps to
  a cloudquery version bump that exposes it on the source plugin
  (`CLOUDQUERY_AWS_SOURCE_VERSION` env), NOT to a code change in
  the RAGdoll handler.
- **RAGdoll**: the spec YAML emission, the env injection, and the
  per-table row-count parsing. Telemetry on `outputs.metadata`.
  Nothing else.

## Verification

TS — `plugins/builtin-rag/test/cloudquery.test.ts` (16 cases):

- manifest id / category / contract stable
- `requires: [{binding: "destination", kind: "postgres"}]` —
  AND no host/port/dsn fields in `configSchema` (contract guard)
- tables enum mirrors `CLOUDQUERY_AWS_ALLOWED_TABLES` verbatim
  (no split-source-of-truth drift)
- default tables include the route-table headline scope
- `writeMode` / `runner` enums + 30-minute timeout default
- `credsSecretRef` has `format: "secret-ref"` AND the description
  warns about the dual-declaration trap
- single `metadata` output port; description calls out the seam
- `streaming: true` declared
- plugin description carries the seam-discipline rule verbatim
- loader registers the plugin only when `PYTHON_PLUGIN_URL` is set
- `PYTHON_PLUGIN_CLOUDQUERY_TIMEOUT_MS` env override applied

Python —
`services/python-plugins/tests/test_cloudquery_aws_sync.py`:

- table-allowlist rejection
- omitted tables → route-table default; explicit `[]` → loud refusal
- unknown `writeMode` rejected
- missing / wrong-kind `destination` binding rejected
- missing PG DSN secret rejected
- dry-run emits synthetic envelope without invoking `subprocess.run`
- subprocess path writes a 2-doc YAML spec (source + destination
  blocks); pg DSN flows into `connection_string`; AWS env injected
- 0 rows per table is NOT a failure (legitimate empty account)
- non-zero exit raises loudly with stderr tail attached to
  `err.metadata`
- missing binary → actionable error
- `credsSecretRef` set without a matching secret → `credsWarning`
  on the envelope
- **seam-discipline check**: `outputs.keys() == {"metadata"}` —
  fails the moment a future contributor adds row payload to the
  output
- count parser tests: max-of-progress-lines; unparseable lines
  skipped; banner fallback when JSON logging is off

## Consequences

- The Postgres tables `aws_ec2_route_tables` / `aws_ec2_routes`
  exist and stay fresh whenever bulwark's pipeline runs the
  scheduled sync. bulwark's Z4/Z6 reads them directly.
- The Node/web bundle is unaffected — cloudquery never enters it.
- AWS creds + the destination DSN live in the secret store + the
  dataset binding respectively; neither leaks into config trace.
- Adding more cloudquery surface for Z6 (VPC, gateways, ELBv2 —
  already in the allowlist) is a config edit on bulwark's
  pipeline; no code change here.
- Adding a wholly new domain (IAM, CloudTrail) is a sibling plugin
  + a sibling ADR amendment, not a widening of this one. The seam
  stays sharp.

## Future work

- **CLI version pin policy.** `CLOUDQUERY_VERSION` is pinned in
  the Dockerfile; `CLOUDQUERY_AWS_SOURCE_VERSION` and
  `CLOUDQUERY_POSTGRESQL_DEST_VERSION` are pinned as env defaults
  on the handler. Both are bumped intentionally + verified against
  bulwark's Z4 adapter understanding the row shape (cloudquery
  follows semver; major bumps can rename columns or split tables).
- **Sibling plugins.** When bulwark grows a need for a different
  AWS shape (IAM/CloudTrail/etc.), add a sibling plugin
  (`cloudquery_aws_iam_sync`, …) with its own allowlist + its own
  ADR amendment. Resist the urge to widen this plugin's
  allowlist into other domains.
- **Multi-cloud.** GCP / Azure CloudQuery sources are the obvious
  next step. Same pattern — sibling plugins
  (`cloudquery_gcp_sync` / `cloudquery_azure_sync`) with their own
  binding requirements (still `destination → postgres` for the
  evidence sink) and their own scoped allowlists.

## References

- ADR-0022 §"Transport subpath" — why the connect-rpc import chain
  is split out from `pipeline-spec`. Same image-hygiene rationale
  applies to keeping cloudquery's Go binary out of the Node
  bundle.
- ADR-0025 — neo4j driver + cartography_crawl as the prior
  external-plugin example. cloudquery_aws_sync mirrors its shape
  (TS manifest only, handler in sidecar, isolated binary install
  in the Dockerfile).
- `PluginManifest.requires` contract — see
  `packages/plugin-sdk/src/index.ts`. Plugins that declare
  `requires` MUST NOT expose host/port/URL in `configSchema`;
  enforced here by the test
  `manifest: requires a postgres 'destination' binding (NOT host/port in config)`.
- cloudquery AWS source plugin docs — `https://hub.cloudquery.io/plugins/source/cloudquery/aws`.
- cloudquery postgresql destination plugin docs —
  `https://hub.cloudquery.io/plugins/destination/cloudquery/postgresql`.
