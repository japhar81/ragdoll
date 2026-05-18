import test from "node:test";
import assert from "node:assert/strict";
import {
  CRON_FIELDS,
  CRON_PRESETS,
  composeCron,
  describeCron,
  parseCron,
  validateCron
} from "../src/lib/cron.ts";

test("CRON_FIELDS is the 5-field order", () => {
  assert.deepEqual(CRON_FIELDS, ["minute", "hour", "dom", "month", "dow"]);
});

test("composeCron joins parts; missing collapse to *", () => {
  assert.equal(
    composeCron({ minute: "0", hour: "2", dom: "*", month: "*", dow: "*" }),
    "0 2 * * *"
  );
  assert.equal(
    composeCron({ minute: "", hour: "  ", dom: "*", month: "*", dow: "*" }),
    "* * * * *"
  );
});

test("parseCron splits a string back into parts (tolerant)", () => {
  assert.deepEqual(parseCron("*/15 * * * *"), {
    minute: "*/15",
    hour: "*",
    dom: "*",
    month: "*",
    dow: "*"
  });
  // extra whitespace collapses
  assert.deepEqual(parseCron("  0   9   *   *   1-5 "), {
    minute: "0",
    hour: "9",
    dom: "*",
    month: "*",
    dow: "1-5"
  });
  // too few fields => missing default to *
  assert.deepEqual(parseCron("0 2"), {
    minute: "0",
    hour: "2",
    dom: "*",
    month: "*",
    dow: "*"
  });
});

test("composeCron/parseCron round-trip the presets", () => {
  for (const p of CRON_PRESETS) {
    assert.equal(composeCron(parseCron(p.cron)), p.cron);
    assert.equal(validateCron(p.cron).valid, true);
  }
});

test("validateCron accepts valid expressions incl. lists/ranges/steps", () => {
  assert.equal(validateCron("* * * * *").valid, true);
  assert.equal(validateCron("0 2 * * *").valid, true);
  assert.equal(validateCron("*/15 * * * *").valid, true);
  assert.equal(validateCron("0 9 * * 1-5").valid, true);
  assert.equal(validateCron("1,15,30 0 1 1,6,12 *").valid, true);
  assert.equal(validateCron("0 0 * * 0").valid, true); // Sunday as 0
  assert.equal(validateCron("0 0 * * 7").valid, true); // Sunday as 7
});

test("validateCron rejects bad field count and out-of-range values", () => {
  const fewer = validateCron("* * * *");
  assert.equal(fewer.valid, false);
  assert.ok(fewer.errors.some((e) => /5 cron fields/.test(e)));

  const tooMany = validateCron("* * * * * *");
  assert.equal(tooMany.valid, false);

  const badMinute = validateCron("99 * * * *");
  assert.equal(badMinute.valid, false);
  assert.ok(badMinute.errors.some((e) => /minute: 99 out of range/.test(e)));

  const badHour = validateCron("0 24 * * *");
  assert.equal(badHour.valid, false);

  const badStep = validateCron("*/0 * * * *");
  assert.equal(badStep.valid, false);

  const descRange = validateCron("0 9-2 * * *");
  assert.equal(descRange.valid, false);
  assert.ok(descRange.errors.some((e) => /descending range/.test(e)));

  const nonNumber = validateCron("a * * * *");
  assert.equal(nonNumber.valid, false);
});

test("describeCron gives a rough gloss / invalid marker", () => {
  assert.equal(describeCron("* * * * *"), "every minute");
  assert.equal(describeCron("0 2 * * *"), "minute 0, hour 2");
  assert.equal(describeCron("not valid"), "invalid cron");
  assert.equal(describeCron("0 9 * * 1-5"), "minute 0, hour 9, day-of-week 1-5");
});
