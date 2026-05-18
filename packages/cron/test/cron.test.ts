import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCron,
  matches,
  nextAfter,
  CronError,
  CronParseError
} from "../src/index.ts";

test("parses a simple expression into explicit fields", () => {
  const c = parseCron("0 0 * * *");
  assert.deepEqual(c.minute, [0]);
  assert.deepEqual(c.hour, [0]);
  assert.equal(c.domStar, true);
  assert.equal(c.dowStar, true);
  assert.equal(c.dayOfMonth.length, 31);
  assert.equal(c.month.length, 12);
  assert.equal(c.dayOfWeek.length, 7);
});

test("star expands to full range", () => {
  const c = parseCron("* * * * *");
  assert.equal(c.minute.length, 60);
  assert.equal(c.hour.length, 24);
  assert.deepEqual(c.dayOfWeek, [0, 1, 2, 3, 4, 5, 6]);
});

test("lists, ranges, and steps", () => {
  assert.deepEqual(parseCron("1,5,9 * * * *").minute, [1, 5, 9]);
  assert.deepEqual(parseCron("0 1-5 * * *").hour, [1, 2, 3, 4, 5]);
  assert.deepEqual(
    parseCron("*/15 * * * *").minute,
    [0, 15, 30, 45]
  );
  assert.deepEqual(
    parseCron("0 0-12/3 * * *").hour,
    [0, 3, 6, 9, 12]
  );
  // `a/n` means a..max step n
  assert.deepEqual(
    parseCron("50/2 * * * *").minute,
    [50, 52, 54, 56, 58]
  );
  // combined list with range + step
  assert.deepEqual(
    parseCron("0,30,45-50 * * * *").minute,
    [0, 30, 45, 46, 47, 48, 49, 50]
  );
});

test("month and weekday names (case-insensitive)", () => {
  assert.deepEqual(parseCron("0 9 * * MON").dayOfWeek, [1]);
  assert.deepEqual(parseCron("0 9 * * mon").dayOfWeek, [1]);
  assert.deepEqual(parseCron("0 0 1 JAN *").month, [1]);
  assert.deepEqual(parseCron("0 0 1 jan-mar *").month, [1, 2, 3]);
  assert.deepEqual(
    parseCron("0 0 * * MON-FRI").dayOfWeek,
    [1, 2, 3, 4, 5]
  );
});

test("7 is normalized to Sunday (0)", () => {
  assert.deepEqual(parseCron("0 0 * * 7").dayOfWeek, [0]);
  assert.deepEqual(parseCron("0 0 * * 0,7").dayOfWeek, [0]);
  assert.deepEqual(parseCron("0 0 * * 5-7").dayOfWeek, [0, 5, 6]);
});

test("invalid expressions throw CronParseError", () => {
  const bad = [
    "",
    "   ",
    "* * * *", // 4 fields
    "* * * * * *", // 6 fields
    "60 * * * *", // minute out of range
    "* 24 * * *", // hour out of range
    "* * 0 * *", // dom min is 1
    "* * 32 * *", // dom out of range
    "* * * 13 *", // month out of range
    "* * * * 8", // dow max is 7
    "abc * * * *", // not a number/name
    "5-1 * * * *", // inverted range
    "*/0 * * * *", // zero step
    "1,,2 * * * *", // empty list element
    "* * * FOO *", // bad month name
    "* * * * FUN" // bad weekday name
  ];
  for (const expr of bad) {
    assert.throws(
      () => parseCron(expr),
      CronParseError,
      `expected throw for: ${JSON.stringify(expr)}`
    );
  }
});

test("CronParseError is a CronError with correct name", () => {
  try {
    parseCron("nope");
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof CronParseError);
    assert.ok(err instanceof CronError);
    assert.ok(err instanceof Error);
    assert.equal((err as CronParseError).name, "CronParseError");
  }
});

test("matches() truth table for 0 0 * * *", () => {
  const expr = "0 0 * * *";
  assert.equal(
    matches(expr, new Date("2026-05-18T00:00:00.000Z")),
    true
  );
  assert.equal(
    matches(expr, new Date("2026-05-18T00:00:30.000Z")),
    true
  ); // seconds ignored
  assert.equal(
    matches(expr, new Date("2026-05-18T00:01:00.000Z")),
    false
  );
  assert.equal(
    matches(expr, new Date("2026-05-18T01:00:00.000Z")),
    false
  );
});

test("matches() truth table for */15 9-17 * * MON-FRI", () => {
  const expr = "*/15 9-17 * * MON-FRI";
  // 2026-05-18 is a Monday
  assert.equal(
    matches(expr, new Date("2026-05-18T09:00:00.000Z")),
    true
  );
  assert.equal(
    matches(expr, new Date("2026-05-18T09:15:00.000Z")),
    true
  );
  assert.equal(
    matches(expr, new Date("2026-05-18T09:07:00.000Z")),
    false
  ); // not a 15-min boundary
  assert.equal(
    matches(expr, new Date("2026-05-18T08:00:00.000Z")),
    false
  ); // before 9
  assert.equal(
    matches(expr, new Date("2026-05-18T18:00:00.000Z")),
    false
  ); // after 17
  // 2026-05-16 is a Saturday
  assert.equal(
    matches(expr, new Date("2026-05-16T09:00:00.000Z")),
    false
  );
});

test("matches() evaluates in UTC, not local time", () => {
  // Midnight UTC matches regardless of host timezone.
  assert.equal(
    matches("0 0 * * *", new Date("2026-05-18T00:00:00.000Z")),
    true
  );
});

test("Vixie dom/dow OR rule: both restricted => EITHER matches", () => {
  // "0 0 13 * 5" -> midnight on the 13th OR any Friday.
  const expr = "0 0 13 * 5";

  // 2026-02-13 is a Friday -> matches (both dom and dow hit).
  assert.equal(
    matches(expr, new Date("2026-02-13T00:00:00.000Z")),
    true
  );
  // 2026-03-13 is a Friday -> matches.
  assert.equal(
    matches(expr, new Date("2026-03-13T00:00:00.000Z")),
    true
  );
  // 2026-05-13 is a Wednesday -> still matches because dom=13.
  assert.equal(
    matches(expr, new Date("2026-05-13T00:00:00.000Z")),
    true
  );
  // 2026-05-15 is a Friday -> matches because dow=5.
  assert.equal(
    matches(expr, new Date("2026-05-15T00:00:00.000Z")),
    true
  );
  // 2026-05-14 is a Thursday and not the 13th -> no match.
  assert.equal(
    matches(expr, new Date("2026-05-14T00:00:00.000Z")),
    false
  );
});

test("dom/dow AND rule when one field is *", () => {
  // dow is *, so only dom matters.
  assert.equal(
    matches("0 0 15 * *", new Date("2026-05-15T00:00:00.000Z")),
    true
  );
  assert.equal(
    matches("0 0 15 * *", new Date("2026-05-16T00:00:00.000Z")),
    false
  );
  // dom is *, so only dow matters. 2026-05-18 is Monday.
  assert.equal(
    matches("0 0 * * 1", new Date("2026-05-18T00:00:00.000Z")),
    true
  );
  assert.equal(
    matches("0 0 * * 1", new Date("2026-05-19T00:00:00.000Z")),
    false
  );
});

test("nextAfter: minute rollover", () => {
  const n = nextAfter("* * * * *", new Date("2026-05-18T10:30:15.000Z"));
  assert.equal(n.toISOString(), "2026-05-18T10:31:00.000Z");
});

test("nextAfter: strictly after (skips exact match)", () => {
  const n = nextAfter("30 10 * * *", new Date("2026-05-18T10:30:00.000Z"));
  assert.equal(n.toISOString(), "2026-05-19T10:30:00.000Z");
});

test("nextAfter: hour rollover", () => {
  const n = nextAfter("0 * * * *", new Date("2026-05-18T10:30:00.000Z"));
  assert.equal(n.toISOString(), "2026-05-18T11:00:00.000Z");
});

test("nextAfter: day rollover", () => {
  const n = nextAfter("0 0 * * *", new Date("2026-05-18T15:00:00.000Z"));
  assert.equal(n.toISOString(), "2026-05-19T00:00:00.000Z");
});

test("nextAfter: month rollover", () => {
  const n = nextAfter("0 0 1 * *", new Date("2026-05-18T00:00:00.000Z"));
  assert.equal(n.toISOString(), "2026-06-01T00:00:00.000Z");
});

test("nextAfter: year rollover", () => {
  const n = nextAfter("0 0 1 1 *", new Date("2026-05-18T00:00:00.000Z"));
  assert.equal(n.toISOString(), "2027-01-01T00:00:00.000Z");
});

test("nextAfter: leap-day case (Feb 29)", () => {
  // 2028 is the next leap year after 2026.
  const n = nextAfter("0 0 29 2 *", new Date("2026-05-18T00:00:00.000Z"));
  assert.equal(n.toISOString(), "2028-02-29T00:00:00.000Z");
});

test("nextAfter: respects Vixie OR rule across days", () => {
  // Friday the 13th-style: next match after a Wednesday the 13th
  // should be the very next Friday (dow), not next month's 13th.
  const n = nextAfter("0 0 13 * 5", new Date("2026-05-13T00:00:00.000Z"));
  // 2026-05-15 is the next Friday.
  assert.equal(n.toISOString(), "2026-05-15T00:00:00.000Z");
});

test("nextAfter: unsatisfiable schedule throws CronError", () => {
  // Feb 30 never exists, and dow is * so the OR rule does not apply.
  assert.throws(
    () => nextAfter("0 0 30 2 *", new Date("2026-01-01T00:00:00.000Z")),
    CronError
  );
});

test("matches accepts a pre-parsed CronExpr", () => {
  const c = parseCron("0 9 * * MON");
  assert.equal(
    matches(c, new Date("2026-05-18T09:00:00.000Z")),
    true
  );
  assert.equal(
    matches(c, new Date("2026-05-19T09:00:00.000Z")),
    false
  );
});
