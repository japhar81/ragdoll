/**
 * Cascade-delete helpers — UI side of the server's 409 `has_dependents`
 * envelope.
 *
 * Server-side contract (apps/api/src/app/cascade-utils.ts):
 *   DELETE /api/<resource>/:id          → 204 on a clean delete,
 *                                       OR 409 `{error: "has_dependents",
 *                                                dependents: {<kind>: <count>},
 *                                                hint: "?force=true to cascade"}`
 *   DELETE /api/<resource>/:id?force=true → 204 (nukes the row + every
 *                                            dependent the route knows about)
 *
 * The two helpers here keep the UI side dead-simple:
 *
 *   - `isHasDependentsError(err)` — narrows an ApiError to the 409 shape and
 *     returns `{dependents, hint}` (or `undefined` for non-cascade 409s, like
 *     a built-in role refusal).
 *
 *   - `tryCascadeDelete(deleteFn)` — fires the default DELETE; on a
 *     `has_dependents` response, resolves with `{ok: false, dependents}`
 *     instead of throwing. Lets the caller render the modal without
 *     try/catch boilerplate at every call site.
 */
import { ApiError } from "./api.ts";

/** Server-side envelope for the 409 refusal. */
export interface HasDependentsBody {
  error: "has_dependents";
  message: string;
  dependents: Record<string, number>;
  hint: string;
}

/** Narrow an ApiError to the cascade envelope. Returns `undefined` for
 *  any other 409 (e.g. built-in role refusal, slug conflict on POST). */
export function isHasDependentsError(err: unknown): HasDependentsBody | undefined {
  if (!(err instanceof ApiError) || err.status !== 409) return undefined;
  const body = err.body as Record<string, unknown> | undefined;
  if (!body || body.error !== "has_dependents") return undefined;
  const deps = body.dependents;
  if (!deps || typeof deps !== "object") return undefined;
  return {
    error: "has_dependents",
    message: typeof body.message === "string" ? body.message : "",
    dependents: deps as Record<string, number>,
    hint: typeof body.hint === "string" ? body.hint : ""
  };
}

export type CascadeDeleteOutcome =
  | { ok: true }
  | { ok: false; dependents: HasDependentsBody };

/**
 * Run a delete callback that may throw `has_dependents`. Translates the
 * 409 path into a resolved `{ok: false}` so the caller can render the
 * cascade-confirm modal without a try/catch. ANY other error
 * (401/403/404/422/500) propagates as a thrown ApiError — those need
 * the caller's normal error UI, not the cascade flow.
 */
export async function tryCascadeDelete(
  deleteFn: () => Promise<void>
): Promise<CascadeDeleteOutcome> {
  try {
    await deleteFn();
    return { ok: true };
  } catch (err) {
    const dep = isHasDependentsError(err);
    if (dep) return { ok: false, dependents: dep };
    throw err;
  }
}

/** Sum of every dependent count — useful for the "this will nuke N items"
 *  affordance on the force-confirm button. */
export function totalDependents(body: HasDependentsBody): number {
  let total = 0;
  for (const n of Object.values(body.dependents)) total += n;
  return total;
}
