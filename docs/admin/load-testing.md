# Load testing

RAGdoll ships a [k6](https://k6.io) load harness that drives the public
HTTP API against a corpus of "platform-only" pipelines — pipelines built
entirely from CPU-light, side-effect-free plugins (`transform`,
`xml_codec`, etc.) so the measurement reflects the API + runtime +
database overhead, not the latency of an LLM or vector store.

> **Why no LLMs?** The first thing every load test of a RAG system
> measures, by default, is whatever model you point it at. That's a
> useful number for capacity planning but a terrible regression test
> for the platform itself — a slow Ollama looks identical to a slow
> scheduler. The load corpus deliberately avoids LLMs / embeddings /
> external I/O so a regression in DAG traversal, request parsing, or
> RBAC enforcement shows up cleanly.

Live scripts: [`tests/load/k6/`](../../tests/load/k6).
Seed pipelines: [`examples/load/pipelines/`](../../examples/load/pipelines).
Generated seed SQL: `packages/db/seeds/zzzzzzz-load-test-pipelines.sql`.

## Prerequisites

1. **k6 on PATH.** The wrapper prints an install hint if it isn't:
   - macOS: `brew install k6`
   - Linux: <https://grafana.com/docs/k6/latest/set-up/install-k6/>
   - Docker: `alias k6='docker run --rm -i --network host -v "$PWD":/scripts grafana/k6'`
2. **A running stack** with the load pipelines seeded. The local Docker
   stack does this automatically on `make up`; seeds re-apply on
   `make refresh`. To confirm:
   ```bash
   curl -fsS http://localhost:3001/api/pipelines \
     -H "authorization: Bearer $(login_token)" \
     | jq '.pipelines[] | select(.slug | startswith("load-"))'
   ```
3. **Auth.** Defaults are the bootstrap admin
   (`admin@ragdoll.local` / `ragdoll-admin`); override via env when
   pointing at a remote stack.

## Run a scenario

The wrapper (`scripts/k6.sh`) takes a scenario name and threads any
extra args through to `k6 run`.

| Command                 | Scenario | Shape                                                                |
| ----------------------- | -------- | -------------------------------------------------------------------- |
| `npm run load`          | smoke    | 1 VU × 30 iterations across every pipeline. Default.                 |
| `npm run load:smoke`    | smoke    | Same as `load` — explicit for the unambiguous case.                  |
| `npm run load:steady`   | steady   | Constant arrival rate (default 20 RPS) for 60 s.                     |
| `npm run load:spike`    | spike    | Ramp 1 → 50 VUs over 10 s, hold 30 s, drain over 10 s.                |
| `npm run load:soak`     | soak     | 5 VUs for 10 min (override with `DURATION=30m`).                     |
| `npm run load:trend`    | trend    | Sustained 10 RPS for 5 min + per-bucket drift analyzer.              |

`make load`, `make load-steady`, `make load-spike`, `make load-soak`,
`make load-trend` work the same. All scenarios run the same `main.js`;
they differ only in the `SCENARIO` env the wrapper sets.

### Trend scenario: did the pipelines slow down?

Smoke / steady / spike / soak all answer "did the harness finish without
breaching the latency ceiling." None answer "did the pipelines keep
finishing at roughly the same speed over the sustained run." The `trend`
scenario does:

1. k6 runs `constant-arrival-rate` for `DURATION` (default 5 m) at `RATE`
   RPS (default 10), tagging each request with its pipeline.
2. The wrapper directs k6's per-sample output to
   `tests/load/k6/.last-run.ndjson` (gitignored).
3. `scripts/load-trend.ts` reads the NDJSON, groups
   `http_req_duration` samples by `(pipeline, time bucket)` where each
   bucket is `BUCKET_SECONDS` long (default 30 s), and prints a table:
   ```
   === load trend per pipeline (p95 by time bucket) ===

   pipeline           b0      b1      b2      ...  b9      drift   verdict
   --------------------------------------------------------------------------------
   load-deep-chain    33ms    34ms    36ms    ...  35ms      6%    ok
   load-fanout-merge  41ms    40ms    42ms    ...  44ms      7%    ok
   load-passthrough   18ms    19ms    18ms    ...  19ms      6%    ok
   load-xml-parse     23ms    23ms    24ms    ...  25ms      9%    ok
   ```
4. **Drift** for each pipeline is
   `median(p95 of LAST two buckets) / median(p95 of FIRST two buckets)`.
   The analyzer fails non-zero if any pipeline drifts above `DRIFT_LIMIT`
   (default `1.5` — i.e. a 50% slowdown over the run).

Knobs (all env vars):

| Var              | Default | Meaning                                                          |
| ---------------- | ------- | ---------------------------------------------------------------- |
| `DURATION`       | `5m`    | Total run length (k6 duration syntax).                           |
| `RATE`           | `10`    | Constant arrival rate, RPS.                                      |
| `BUCKET_SECONDS` | `30`    | Time-bucket size used by the analyzer.                           |
| `DRIFT_LIMIT`    | `1.5`   | Multiplier above which a pipeline's drift fails the run.         |
| `NDJSON_OUT`     | `tests/load/k6/.last-run.ndjson` | Where to land the per-sample NDJSON. |

A clean run on a healthy local stack should show drift values in the
single-digit percent range — the platform isn't doing real work that
heats up. Watch for any pipeline that shows monotonically increasing
bucket p95s; that's the signal a leak or cache-warm-up bug is shifting
the latency floor over time.

## Tweaking a run

Every knob is an env var; no editing required.

| Var                         | Default                  | Meaning                                                  |
| --------------------------- | ------------------------ | -------------------------------------------------------- |
| `BASE_URL`                  | `http://localhost:3001`  | API base URL.                                            |
| `TENANT_SLUG`               | `tenant-local`           | Tenant the pipelines are deployed to.                    |
| `RAGDOLL_API_KEY`           | (unset)                  | If set, used directly; otherwise the harness logs in.    |
| `BOOTSTRAP_ADMIN_EMAIL`     | `admin@ragdoll.local`    | Login email when `RAGDOLL_API_KEY` is unset.             |
| `BOOTSTRAP_ADMIN_PASSWORD`  | `ragdoll-admin`          | Login password.                                          |
| `PIPELINE`                  | (round-robin all 4)      | Pin every iteration to one slug (e.g. `load-deep-chain`).|
| `RATE`                      | `20` (steady only)       | Target arrival rate, RPS.                                |
| `DURATION`                  | `10m` (soak only)        | Soak length, k6 duration syntax.                         |
| `SCENARIO`                  | `smoke`                  | Override the scenario when calling `k6 run` directly.    |

Examples:

```bash
# 50 RPS for a minute against the deep-chain pipeline
PIPELINE=load-deep-chain RATE=50 npm run load:steady

# Half-hour soak
DURATION=30m npm run load:soak

# Point at a stage cluster with a pre-minted API key
BASE_URL=https://stage.example.com:3001 \
  RAGDOLL_API_KEY=rgd_xxx_yyyyyyy \
  npm run load:steady
```

## What the corpus exercises

| Pipeline             | Shape                            | What it measures                                       |
| -------------------- | -------------------------------- | ------------------------------------------------------ |
| `load-passthrough`   | input → transform → output       | Floor: API + runtime overhead for a 3-node DAG.        |
| `load-fanout-merge`  | 1 → 4 parallel → merge           | Parallel-node scheduling, port-routing, edge-ordering. |
| `load-deep-chain`    | 6 sequential transforms          | Per-node DAG-traversal cost (the delta vs. passthrough).|
| `load-xml-parse`     | input → xml_codec → transform    | CPU-realistic per-iteration cost (XML parse + JSONata).|

Every pipeline ships an `input.config.default` payload, so the harness's
`/invoke` body is small (just the per-request input). Scale per-iteration
work by sending a larger `xml` body for `load-xml-parse`.

## Interpreting results

k6 prints a checks/HTTP summary at the end of every run. The thresholds
the harness fails on:

- **Error budget**: `http_req_failed < 1%`. Anything that isn't a 2xx
  with `status: "succeeded"` in the JSON counts.
- **Global latency**: `p(95) < 1000 ms`, `p(99) < 2000 ms` across all
  requests. Generous on purpose — non-LLM platform work on a healthy
  local stack is consistently low-millisecond.
- **Per-pipeline latency**: each load pipeline has its own
  `http_req_duration{pipeline:<slug>}` threshold so a regression in
  one shape doesn't get hidden in the global aggregate.

A failed threshold causes `k6 run` to exit non-zero — wire it into CI
the same way you would any other test command.

For deeper analysis the local stack's Grafana → "RAGdoll · Overview"
dashboard shows API request rate / latency / error rate over time, so
a 10-minute soak gives you a real graph (not just a terminal summary).

## Adding a new pipeline

1. Drop a new YAML in `examples/load/pipelines/`. Author it minimally
   (no `stages:` / `ui:`); the generator fills the layout.
2. `npm run build:load-seeds` — this rewrites the YAML in canonical
   form AND regenerates `packages/db/seeds/zzzzzzz-load-test-pipelines.sql`.
3. Add a payload generator to `tests/load/k6/lib/payloads.js`.
4. If the pipeline needs its own latency budget, add a per-pipeline
   threshold to `tests/load/k6/lib/scenarios.js`.
5. The offline test (`tests/e2e/load-pipelines.e2e.test.ts`) picks up
   any new YAML automatically — `npm run test:e2e` will validate it
   against the real registry and run it through `DagExecutor`.
6. `make refresh` to re-seed the local stack, then `npm run load:smoke`
   to confirm the new pipeline answers.

## Adding a new scenario

Add an entry to `SCENARIOS` in `tests/load/k6/lib/scenarios.js` and a
matching `load:<name>` script in `package.json` (or invoke directly with
`SCENARIO=<name> k6 run tests/load/k6/main.js`).

## Why a generator instead of hand-written SQL?

The other example pipelines ship as hand-encoded SQL seeds because they
double as documentation: the YAML and the SQL are kept in lockstep by
`scripts/relayout-seeds.ts`. The load corpus is scaffolding for
performance work — there's no value in maintaining two byte-equivalent
encodings by hand, so `scripts/build-load-seeds.ts` projects every YAML
to one SQL file and the offline test asserts they stay aligned.
