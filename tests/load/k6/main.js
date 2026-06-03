// k6 load harness for the RAGdoll API.
//
// Picks a scenario via SCENARIO env (smoke|steady|spike|soak; default smoke)
// and round-robins across every load-* pipeline so a single run exercises
// every shape (passthrough / fanout / deep chain / xml parse) under the
// same arrival profile. Pin to one pipeline with PIPELINE=<slug>.
//
// Run:
//   k6 run tests/load/k6/main.js                                  # smoke
//   SCENARIO=steady RATE=50 k6 run tests/load/k6/main.js
//   SCENARIO=spike k6 run tests/load/k6/main.js
//   SCENARIO=soak DURATION=10m k6 run tests/load/k6/main.js
//   PIPELINE=load-deep-chain SCENARIO=steady k6 run tests/load/k6/main.js
//
// Defaults assume a local stack on http://localhost:3001 with the bootstrap
// admin and `tenant-local` seeded. Override BASE_URL / TENANT_SLUG /
// BOOTSTRAP_ADMIN_* / RAGDOLL_API_KEY when pointing at a remote target.
//
// See docs/admin/load-testing.md for a walk-through + how to add a new
// pipeline and scenario.

import http from "k6/http";
import { check } from "k6";
import { bootstrapAuth, invokeHeaders } from "./lib/auth.js";
import { PAYLOADS, loadPipelineSlugs } from "./lib/payloads.js";
import { selectScenario, THRESHOLDS } from "./lib/scenarios.js";

export const options = {
  scenarios: selectScenario(),
  thresholds: THRESHOLDS,
  // Real-world clients reconnect; we want connection setup costs in the p99.
  noConnectionReuse: false,
  // Slap a meaningful run tag so multi-run dashboards differentiate sources.
  tags: { harness: "ragdoll-k6" }
};

const TARGET_PIPELINE = __ENV.PIPELINE; // optional: pin to one slug

export function setup() {
  return bootstrapAuth();
}

const SLUGS = loadPipelineSlugs();

export default function (data) {
  const slug = TARGET_PIPELINE
    ? TARGET_PIPELINE
    : SLUGS[(__ITER + __VU) % SLUGS.length];
  const pipelineId = data.pipelines[slug];
  if (!pipelineId) {
    // setup() already validated REQUIRED_PIPELINES; this only fires if you
    // typo'd PIPELINE=... at the CLI.
    throw new Error(
      `PIPELINE="${slug}" not in setup pipeline map (have: ${Object.keys(data.pipelines).join(", ")})`
    );
  }
  const payload = PAYLOADS[slug]();
  const res = http.post(
    `${data.baseUrl}/api/pipelines/${pipelineId}/invoke`,
    JSON.stringify({ ...payload, environment: "dev" }),
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
    { pipeline: slug }
  );
}
