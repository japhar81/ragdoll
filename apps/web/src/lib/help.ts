/**
 * Pure registry that drives every embedded-help surface:
 *
 *   - {@link routeToDoc} maps a URL pathname to the `docs/admin/*.md` slug
 *     the Help drawer should open by default.
 *   - {@link SHORTCUTS} is the source of truth for the keyboard-shortcuts
 *     overlay (rendered on bare `?`).
 *   - {@link ACTIONS} is the curated catalog of "things you can do"
 *     surfaced in the Cmd-K palette; each entry is permission-gated so we
 *     never offer an action the server will deny.
 *   - {@link filterPalette} is the fuzzy filter the palette uses.
 *
 * No React / DOM imports — every export is unit-testable with `node --test`,
 * matching lib/router.ts / lib/auth.ts.
 */

/** Slugs match the basename of files under `docs/admin/`. */
export type HelpDocSlug =
  | "access-control"
  | "triggers"
  | "cli"
  | "mcp"
  | "governance-and-security"
  | "in-app-help";

/** Best-fit doc for a given URL pathname; null when we have no specific match. */
export function routeToDoc(pathname: string): HelpDocSlug | null {
  const p = (pathname || "/").replace(/\/+$/, "") || "/";
  if (p.startsWith("/users") || p.startsWith("/roles") || p.startsWith("/identity-providers") || p.startsWith("/auth-settings")) {
    return "access-control";
  }
  if (p.startsWith("/scheduler")) return "triggers";
  if (p.startsWith("/builder") || p.startsWith("/pipelines")) return "triggers";
  if (p === "/" || p === "") return "in-app-help";
  return null;
}

/** A single keyboard shortcut. `keys` are joined with `+` in the overlay. */
export interface Shortcut {
  keys: string[];
  description: string;
  /** Where the shortcut applies — global, in the palette, etc. */
  scope: "global" | "palette" | "drawer";
}

export const SHORTCUTS: Shortcut[] = [
  { keys: ["⌘", "K"], description: "Open the command palette", scope: "global" },
  { keys: ["Ctrl", "K"], description: "Open the command palette (Windows / Linux)", scope: "global" },
  { keys: ["?"], description: "Show this keyboard shortcuts overlay", scope: "global" },
  { keys: ["g", "p"], description: "Go to Pipelines", scope: "global" },
  { keys: ["g", "s"], description: "Go to Scheduler", scope: "global" },
  { keys: ["g", "e"], description: "Go to Executions", scope: "global" },
  { keys: ["g", "u"], description: "Go to Users", scope: "global" },
  { keys: ["Esc"], description: "Close any open overlay", scope: "drawer" },
  { keys: ["↑", "↓"], description: "Move highlight up / down", scope: "palette" },
  { keys: ["Enter"], description: "Run highlighted item", scope: "palette" }
];

/** A `g <letter>` chord. Returned by `parseGoShortcut` when the buffer matches. */
export type GoTarget = "pipelines" | "scheduler" | "executions" | "users";

/** Map a two-key chord (e.g. "g","e") to a route target. */
export function parseGoShortcut(buffer: string): GoTarget | undefined {
  switch (buffer) {
    case "gp":
      return "pipelines";
    case "gs":
      return "scheduler";
    case "ge":
      return "executions";
    case "gu":
      return "users";
    default:
      return undefined;
  }
}

/** A Cmd-K item. `perms` makes it permission-gated; empty = always visible. */
export interface PaletteAction {
  id: string;
  /** Group heading the item lives under in the palette UI. */
  group: "Navigate" | "Create" | "Run" | "Inspect" | "Help";
  /** Short label shown in the row. */
  label: string;
  /** Subtle right-aligned hint (e.g. URL or "press Enter"). */
  hint?: string;
  /** Search keywords ANDed against the user's typed query. */
  keywords?: string[];
  /** Permission gate — surfaced only when the user has *any* of these. */
  perms?: string[];
  /** What the row does. */
  kind:
    | { type: "navigate"; to: string }
    | { type: "openDoc"; doc: HelpDocSlug }
    | { type: "openShortcuts" };
}

/** Static catalog. Per-tenant / per-execution items are added at the call site. */
export const ACTIONS: PaletteAction[] = [
  // ---- navigate ---------------------------------------------------------
  { id: "nav.pipelines", group: "Navigate", label: "Pipelines", hint: "/pipelines", kind: { type: "navigate", to: "/pipelines" }, perms: ["execution:view_logs", "pipeline:create", "pipeline:update"] },
  { id: "nav.builder", group: "Navigate", label: "Pipeline Builder", hint: "/builder", kind: { type: "navigate", to: "/builder" }, perms: ["pipeline:create", "pipeline:update"] },
  { id: "nav.scheduler", group: "Navigate", label: "Scheduler", hint: "/scheduler", kind: { type: "navigate", to: "/scheduler" }, perms: ["pipeline:run", "config:edit_tenant"] },
  { id: "nav.executions", group: "Navigate", label: "Executions", hint: "/executions", kind: { type: "navigate", to: "/executions" }, perms: ["execution:view_logs"] },
  { id: "nav.usage", group: "Navigate", label: "Usage", hint: "/usage", kind: { type: "navigate", to: "/usage" }, perms: ["execution:view_logs"] },
  { id: "nav.audit", group: "Navigate", label: "Audit log", hint: "/audit", kind: { type: "navigate", to: "/audit" }, perms: ["audit:view"] },
  { id: "nav.tenants", group: "Navigate", label: "Tenants", hint: "/tenants", kind: { type: "navigate", to: "/tenants" }, perms: ["config:edit_global"] },
  { id: "nav.config", group: "Navigate", label: "Config values", hint: "/config", kind: { type: "navigate", to: "/config" }, perms: ["config:edit_global", "config:edit_tenant", "config:edit_pipeline"] },
  { id: "nav.secrets", group: "Navigate", label: "Secrets", hint: "/secrets", kind: { type: "navigate", to: "/secrets" }, perms: ["secret:manage_tenant"] },
  { id: "nav.users", group: "Navigate", label: "Users", hint: "/users", kind: { type: "navigate", to: "/users" }, perms: ["user:manage"] },
  { id: "nav.roles", group: "Navigate", label: "Roles & Permissions", hint: "/roles", kind: { type: "navigate", to: "/roles" }, perms: ["role:manage"] },
  { id: "nav.idps", group: "Navigate", label: "Identity Providers", hint: "/identity-providers", kind: { type: "navigate", to: "/identity-providers" }, perms: ["idp:manage"] },
  { id: "nav.auth-settings", group: "Navigate", label: "Auth Settings", hint: "/auth-settings", kind: { type: "navigate", to: "/auth-settings" }, perms: ["auth:settings"] },
  // ---- common create / run -----------------------------------------------
  { id: "create.pipeline", group: "Create", label: "Create a pipeline", keywords: ["new"], kind: { type: "navigate", to: "/pipelines" }, perms: ["pipeline:create"] },
  { id: "create.tenant", group: "Create", label: "Create a tenant", keywords: ["new"], kind: { type: "navigate", to: "/tenants" }, perms: ["config:edit_global"] },
  { id: "create.user", group: "Create", label: "Create a user", keywords: ["new", "invite"], kind: { type: "navigate", to: "/users" }, perms: ["user:manage"] },
  { id: "create.schedule", group: "Create", label: "Create a schedule", keywords: ["cron", "new"], kind: { type: "navigate", to: "/scheduler" }, perms: ["pipeline:run", "config:edit_tenant"] },
  // ---- help --------------------------------------------------------------
  { id: "help.access-control", group: "Help", label: "Docs · Access control & RBAC", kind: { type: "openDoc", doc: "access-control" } },
  { id: "help.triggers", group: "Help", label: "Docs · Triggering pipelines (UI / API / cron / webhooks)", kind: { type: "openDoc", doc: "triggers" } },
  { id: "help.cli", group: "Help", label: "Docs · CLI (ragdoll)", kind: { type: "openDoc", doc: "cli" } },
  { id: "help.mcp", group: "Help", label: "Docs · MCP endpoint", kind: { type: "openDoc", doc: "mcp" } },
  { id: "help.governance", group: "Help", label: "Docs · Governance & security", kind: { type: "openDoc", doc: "governance-and-security" } },
  { id: "help.shortcuts", group: "Help", label: "Keyboard shortcuts", hint: "?", kind: { type: "openShortcuts" } }
];

/**
 * Permission-gate + fuzzy-filter the palette catalog.
 *
 * Matching is intentionally simple: lowercase the query, split on
 * whitespace, and require every token to substring-match either the label,
 * hint, group, or any keyword. This matches what users expect from Cmd-K
 * palettes (Linear, Vercel) without pulling a fuzzy library.
 *
 * `can(...perms)` is the AuthContext predicate — passing the empty list
 * always returns true so unauthenticated callers see help-only items.
 */
export function filterPalette(
  actions: PaletteAction[],
  query: string,
  can: (...perms: string[]) => boolean = () => true
): PaletteAction[] {
  const visible = actions.filter(
    (a) => !a.perms || a.perms.length === 0 || can(...a.perms)
  );
  const q = query.trim().toLowerCase();
  if (!q) return visible;
  const tokens = q.split(/\s+/);
  return visible.filter((a) => {
    const haystack = [
      a.label,
      a.hint ?? "",
      a.group,
      ...(a.keywords ?? [])
    ]
      .join(" ")
      .toLowerCase();
    return tokens.every((t) => haystack.includes(t));
  });
}
