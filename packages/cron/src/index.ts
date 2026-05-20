/**
 * Thin wrapper over `croner` that preserves the small surface this codebase
 * relies on (validate + compute the next fire time). We deliberately do NOT
 * maintain a hand-rolled cron parser — croner is the engine of record.
 *
 * Public API is unchanged from the previous in-house module:
 *   parseCron(expr, timezone?)         -> throws CronParseError on bad input
 *   nextAfter(expr, after, timezone?)  -> returns the next firing Date after
 *                                         `after`, in the supplied timezone
 *   CronError / CronParseError         -> error sentinels used by the API
 *
 * croner is a regular runtime dependency; this module is loaded by app.ts and
 * the worker scheduler, so `npm install` is required before running tests
 * that exercise those paths.
 */
import { Cron } from "croner";

export class CronError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "CronError";
  }
}

export class CronParseError extends CronError {
  constructor(msg: string) {
    super(msg);
    this.name = "CronParseError";
  }
}

function build(expr: string, timezone?: string): InstanceType<typeof Cron> {
  // croner is lenient about bogus timezone strings (it surfaces them as a
  // later runtime issue); validate up front so an obviously invalid IANA name
  // becomes a clean 422 at schedule-create time instead of a silent failure.
  if (timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      throw new CronParseError(`invalid timezone: ${timezone}`);
    }
  }
  try {
    return new Cron(expr, timezone ? { timezone } : undefined);
  } catch (e) {
    throw new CronParseError(
      e instanceof Error ? e.message : `invalid cron expression: ${expr}`
    );
  }
}

/**
 * Validate `expr` (and optional IANA timezone) eagerly. Returns nothing on
 * success; throws {@link CronParseError} on any parse / timezone failure so
 * route handlers can map it to a 422.
 */
export function parseCron(expr: string, timezone?: string): void {
  build(expr, timezone);
}

/**
 * Next firing time strictly after `after`. Honours `timezone` (IANA name);
 * croner defaults to local time when omitted, but every caller in this
 * codebase has a timezone in hand (the schedule row carries one) — pass it
 * explicitly so DST is handled correctly.
 */
export function nextAfter(
  expr: string,
  after: Date,
  timezone?: string
): Date {
  const cron = build(expr, timezone);
  const next = cron.nextRun(after);
  if (!next) {
    throw new CronError(`No matching time found for "${expr}"`);
  }
  return next;
}

/** Convenience: the next `n` firing times after `after`. Used by the UI. */
export function nextRuns(
  expr: string,
  after: Date,
  count: number,
  timezone?: string
): Date[] {
  const cron = build(expr, timezone);
  const out: Date[] = [];
  let cursor: Date | null = after;
  for (let i = 0; i < count; i += 1) {
    const next: Date | null = cron.nextRun(cursor ?? undefined);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}
