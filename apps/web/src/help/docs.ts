/**
 * Eagerly bundles `docs/admin/*.md` into the web app so the Help drawer can
 * render them without a network round-trip. Vite supports `?raw` queries that
 * inline the file contents as strings, gated to the markdown we know about.
 *
 * Slugs are the basename without the `.md` extension (e.g. `access-control`,
 * `triggers`, `cli`, `mcp`, `governance-and-security`, `in-app-help`).
 */
import type { HelpDocSlug } from "../lib/help.ts";

const RAW_DOCS = import.meta.glob("../../../../docs/admin/*.md", {
  query: "?raw",
  import: "default",
  eager: true
}) as Record<string, string>;

const FRIENDLY_TITLES: Partial<Record<HelpDocSlug, string>> = {
  "access-control": "Access control · login, SSO, RBAC",
  triggers: "Triggering pipelines (UI / API / cron / webhooks)",
  cli: "ragdoll CLI",
  mcp: "MCP endpoint (/mcp)",
  "governance-and-security": "Governance & security",
  "in-app-help": "Embedded help"
};

export interface HelpDoc {
  slug: HelpDocSlug;
  title: string;
  body: string;
}

function slugFromPath(path: string): HelpDocSlug | undefined {
  const m = /\/([^/]+)\.md$/.exec(path);
  if (!m) return undefined;
  const known: HelpDocSlug[] = [
    "access-control",
    "triggers",
    "cli",
    "mcp",
    "governance-and-security",
    "in-app-help"
  ];
  return known.includes(m[1] as HelpDocSlug) ? (m[1] as HelpDocSlug) : undefined;
}

function firstHeading(md: string): string | undefined {
  const m = /^#\s+(.+?)\s*$/m.exec(md);
  return m?.[1];
}

const BY_SLUG: Partial<Record<HelpDocSlug, HelpDoc>> = (() => {
  const out: Partial<Record<HelpDocSlug, HelpDoc>> = {};
  for (const [path, body] of Object.entries(RAW_DOCS)) {
    const slug = slugFromPath(path);
    if (!slug) continue;
    out[slug] = {
      slug,
      title: FRIENDLY_TITLES[slug] ?? firstHeading(body) ?? slug,
      body
    };
  }
  return out;
})();

export function getHelpDoc(slug: HelpDocSlug): HelpDoc | undefined {
  return BY_SLUG[slug];
}

export function listHelpDocs(): HelpDoc[] {
  return Object.values(BY_SLUG).filter((d): d is HelpDoc => Boolean(d));
}
