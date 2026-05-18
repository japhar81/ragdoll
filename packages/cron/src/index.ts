// Dependency-free 5-field cron evaluator for the worker scheduler.
//
// Field order (standard Vixie/POSIX 5-field crontab):
//   minute        0-59
//   hour          0-23
//   day-of-month  1-31
//   month         1-12        (also JAN..DEC, case-insensitive)
//   day-of-week   0-6         (0 = Sunday; 7 also accepted as Sunday;
//                              also SUN..SAT, case-insensitive)
//
// Per-field syntax: `*`, lists `a,b,c`, ranges `a-b`, steps `*/n`,
// `a-b/n`, and `a/n` (which means a..max step n).

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

// A parsed cron expression. Each field is the explicit, de-duplicated,
// sorted set of integer values allowed for that field. `domStar` and
// `dowStar` record whether the source token was a bare `*`, which is
// required for the Vixie dom/dow OR semantics in `matches`.
export interface CronExpr {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
  domStar: boolean;
  dowStar: boolean;
  source: string;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12
};

const DOW_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6
};

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: Record<string, number>;
}

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES },
  { name: "day-of-week", min: 0, max: 7, names: DOW_NAMES }
];

function parseValue(raw: string, spec: FieldSpec): number {
  const lower = raw.toLowerCase();
  if (spec.names && lower in spec.names) {
    return spec.names[lower];
  }
  if (!/^\d+$/.test(raw)) {
    throw new CronParseError(
      `Invalid value "${raw}" in ${spec.name} field`
    );
  }
  return Number(raw);
}

function rangeError(value: number, spec: FieldSpec): never {
  throw new CronParseError(
    `Value ${value} out of range for ${spec.name} (expected ${spec.min}-${spec.max})`
  );
}

// Parse a single field token into an explicit list of allowed integers.
function parseField(token: string, spec: FieldSpec): number[] {
  const values = new Set<number>();

  for (const part of token.split(",")) {
    if (part === "") {
      throw new CronParseError(
        `Empty list element in ${spec.name} field`
      );
    }

    let body = part;
    let step = 1;

    const slashIdx = part.indexOf("/");
    if (slashIdx !== -1) {
      body = part.slice(0, slashIdx);
      const stepRaw = part.slice(slashIdx + 1);
      if (!/^\d+$/.test(stepRaw)) {
        throw new CronParseError(
          `Invalid step "${stepRaw}" in ${spec.name} field`
        );
      }
      step = Number(stepRaw);
      if (step <= 0) {
        throw new CronParseError(
          `Step must be positive in ${spec.name} field`
        );
      }
    }

    let lo: number;
    let hi: number;

    if (body === "*") {
      lo = spec.min;
      hi = spec.max;
    } else {
      const dashIdx = body.indexOf("-");
      if (dashIdx > 0) {
        lo = parseValue(body.slice(0, dashIdx), spec);
        hi = parseValue(body.slice(dashIdx + 1), spec);
      } else {
        lo = parseValue(body, spec);
        // `a/n` means a..max step n; a bare `a` is just a.
        hi = slashIdx !== -1 ? spec.max : lo;
      }
    }

    if (lo < spec.min || lo > spec.max) rangeError(lo, spec);
    if (hi < spec.min || hi > spec.max) rangeError(hi, spec);
    if (lo > hi) {
      throw new CronParseError(
        `Range ${lo}-${hi} is inverted in ${spec.name} field`
      );
    }

    for (let v = lo; v <= hi; v += step) {
      values.add(v);
    }
  }

  // Normalize day-of-week: 7 means Sunday (0).
  if (spec.name === "day-of-week" && values.has(7)) {
    values.delete(7);
    values.add(0);
  }

  return [...values].sort((a, b) => a - b);
}

export function parseCron(expr: string): CronExpr {
  if (typeof expr !== "string") {
    throw new CronParseError("Cron expression must be a string");
  }
  const trimmed = expr.trim();
  if (trimmed === "") {
    throw new CronParseError("Cron expression is empty");
  }

  const tokens = trimmed.split(/\s+/);
  if (tokens.length !== 5) {
    throw new CronParseError(
      `Expected 5 fields, got ${tokens.length} in "${expr}"`
    );
  }

  const minute = parseField(tokens[0], FIELDS[0]);
  const hour = parseField(tokens[1], FIELDS[1]);
  const dayOfMonth = parseField(tokens[2], FIELDS[2]);
  const month = parseField(tokens[3], FIELDS[3]);
  const dayOfWeek = parseField(tokens[4], FIELDS[4]);

  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    domStar: tokens[2] === "*",
    dowStar: tokens[4] === "*",
    source: trimmed
  };
}

function toExpr(expr: string | CronExpr): CronExpr {
  return typeof expr === "string" ? parseCron(expr) : expr;
}

export function matches(expr: string | CronExpr, date: Date): boolean {
  const c = toExpr(expr);

  const min = date.getUTCMinutes();
  const hr = date.getUTCHours();
  const dom = date.getUTCDate();
  const mon = date.getUTCMonth() + 1; // getUTCMonth is 0-based
  const dow = date.getUTCDay(); // 0 = Sunday

  if (!c.minute.includes(min)) return false;
  if (!c.hour.includes(hr)) return false;
  if (!c.month.includes(mon)) return false;

  const domMatch = c.dayOfMonth.includes(dom);
  const dowMatch = c.dayOfWeek.includes(dow);

  // Standard Vixie day-of-month / day-of-week semantics:
  // if BOTH dom and dow are restricted (neither field is a bare `*`),
  // the date matches if EITHER field matches. Otherwise both the
  // (possibly `*`) dom and dow conditions must hold.
  if (!c.domStar && !c.dowStar) {
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
}

export function nextAfter(expr: string | CronExpr, after: Date): Date {
  const c = toExpr(expr);

  // Start at the first whole minute strictly after `after`.
  const cursor = new Date(after.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  // Bounded search: ~4 years of minutes covers any 5-field schedule
  // (including Feb 29 leap-day cases, which recur within 4 years).
  const MAX_MINUTES = 4 * 366 * 24 * 60;

  for (let i = 0; i < MAX_MINUTES; i++) {
    if (matches(c, cursor)) {
      return new Date(cursor.getTime());
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }

  throw new CronError(
    `No matching time found within ~4 years for "${c.source}"`
  );
}
