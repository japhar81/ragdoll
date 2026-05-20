/**
 * Tests the croner-backed wrapper in @ragdoll/cron. We don't re-test croner
 * itself (it has its own tests upstream) — only that:
 *   - parseCron accepts known-good 5-field expressions
 *   - parseCron throws CronParseError on bad expressions and bad timezones
 *   - nextAfter returns a Date strictly after `after`, honouring `timezone`
 *   - nextRuns yields a strictly increasing sequence of `count` runs
 *
 * Requires `npm install` (croner is a runtime dependency).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CronError,
  CronParseError,
  nextAfter,
  nextRuns,
  parseCron
} from "../src/index.ts";

test("parseCron accepts canonical 5-field expressions", () => {
  assert.doesNotThrow(() => parseCron("0 0 * * *"));
  assert.doesNotThrow(() => parseCron("*/15 * * * *"));
  assert.doesNotThrow(() => parseCron("0 9 * * 1-5"));
});

test("parseCron rejects malformed expressions with CronParseError", () => {
  assert.throws(() => parseCron("not a cron"), CronParseError);
  assert.throws(() => parseCron("99 99 99 99 99"), CronParseError);
});

test("parseCron rejects an invalid IANA timezone", () => {
  assert.throws(
    () => parseCron("0 0 * * *", "Not/A_Real_Zone"),
    CronParseError
  );
});

test("nextAfter returns a Date strictly after `after`", () => {
  const ref = new Date("2026-05-19T12:00:00Z");
  const next = nextAfter("0 * * * *", ref, "UTC");
  // The next 0-th-minute hour after 12:00:00Z is 13:00:00Z.
  assert.equal(next.toISOString(), "2026-05-19T13:00:00.000Z");
  assert.ok(next.getTime() > ref.getTime());
});

test("nextAfter honours the supplied timezone (NY summer = UTC-4)", () => {
  const ref = new Date("2026-07-15T12:00:00Z"); // 08:00 in America/New_York
  const next = nextAfter("0 9 * * *", ref, "America/New_York");
  // The next 09:00 NY time after 08:00 NY today is the same day 09:00 NY,
  // which is 13:00:00Z.
  assert.equal(next.toISOString(), "2026-07-15T13:00:00.000Z");
});

test("nextRuns yields a strictly increasing window of size `count`", () => {
  const ref = new Date("2026-05-19T12:00:00Z");
  const runs = nextRuns("0 * * * *", ref, 4, "UTC");
  assert.equal(runs.length, 4);
  for (let i = 1; i < runs.length; i += 1) {
    assert.ok(runs[i].getTime() > runs[i - 1].getTime(), "monotonic");
  }
  // Each run is exactly one hour after the previous (every hour at :00).
  for (let i = 1; i < runs.length; i += 1) {
    assert.equal(
      runs[i].getTime() - runs[i - 1].getTime(),
      60 * 60 * 1000
    );
  }
});

test("CronParseError extends CronError so callers can branch by sentinel", () => {
  try {
    parseCron("garbage");
    assert.fail("expected throw");
  } catch (e) {
    assert.ok(e instanceof CronParseError);
    assert.ok(e instanceof CronError);
  }
});
