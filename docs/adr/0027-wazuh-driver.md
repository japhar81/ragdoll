# ADR 0027: Wazuh connection driver + host/agent pull blocks

## Status

**Accepted + implemented** (Phase 2b). First telemetry-shaped record-
source on the platform — the shape that closes the gap between the
batch-orchestrator driver (`cartography_crawl`, ADR-0025) and the
generic database read tools (`postgres_query`, `neo4j_query`, etc.).

Companions:
- [ADR 0024 — Connection Drivers as Plugins](./0024-connection-drivers-as-plugins.md)
- [ADR 0025 — Neo4j driver + property-graph plugins](./0025-neo4j-driver.md)
  (cartography_crawl ships the upstream batch orchestrator; this ADR ships
  the leaf pull blocks bulwark composes around)

## Context

Bulwark needs a *second* source to merge EC2 against in its host /
observation graph. Cartography supplies the AWS view; Wazuh supplies
the agent view. Both flow into the same Neo4j spine — bulwark's
pipeline-config concern, not RAGdoll's.

The two sources have very different shapes:

- **Cartography** is a batch orchestrator (a crawler) — one
  invocation, many internal sync jobs, writes its own destination.
  Modelled as a `datasource` plugin with a `target` binding to a
  Neo4j connection.
- **Wazuh** is the opposite: a leaf **record-source** the platform
  pulls from on a cadence. Exactly the shape RAGdoll's existing
  connection-driver + binding + delta-filter machinery exists for.

So Wazuh ships as a `connection_driver` (ADR-0024), and bulwark
composes `wazuh_*_pull → delta_filter → transform → neo4j_write`
around it. The driver owns auth + lifecycle; the pull blocks are
leaf read tools.

## Decisions

### 1. `wazuh` connection driver

`category: connection_driver`, `kind: wazuh`. Shipped as a
`ConnectionDriverPlugin` discovered by the loader scan (same as every
other driver). Lives in
`plugins/builtin-rag/src/wazuh.ts`.

- **`configSchema`** — `baseUrl` (required: hostname or full URL),
  `port` (default 55000 — upstream Wazuh server API port), `verifyTls`
  (default true).
- **`secretSchema`** — JSON `{"username","password"}` (recommended:
  driver runs the JWT flow), or `{"token"}` (long-lived operator-
  supplied bearer; the driver skips `authenticate`). Plain `user:pass`
  also accepted for ergonomics.
- **`acquire(resolved)`** — returns an authenticated client that
  manages the JWT lifecycle: obtain on first request, cache in the
  handle, refresh on 401 ONCE before bubbling the error. Cached per
  `connection.id` like every other driver.
- **`probe(client)`** — `GET /agents?limit=1`. Cheapest call that
  exercises both auth and reachability.
- **`dispose(client)`** — drops the cached token. (Wazuh has no
  server-side logout; the token expires on its own.)

**TLS posture.** `verifyTls: false` threads `rejectUnauthorized:
false` to the underlying fetch via an undici `Agent` constructed PER
REQUEST. This is the same isolation pattern the cartography sidecar
uses for its python venv — opt-in, request-scoped, never flips
`NODE_TLS_REJECT_UNAUTHORIZED` process-wide (that would bleed into
unrelated drivers in the same worker process).

**Auth refresh contract.** A 401 mid-flight triggers exactly ONE
re-authenticate + retry. A second 401 surfaces as an error — no
infinite refresh loop, no silent retry storm. Tests cover both the
"token expired between local check and server check" race and the
"creds rotated under us" terminal case.

**Credential hygiene.** Passwords / tokens / base64 basic-auth
strings NEVER appear in error messages or logs (test:
"driver: error messages never carry the password or the token").

### 2. `wazuh_agents_pull` (read tool)

`category: datasource`, `contract: 2`,
`requires: [{ binding: "wazuh", kind: "wazuh" }]`. Walks
`GET /agents` with pagination until the server returns a short page
(or `total_affected_items` is drained). Config knobs:

- `select?` (string[]) → maps to `?select=` for narrow row reads
- `q?` (string) → Wazuh filter expression passed verbatim
- `sort?` (string) → server-side sort spec
- `limit?` (default 500) → page size; clamped to Wazuh's server cap
- `maxPages?` (default 200) → runaway guard against a misconfigured
  filter

Emits `agents` (array of raw agent rows) + `metadata` (`{pages,
total, fetched, truncated}` — `truncated:true` when the page cap
fires before draining).

### 3. `wazuh_syscollector_pull` (read tool)

`category: datasource`, `contract: 2`, same binding requirement.
For each agent id (read from `inputs.agentIds` directly, or off
`inputs.agents[*][config.agentIdField]` — the natural chain from the
registry pull), fetches the configured inventory items via
`GET /syscollector/{id}/{item}`.

Inventory items in this pass (host/agent layer only):
`hardware`, `os`, `netiface`, `netaddr`. **Packages, processes,
vulns, ports, logs, compliance** are deferred to the OCSF-findings
pass — not built here.

**Empty / missing per-agent inventory is tolerated.** A 404 on an
item means the agent's syscollector DB isn't populated for that
item — skip-and-continue, surface the gap. If EVERY item returns
empty for an agent, that agent lands in
`metadata.missingAgents`; agents with partial inventory still emit
an enrichment row. Non-404 per-item errors land in
`metadata.perItemErrors` without killing the batch. This is the
explicit posture called out in the scope brief.

Emits `enrichment` (array of `{agentId, inventory, scanTime?}`) +
`metadata`. `scanTime` carries the latest `scan_time` across the
inventory rows so a downstream `delta_filter` has a watermark.

### 4. Reuse, don't rebuild

The **delta-filter**, **transform**, and **neo4j_write** blocks are
NOT rebuilt by this pass — they ship from Cartography (`neo4j_write`)
and the ingest module (`delta_filter`, `transform`). Bulwark composes
them around the new pull blocks; RAGdoll's contribution is only the
driver + the two pulls.

### 5. Scope boundary

Host/agent layer ONLY. No findings / OCSF / vulns / packages /
processes / logs / compliance / ports work in this pass. No API
changes, no pipeline definitions, no schedules, no mapping logic.
Wazuh → observation shape lives in bulwark's pipeline config.

## Verification

- **Driver unit tests** (`plugins/builtin-rag/test/wazuh.test.ts`):
  parseWazuhSecret across all accepted formats, buildWazuhBaseUrl,
  authenticate hop runs once, 401 → refresh + retry, persistent
  401 surfaces, static-token bypass, probe shape, verifyTls
  per-request threading, no-creds-in-error-messages guard.
- **Pull-block unit tests** (same file): pagination walk, `select`/
  `q`/`sort` pass-through, maxPages → `truncated`, syscollector 404
  → missingAgents, partial-inventory rows still emit, non-404 errors
  → perItemErrors, chain from `inputs.agents` via `agentIdField`.
- **Stub-run integration test**
  (`plugins/builtin-rag/test/wazuh-stub-pipeline.test.ts`): wires
  `pull_agents → pull_enrich → shape → neo4j_write` against fake
  fetch + a stub neo4j driver. Three agents (one with empty
  inventory) flow through to a single `UNWIND/MERGE` Cypher batch;
  the empty-inventory agent's bare row is preserved.

## Consequences

- RAGdoll grows its first **JWT-lifecycle-owning** driver. The
  `authenticate-once-cache-on-handle-refresh-on-401` pattern slots
  into the existing `acquire()` contract without changing it.
- Operators can now register a Wazuh connection from the Connections
  screen, fill out the schema-driven form, and probe → green from a
  test install (verified against the brief's
  `https://34.230.171.145/` test server with `verifyTls: false`).
- Bulwark gets the second source it needed. The Wazuh →
  observation mapping is unblocked — that's its pipeline config to
  write next.
- Future telemetry-shaped sources (Elastic agent, Falco event
  stream, …) can follow the same shape: driver owns auth, pull blocks
  own pagination + empty-tolerance, bulwark owns mapping.

## References

- Wazuh server API spec — https://documentation.wazuh.com/current/_static/server-api-spec/spec-v4.14.5.yaml
- ADR-0024 connection drivers as plugins
- ADR-0025 cartography pass (the upstream batch orchestrator;
  contrast)
