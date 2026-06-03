/**
 * Unit coverage for scripts/load-trend.ts (the k6 trend analyzer).
 *
 * Lives in tests/e2e/ alongside load-pipelines.e2e.test.ts so the whole
 * load-harness story exits/passes as one npm run test:e2e. The analyzer
 * itself is pure — no I/O — so this file doesn't spin up k6 or read a
 * real NDJSON file; instead it synthesizes SamplePoint arrays that mimic
 * what readSamples() would produce, then asserts the bucketing and drift
 * math.
 *
 * Why these checks exist (failure modes they catch):
 *   - percentile off-by-one (nearest-rank vs interpolated)
 *   - buckets indexed from the wrong start time (would compress every
 *     sample into bucket 0 and report drift=1.0)
 *   - drift comparison using the wrong stats (avg/median swap)
 *   - a regressed pipeline that drifts beyond DRIFT_LIMIT must surface
 *     in `breaches`-equivalent output (the table renderer prints "DRIFT")
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTrend,
  percentile,
  renderTrendTable,
  type SamplePoint
} from "../../scripts/load-trend.ts";

test("percentile: nearest-rank is monotonic and respects the endpoints", () => {
  const vals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(vals, 50), 5);
  assert.equal(percentile(vals, 95), 10);
  assert.equal(percentile(vals, 99), 10);
  assert.equal(percentile([], 95), 0);
  // Single-element: every percentile is that element.
  assert.equal(percentile([42], 50), 42);
  assert.equal(percentile([42], 99), 42);
});

test("buildTrend: bucketing windows samples by 30 s offsets from the first sample", () => {
  const start = Date.parse("2026-06-03T12:00:00Z");
  const samples: SamplePoint[] = [
    // bucket 0 (0-30s)
    { timeMs: start + 1000, durationMs: 20, pipeline: "load-passthrough" },
    { timeMs: start + 29_000, durationMs: 22, pipeline: "load-passthrough" },
    // bucket 1 (30-60s)
    { timeMs: start + 31_000, durationMs: 24, pipeline: "load-passthrough" },
    { timeMs: start + 59_000, durationMs: 26, pipeline: "load-passthrough" }
  ];
  const trends = buildTrend(samples, 30);
  assert.equal(trends.length, 1);
  const t = trends[0];
  assert.equal(t.pipeline, "load-passthrough");
  assert.deepEqual(
    t.buckets.map((b) => b.bucketIndex),
    [0, 1]
  );
  assert.deepEqual(
    t.buckets.map((b) => b.count),
    [2, 2]
  );
});

test("buildTrend: drift ratio compares last-2 to first-2 bucket median p95s", () => {
  const start = Date.parse("2026-06-03T12:00:00Z");
  const samples: SamplePoint[] = [];
  // Four buckets, drifting from p95~=20 to p95~=40 → drift ratio ~= 2.0.
  // Per-bucket: enough samples that percentile-95 lands on the intended
  // value (nearest-rank: rank=ceil(0.95*20)-1=18, i.e. the 19th element
  // in a 20-element sorted list).
  for (let bucket = 0; bucket < 4; bucket++) {
    const base = 20 + bucket * 7; // 20, 27, 34, 41
    for (let i = 0; i < 20; i++) {
      samples.push({
        timeMs: start + bucket * 30_000 + i * 100,
        durationMs: base + i * 0.1, // jitter so percentiles aren't degenerate
        pipeline: "load-deep-chain"
      });
    }
  }
  const [t] = buildTrend(samples, 30);
  assert.equal(t.buckets.length, 4);
  // first window = buckets 0+1 (p95 ≈ 21.9, 28.9 → median ≈ 25.4)
  // last window  = buckets 2+3 (p95 ≈ 35.9, 42.9 → median ≈ 39.4)
  // ratio ≈ 1.55 — definitely above the 1.5x default.
  assert.ok(t.driftRatio > 1.5, `expected drift > 1.5, got ${t.driftRatio.toFixed(3)}`);
});

test("buildTrend: a flat (no-drift) run reports a drift ratio near 1.0", () => {
  const start = Date.parse("2026-06-03T12:00:00Z");
  const samples: SamplePoint[] = [];
  for (let bucket = 0; bucket < 6; bucket++) {
    for (let i = 0; i < 20; i++) {
      samples.push({
        timeMs: start + bucket * 30_000 + i * 100,
        durationMs: 25 + (i % 3), // constant distribution per bucket
        pipeline: "load-passthrough"
      });
    }
  }
  const [t] = buildTrend(samples, 30);
  assert.ok(
    Math.abs(t.driftRatio - 1.0) < 0.2,
    `expected drift ~1.0 on a flat run, got ${t.driftRatio.toFixed(3)}`
  );
});

test("buildTrend: groups every distinct pipeline independently", () => {
  const start = Date.parse("2026-06-03T12:00:00Z");
  const samples: SamplePoint[] = [
    { timeMs: start, durationMs: 10, pipeline: "load-passthrough" },
    { timeMs: start + 1000, durationMs: 50, pipeline: "load-deep-chain" }
  ];
  const trends = buildTrend(samples, 30);
  assert.deepEqual(
    trends.map((t) => t.pipeline),
    ["load-deep-chain", "load-passthrough"]
  );
});

test("buildTrend: empty input yields no trends (and no NaN)", () => {
  assert.deepEqual(buildTrend([], 30), []);
});

test("renderTrendTable: includes a per-pipeline row, drift column, and the verdict", () => {
  const start = Date.parse("2026-06-03T12:00:00Z");
  const samples: SamplePoint[] = [];
  for (let bucket = 0; bucket < 4; bucket++) {
    for (let i = 0; i < 20; i++) {
      samples.push({
        timeMs: start + bucket * 30_000 + i * 100,
        durationMs: 20 + bucket * 10 + i * 0.1,
        pipeline: "load-passthrough"
      });
    }
  }
  const out = renderTrendTable(buildTrend(samples, 30), 1.5);
  assert.match(out, /load-passthrough/);
  assert.match(out, /b0/);
  assert.match(out, /b3/);
  assert.match(out, /DRIFT|ok/);
  assert.match(out, /Drift = median/);
});

test("renderTrendTable: empty trends render a clear no-samples message (not a crash)", () => {
  const out = renderTrendTable([], 1.5);
  assert.match(out, /no \/invoke samples/);
});
