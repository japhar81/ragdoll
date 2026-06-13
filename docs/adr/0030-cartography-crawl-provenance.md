# ADR 0030: Per-crawl provenance for Cartography observations

## Status

**Accepted + implemented.** Companion to a parallel bulwark change
that introduces gated windowed close-by-absence for Cartography
observations. This ADR documents the shared contract — RAGdoll
stamps, bulwark consumes.

Companions:
- [ADR 0025 — Neo4j driver + property-graph plugins (cartography
  first shipped here)](./0025-neo4j-driver.md)
- [ADR 0028 — k8s driver + completeness-aware list-pull (the per-
  collection completeness pattern this ADR extends with per-RUN
  provenance)](./0028-k8s-driver.md)
- [ADR 0029 — cartography_crawl three-way module outcomes](./0029-cartography-module-completeness.md)
- ADR-0026 §#2 (cartography in the python-plugins sidecar — handler
  location)

## Context

bulwark's Cartography projection writes append-only observations
into the spine. Today they're upsert-only: re-running a crawl
overwrites existing observation rows but never closes anything that
disappears. bulwark is introducing **gated windowed close-by-
absence** — close an observation's edges when (a) it wasn't re-
stamped this crawl AND (b) the module that owns its entity types
ran to `complete` in this crawl. The gate prevents partial crawls
from tombstoning live assets (see ADR-0029 §"Three-way
classification").

For bulwark to compute either dimension of "absence," every
Cartography observation needs **per-crawl provenance**:

- **`crawlId`** — a run-scoped identifier. "Not re-stamped this
  crawl" = `observation.crawlId != current.crawlId` for the latest
  observation of an entity.
- **`crawledAt`** — the run's ISO timestamp. Window-age = `now -
  observation.crawledAt`.

The per-module status envelope (ADR-0029) and the observations it
correlates with must carry the **same** `crawlId`. That's how
bulwark pairs "modules complete in crawl N" with "observations
stamped crawlId N."

## Decisions

### 1. Where `crawlId` comes from

**Path taken: pipeline-config-only.** The runtime already exposes
the per-pipeline-execution identifier (`RuntimeContext.requestId`
in `packages/core/src/index.ts`) over the proto wire to the
python sidecar. The TS-side `buildExecuteRequest` populates
`request_id` (proto field 6 in `proto/plugin.proto`); the bridge
threads it into `request.context.requestId`. **No proto or bridge
change was needed.**

The handler in
`services/python-plugins/app/plugins/cartography_crawl_plugin.py`
now derives `crawl_id` from that identifier:

```python
crawl_id = (
    getattr(request.context, "requestId", None) or str(uuid.uuid4())
)
```

The fallback to `uuid.uuid4()` is **for dev / test only** — a real
RuntimeContext always populates `requestId`. Production callers
must not rely on the fallback because it loses correlation with
RAGdoll's `executions` row.

Why `requestId` and not `executionId`: both fields exist on
`RuntimeContext` and both are 1:1 with a pipeline run in practice.
`requestId` is the one already on the wire (`buildExecuteRequest`
only sends `requestId`, not `executionId`), so using it requires
no proto change. If a future bulwark requirement demands the
canonical `executions.execution_id` instead, adding `execution_id`
to `proto/plugin.proto` is a one-field change — bridged value plus
a `.connection_string()` field — but until then this is the minimal
capability that lights the contract up.

### 2. Where `crawledAt` comes from

`crawledAt` is the wall-clock at the moment the handler started the
run, ISO-8601 UTC (`"2026-06-13T18:42:07Z"`). Aliased to
`metadata.startedAt` for now — same anchor moment, different
contract name. Surfaced as a separate field rather than reusing
`startedAt` so the provenance contract has a stable identifier
distinct from the handler's diagnostic fields.

### 3. Envelope shape (the shared contract)

```jsonc
{
  "outputs": {
    "metadata": {
      // ===== Provenance contract (this ADR) =====
      "crawlId":   "<requestId>",
      "crawledAt": "2026-06-13T18:42:07Z",

      // ===== Per-module status envelope (ADR-0029) =====
      "modules": [
        { "module": "aws",            "status": "complete", "entityTypes": ["EC2Instance", ...] },
        { "module": "identitycenter", "status": "excluded", "entityTypes": ["AWSPermissionSet", ...] }
      ],

      // ===== Existing diagnostic fields =====
      "startedAt": "2026-06-13T18:42:07Z",
      "completedAt": "2026-06-13T18:48:31Z",
      "mode": "subprocess",
      "target": { "connectionSlug": "...", "database": "neo4j" },
      "exitCode": 0,
      "cartographyStdoutTail": "...",
      "cartographyStderrTail": "..."
    }
  }
}
```

### 4. How observations get stamped (bulwark's pipeline config)

This is the **other half of the contract**. The cartography_crawl
node's output is the input to bulwark's transform node; the
transform stamps each row with the upstream `metadata.crawlId` /
`metadata.crawledAt`. A representative JSONata expression
(bulwark authors the actual one):

```jsonata
$.{
  "id":         <id>,
  "kind":       <kind>,
  "props":      <props>,
  "crawlId":    $$.metadata.crawlId,
  "crawledAt":  $$.metadata.crawledAt
}
```

The runtime's flat-merge edge delivery
(`DagExecutor.buildNodeInputs`) makes the cartography node's
`metadata` output available at `inputs.metadata` on the transform.
Same identifier reaches every row → every observation neo4j_write
emits carries the matching `crawlId` / `crawledAt`. **The per-
module status envelope and the written observations correlate by
construction.**

### 5. Failed-path provenance

When the `failed` path raises (ADR-0029 §3), `err.metadata` carries
the full envelope **including** `crawlId` + `crawledAt`. bulwark
may want to record what crawl was attempted even on the fatal
path so the next successful crawl with the same data shape can be
compared. Tested in
`test_failed_path_exception_metadata_still_carries_provenance`.

## Verification

New tests in
`services/python-plugins/tests/test_cartography_crawl.py`:

- `test_metadata_crawlid_derives_from_runtime_request_id` — handler
  reads `request.context.requestId` and emits it as
  `metadata.crawlId`.
- `test_metadata_carries_crawled_at_iso_timestamp` — `crawledAt`
  present, ISO-8601 UTC, aliased to `startedAt`.
- `test_two_runs_have_distinct_crawlids_so_restamping_is_observable`
  — successive runs with distinct requestIds produce distinct
  crawlIds, which is what makes re-stamping observable to bulwark.
- `test_crawlid_falls_back_to_uuid_when_runtime_omits_request_id`
  — dev-only safety net produces a usable id; correlation lost.
- `test_dry_run_also_emits_crawlid_and_crawledat` — Builder
  preview matches production envelope shape.
- `test_failed_path_exception_metadata_still_carries_provenance`
  — `err.metadata.crawlId` / `crawledAt` are present even on the
  fatal path.

## Consequences

- bulwark can now compute "re-stamped this crawl" by comparing
  `observation.crawlId` to the envelope's `crawlId`.
- bulwark can compute window-age from `crawledAt`.
- The per-module status envelope + observations correlate by the
  same identifier without bulwark having to plumb a separate
  out-of-band channel.
- No proto change. No bridge change. The wire was already
  carrying the identifier.
- Operators can correlate `metadata.crawlId` against
  `/api/executions/<id>` traces in RAGdoll (when the requestId
  matches the executionId, which is the common case — when it
  doesn't, the trace surfaces both).

## Future work

If bulwark requires the canonical `executions.execution_id`
specifically (rather than the request-id), adding
`execution_id = 12` to `proto/plugin.proto`, plumbing it through
`buildExecuteRequest`, and reading it in
`_proto_to_pydantic` is the minimal next step. Keep `requestId`
as the fallback so this ADR's contract stays stable.

## Coordination report (for bulwark)

- **Path taken: pipeline-config-only / no RAGdoll code change beyond
  using the existing wire identifier as `crawlId` and adding the
  `crawledAt` alias.** No proto change, no bridge change.
- The per-module status envelope already carried `crawlId` at top
  level from ADR-0029; this ADR connects it to a stable run-scoped
  source.
- The transform expression on bulwark's side stamps each
  observation row via `$$.metadata.crawlId` /
  `$$.metadata.crawledAt`. No special syntax — same JSONata flat-
  merge access pattern any other transform uses.
- A subsequent crawl re-stamps re-seen observations with the new
  values; an observation last_seen on crawl N-1 but not re-stamped
  on crawl N has `observation.crawlId != current.crawlId`, which
  is bulwark's "absent" signal — gated by the per-module
  `status: complete` rule from ADR-0029.

## References

- ADR-0028 §"Completeness rule" — the broader per-collection
  completeness pattern this ADR specialises to per-RUN provenance.
- ADR-0029 §"Three-way classification" — the per-module status
  envelope this ADR adds run-scoped correlation to.
- `RuntimeContext` definition — `packages/core/src/index.ts` lines 357-379.
- `buildExecuteRequest` — `packages/plugin-sdk/src/transport.ts`.
- `_proto_to_pydantic` — `services/python-plugins/app/connect_bridge.py`.
- Cartography pipeline reference (operator-facing) —
  `plugins/builtin-rag/src/cartography.ts` manifest description.
