/**
 * Shared helpers for cascade-aware DELETE routes.
 *
 * The platform's default DELETE posture is "refuse if dependents would
 * be orphaned, return 409 with the dependent counts." Operators opt
 * into a true nuke via `?force=true` (or `?force=1`), at which point
 * the route walks its known dependents, cleans them up explicitly,
 * and deletes the parent.
 *
 * The 409 shape is uniform so admin tooling can render it without
 * per-resource code:
 *
 *   {
 *     "error": "has_dependents",
 *     "message": "...",
 *     "dependents": { "<kind>": <count>, ... },
 *     "hint": "?force=true to cascade"
 *   }
 */
import { error } from "./http-utils.ts";
import type { AppResponse, AppRequest } from "./types.ts";

/** Parse `?force=true|1` from a request query. Anything else (omitted,
 *  empty, "false", "no") is `false`. Strict so a typo doesn't silently
 *  enable cascade. */
export function parseForce(request: AppRequest): boolean {
  const raw = request.query.force;
  if (typeof raw !== "string") return false;
  const v = raw.toLowerCase();
  return v === "true" || v === "1";
}

/** Build a 409 `has_dependents` response with the canonical envelope.
 *  Drops zero-count entries so the response only lists what's actually
 *  blocking. Returns the AppResponse-compatible value the handler
 *  should return directly. */
export function hasDependents(
  resourceLabel: string,
  dependents: Record<string, number>
): AppResponse {
  const nonZero: Record<string, number> = {};
  let total = 0;
  for (const [k, v] of Object.entries(dependents)) {
    if (v > 0) {
      nonZero[k] = v;
      total += v;
    }
  }
  return error(409, "has_dependents", {
    message:
      total === 0
        ? `Cannot delete ${resourceLabel} — refused by the server.`
        : `Cannot delete ${resourceLabel} — ${total} dependent resource${total === 1 ? "" : "s"} would be orphaned. Pass ?force=true to cascade.`,
    dependents: nonZero,
    hint: "?force=true to cascade"
  });
}
