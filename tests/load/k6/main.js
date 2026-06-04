// k6 load harness for the RAGdoll API.
//
// Picks a scenario via SCENARIO env (smoke|steady|spike|soak|trend; default
// smoke) and round-robins across every load-* pipeline so a single run
// exercises every shape (passthrough / fanout / deep chain / xml parse)
// under the same arrival profile. Pin to one pipeline with PIPELINE=<slug>.
//
// Two endpoints:
//
//   ENDPOINT=invoke (default) — POST /api/pipelines/:id/invoke. Synchronous
//     in-API execution; the worker process is NOT involved. Lowest variance,
//     best signal for "did the platform's compute path slow down."
//
//   ENDPOINT=run             — POST /api/pipelines/:id/run, then poll
//     GET /api/executions/:id until the status is terminal. The job is
//     processed by a BullMQ worker, so the worker scale-out dashboard
//     (ragdoll_worker_* metrics) populates. Use this whenever you care
//     about end-to-end queue+worker behavior — soak defaults to it so the
//     dashboard isn't empty during a soak run.
//
// Run:
//   k6 run tests/load/k6/main.js                                  # smoke
//   SCENARIO=steady RATE=50 k6 run tests/load/k6/main.js
//   SCENARIO=spike k6 run tests/load/k6/main.js
//   SCENARIO=soak DURATION=10m k6 run tests/load/k6/main.js       # → /run + poll
//   SCENARIO=soak ENDPOINT=invoke k6 run tests/load/k6/main.js    # bypass worker
//   PIPELINE=load-deep-chain SCENARIO=steady k6 run tests/load/k6/main.js
//
// Defaults assume a local stack on http://localhost:3001 with the bootstrap
// admin and `tenant-local` seeded. Override BASE_URL / TENANT_SLUG /
// BOOTSTRAP_ADMIN_* / RAGDOLL_API_KEY when pointing at a remote target.
//
// See docs/admin/load-testing.md for a walk-through + how to add a new
// pipeline and scenario.

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend } from "k6/metrics";
import { bootstrapAuth, invokeHeaders } from "./lib/auth.js";
import { PAYLOADS, loadPipelineSlugs } from "./lib/payloads.js";
import { selectScenario, THRESHOLDS } from "./lib/scenarios.js";

const SCENARIO = __ENV.SCENARIO || "smoke";
// Soak is the one scenario that exists specifically to put sustained
// pressure on the *worker* process (find leaks, prove scale-out spreads
// work across workers). Default it to /run so the worker dashboard isn't
// empty during a soak. Every other scenario stays on /invoke because they
// measure the API/runtime path and adding a queue hop would just inject
// scheduling noise into their latency numbers.
const ENDPOINT = __ENV.ENDPOINT || (SCENARIO === "soak" ? "run" : "invoke");
const POLL_INTERVAL_MS = Number(__ENV.POLL_INTERVAL_MS) || 100;
const POLL_TIMEOUT_MS = Number(__ENV.POLL_TIMEOUT_MS) || 30000;

const TARGET_PIPELINE = __ENV.PIPELINE; // optional: pin to one slug

export const options = {
  scenarios: selectScenario(),
  thresholds: THRESHOLDS,
  // Real-world clients reconnect; we want connection setup costs in the p99.
  noConnectionReuse: false,
  // Slap meaningful run tags so multi-run dashboards differentiate sources
  // AND so the trend analyzer can split iteration_duration by endpoint
  // (the worker-path numbers are minutes-long; lumping them into the
  // /invoke histogram would smear every percentile).
  tags: { harness: "ragdoll-k6", endpoint: ENDPOINT }
};

// End-to-end iteration latency for ENDPOINT=run: enqueue + poll loop +
// final status check. Tagged per pipeline so the dashboard / drift analyzer
// can split it. http_req_duration only sees the individual HTTP calls.
const runEndToEnd = new Trend("ragdoll_run_e2e_ms", true);

export function setup() {
  return bootstrapAuth();
}

const SLUGS = loadPipelineSlugs();

function pickPipeline() {
  if (TARGET_PIPELINE) return TARGET_PIPELINE;
  return SLUGS[(__ITER + __VU) % SLUGS.length];
}

function invokeIteration(data, slug, pipelineId, body) {
  const res = http.post(
    `${data.baseUrl}/api/pipelines/${pipelineId}/invoke`,
    JSON.stringify({ ...body, environment: "dev" }),
    {
      headers: invokeHeaders(data),
      tags: { pipeline: slug, endpoint: "invoke" }
    }
  );
  check(
    res,
    {
      "200": (r) => r.status === 200,
      "has executionId": (r) => !!r.json("executionId"),
      "status succeeded": (r) => r.json("status") === "succeeded"
    },
    { pipeline: slug, endpoint: "invoke" }
  );
}

function runIteration(data, slug, pipelineId, body) {
  const startMs = Date.now();
  const enqueue = http.post(
    `${data.baseUrl}/api/pipelines/${pipelineId}/run`,
    JSON.stringify({ ...body, environment: "dev" }),
    {
      headers: invokeHeaders(data),
      tags: { pipeline: slug, endpoint: "run", phase: "enqueue" }
    }
  );
  const enqueueOk = check(
    enqueue,
    {
      // /run returns 202 Accepted, not 200 — the job is enqueued, not done.
      "/run 202": (r) => r.status === 202,
      "/run accepted": (r) => r.json("status") === "accepted",
      "/run has executionId": (r) => !!r.json("executionId")
    },
    { pipeline: slug, endpoint: "run" }
  );
  if (!enqueueOk) return;

  const executionId = enqueue.json("executionId");

  // Poll until the worker terminates the execution. Bounded by
  // POLL_TIMEOUT_MS so a stuck worker doesn't hang every VU forever; bounded
  // by POLL_INTERVAL_MS sleeps so we don't busy-poll the API into the
  // ground. iteration_duration captures the whole loop, which means VU
  // arrival self-throttles to whatever the workers can drain — the queue
  // never grows unbounded under sustained load even if RATE is high.
  let status = "running";
  let attempts = 0;
  const maxAttempts = Math.ceil(POLL_TIMEOUT_MS / POLL_INTERVAL_MS);
  while (status === "running" && attempts < maxAttempts) {
    sleep(POLL_INTERVAL_MS / 1000);
    const pollRes = http.get(
      `${data.baseUrl}/api/executions/${executionId}`,
      {
        headers: invokeHeaders(data),
        tags: { pipeline: slug, endpoint: "run", phase: "poll" }
      }
    );
    if (pollRes.status !== 200) break;
    status = pollRes.json("execution.status") || "running";
    attempts += 1;
  }

  runEndToEnd.add(Date.now() - startMs, { pipeline: slug });
  check(
    { status },
    {
      "execution terminated": (s) => s.status !== "running",
      "execution succeeded": (s) => s.status === "succeeded"
    },
    { pipeline: slug, endpoint: "run" }
  );
}

export default function (data) {
  const slug = pickPipeline();
  const pipelineId = data.pipelines[slug];
  if (!pipelineId) {
    // setup() already validated REQUIRED_PIPELINES; this only fires if you
    // typo'd PIPELINE=... at the CLI.
    throw new Error(
      `PIPELINE="${slug}" not in setup pipeline map (have: ${Object.keys(data.pipelines).join(", ")})`
    );
  }
  const body = PAYLOADS[slug]();
  if (ENDPOINT === "run") {
    runIteration(data, slug, pipelineId, body);
  } else {
    invokeIteration(data, slug, pipelineId, body);
  }
}
