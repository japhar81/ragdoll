/**
 * The Builder inspector's Docs tab. Renders, for the currently-selected
 * plugin-backed node:
 *
 *   1. Header: name, version, category, capabilities, mode.
 *   2. Manifest `description` (plain text from the plugin manifest).
 *   3. Narrative markdown from `docs/plugins/<plugin_id>.md` if bundled —
 *      describes inputs, outputs, gotchas, typical position. Falls back to
 *      a short hint when not bundled.
 *   4. Required configs and secrets, derived live from the manifest schemas.
 *   5. A sample JSON config built from each field's default value.
 *
 * Everything except the narrative comes straight from the manifest, so adding
 * a config option to a plugin auto-updates this tab — no markdown to keep in
 * sync. The narrative file is purely the human story.
 */
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import type { PluginInfo } from "../../lib/api.ts";
import {
  buildSampleConfig,
  requiredFields,
  summarizeSchema,
  type FieldSummary
} from "../../lib/nodeDocs.ts";
import { getPluginDoc } from "../../help/pluginDocs.ts";

export function NodeDocsTab(props: {
  plugin?: PluginInfo;
  /** Set when the plugin metadata request is still in flight. */
  loading?: boolean;
  /** Set when the plugin metadata request failed. */
  error?: boolean;
}) {
  const { plugin, loading, error } = props;
  if (loading) {
    return <p className="muted">Loading plugin docs…</p>;
  }
  if (error || !plugin) {
    return (
      <p className="muted">
        No plugin metadata available — docs will appear once a registered
        plugin is selected.
      </p>
    );
  }

  const configFields = summarizeSchema(plugin.configSchema);
  const secretFields = summarizeSchema(plugin.secretsSchema);
  const sample = buildSampleConfig(plugin.configSchema);
  const narrative = getPluginDoc(plugin.id);
  const requiredCfg = requiredFields(plugin.configSchema);
  const requiredSec = requiredFields(plugin.secretsSchema);

  return (
    <div className="node-docs">
      <header className="node-docs-head">
        <h3 className="node-docs-title">
          {plugin.name}{" "}
          <span className="muted">
            {plugin.category} · v{plugin.version}
          </span>
        </h3>
        {plugin.capabilities && plugin.capabilities.length > 0 && (
          <p className="node-docs-caps">
            {plugin.capabilities.map((cap) => (
              <span key={cap} className="node-docs-chip">
                {cap}
              </span>
            ))}
          </p>
        )}
      </header>

      {plugin.description && (
        <p className="node-docs-desc">{plugin.description}</p>
      )}

      <section className="node-docs-section">
        <h4>About this node</h4>
        {narrative ? (
          <div className="node-docs-md">
            <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
              {narrative}
            </ReactMarkdown>
          </div>
        ) : (
          <p className="muted">
            No narrative docs bundled for <code>{plugin.id}</code>. Add one
            at <code>docs/plugins/{plugin.id}.md</code>.
          </p>
        )}
      </section>

      <section className="node-docs-section">
        <h4>
          Required config{" "}
          <span className="muted">
            ({requiredCfg.length || "none"})
          </span>
        </h4>
        {requiredCfg.length === 0 ? (
          <p className="muted">No required config fields.</p>
        ) : (
          <ul className="node-docs-required">
            {requiredCfg.map((key) => (
              <li key={key}>
                <code>{key}</code>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="node-docs-section">
        <h4>
          Required secrets{" "}
          <span className="muted">
            ({requiredSec.length || "none"})
          </span>
        </h4>
        {requiredSec.length === 0 ? (
          <p className="muted">No required secrets.</p>
        ) : (
          <ul className="node-docs-required">
            {requiredSec.map((key) => (
              <li key={key}>
                <code>{key}</code>
              </li>
            ))}
          </ul>
        )}
      </section>

      {configFields.length > 0 && (
        <section className="node-docs-section">
          <h4>Config fields</h4>
          <FieldTable fields={configFields} />
        </section>
      )}

      {secretFields.length > 0 && (
        <section className="node-docs-section">
          <h4>Secret fields</h4>
          <FieldTable fields={secretFields} />
        </section>
      )}

      <section className="node-docs-section">
        <h4>Sample config (JSON)</h4>
        {Object.keys(sample).length === 0 ? (
          <p className="muted">
            No defaultable fields — start from <code>{"{}"}</code>.
          </p>
        ) : (
          <pre className="node-docs-sample">
            {JSON.stringify(sample, null, 2)}
          </pre>
        )}
      </section>
    </div>
  );
}

function FieldTable(props: { fields: FieldSummary[] }) {
  return (
    <table className="node-docs-table">
      <thead>
        <tr>
          <th>Field</th>
          <th>Type</th>
          <th>Default</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>
        {props.fields.map((f) => (
          <tr key={f.key}>
            <td>
              <code>{f.key}</code>
              {f.required && <span className="node-docs-required-tag">required</span>}
            </td>
            <td className="muted">
              {f.format ? `${f.type} · ${f.format}` : f.type}
            </td>
            <td className="muted">
              {f.default === undefined ? "—" : formatDefault(f.default)}
            </td>
            <td>
              {f.description}
              {f.enum && (
                <div className="muted">
                  one of {f.enum.map((v) => JSON.stringify(v)).join(", ")}
                </div>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatDefault(value: unknown): string {
  if (typeof value === "string") return value === "" ? '""' : value;
  return JSON.stringify(value);
}
