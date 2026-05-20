/**
 * Pure, DOM-free helpers for the Scheduler's small visual cron builder, plus
 * a `previewNextRuns` powered by croner so the form shows real schedule
 * predictions (matching what the server will compute).
 *
 * We model a standard 5-field Vixie/POSIX cron (minute hour dom month dow).
 * The builder edits each field as a free string (star, "0", step, list) and
 * the compose/parse/validate helpers stay free of croner so they're unit-
 * testable. croner is bundled by the web build.
 */
import { Cron } from "croner";

/** The five cron positions, in order. */
export const CRON_FIELDS = ["minute", "hour", "dom", "month", "dow"] as const;
export type CronFieldName = (typeof CRON_FIELDS)[number];

/** Flat, all-strings shape the visual builder binds its inputs to. */
export interface CronParts {
  minute: string;
  hour: string;
  dom: string;
  month: string;
  dow: string;
}

const EMPTY_PARTS: CronParts = {
  minute: "*",
  hour: "*",
  dom: "*",
  month: "*",
  dow: "*"
};

/** Inclusive numeric bounds per field (dow allows 0-7, both meaning Sunday). */
const BOUNDS: Record<CronFieldName, { min: number; max: number }> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dom: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dow: { min: 0, max: 7 }
};

/** Join the five parts into a normalized "m h dom mon dow" string. */
export function composeCron(parts: CronParts): string {
  return CRON_FIELDS.map((f) => (parts[f] || "*").trim() || "*").join(" ");
}

/**
 * Split a cron string back into parts. Tolerant: extra whitespace is
 * collapsed; a string with the wrong field count still yields a best-effort
 * fill (missing fields default to "*") so the form stays editable.
 */
export function parseCron(cron: string): CronParts {
  const tokens = (cron ?? "").trim().split(/\s+/).filter(Boolean);
  const parts: CronParts = { ...EMPTY_PARTS };
  CRON_FIELDS.forEach((f, i) => {
    if (tokens[i]) parts[f] = tokens[i];
  });
  return parts;
}

/** Validate one field token (supports `*`, lists, ranges and `*|n / step`). */
function validateField(name: CronFieldName, raw: string): string | undefined {
  const token = (raw ?? "").trim();
  if (!token) return `${name} is empty`;
  const { min, max } = BOUNDS[name];
  for (const part of token.split(",")) {
    if (!part) return `${name} has an empty list item`;
    const [body, step] = part.split("/");
    if (part.includes("/")) {
      if (!step || !/^\d+$/.test(step) || Number(step) < 1) {
        return `${name}: bad step in "${part}"`;
      }
    }
    if (body === "*") continue;
    const range = body.split("-");
    if (range.length > 2) return `${name}: bad range "${body}"`;
    for (const n of range) {
      if (!/^\d+$/.test(n)) return `${name}: "${n}" is not a number`;
      const v = Number(n);
      if (v < min || v > max) {
        return `${name}: ${v} out of range ${min}-${max}`;
      }
    }
    if (range.length === 2 && Number(range[0]) > Number(range[1])) {
      return `${name}: descending range "${body}"`;
    }
  }
  return undefined;
}

export interface CronValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Light client-side validation. Catches obvious field-count / range mistakes;
 * the server's parseCron remains authoritative (surface its 422 too).
 */
export function validateCron(cron: string): CronValidation {
  const tokens = (cron ?? "").trim().split(/\s+/).filter(Boolean);
  const errors: string[] = [];
  if (tokens.length !== 5) {
    errors.push(`Expected 5 cron fields, got ${tokens.length}.`);
    return { valid: false, errors };
  }
  CRON_FIELDS.forEach((f, i) => {
    const err = validateField(f, tokens[i]);
    if (err) errors.push(err);
  });
  return { valid: errors.length === 0, errors };
}

/** A handful of presets the builder offers as one-click starting points. */
export const CRON_PRESETS: Array<{ label: string; cron: string }> = [
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Daily at 02:00", cron: "0 2 * * *" },
  { label: "Weekdays 09:00", cron: "0 9 * * 1-5" },
  { label: "Weekly (Mon 00:00)", cron: "0 0 * * 1" },
  { label: "Monthly (1st 00:00)", cron: "0 0 1 * *" }
];

/**
 * Real next-runs preview via croner (matches what the server schedules).
 * Returns `undefined` when croner rejects the input or the timezone is bogus,
 * so the UI can render a "—" placeholder instead of a misleading prediction.
 */
export function previewNextRuns(
  cron: string,
  count: number,
  timezone?: string,
  from: Date = new Date()
): Date[] | undefined {
  if (!validateCron(cron).valid) return undefined;
  if (timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      return undefined;
    }
  }
  try {
    const c = new Cron(cron, timezone ? { timezone } : undefined);
    const out: Date[] = [];
    let cursor: Date | null = from;
    for (let i = 0; i < count; i += 1) {
      const next: Date | null = c.nextRun(cursor ?? undefined);
      if (!next) break;
      out.push(next);
      cursor = next;
    }
    return out;
  } catch {
    return undefined;
  }
}

/** Very rough English gloss of a cron string for the form preview. */
export function describeCron(cron: string): string {
  const v = validateCron(cron);
  if (!v.valid) return "invalid cron";
  const p = parseCron(cron);
  if (cron.trim() === "* * * * *") return "every minute";
  const bits: string[] = [];
  bits.push(p.minute === "*" ? "every minute" : `minute ${p.minute}`);
  if (p.hour !== "*") bits.push(`hour ${p.hour}`);
  if (p.dom !== "*") bits.push(`day-of-month ${p.dom}`);
  if (p.month !== "*") bits.push(`month ${p.month}`);
  if (p.dow !== "*") bits.push(`day-of-week ${p.dow}`);
  return bits.join(", ");
}
