/**
 * CLI-side helpers for the server's cascade-aware DELETE pattern.
 *
 * Server contract (apps/api/src/app/cascade-utils.ts):
 *   - Default DELETE refuses with HTTP 409 has_dependents +
 *     {dependents: {<kind>: <count>}, hint: "?force=true to cascade"}.
 *   - Append ?force=true to cascade.
 *
 * CLI surface:
 *   - `forceQs(opts.force)` — returns "?force=true" or "" so command
 *     handlers can splice into URLs without per-command string-building.
 *   - `runDelete(ctx, action, path, opts)` — fires the DELETE, pretty-
 *     prints the dependents breakdown when the server refuses, and
 *     suggests `--force` so the operator doesn't have to remember.
 *     Exits with code 2 on any other error (same shape as ctx.fail).
 */
import { api, fail, type Ctx } from "./ctx.ts";
import { ApiError } from "./http.ts";

/** Append `?force=true` when --force is set. Empty string otherwise so
 *  the URL stays clean for the default soft path (matters for the
 *  connection route, which soft-archives by default). */
export function forceQs(force: boolean | undefined): string {
  return force ? "?force=true" : "";
}

interface HasDependentsBody {
  error: "has_dependents";
  message?: string;
  dependents?: Record<string, number>;
  hint?: string;
}

function isHasDependentsBody(body: unknown): body is HasDependentsBody {
  if (!body || typeof body !== "object") return false;
  const b = body as { error?: unknown; dependents?: unknown };
  return b.error === "has_dependents" && !!b.dependents && typeof b.dependents === "object";
}

/**
 * Run a DELETE that may return the cascade-refusal envelope. On 409
 * has_dependents, prints a structured breakdown to stderr and exits
 * with code 3 (distinct from generic ApiError = 2) so a `--force`
 * absence is scriptable. Every other error path delegates to `fail`.
 */
export async function runDelete(
  ctx: Ctx,
  action: string,
  path: string,
  opts: { force?: boolean } = {}
): Promise<void> {
  try {
    await api(ctx, "DELETE", `${path}${forceQs(opts.force)}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && isHasDependentsBody(err.body)) {
      const body = err.body as HasDependentsBody;
      const deps = body.dependents ?? {};
      const lines: string[] = [
        `ragdoll: ${action} refused — would orphan dependents:`
      ];
      let total = 0;
      for (const [kind, count] of Object.entries(deps)) {
        lines.push(`  ${count} ${kind}`);
        total += count;
      }
      lines.push(
        `Pass --force to cascade-delete (nukes ${total} item${total === 1 ? "" : "s"}).`
      );
      if (body.message) lines.push(`Server: ${body.message}`);
      process.stderr.write(lines.join("\n") + "\n");
      process.exit(3);
    }
    fail(err, action);
  }
}
