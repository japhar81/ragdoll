# ADR 0031: Per-pull provenance for Wazuh observations

## Status

**Accepted + implemented.** Sibling to ADR-0030 — same contract shape
(`pullId` / `pulledAt`) carried by every wazuh pull plugin's metadata
envelope. RAGdoll stamps, bulwark consumes.

Companions:
- [ADR 0027 — Wazuh connection driver + the first two pull plugins](./0027-wazuh-driver.md)
- [ADR 0028 — k8s driver + per-collection completeness pattern](./0028-k8s-driver.md)
- [ADR 0030 — Cartography per-crawl provenance (the parallel
  contract; same shape, different domain)](./0030-cartography-crawl-provenance.md)

## Context

bulwark's wazuh projection is moving to the same shape it already
uses for Cartography: gated windowed close-by-absence. A CVE that
was reported by `wazuh_vulns_pull` on pull N-1 but is absent from
pull N closes — but **only** when pull N actually ran (no skipped
runs miscounted as "absent"), and the close window is bounded by
how long ago pull N happened (`now - pulledAt`).

That requires the wazuh observation row to carry **per-pull
provenance**:

- **`pullId`** — a run-scoped identifier. "Absent from this pull" =
  `observation.pullId != current.pullId` for the latest observation
  of an agent/CVE.
- **`pulledAt`** — the run's ISO timestamp. Window-age = `now -
  observation.pulledAt`. Bulwark's "patched CVE closes after Y
  hours" rule depends on this.

This is the same shape ADR-0030 introduced for Cartography
(`crawlId` / `crawledAt`). The wazuh pulls are the next domain to
land it; the contract field names differ (`pullId` not `crawlId`)
because the upstream noun is "pull," not "crawl" — bulwark already
distinguishes the two on the projection side.

Phase 5.2 in the bulwark roadmap is the consumer side; this ADR is
the producer side.

## Decisions

### 1. Where `pullId` comes from

**Path taken: pipeline-config-only.** Same approach as
ADR-0030 §1. The runtime already exposes
`RuntimeContext.requestId` on the wire (proto field 6 in
`proto/plugin.proto`); wazuh pulls run in-process so they read it
straight off `input.context.requestId` without a bridge hop:

```ts
// plugins/builtin-rag/src/wazuh.ts
function deriveWazuhProvenance(input: PluginExecutionInput): WazuhProvenance {
  const requestId = input.context?.requestId;
  return {
    pullId: requestId || `wazuh-pull-${Date.now()}`,
    pulledAt: new Date().toISOString()
  };
}
```

The `wazuh-pull-${Date.now()}` fallback is **for dev / test only**.
A real RuntimeContext always populates `requestId`. Production
callers must not rely on the fallback — it loses correlation with
the RAGdoll `executions` row.

### 2. Where `pulledAt` comes from

Wall-clock at the moment the plugin's `execute()` was entered,
ISO-8601 UTC (`"2026-06-13T18:42:07Z"`). Captured **once per
execute**, not per-agent — every row a single pull emits shares the
same `pulledAt`. That's the invariant bulwark's "absent since X"
math depends on: the next pull's `pulledAt` defines the window
boundary, not the wall-clock at row N.

### 3. Envelope shape (the shared contract)

Every wazuh pull plugin's `outputs.metadata` carries:

```jsonc
{
  "outputs": {
    "metadata": {
      // ===== Provenance contract (this ADR) =====
      "pullId":   "<requestId>",
      "pulledAt": "2026-06-13T18:42:07Z",

      // ===== Per-pull diagnostic envelope =====
      "fetched":        17,
      "missingAgents":  ["A12", "A77"],
      "perItemErrors":  [],
      "truncated":      false
    }
  }
}
```

Three plugins currently stamp this:

- `wazuh_agents_pull` — agent inventory
- `wazuh_syscollector_pull` — per-agent hardware / os / netiface /
  netaddr inventory (the syscollector empty-tolerance contract is
  pre-existing; this ADR adds the provenance stamp on top)
- `wazuh_vulns_pull` — per-agent CVE findings (introduced in this
  cycle; see §"Pull plugin landed alongside this ADR")

Any future wazuh pull plugin MUST call `deriveWazuhProvenance(input)`
and surface `pullId` + `pulledAt` in its metadata envelope. The
helper is module-internal — a sibling pull cannot opt out, which is
the point.

### 4. Per-row stamping is bulwark's job, not the pull's

Same split as ADR-0030 §4. The pull stamps the **metadata
envelope**, not the individual `agents` / `enrichment` / `vulns`
rows. A downstream `transform` node (authored on bulwark's side)
copies `$$.metadata.pullId` / `$$.metadata.pulledAt` onto each row
on its way to bulwark. The runtime's flat-merge edge delivery makes
this trivial:

```jsonata
$.{
  "agentId":  agentId,
  "cve":      vulns,
  "pullId":   $$.metadata.pullId,
  "pulledAt": $$.metadata.pulledAt
}
```

Putting the stamp in the transform — rather than in the pull —
keeps the wire shape between the pull and the transform stable
across the ADR's lifetime. Adding a new field (say, `pullSourceUrl`)
later requires changing the metadata envelope and bulwark's
transform, never the rows themselves.

### 5. Pull plugin landed alongside this ADR: `wazuh_vulns_pull`

The new third pull was deferred from Phase 2b; landing it now
because its absence was the gap bulwark's projection couldn't fill.
Two API surfaces, operator-selected via `config.apiVariant`:

- **`server-api`** (Wazuh 4.x) — `GET /vulnerability/{agent_id}`
  paginated by `?offset=&limit=`, JWT-authed through the existing
  driver.
- **`indexer`** (Wazuh 4.8+ — vulns moved to the Wazuh indexer) —
  `GET /<indexPattern>/_search?size=&q=agent.id:"<id>"` against
  the indexer cluster (default index pattern
  `wazuh-states-vulnerabilities-*`).

We **deliberately do not auto-detect**. Auto-detect would burn a
probe call per pull and could pick the wrong surface during a
rolling upgrade; operator-knob is loud and correct.

Empty-tolerance mirrors `wazuh_syscollector_pull`: a 404 (vuln
detector not enabled for that agent) or empty `affected_items` /
empty `hits.hits` lands the agent in `metadata.missingAgents`, the
batch keeps going. Non-404 errors land in `perAgentErrors` — they
are NOT absence; bulwark must NOT close on a 500. The two are
intentionally distinguished.

The pull emits raw Wazuh rows verbatim — NO transform into
observation / CWE / ATT&CK shape. That mapping is bulwark's job
(and ATT&CK reference data is loaded via the ADR-0032 reference-ETL
pattern, not by this pull).

## Verification

Tests in `plugins/builtin-rag/test/wazuh.test.ts`:

- `wazuh_agents_pull: metadata stamps pullId (from context.requestId)
  + pulledAt` — provenance present on the simplest pull.
- `wazuh_syscollector_pull: metadata stamps pullId + pulledAt` —
  syscollector picked up the stamp without breaking its existing
  empty-tolerance contract. Companion assertion that per-row
  stamping is bulwark's job, not the pull's (§4 invariant).
- `wazuh_vulns_pull (server-api): per-agent pagination, missingAgents
  tolerance, 404 lands as missing` — empty inventory AND 404 both
  surface in `missingAgents`; the batch continues.
- `wazuh_vulns_pull (server-api): non-404 errors land in
  perAgentErrors, batch keeps going` — distinguishes error from
  absence (the load-bearing distinction for bulwark).
- `wazuh_vulns_pull (indexer): hits /<indexPattern>/_search with
  agent.id term, surfaces _source rows verbatim` — second API
  variant; lucene term is quoted so an id of `001:agent2` doesn't
  match both halves.
- `wazuh_vulns_pull: reads agent ids from inputs.agents via
  agentIdField (chain off wazuh_agents_pull)` — natural pipeline
  composition: agents → vulns.
- `wazuh_vulns_pull: no agent ids → empty output with pullId stamp
  (no crash)` — provenance is stamped even on the no-op path so
  bulwark sees a stamp on every run.

## Consequences

- bulwark can now compute "absent from this pull" by comparing
  `observation.pullId` to the envelope's `pullId`, gated by
  `pulledAt` window-age.
- All three wazuh pulls share the same provenance shape — a new
  one is one helper call away from compliance, and the test surface
  catches a regression that drops the stamp.
- Operators can correlate `metadata.pullId` against
  `/api/executions/<id>` traces in RAGdoll the same way they do for
  Cartography (`crawlId` → execution).
- No proto change. No bridge change. No wire change. The wire was
  already carrying the identifier.

## Amendment — indexer (4.8+) wire contract

The original landing of `wazuh_vulns_pull` shipped the indexer
variant by routing it through the same JWT-bearer + GET-only path
the server-API surface uses. That path runs green but yields zero
rows against a real Wazuh 4.8+ indexer. bulwark proved the correct
wire contract with a direct pull against the live indexer
(1917 CVEs, per-agent magnitudes ≈ 36–1632). This amendment
records the proven contract so the next reader doesn't re-derive
it:

| Dimension          | Server API (4.x)                       | Indexer (4.8+ / OpenSearch)                 |
| ------------------ | -------------------------------------- | ------------------------------------------- |
| Endpoint           | `https://<host>:55000`                 | `https://<host>:9200` (often a split host)  |
| Auth               | JWT — `POST /security/user/authenticate` → `Authorization: Bearer <token>` | **HTTP Basic** per request from the SAME connection secret |
| Auth-flow probe    | 200 with `{data:{token:…}}`            | 400 — the `/security/user/authenticate` endpoint **does not exist** on the indexer |
| Search shape       | `GET /vulnerability/{agent_id}?offset=&limit=` | `POST /<indexPattern>/_search` with a JSON DSL body |
| Body / params      | URL query params                       | `{"size": <limitPerAgent>, "query": {"term": {"agent.id": "<id>"}}}` |
| Hit shape          | `data.affected_items[]`                | `hits.hits[]._source` (surfaced verbatim)   |
| Wazuh secret kind | `{username,password}` or `{token}`     | **`{username,password}` REQUIRED** — `{token}` errors actionably |

Two RAGdoll-side knobs make this work:

- **`config.indexerBaseUrl`** — wired through the plugin, accepts a
  full URL (`https://wazuh-indexer.acme.com:9200`) or a bare
  hostname (defaults to `https://<host>:9200`). When unset, falls
  back to the connection's `baseUrl` — only correct for the rare
  co-located case.
- **Internal `indexerSearch()` helper** — scoped to the indexer
  variant. Does NOT route through `authedRequest` /
  `ensureToken`. Builds the `Authorization: Basic <b64>` header
  per request, honors `verifyTls=false` via the same undici
  per-request dispatcher pattern the rest of the wazuh driver
  uses, surfaces non-2xx with a short body snippet (creds never
  logged).

The server-API path is untouched — it remains the JWT/GET surface
documented in ADR-0027. The amendment scope is the indexer variant
only.

Verification:

- `wazuh_vulns_pull (indexer): POST /<indexPattern>/_search to
  indexerBaseUrl with Basic auth + JSON body` — pins all four
  proven properties (endpoint host:port, POST method, Basic auth,
  DSL body); explicitly asserts the plugin DOES NOT call
  `/security/user/authenticate` on this surface and DOES NOT touch
  the server-API host.
- `wazuh_vulns_pull (indexer): empty hits → agent lands in
  missingAgents` — empty-tolerance contract preserved.
- `wazuh_vulns_pull (indexer): indexerBaseUrl accepts a bare
  hostname → https://<host>:9200` — config knob shape.
- `wazuh_vulns_pull (indexer): static-token connection → actionable
  error, NOT silent failure` — operator visibility on the
  wrong-secret-shape mistake (rather than 0 rows that look like
  an empty fleet).
- `wazuh_vulns_pull (indexer): unset indexerBaseUrl → falls back
  to the connection baseUrl` — co-located case still works.

## Amendment — `wazuh_ruleset_pull` (posture read)

bulwark's Wazuh control was being minted as `Control.mode=block` /
`Control.fidelity=authoritative` from enrollment alone — agent
exists, therefore covered. That's a posture the system had no
evidence for; a detect-only deployment (rules firing, no active
response) gets the same green check as a fully blocking install.
The posture is READABLE from the Wazuh server-API, so this pull
reads it and lets bulwark stop guessing.

### What it reads (server-API endpoints — JWT through the existing driver)

| Endpoint                                                       | Purpose                                                                                                       | Failure mode                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `GET /agents?agents_list=<id>&select=id,group`                 | Membership lookup when `inputs.agents` row doesn't already carry `group`                                      | 404 / empty → agent → `missingAgents`     |
| `GET /groups/{group_id}/configuration`                         | agent.conf delivered to that group (JSON envelope)                                                            | Non-2xx → `groupConfigs[group].readable=false` |
| `GET /agents/{agent_id}/config/com/active-response`            | Live active-response section delivered to that agent's wazuh-execd — the decisive `detect` vs `block` signal  | Wazuh 1707 / 1715 (agent offline / component not requestable) → `activeResponse.readable=false` |
| `GET /rules?status=enabled&offset=&limit=`                     | Manager-wide enabled rules, paginated, ONCE per execute                                                       | Non-2xx → `rulesetSummary.readable=false` |

Same JWT-authed driver, same binding (`requires: wazuh`), same
empty-tolerance and `pullId` / `pulledAt` stamp contract as the
other wazuh pulls. NOT the indexer (the indexer-specific contract
in the earlier amendment applies only to `wazuh_vulns_pull`).

### Row shape (what bulwark consumes)

```jsonc
{
  "agentId": "001",
  "groups": ["default", "linux"],
  "activeResponse": {
    "readable": true,
    "enabledCount": 1,
    "disabledCount": 1,
    "commands": [
      { "command": "firewall-drop", "disabled": false, "level": "6", "timeout": "600" },
      { "command": "host-deny",     "disabled": true,  "level": "6" }
    ]
  },
  "groupConfigs": {
    "default": { "readable": true, "config": { /* agent.conf JSON */ } },
    "linux":   { "readable": true, "config": { /* ... */ } }
  },
  "fidelity":     "authoritative",       // bulwark maps Control.fidelity
  "configSource": "mixed"                 // agent-config + group-config both read
}
```

Bulwark mapping (informational — not enforced by RAGdoll):
- `Control.mode` ← `activeResponse.commands` — any non-disabled
  command present → `block`; empty / all-disabled →
  `detect`. (Refusing to read this and defaulting to `block` was
  the bug.)
- `Control.fidelity` ← row's `fidelity`. `authoritative` only when
  the active-response endpoint AND all referenced group configs
  read successfully. `partial` when either failed — including the
  common "agent offline" 1707 case. Agents whose memberships
  themselves can't be read go to `metadata.missingAgents` — they
  are NOT in the row stream.
- Coarse Control class ← `metadata.rulesetSummary.groups[]` — the
  manager-wide rule-group inventory tells bulwark which families
  (`vulnerability-detector`, `syscheck`, `authentication_failures`,
  etc.) are loaded, with `count` and `maxLevel` per group.

### Honesty signal — `fidelity` is a SIGNAL, not a verdict

RAGdoll reports `authoritative | partial` based purely on
"could we read the API." Bulwark decides whether `partial`
collapses to `declared` or stays as `inferred` — that decision
depends on which dimension was partial and on bulwark's policy.
RAGdoll's job is to never claim a posture it couldn't actually
read. Specifically: an offline agent never gets a fabricated
empty active-response array; it gets `readable: false`.

### What's deliberately NOT here (deferred)

- **Per-CVE rule matching.** The "which Wazuh rule would have
  caught this specific CVE" question is the next rabbit hole;
  it requires deep inspection of rule files and is out of scope
  for the posture pull. The coarse rule-group inventory + per-
  agent active-response is the evidence bulwark needs for the
  mode + fidelity question this pull is fixing.
- **Endpoint auto-discovery.** The 4.x / 4.8+ server-API paths
  used here are documented and stable. If a deployment's path
  layout drifts, the plugin reports the affected dimension as
  unreadable per the failure-mode column above — no silent
  fallback that would mask the drift.

### Verification

Tests in `plugins/builtin-rag/test/wazuh.test.ts` — eight new
cases pin the load-bearing properties:

- chains off `inputs.agents` (reads `group` from row); fidelity
  goes to `authoritative` when AR + group config both succeed
- detect-only reality is visible — empty AR section →
  `enabledCount=0`, fidelity stays `authoritative` (we READ
  zero-commands, vetted)
- AR endpoint 400/1707 → `readable=false`, fidelity drops to
  `partial`, configSource → `group-config` (NOT a fake posture)
- `skipActiveResponse=true` → no per-agent AR call; every row
  fidelity=partial (operator opt-out for known-offline fleets)
- three agents in the same group → group endpoint called ONCE
  (rate-limit hygiene)
- row missing `group` → falls back to
  `/agents?agents_list=<id>` lookup
- agent with `group=[]` (freshly enrolled, unassigned) →
  `missingAgents`, batch continues
- no agents on input → empty rowstream, but `pullId` stamp +
  `rulesetSummary` still surfaced (manager-side fetch is
  independent of agent count)

## Future work

If bulwark requires the canonical `executions.execution_id`
specifically (rather than the request-id), the change is the same
one ADR-0030 §"Future work" describes — add `execution_id` to the
proto, plumb it through `buildExecuteRequest`, fall through to
`requestId`. The contract field name in the envelope (`pullId`)
stays stable.

## References

- ADR-0027 §"Pull plugins" — the original wazuh pulls.
- ADR-0030 §"Where crawlId comes from" — the sibling contract this
  ADR mirrors; same wire identifier, same handler-reads-it pattern.
- ADR-0032 §"Reference-ontology ETL" — why ATT&CK / D3FEND go
  through a different pipeline shape than wazuh evidence.
- `RuntimeContext` definition — `packages/core/src/index.ts`.
- `deriveWazuhProvenance` — `plugins/builtin-rag/src/wazuh.ts`.
