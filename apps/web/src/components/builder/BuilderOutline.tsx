/**
 * Outline view — Mermaid `graph TD` text dump of the current DAG.
 *
 * Pure presentation: a copy-to-clipboard button and a preformatted block
 * the user can paste into Markdown, GitHub Issues / READMEs, ADRs, or
 * any Mermaid renderer to get a rendered flowchart. Edges that carry
 * port labels surface the port pair (`source -- "fromPort → toPort" -->
 * target`); plain edges render as bare arrows.
 *
 * No interactive editing here — the other three views own that. This
 * one is for explaining a pipeline elsewhere.
 */
import { useCallback, useMemo, useState } from "react";
import type { Node, Edge } from "reactflow";
import { nodeLabel } from "../../lib/builderViews.ts";

export interface BuilderOutlineProps {
  nodes: Node[];
  edges: Edge[];
  pipelineName: string;
}

/** Mermaid node ids can't contain `-` / `:` / spaces, so coerce. The
 *  display label keeps the human form. */
function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, "_");
}

function escapeLabel(text: string): string {
  // Mermaid labels are wrapped in double quotes when they contain
  // special chars; escape the few that break the parser.
  return text.replace(/"/g, '\\"');
}

function buildMermaid(
  nodes: Node[],
  edges: Edge[],
  pipelineName: string
): string {
  const lines: string[] = [];
  lines.push(`%% ${pipelineName || "pipeline"}`);
  lines.push("graph TD");
  for (const n of nodes) {
    const label = nodeLabel(n);
    const idSafe = safeId(n.id);
    const human = label && label !== n.id ? `${n.id}\\n(${label})` : n.id;
    lines.push(`  ${idSafe}["${escapeLabel(human)}"]`);
  }
  for (const e of edges) {
    const src = safeId(e.source);
    const dst = safeId(e.target);
    const from = e.sourceHandle ?? null;
    const to = e.targetHandle ?? null;
    if (from || to) {
      const fp = from ?? "default";
      const tp = to ?? "default";
      lines.push(`  ${src} -- "${escapeLabel(`${fp} → ${tp}`)}" --> ${dst}`);
    } else {
      lines.push(`  ${src} --> ${dst}`);
    }
  }
  return lines.join("\n");
}

export function BuilderOutline(props: BuilderOutlineProps) {
  const { nodes, edges, pipelineName } = props;
  const mermaid = useMemo(
    () => buildMermaid(nodes, edges, pipelineName),
    [nodes, edges, pipelineName]
  );
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard?.writeText(mermaid).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      },
      () => setCopied(false)
    );
  }, [mermaid]);

  return (
    <div className="builder-outline">
      <header className="builder-tree-head">
        <span className="muted">
          {nodes.length} node{nodes.length === 1 ? "" : "s"} · Mermaid graph
          TD
        </span>
        <span className="muted builder-tree-hint">
          paste into Markdown that supports Mermaid (GitHub, GitLab, many
          wikis) and the diagram renders inline
        </span>
      </header>
      <div className="builder-outline-actions">
        <button type="button" className="primary" onClick={handleCopy}>
          {copied ? "Copied" : "Copy"}
        </button>
        <span className="muted">
          {nodes.length === 0
            ? "(empty — add nodes from another view first)"
            : `${edges.length} edge${edges.length === 1 ? "" : "s"}`}
        </span>
      </div>
      <pre className="builder-outline-code">{mermaid}</pre>
    </div>
  );
}
