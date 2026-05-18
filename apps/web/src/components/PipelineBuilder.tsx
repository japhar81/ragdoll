import React, { useCallback, useMemo, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node
} from "reactflow";
import "reactflow/dist/style.css";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.ts";
import { stringifyYaml } from "../lib/yaml.ts";
import {
  PLUGIN_CATEGORIES,
  applyResolved,
  extractConfigRefs,
  extractSecretRefs,
  graphToSpec,
  newIoNode,
  newNodeForCategory,
  specToGraph
} from "../lib/spec.ts";
import type { FlowEdge, FlowNode, PipelineNode, PipelineSpec, PluginCategory } from "../lib/types.ts";

const STARTER_SPEC: PipelineSpec = {
  apiVersion: "rag-platform/v1",
  kind: "Pipeline",
  metadata: { name: "support-rag" },
  spec: {
    nodes: [
      { id: "input", type: "input", ui: { position: { x: 40, y: 140 } } },
      {
        id: "retrieve",
        plugin: { category: "retriever", id: "qdrant_retriever", version: "1.0.0" },
        config: { top_k: "${config.retrieval.top_k}" },
        ui: { position: { x: 280, y: 140 } }
      },
      {
        id: "prompt",
        plugin: { category: "prompt_template", id: "basic_rag_prompt", version: "1.0.0" },
        ui: { position: { x: 520, y: 140 } }
      },
      {
        id: "llm",
        plugin: { category: "llm", id: "provider_chat", version: "1.0.0" },
        config: {
          provider: "${config.llm.provider}",
          model: "${config.llm.model}",
          temperature: "${config.llm.temperature}"
        },
        secrets: { apiKey: { scope: "tenant", key: "llm.api_key" } },
        ui: { position: { x: 760, y: 140 } }
      },
      { id: "output", type: "output", ui: { position: { x: 1000, y: 140 } } }
    ],
    edges: [
      { from: "input", to: "retrieve" },
      { from: "retrieve", to: "prompt" },
      { from: "prompt", to: "llm" },
      { from: "llm", to: "output" }
    ]
  }
};

const starter = specToGraph(STARTER_SPEC);

function download(name: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function PipelineBuilder() {
  const [nodes, setNodes, onNodesChange] = useNodesState(starter.nodes as Node[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState(starter.edges as Edge[]);
  const [pipelineName, setPipelineName] = useState("support-rag");
  const [pipelineId, setPipelineId] = useState("support-rag");
  const [version, setVersion] = useState("0.1.0");
  const [tenantId, setTenantId] = useState("tenant-a");
  const [environment, setEnvironment] = useState("prod");
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [testInput, setTestInput] = useState('{ "question": "How do I reset my password?" }');
  const [log, setLog] = useState<string>("Ready.");

  const spec: PipelineSpec = useMemo(
    () =>
      graphToSpec(nodes as unknown as FlowNode[], edges as unknown as FlowEdge[], {
        name: pipelineName
      }),
    [nodes, edges, pipelineName]
  );

  const resolved = useQuery({
    queryKey: ["resolved-config", pipelineId, tenantId, environment],
    queryFn: () =>
      api.resolvedConfig({
        pipeline_id: pipelineId,
        tenant_id: tenantId,
        environment
      }),
    retry: false
  });

  const flatResolved = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(resolved.data?.values ?? {})) {
      out[key] = entry.value;
    }
    return out;
  }, [resolved.data]);

  const resolvedSpec = useMemo(
    () => applyResolved(spec, flatResolved),
    [spec, flatResolved]
  );

  const selectedNode = useMemo(
    () =>
      (nodes as unknown as FlowNode[]).find((n) => n.id === selectedId)?.data.node,
    [nodes, selectedId]
  );

  function report(label: string, value: unknown): void {
    setLog(`${label}\n\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
  }

  function reportError(label: string, e: unknown): void {
    if (e instanceof ApiError) report(`${label} (HTTP ${e.status})`, e.body);
    else report(label, e instanceof Error ? e.message : String(e));
  }

  const onConnect = useCallback(
    (connection: Connection) => setEdges((current) => addEdge(connection, current)),
    [setEdges]
  );

  function addPaletteNode(category: PluginCategory | "input" | "output") {
    const base = category === "input" || category === "output" ? category : `${category}`;
    let id = base;
    let n = 1;
    const existing = new Set((nodes as Node[]).map((node) => node.id));
    while (existing.has(id)) id = `${base}_${n++}`;
    const node: PipelineNode =
      category === "input" || category === "output"
        ? newIoNode(category, id)
        : newNodeForCategory(category, id);
    const flow = specToGraph({
      ...STARTER_SPEC,
      spec: { nodes: [node], edges: [] }
    }).nodes[0];
    flow.position = { x: 120 + (nodes.length % 5) * 60, y: 320 + (nodes.length % 4) * 60 };
    setNodes((current) => [...current, flow as unknown as Node]);
    setSelectedId(id);
  }

  function updateSelectedNode(mutate: (node: PipelineNode) => PipelineNode) {
    if (!selectedId) return;
    setNodes((current) =>
      current.map((flow) => {
        if (flow.id !== selectedId) return flow;
        const fn = flow as unknown as FlowNode;
        const next = mutate(fn.data.node);
        return {
          ...flow,
          data: { ...fn.data, node: next }
        } as unknown as Node;
      })
    );
  }

  function setConfigText(text: string) {
    try {
      const parsed = JSON.parse(text || "{}");
      updateSelectedNode((node) => ({ ...node, config: parsed }));
    } catch {
      /* keep typing; ignore parse errors until valid */
    }
  }

  function setSecretsText(text: string) {
    try {
      const parsed = JSON.parse(text || "{}");
      updateSelectedNode((node) => ({ ...node, secrets: parsed }));
    } catch {
      /* ignore until valid */
    }
  }

  function deleteSelected() {
    if (!selectedId) return;
    setEdges((current) =>
      current.filter((e) => e.source !== selectedId && e.target !== selectedId)
    );
    setNodes((current) => current.filter((n) => n.id !== selectedId));
    setSelectedId(undefined);
  }

  async function validate() {
    try {
      report("Validation", await api.validateSpec(spec));
    } catch (e) {
      reportError("Validate failed", e);
    }
  }

  async function saveDraft() {
    try {
      report("Draft saved", await api.saveVersion(pipelineId, { version, spec }));
    } catch (e) {
      reportError("Save draft failed", e);
    }
  }

  async function publish() {
    try {
      report(
        "Published",
        await api.saveVersion(pipelineId, { version, spec, publish: true })
      );
    } catch (e) {
      reportError("Publish failed", e);
    }
  }

  async function deploy() {
    try {
      report(
        "Deployed",
        await api.deploy(pipelineId, { version, environment, tenantId })
      );
    } catch (e) {
      reportError("Deploy failed", e);
    }
  }

  function exportJson() {
    download(`${pipelineName}.json`, JSON.stringify(spec, null, 2), "application/json");
    report("Exported JSON", `${pipelineName}.json downloaded.`);
  }

  function exportYaml() {
    download(`${pipelineName}.yaml`, stringifyYaml(spec), "application/yaml");
    report("Exported YAML", `${pipelineName}.yaml downloaded.`);
  }

  function importSpecFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as PipelineSpec;
        const graph = specToGraph(parsed);
        setPipelineName(parsed.metadata?.name ?? pipelineName);
        setNodes(graph.nodes as unknown as Node[]);
        setEdges(graph.edges as unknown as Edge[]);
        report("Imported", `${graph.nodes.length} nodes, ${graph.edges.length} edges.`);
      } catch (e) {
        reportError("Import failed", e);
      }
    };
    input.click();
  }

  async function run() {
    let parsedInput: unknown;
    try {
      parsedInput = JSON.parse(testInput || "{}");
    } catch {
      report("Run failed", "Test input is not valid JSON.");
      return;
    }
    try {
      const result = await api.run(pipelineId, { input: parsedInput, environment });
      report(`Run accepted - execution ${result.executionId}`, result);
    } catch (e) {
      reportError("Run failed", e);
    }
  }

  const requiredConfig = extractConfigRefs(spec);
  const requiredSecrets = extractSecretRefs(spec);

  return (
    <section className="builder">
      <header className="toolbar">
        <strong>Visual Pipeline Builder</strong>
        <label>
          Pipeline
          <input
            value={pipelineId}
            onChange={(e) => setPipelineId(e.target.value)}
            style={{ width: 120 }}
          />
        </label>
        <label>
          Version
          <input
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            style={{ width: 80 }}
          />
        </label>
        <button onClick={validate}>Validate</button>
        <button onClick={saveDraft}>Save Draft</button>
        <button onClick={publish}>Publish</button>
        <button onClick={deploy}>Deploy</button>
        <button onClick={exportJson}>Export JSON</button>
        <button onClick={exportYaml}>Export YAML</button>
        <button onClick={importSpecFile}>Import</button>
        <button onClick={run}>Run</button>
        <label>
          Tenant
          <select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
            <option value="tenant-a">tenant-a</option>
            <option value="tenant-b">tenant-b</option>
            <option value="tenant-local">tenant-local</option>
          </select>
        </label>
        <label>
          Environment
          <select value={environment} onChange={(e) => setEnvironment(e.target.value)}>
            <option value="dev">dev</option>
            <option value="prod">prod</option>
          </select>
        </label>
      </header>
      <div className="builder-grid">
        <aside className="palette">
          <h2>Node Palette</h2>
          <button onClick={() => addPaletteNode("input")}>+ input</button>
          <button onClick={() => addPaletteNode("output")}>+ output</button>
          {PLUGIN_CATEGORIES.map((cat) => (
            <button key={cat} onClick={() => addPaletteNode(cat)}>
              + {cat}
            </button>
          ))}
        </aside>
        <div className="canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            onPaneClick={() => setSelectedId(undefined)}
            deleteKeyCode={["Backspace", "Delete"]}
            fitView
          >
            <MiniMap />
            <Controls />
            <Background />
          </ReactFlow>
        </div>
        <aside className="inspector">
          <h2>Inspector</h2>
          {!selectedNode && <p>Select a node to edit its plugin ref, config and secrets.</p>}
          {selectedNode && (
            <>
              <p>
                Node <strong>{selectedNode.id}</strong>{" "}
                {selectedNode.type ? `(${selectedNode.type})` : ""}
              </p>
              {selectedNode.plugin && (
                <p className="muted">
                  {selectedNode.plugin.category} / {selectedNode.plugin.id} @{" "}
                  {selectedNode.plugin.version}
                </p>
              )}
              {!selectedNode.type && (
                <>
                  <label>Plugin ref (JSON)</label>
                  <textarea
                    key={`plugin-${selectedNode.id}`}
                    defaultValue={JSON.stringify(selectedNode.plugin ?? {}, null, 2)}
                    onBlur={(e) => {
                      try {
                        const plugin = JSON.parse(e.target.value);
                        updateSelectedNode((node) => ({ ...node, plugin }));
                      } catch {
                        /* ignore */
                      }
                    }}
                  />
                  <label>Config (JSON) - supports {"${config.*}"}</label>
                  <textarea
                    key={`config-${selectedNode.id}`}
                    defaultValue={JSON.stringify(selectedNode.config ?? {}, null, 2)}
                    onChange={(e) => setConfigText(e.target.value)}
                  />
                  <label>Secrets (JSON) - SecretRef map</label>
                  <textarea
                    key={`secrets-${selectedNode.id}`}
                    defaultValue={JSON.stringify(selectedNode.secrets ?? {}, null, 2)}
                    onChange={(e) => setSecretsText(e.target.value)}
                  />
                </>
              )}
              <button onClick={deleteSelected}>Delete node</button>
            </>
          )}
          <h2>Required config</h2>
          <pre>{requiredConfig.join("\n") || "(none)"}</pre>
          <h2>Required secrets</h2>
          <pre>{requiredSecrets.join("\n") || "(none)"}</pre>
          <h2>Resolved Config</h2>
          {resolved.isError && (
            <p className="muted">
              Unable to resolve (
              {resolved.error instanceof ApiError
                ? `HTTP ${resolved.error.status}`
                : "API unavailable"}
              ).
            </p>
          )}
          <pre>{JSON.stringify(resolved.data?.values ?? {}, null, 2)}</pre>
          <h2>Resolved spec preview</h2>
          <pre>{JSON.stringify(resolvedSpec.spec.nodes, null, 2)}</pre>
          <h2>Test Input (JSON)</h2>
          <textarea value={testInput} onChange={(e) => setTestInput(e.target.value)} />
          <h2>Output</h2>
          <pre>{log}</pre>
        </aside>
      </div>
    </section>
  );
}
