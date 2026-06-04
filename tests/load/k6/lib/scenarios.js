// Four canonical load scenarios. SCENARIO=<name> env var picks one;
// defaults to "smoke" so a bare `k6 run main.js` is safe to ctrl-C.
//
//   smoke   — 1 VU × ~30 iterations. Sanity that everything responds 200.
//             Run before any "real" load run to catch broken auth / missing
//             pipelines without burning a soak budget.
//
//   steady  — constant arrival rate (default 20 RPS) for 1 minute. The
//             throughput shape we ship SLAs against. Adjust the rate via
//             RATE=<rps>.
//
//   spike   — ramp 1 → 50 VUs over 10s, hold 30s, drain to 1 over 10s.
//             Catches connection-pool exhaustion + queue-depth blowups that
//             steady-state hides.
//
//   soak    — 5 VUs for 10 minutes (default). Catches slow leaks: file
//             descriptors, in-memory caches, anything that grows unbounded
//             on the happy path. Defaults to ENDPOINT=run (POST /run +
//             poll), so the WORKER process is what's actually under load —
//             that's what populates the Worker scale-out Grafana dashboard
//             (ragdoll_worker_* metrics). Use ENDPOINT=invoke to soak the
//             API/runtime path instead. Duration via DURATION=<k6 duration>.
//
//   trend   — sustained constant-arrival-rate for DURATION (default 5m) at
//             RATE rps (default 10). The wrapper pairs this with the
//             scripts/load-trend.ts analyzer, which buckets per-pipeline
//             latency by BUCKET_SECONDS (default 30) and fails the run if
//             median(last-2-buckets p95) / median(first-2 p95) > DRIFT_LIMIT
//             (default 1.5x). Use this to confirm pipelines keep finishing
//             at roughly the same speed under sustained load.
//
// Latency thresholds are kept loose on purpose — the load corpus is plumbing
// (no LLMs, no I/O), so a healthy local stack hits low millisecond p95s.
// Tighten thresholds per-scenario when you're characterizing a deploy you
// actually care about (CI cluster, prod baseline).

const RATE = Number(__ENV.RATE) || 20;
const DURATION = __ENV.DURATION || "10m";
// `trend` defaults stay separate from `steady` so the steady scenario
// (short, throughput-shape SLA) and the trend scenario (long, drift-
// detection) can coexist without overloading one set of env vars.
const TREND_RATE = Number(__ENV.RATE) || 10;
const TREND_DURATION = __ENV.DURATION || "5m";

export const SCENARIOS = {
  smoke: {
    executor: "shared-iterations",
    vus: 1,
    iterations: 30,
    maxDuration: "60s"
  },
  steady: {
    executor: "constant-arrival-rate",
    rate: RATE,
    timeUnit: "1s",
    duration: "1m",
    preAllocatedVUs: Math.max(10, RATE),
    maxVUs: Math.max(50, RATE * 4)
  },
  spike: {
    executor: "ramping-vus",
    startVUs: 1,
    stages: [
      { duration: "10s", target: 50 },
      { duration: "30s", target: 50 },
      { duration: "10s", target: 1 }
    ],
    gracefulRampDown: "5s"
  },
  soak: {
    executor: "constant-vus",
    vus: 5,
    duration: DURATION
  },
  trend: {
    executor: "constant-arrival-rate",
    rate: TREND_RATE,
    timeUnit: "1s",
    duration: TREND_DURATION,
    preAllocatedVUs: Math.max(5, TREND_RATE),
    maxVUs: Math.max(20, TREND_RATE * 2)
  }
};

// Thresholds the harness FAILS the run on. Two-tier:
//  - error budget: <1% of requests may fail (any non-2xx, or the body check)
//  - latency: p95 < 1s on non-LLM platform-only work is a generous ceiling
//    for any reasonable local stack; flag a regression if we cross it.
export const THRESHOLDS = {
  http_req_failed: ["rate<0.01"],
  http_req_duration: ["p(95)<1000", "p(99)<2000"],
  // Per-pipeline duration thresholds let you spot which slug regressed
  // when the global threshold fails. The `pipeline` tag is set by main.js.
  "http_req_duration{pipeline:load-passthrough}": ["p(95)<500"],
  "http_req_duration{pipeline:load-fanout-merge}": ["p(95)<750"],
  "http_req_duration{pipeline:load-deep-chain}": ["p(95)<750"],
  "http_req_duration{pipeline:load-xml-parse}": ["p(95)<1000"]
};

export function selectScenario() {
  const name = __ENV.SCENARIO || "smoke";
  const s = SCENARIOS[name];
  if (!s) {
    throw new Error(
      `unknown SCENARIO="${name}" (valid: ${Object.keys(SCENARIOS).join(", ")})`
    );
  }
  return { [name]: s };
}
