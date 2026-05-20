/**
 * Eagerly bundles `docs/plugins/<plugin_id>.md` into the web app so the
 * Builder's per-node Docs tab can render the narrative description (what the
 * node does, inputs/outputs, gotchas, typical pipeline position) without a
 * network round-trip. Schema-derived sections (required configs/secrets,
 * sample JSON) are rendered separately from the live manifest — the markdown
 * here is narrative-only.
 *
 * The slug is the plugin's `id` field (e.g. `qdrant_retriever`,
 * `basic_text_chunker`). A missing doc is a non-error; the Docs tab falls
 * back to the manifest's `description`.
 */

const RAW_DOCS = import.meta.glob("../../../../docs/plugins/*.md", {
  query: "?raw",
  import: "default",
  eager: true
}) as Record<string, string>;

function slugFromPath(path: string): string | undefined {
  const m = /\/([^/]+)\.md$/.exec(path);
  return m?.[1];
}

const BY_SLUG: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [path, body] of Object.entries(RAW_DOCS)) {
    const slug = slugFromPath(path);
    if (slug && slug !== "README") out[slug] = body;
  }
  return out;
})();

/** Returns the bundled markdown body for a plugin id, or `null` if none. */
export function getPluginDoc(pluginId: string): string | null {
  return BY_SLUG[pluginId] ?? null;
}

/** Slugs that have a bundled doc — useful for completeness checks in tests. */
export function listDocumentedPlugins(): string[] {
  return Object.keys(BY_SLUG).sort();
}
