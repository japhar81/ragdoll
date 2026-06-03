/**
 * Post-run trend analyzer for the k6 load harness.
 *
 * Why: the smoke / steady / spike / soak scenarios all answer "did the
 * harness finish without breaching thresholds." None answer "did the
 * pipelines keep finishing in roughly the same time over a sustained
 * run?" — i.e. did latency drift up over the minutes.
 *
 * How: k6 writes per-sample NDJSON with `--out json=<path>`. We read it,
 * filter to `http_req_duration` Points that carry a `pipeline` tag (the
 * /invoke requests; setup-phase login / list calls have no pipeline tag
 * and get skipped), bucket each sample into a fixed-size time window
 * (default 30 s), compute p95 per (pipeline, bucket), and compare the
 * median of the LAST two buckets' p95s against the median of the FIRST
 * two. The ratio is the drift; we fail loudly if it exceeds `DRIFT_LIMIT`
 * (default 1.5×, i.e. a 50% slowdown over the run).
 *
 * Output: a per-pipeline trend table on stdout, plus a non-zero exit when
 * any pipeline breaches the drift ceiling. Side-effect-free otherwise —
 * the NDJSON path is read once and never written.
 *
 * Run via the k6 wrapper (`./scripts/k6.sh trend`); also runnable standalone:
 *   node --experimental-strip-types scripts/load-trend.ts <ndjson-path>
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export interface SamplePoint {
  timeMs: number;
  durationMs: number;
  pipeline: string;
}

export interface BucketStats {
  bucketIndex: number;
  count: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface PipelineTrend {
  pipeline: string;
  buckets: BucketStats[];
  driftRatio: number; // last-half median p95 / first-half median p95
  firstP95: number;
  lastP95: number;
}

/** Pure: percentile via nearest-rank on a sorted copy. */
export function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.ceil((q / 100) * sorted.length) - 1);
  return sorted[Math.max(0, rank)];
}

/** Pure: median of a small list (used to compare 2 values without sorting noise). */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Group samples by pipeline + time bucket. Returns one PipelineTrend per slug. */
export function buildTrend(
  samples: SamplePoint[],
  bucketSeconds: number
): PipelineTrend[] {
  if (samples.length === 0) return [];
  const bucketMs = bucketSeconds * 1000;
  const startMs = Math.min(...samples.map((s) => s.timeMs));

  // pipeline -> bucketIndex -> values
  const grouped = new Map<string, Map<number, number[]>>();
  for (const s of samples) {
    const idx = Math.floor((s.timeMs - startMs) / bucketMs);
    let byBucket = grouped.get(s.pipeline);
    if (!byBucket) {
      byBucket = new Map();
      grouped.set(s.pipeline, byBucket);
    }
    let bucket = byBucket.get(idx);
    if (!bucket) {
      bucket = [];
      byBucket.set(idx, bucket);
    }
    bucket.push(s.durationMs);
  }

  const out: PipelineTrend[] = [];
  for (const [pipeline, byBucket] of grouped) {
    const buckets: BucketStats[] = [];
    const indexes = Array.from(byBucket.keys()).sort((a, b) => a - b);
    for (const idx of indexes) {
      const values = byBucket.get(idx)!;
      buckets.push({
        bucketIndex: idx,
        count: values.length,
        p50: percentile(values, 50),
        p95: percentile(values, 95),
        p99: percentile(values, 99)
      });
    }
    // Drift = compare LAST two buckets to FIRST two. Two-bucket window
    // damps single-bucket noise (CPU steal, GC tick). When the run is
    // too short to have 4 distinct buckets we fall back to first/last
    // single buckets — still informative, just noisier.
    const firstSlice = buckets.length >= 4 ? buckets.slice(0, 2) : buckets.slice(0, 1);
    const lastSlice =
      buckets.length >= 4
        ? buckets.slice(-2)
        : buckets.slice(-1);
    const firstP95 = median(firstSlice.map((b) => b.p95));
    const lastP95 = median(lastSlice.map((b) => b.p95));
    const driftRatio = firstP95 > 0 ? lastP95 / firstP95 : 0;
    out.push({ pipeline, buckets, driftRatio, firstP95, lastP95 });
  }
  // Stable order so the printed table doesn't shuffle between runs.
  out.sort((a, b) => a.pipeline.localeCompare(b.pipeline));
  return out;
}

/** Reads a k6 NDJSON output and extracts the http_req_duration samples
 *  that carry a `pipeline` tag (i.e. /invoke requests; setup-phase
 *  auth/list calls have no pipeline tag and are skipped). */
export async function readSamples(path: string): Promise<SamplePoint[]> {
  const out: SamplePoint[] = [];
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    if (line.indexOf('"http_req_duration"') < 0) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const row = obj as {
      type?: string;
      metric?: string;
      data?: {
        time?: string;
        value?: number;
        tags?: Record<string, string>;
      };
    };
    if (row.type !== "Point" || row.metric !== "http_req_duration") continue;
    const tags = row.data?.tags ?? {};
    const pipeline = tags.pipeline;
    if (!pipeline) continue; // setup/teardown noise
    const t = row.data?.time ? Date.parse(row.data.time) : NaN;
    const v = row.data?.value;
    if (!Number.isFinite(t) || typeof v !== "number") continue;
    out.push({ timeMs: t, durationMs: v, pipeline });
  }
  return out;
}

function fmt(ms: number): string {
  if (ms < 10) return ms.toFixed(2) + "ms";
  if (ms < 100) return ms.toFixed(1) + "ms";
  return Math.round(ms) + "ms";
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/** Build a human-readable table of bucket p95 values per pipeline plus
 *  the drift conclusion. Pure — no I/O. */
export function renderTrendTable(trends: PipelineTrend[], driftLimit: number): string {
  if (trends.length === 0) return "(no /invoke samples with a `pipeline` tag found in the k6 output)\n";

  const pipelineColWidth = Math.max(
    "pipeline".length,
    ...trends.map((t) => t.pipeline.length)
  );

  // Determine the union of bucket indexes so the table aligns.
  const allBuckets = new Set<number>();
  for (const t of trends) for (const b of t.buckets) allBuckets.add(b.bucketIndex);
  const bucketIndexes = Array.from(allBuckets).sort((a, b) => a - b);

  const header =
    pad("pipeline", pipelineColWidth) +
    "  " +
    bucketIndexes.map((i) => pad(`b${i}`, 7)).join(" ") +
    "  drift     verdict\n";
  const rule = "-".repeat(header.length - 1) + "\n";

  let body = "";
  for (const t of trends) {
    const byIdx = new Map(t.buckets.map((b) => [b.bucketIndex, b]));
    const cells = bucketIndexes
      .map((i) => {
        const b = byIdx.get(i);
        return pad(b ? fmt(b.p95) : "-", 7);
      })
      .join(" ");
    const driftPct =
      t.driftRatio > 0 ? `${((t.driftRatio - 1) * 100).toFixed(0).padStart(3, " ")}%` : "  -";
    const verdict = t.driftRatio > driftLimit ? "DRIFT  ⚠" : "ok";
    body +=
      pad(t.pipeline, pipelineColWidth) +
      "  " +
      cells +
      "  " +
      pad(driftPct, 6) +
      "  " +
      verdict +
      "\n";
  }

  const note =
    `\nDrift = median(p95 of last 2 buckets) / median(p95 of first 2 buckets) per pipeline.\n` +
    `Threshold: ${driftLimit.toFixed(2)}× (i.e. fail above ${((driftLimit - 1) * 100).toFixed(0)}% slowdown). Override via DRIFT_LIMIT env.\n`;

  return "\n=== load trend per pipeline (p95 by time bucket) ===\n\n" + header + rule + body + note;
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write(
      "usage: load-trend.ts <k6-ndjson-path>\n  env: BUCKET_SECONDS (default 30), DRIFT_LIMIT (default 1.5)\n"
    );
    process.exit(2);
  }
  const bucketSeconds = Number(process.env.BUCKET_SECONDS) || 30;
  const driftLimit = Number(process.env.DRIFT_LIMIT) || 1.5;

  const samples = await readSamples(path);
  const trends = buildTrend(samples, bucketSeconds);
  process.stdout.write(renderTrendTable(trends, driftLimit));

  const breaches = trends.filter((t) => t.driftRatio > driftLimit);
  if (breaches.length > 0) {
    process.stderr.write(
      `\nFAIL: ${breaches.length} pipeline${breaches.length === 1 ? "" : "s"} drifted past ${driftLimit.toFixed(2)}×: ${breaches.map((b) => b.pipeline).join(", ")}\n`
    );
    process.exit(1);
  }
}

const isEntryPoint = import.meta.url.endsWith(process.argv[1]);
if (isEntryPoint) {
  main().catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(2);
  });
}
