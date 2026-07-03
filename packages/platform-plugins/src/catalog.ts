/**
 * The event catalog — the documented surface a platform-plugin author binds
 * to, and the metadata the dispatcher uses to know which phases fire and what
 * a `pre` hook may do at each.
 *
 * Two shapes of entry:
 *   - EXECUTION + USAGE events are enumerated explicitly with per-event
 *     capabilities (only `execution.start`/`execution.finish` accept a `pre`
 *     mutation, and only `execution.finish` may force-fail).
 *   - MUTATION events (the 72 audited actions) are uniform — every one accepts
 *     a `pre` veto/mutate of before/after and a `post` observation — so they
 *     share a single generated entry. {@link KNOWN_MUTATION_EVENTS} lists the
 *     current names for documentation + soft validation, but emission of an
 *     unlisted `<domain>.<verb>` mutation is allowed (forward-compatible: a new
 *     audited action is trappable the day it's added, no catalog edit needed).
 */

import type { EventCategory, EventPhase } from "./events.ts";

/** What a `pre` hook is permitted to do at an event. */
export type PreCapability = "veto" | "mutate" | "fail";

export interface EventCatalogEntry {
  event: string;
  category: EventCategory;
  /** Which phases actually fire for this event. */
  phases: EventPhase[];
  /** What a `pre` hook may do (empty / absent → observe-only pre, if any). */
  preCapabilities: PreCapability[];
  /** Which envelope fields a `pre` `mutate` may set. */
  mutablePatch: string[];
  description: string;
}

/** The pipeline-run lifecycle bracket (fired from DagExecutor + the API accept
 *  path, covering both async and sync runs). */
export const EXECUTION_EVENTS: EventCatalogEntry[] = [
  {
    event: "execution.accept",
    category: "execution",
    phases: ["pre"],
    preCapabilities: ["veto", "mutate"],
    mutablePatch: ["input", "environment"],
    description:
      "API accept gate — fires synchronously before a run is enqueued; a veto becomes a 4xx (the run is never accepted)."
  },
  {
    event: "execution.start",
    category: "execution",
    phases: ["pre", "post"],
    preCapabilities: ["veto", "mutate"],
    mutablePatch: ["input", "config", "context"],
    description:
      "Fires before the first node runs (worker + sync paths, in DagExecutor). pre may rewrite input/config/context, or veto → the execution terminates as `denied` (async) / 4xx (sync)."
  },
  {
    event: "execution.finish",
    category: "execution",
    phases: ["pre", "post"],
    preCapabilities: ["mutate", "fail"],
    mutablePatch: ["output"],
    description:
      "Fires after the last node, before the terminal status/result is committed. pre may rewrite the output or force-fail an otherwise-successful run."
  },
  {
    event: "execution.success",
    category: "execution",
    phases: ["post"],
    preCapabilities: [],
    mutablePatch: [],
    description: "A run reached terminal status `succeeded`."
  },
  {
    event: "execution.failure",
    category: "execution",
    phases: ["post"],
    preCapabilities: [],
    mutablePatch: [],
    description: "A run reached terminal status `failed`."
  },
  {
    event: "execution.denied",
    category: "execution",
    phases: ["post"],
    preCapabilities: [],
    mutablePatch: [],
    description: "A run was denied (permission lost, or a start/accept hook vetoed)."
  },
  {
    event: "execution.cancelled",
    category: "execution",
    phases: ["post"],
    preCapabilities: [],
    mutablePatch: [],
    description: "A run was cancelled (aborted before completion)."
  }
];

export const USAGE_EVENTS: EventCatalogEntry[] = [
  {
    event: "usage.recorded",
    category: "usage",
    phases: ["post"],
    preCapabilities: [],
    mutablePatch: [],
    description:
      "A metered LLM/embedding/ingestion cost was recorded (per node or per ingestion job)."
  }
];

/**
 * The currently-emitted audited mutation actions, grouped by domain — the
 * `pre`/`post` interceptable + observable resource changes. This is a
 * documentation + soft-validation list, NOT a hard gate: any `<domain>.<verb>`
 * a future `audit()` call emits is trappable immediately.
 */
export const KNOWN_MUTATION_EVENTS: Record<string, string[]> = {
  pipeline: [
    "pipeline.create",
    "pipeline.update",
    "pipeline.delete",
    "pipeline.set_folder",
    "pipeline.run",
    "pipeline.ingest",
    "pipeline.invoke",
    "pipeline.deploy",
    "pipeline.deployment_delete",
    "pipeline_version.publish",
    "pipeline_version.save_draft",
    "pipeline_version.save",
    "pipeline_version.rollback",
    "pipeline_version.archive",
    "pipeline_folder.create",
    "pipeline_folder.update",
    "pipeline_folder.delete"
  ],
  tenant: [
    "tenant.create",
    "tenant.update",
    "tenant.delete",
    "tenant_git.upsert",
    "tenant_git.delete",
    "tenant_git.sync_requested",
    "environment.create",
    "environment.update",
    "environment.delete",
    "tenant_pipeline.associate",
    "tenant_pipeline.update",
    "pipeline_activation.create",
    "pipeline_activation.update",
    "pipeline_activation.delete"
  ],
  schedule: [
    "schedule.create",
    "schedule.update",
    "schedule.toggle",
    "schedule.delete"
  ],
  secret: ["secret.create", "secret.rotate", "secret.delete"],
  access: [
    "user.create",
    "user.update",
    "user.delete",
    "user.grant",
    "user.revoke",
    "user.password_change",
    "role.create",
    "role.set_permissions",
    "role.delete",
    "idp.create",
    "idp.update",
    "idp.delete",
    "apikey.create",
    "apikey.revoke",
    "auth.settings.update"
  ],
  dataset: [
    "dataset.create",
    "dataset.update",
    "dataset.delete",
    "dataset_version.create",
    "dataset_version.delete",
    "pipeline_dataset_binding.create",
    "pipeline_dataset_binding.update",
    "pipeline_dataset_binding.delete"
  ],
  connection: [
    "connection.create",
    "connection.update",
    "connection.archive",
    "connection.delete"
  ],
  webhook: ["webhook_trigger.create", "webhook_trigger.delete"],
  config: [
    "config_definition.upsert",
    "config_definition.delete",
    "config_value.upsert",
    "config_value.delete"
  ],
  observability: ["retention.update"]
};

/** Flat set of all known mutation action names. */
export const KNOWN_MUTATION_EVENT_NAMES: ReadonlySet<string> = new Set(
  Object.values(KNOWN_MUTATION_EVENTS).flat()
);

/** The uniform capabilities every mutation event exposes. */
export function mutationCatalogEntry(event: string): EventCatalogEntry {
  return {
    event,
    category: "mutation",
    phases: ["pre", "post"],
    preCapabilities: ["veto", "mutate"],
    mutablePatch: ["before", "after"],
    description: KNOWN_MUTATION_EVENT_NAMES.has(event)
      ? `Audited mutation \`${event}\`.`
      : `Mutation \`${event}\` (not in the known catalog — trapped forward-compatibly).`
  };
}

const EXPLICIT: ReadonlyMap<string, EventCatalogEntry> = new Map(
  [...EXECUTION_EVENTS, ...USAGE_EVENTS].map((e) => [e.event, e])
);

/**
 * Resolve the catalog entry for an event name. Execution/usage events are
 * looked up explicitly; anything else is treated as a mutation (the uniform
 * entry), so a new audited action needs no catalog change.
 */
export function catalogEntry(event: string): EventCatalogEntry {
  return EXPLICIT.get(event) ?? mutationCatalogEntry(event);
}

/** Every explicitly-catalogued event (execution + usage). Mutation events are
 *  open-ended and listed via {@link KNOWN_MUTATION_EVENTS}. */
export function explicitCatalog(): EventCatalogEntry[] {
  return [...EXECUTION_EVENTS, ...USAGE_EVENTS];
}

/**
 * Match an event name against a subscription pattern. Supports:
 *   - `"*"`               → everything
 *   - `"secret.*"`        → any event whose name starts with `secret.`
 *   - `"execution.start"` → exact
 * (A trailing `.*` matches the dotted prefix; a bare `*` matches all.)
 */
export function eventMatches(pattern: string, event: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    return event.startsWith(pattern.slice(0, -1)); // keep the dot: "secret."
  }
  return pattern === event;
}
