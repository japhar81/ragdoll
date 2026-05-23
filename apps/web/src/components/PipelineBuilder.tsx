import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBuilderRoom } from "../events/EventsProvider.tsx";
import { BuilderRoster } from "../events/BuilderRoster.tsx";
import type {
  BuilderEdit,
  BuilderPresence
} from "../../../../packages/events/src/index.ts";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  MarkerType,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type ReactFlowInstance
} from "reactflow";
import "reactflow/dist/style.css";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, type PluginInfo } from "../lib/api.ts";
import { stringifyYaml } from "../lib/yaml.ts";
import {
  applyResolved,
  decodeViewport,
  extractConfigRefs,
  extractSecretRefs,
  graphToSpec,
  newIoNode,
  specToGraph,
  withViewportAnnotation
} from "../lib/spec.ts";
import {
  DND_MIME,
  clampInspectorWidth,
  clampPaletteWidth,
  nodeKind,
  validateConnection
} from "../lib/graph.ts";
import {
  decodePaletteDrag,
  newNodeFromPlugin,
  type PaletteDragItem
} from "../lib/palette.ts";
import { PalettePanel } from "./PalettePanel.tsx";
import {
  FlowNodeCard,
  PluginManifestContext,
  NodeValidationContext,
  type NodeValidationBuckets
} from "./FlowNodeCard.tsx";
import { PluginEditorSlot } from "./PluginEditorSlot.tsx";
import { SecretsEditor } from "./SecretsEditor.tsx";
import { NodeDocsTab } from "./builder/NodeDocsTab.tsx";
import { BuilderConsole, useConsoleLog } from "./BuilderConsole.tsx";
import { TenantSelect, useSelectedTenant } from "./useTenants.tsx";
import { useEnvironments, EnvironmentSelect } from "./useEnvironments.tsx";
import { ToolbarMenu } from "./ToolbarMenu.tsx";
import { applyLayout, type LayoutKind } from "../lib/layouts.ts";
import {
  validatePipelineSpec,
  type ValidationIssue
} from "../../../../packages/pipeline-spec/src/index.ts";
import { hasRealPipeline } from "../lib/consoleLog.ts";
import {
  diffNodeEvents,
  isTerminalStatus,
  sampleForDisplay,
  summarizeExecution,
  type NodeLike
} from "../lib/execTrace.ts";
import type {
  FlowEdge,
  FlowNode,
  PipelineNode,
  PipelineSpec,
  SecretRef
} from "../lib/types.ts";
import type { EditingPipeline } from "../App.tsx";

const nodeTypes = { ragNode: FlowNodeCard };

/**
 * Run poller: the worker runs the pipeline async and writes the per-node
 * trace to Postgres; the API serves it. We poll the trace every
 * RUN_POLL_INTERVAL_MS, emitting only the *new* node transitions each tick,
 * and stop on a terminal status or after RUN_POLL_MAX_MS (so a stuck/lost
 * worker can't poll forever). Polling (not WS) is deliberate: the trace lives
 * in a shared store, so cross-process polling is reliable with zero
 * worker->API pub/sub. SSE/WS is a clean future upgrade.
 */
const RUN_POLL_INTERVAL_MS = 1000;
const RUN_POLL_MAX_MS = 3 * 60 * 1000;

// `default` is React Flow's bezier curve — softer than the smoothstep
// right-angled lines we used previously. Curves read more naturally for
// data flow where edges fan in/out at varied angles.
const EDGE_DEFAULTS = {
  type: "default",
  markerEnd: { type: MarkerType.ArrowClosed }
} as const;

const STARTER_SPEC: PipelineSpec = {
  apiVersion: "rag-platform/v1",
  kind: "Pipeline",
  metadata: { name: "support-rag" },
  spec: {
    nodes: [
      { id: "input", type: "input", ui: { position: { x: 40, y: 160 } } },
      {
        id: "retrieve",
        plugin: { category: "retriever", id: "qdrant_retriever", version: "1.0.0" },
        config: { top_k: "${config.retrieval.top_k}" },
        ui: { position: { x: 300, y: 160 } }
      },
      {
        id: "prompt",
        plugin: { category: "prompt_template", id: "basic_rag_prompt", version: "1.0.0" },
        ui: { position: { x: 560, y: 160 } }
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
        ui: { position: { x: 820, y: 160 } }
      },
      { id: "output", type: "output", ui: { position: { x: 1080, y: 160 } } }
    ],
    edges: [
      { from: "input", to: "retrieve" },
      { from: "retrieve", to: "prompt" },
      { from: "prompt", to: "llm" },
      { from: "llm", to: "output" }
    ]
  }
};

/** React Flow nodes use our colored custom renderer; tag every node. */
function toFlowNodes(spec: PipelineSpec): Node[] {
  return specToGraph(spec).nodes.map(
    (n) => ({ ...n, type: "ragNode" }) as unknown as Node
  );
}

function toFlowEdges(spec: PipelineSpec): Edge[] {
  return specToGraph(spec).edges.map(
    (e) => ({ ...e, ...EDGE_DEFAULTS }) as unknown as Edge
  );
}

/**
 * Layout dropdown anchored to the canvas upper-left. Lives inside React
 * Flow so it pans/zooms-with-canvas isn't desired — we use position:
 * absolute on the wrapper instead. The OSS edition of React Flow doesn't
 * ship layout algorithms; the three options below all run from our own
 * `lib/layouts.ts`.
 */
function LayoutMenu({ onApply }: { onApply: (kind: LayoutKind) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rf-layout-menu">
      <button
        type="button"
        className="rf-layout-button"
        onClick={() => setOpen((o) => !o)}
        title="Auto-layout"
      >
        ⫶ Layout
      </button>
      {open && (
        <div className="rf-layout-options" role="menu">
          <button
            type="button"
            onClick={() => {
              onApply("layered-TB");
              setOpen(false);
            }}
          >
            Layered (top → bottom)
          </button>
          <button
            type="button"
            onClick={() => {
              onApply("layered-LR");
              setOpen(false);
            }}
          >
            Layered (left → right)
          </button>
          <button
            type="button"
            onClick={() => {
              onApply("force");
              setOpen(false);
            }}
          >
            Force-directed
          </button>
        </div>
      )}
    </div>
  );
}

function download(name: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function PipelineBuilder(props: {
  editing?: EditingPipeline;
  onClearEditing?: () => void;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState(toFlowNodes(STARTER_SPEC));
  const [edges, setEdges, onEdgesChange] = useEdgesState(toFlowEdges(STARTER_SPEC));
  const [pipelineName, setPipelineName] = useState("support-rag");
  const [pipelineSlug, setPipelineSlug] = useState("support-rag");
  const [pipelineDescription, setPipelineDescription] = useState("");
  // The identifier used for every API call: the slug until the pipeline row
  // exists, then its real UUID (set on create / open-from-tree).
  const [pipelineId, setPipelineId] = useState("support-rag");
  const [version, setVersion] = useState("0.1.0");
  const [saveLevel, setSaveLevel] = useState<"patch" | "minor" | "major">("patch");
  // Tenant comes from real data (GET /api/tenants); the value is the tenant
  // UUID. Defaults to the `tenant-local` demo tenant once the list loads and
  // pushes the id into the api client (x-tenant-id) via api.setTenant.
  const {
    tenants,
    isLoading: tenantsLoading,
    error: tenantsError,
    tenantId,
    setTenantId,
    selected: selectedTenant,
    ready: tenantReady
  } = useSelectedTenant("tenant-local");
  // Demo defaults: dev environment so the bundled Local Demo just works.
  const [environment, setEnvironment] = useState("dev");
  const envs = useEnvironments(tenantId);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [testInput, setTestInput] = useState('{ "question": "How do I reset my password?" }');
  const [openedViaTree, setOpenedViaTree] = useState(false);
  const clog = useConsoleLog();
  const [inspectorWidth, setInspectorWidth] = useState(360);
  const [paletteWidth, setPaletteWidth] = useState(220);
  // Inspector tab selection. Sticky inside the session — selecting a new node
  // keeps the previously-active tab so a "compare configs across nodes" flow
  // doesn't drop the user back on Config every time.
  const [inspectorTab, setInspectorTab] =
    useState<"config" | "resolved" | "docs">("config");
  // The pipeline id we last loaded a spec for, so the editing-load effect
  // only fires once per "Edit" hand-off from the Pipelines tree.
  const loadedFor = useRef<string | undefined>(undefined);

  const rfRef = useRef<ReactFlowInstance | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  // A viewport (pan + zoom) decoded from a just-loaded spec, waiting to be
  // applied to the React Flow instance once the loaded nodes have rendered.
  // Set by the editing-load effect; consumed by restorePendingViewport.
  const pendingViewport = useRef<{ x: number; y: number; zoom: number } | null>(
    null
  );

  // Run poller bookkeeping. `pollTimer` holds the pending setTimeout id;
  // `pollToken` is bumped on every new run / unmount so an in-flight tick
  // belonging to a superseded run is ignored (no cross-run log spam).
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollToken = useRef(0);

  const stopPoll = useCallback(() => {
    pollToken.current += 1;
    if (pollTimer.current !== null) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  // Cancel any in-flight poller when the Builder unmounts.
  useEffect(() => stopPoll, [stopPoll]);

  /**
   * Poll GET /api/executions/:id/trace until the execution is terminal (or the
   * cap is hit). Each tick logs only the node transitions not yet emitted
   * (diffNodeEvents, keyed by nodeId+status) with a sampled output preview,
   * and a final SUCCESS/ERROR line with duration + sampled final output/error.
   */
  const pollExecution = useCallback(
    (executionId: string) => {
      stopPoll();
      const myToken = ++pollToken.current;
      const startedAt = Date.now();
      let seenNodes: NodeLike[] = [];

      const tick = async () => {
        if (myToken !== pollToken.current) return; // superseded by a new run
        try {
          const trace = await api.getExecutionTrace(executionId);
          if (myToken !== pollToken.current) return;

          const nodes = (trace.nodes ?? []) as NodeLike[];
          for (const ev of diffNodeEvents(seenNodes, nodes)) {
            clog.log(ev.level, ev.message, ev.detail);
          }
          seenNodes = nodes;

          const sum = summarizeExecution(trace.execution);
          if (sum.terminal) {
            if (sum.status === "succeeded") {
              clog.log(
                "success",
                `▶ execution ${executionId} ${sum.line}`,
                sampleForDisplay(trace.execution.output)
              );
            } else {
              const failed = nodes.find((n) => n.status === "failed");
              if (failed) {
                clog.log(
                  "error",
                  `▶ node ${failed.nodeId} failed — ${
                    failed.error ?? "unknown error"
                  }`,
                  sampleForDisplay(
                    failed.output !== undefined && failed.output !== null
                      ? failed.output
                      : failed.input
                  )
                );
              }
              clog.log(
                "error",
                `▶ execution ${executionId} ${sum.line}`,
                sampleForDisplay(
                  trace.execution.error ?? trace.execution.output
                )
              );
            }
            stopPoll();
            return;
          }

          if (Date.now() - startedAt > RUN_POLL_MAX_MS) {
            clog.log(
              "warn",
              `▶ stopped polling execution ${executionId} after ${Math.round(
                RUN_POLL_MAX_MS / 1000
              )}s — still ${sum.status}. Check the Executions screen.`,
              { executionId, lastStatus: sum.status }
            );
            stopPoll();
            return;
          }
        } catch (e) {
          // A transient trace fetch error shouldn't kill the run feed; log
          // once and keep polling until the cap.
          clog.failure("Trace poll failed (will retry)", e, {
            method: "GET",
            path: `/api/executions/${executionId}/trace`
          });
          if (Date.now() - startedAt > RUN_POLL_MAX_MS) {
            stopPoll();
            return;
          }
        }
        if (myToken !== pollToken.current) return;
        pollTimer.current = setTimeout(tick, RUN_POLL_INTERVAL_MS);
      };

      // First poll on the next interval so the worker has a beat to start.
      pollTimer.current = setTimeout(tick, RUN_POLL_INTERVAL_MS);
    },
    [clog, stopPoll]
  );

  const spec: PipelineSpec = useMemo(
    () =>
      graphToSpec(nodes as unknown as FlowNode[], edges as unknown as FlowEdge[], {
        name: pipelineName,
        description: pipelineDescription.trim() || undefined
      }),
    [nodes, edges, pipelineName, pipelineDescription]
  );


  /**
   * The spec to persist/export: the graph-derived `spec` plus the *current*
   * React Flow viewport (pan + zoom) baked into `metadata.annotations` via
   * VIEWPORT_ANNOTATION. Node X/Y already round-trip via `node.ui.position`;
   * this adds zoom/pan so the canvas reopens exactly as the user left it.
   * Read at call time (not memoized) because the viewport lives on the
   * imperative React Flow instance, not in React state. If the instance
   * isn't ready, `withViewportAnnotation` is a no-op and `spec` is unchanged.
   */
  const specWithLayout = useCallback(
    (): PipelineSpec => withViewportAnnotation(spec, rfRef.current?.getViewport()),
    [spec]
  );

  /**
   * Apply a viewport stashed by the editing-load effect onto the React Flow
   * instance, overriding the `fitView` prop so the canvas reopens at the saved
   * zoom/pan (node X/Y already restored via specToGraph -> node.ui.position).
   * Retries briefly if the instance or nodes aren't ready yet; if no viewport
   * was stored, this is a no-op and the default fitView stands.
   */
  const restorePendingViewport = useCallback((attempt = 0) => {
    const vp = pendingViewport.current;
    if (!vp) return;
    const rf = rfRef.current;
    if (rf && rf.getNodes().length > 0) {
      rf.setViewport(vp);
      pendingViewport.current = null;
      return;
    }
    // Instance / nodes not mounted yet; retry a few times then give up so a
    // missing instance simply falls back to the existing fitView behavior.
    if (attempt < 10) {
      setTimeout(() => restorePendingViewport(attempt + 1), 50);
    } else {
      pendingViewport.current = null;
    }
  }, []);

  // Every registered plugin, fetched once and shared with the palette. The
  // descriptor a drag/click carries only holds the plugin REF; we look the
  // full PluginInfo back up here so a dropped node arrives with its
  // schema-default config pre-filled (no JSON incantations).
  const plugins = useQuery({
    queryKey: ["plugins"],
    queryFn: () => api.listPlugins(),
    retry: false,
    staleTime: 5 * 60 * 1000
  });
  const pluginList = useMemo<PluginInfo[]>(
    () => plugins.data?.plugins ?? [],
    [plugins.data]
  );
  const pluginManifestMap = useMemo(() => {
    const map = new Map<string, PluginInfo>();
    for (const info of pluginList) {
      map.set(`${info.category}:${info.id}:${info.version}`, info);
    }
    return map;
  }, [pluginList]);

  // Real-time validation: run validatePipelineSpec on every spec change,
  // bucket the issues by nodeId so FlowNodeCard can render a corner
  // badge. The validator's plugin-aware checks (missing_plugin_ref,
  // unknown_output_port, etc.) need a registry; we duck-type one from
  // the API's pluginList so the client catches the same errors save will.
  const clientPluginRegistry = useMemo(() => {
    const byKey = new Map<string, { manifest: PluginInfo }>();
    for (const info of pluginList) {
      byKey.set(`${info.category}:${info.id}:${info.version}`, { manifest: info });
    }
    // The validator only calls `registry.get(ref)` so a duck-typed
    // object is sufficient — we don't have to drag a real PluginRegistry
    // into the web bundle.
    return {
      get: (ref: { category: string; id: string; version: string }) =>
        byKey.get(`${ref.category}:${ref.id}:${ref.version}`)
    };
  }, [pluginList]);

  const validationByNode = useMemo(() => {
    // Skip validation while the plugin list is still loading — otherwise
    // every plugin ref looks "missing" for the first render.
    if (pluginList.length === 0) {
      return new Map<string, NodeValidationBuckets>();
    }
    const result = validatePipelineSpec(
      spec as unknown as Parameters<typeof validatePipelineSpec>[0],
      clientPluginRegistry as unknown as Parameters<typeof validatePipelineSpec>[1]
    );
    const byNode = new Map<string, NodeValidationBuckets>();
    const push = (issue: ValidationIssue, ids: string[]) => {
      for (const id of ids) {
        if (!byNode.has(id)) byNode.set(id, { errors: [], warnings: [] });
        const bucket = byNode.get(id)!;
        (issue.level === "error" ? bucket.errors : bucket.warnings).push({
          code: issue.code,
          message: issue.message
        });
      }
    };
    for (const issue of [...result.errors, ...result.warnings]) {
      const ids: string[] = [];
      if (issue.nodeId) ids.push(issue.nodeId);
      // Edge-level issues attach to BOTH endpoints so the badge appears
      // wherever the user looks.
      if (issue.edge) {
        if (issue.edge.from) ids.push(issue.edge.from);
        if (issue.edge.to) ids.push(issue.edge.to);
      }
      if (ids.length > 0) push(issue, ids);
    }
    return byNode;
  }, [spec, clientPluginRegistry, pluginList.length]);

  const resolved = useQuery({
    queryKey: ["resolved-config", pipelineId, tenantId, environment],
    queryFn: () =>
      api.resolvedConfig({ pipeline_id: pipelineId, tenant_id: tenantId, environment }),
    // Don't fire a doomed request before a tenant UUID is selected.
    enabled: tenantReady,
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
    () => (nodes as unknown as FlowNode[]).find((n) => n.id === selectedId)?.data.node,
    [nodes, selectedId]
  );

  const selectedPluginRef = selectedNode?.plugin;
  const selectedPlugin = useQuery({
    queryKey: [
      "plugin",
      selectedPluginRef?.category,
      selectedPluginRef?.id,
      selectedPluginRef?.version
    ],
    queryFn: () =>
      api.getPlugin(
        selectedPluginRef!.category,
        selectedPluginRef!.id,
        selectedPluginRef!.version
      ),
    enabled: !!selectedPluginRef,
    retry: false
  });

  const nodeKinds = useMemo(
    () =>
      new Map(
        (nodes as unknown as FlowNode[]).map((n) => [n.id, nodeKind(n.data.node)])
      ),
    [nodes]
  );

  const isValidConnection = useCallback(
    (c: Connection) =>
      validateConnection(
        { source: c.source, target: c.target },
        nodeKinds,
        edges.map((e) => ({ source: e.source, target: e.target }))
      ),
    [nodeKinds, edges]
  );

  /**
   * Run an API action with full request→result/error logging. Logs the
   * "→ request" line (method + path + redacted body), then either the
   * "← result" success line (HTTP status + body) or a clear error line.
   */
  async function withLog<T>(
    okLabel: string,
    failLabel: string,
    call: {
      method: string;
      path: string;
      body?: unknown;
      run: () => Promise<T>;
      ok?: (result: T) => string;
    }
  ): Promise<T | undefined> {
    clog.request(call.method, call.path, call.body);
    try {
      const result = await call.run();
      clog.result(call.ok ? call.ok(result) : okLabel, 200, result);
      return result;
    } catch (e) {
      clog.failure(failLabel, e, { method: call.method, path: call.path });
      return undefined;
    }
  }

  // Tenant-association rollup, shared via the same cache key as the
  // Pipelines screen so a single network sweep serves both. Used below to
  // auto-select the tenant the editing pipeline is bound to, instead of
  // leaving the dropdown on the unrelated `tenant-local` demo default.
  const tenantPipelinesAll = useQuery({
    queryKey: ["tenant-pipelines-all", tenants.map((t) => t.id)],
    enabled: tenants.length > 0,
    queryFn: async () => {
      const out: Array<{ tenantId: string; pipelineIds: string[] }> = [];
      for (const t of tenants) {
        try {
          const res = await api.listTenantPipelines(t.id);
          out.push({
            tenantId: t.id,
            pipelineIds: res.pipelines.map((p) => p.pipelineId)
          });
        } catch {
          out.push({ tenantId: t.id, pipelineIds: [] });
        }
      }
      return out;
    }
  });

  // When the Edit hand-off targets a pipeline that is associated with a
  // tenant, snap the tenant dropdown to one that actually covers it — the
  // default `tenant-local` is almost always wrong for a freshly-created
  // pipeline tied to a different tenant.
  useEffect(() => {
    const editing = props.editing;
    if (!editing) return;
    if (!tenantPipelinesAll.data) return;
    const matches = tenantPipelinesAll.data.filter((t) =>
      t.pipelineIds.includes(editing.id)
    );
    if (matches.length === 0) return;
    if (matches.some((t) => t.tenantId === tenantId)) return;
    setTenantId(matches[0].tenantId);
  }, [props.editing, tenantPipelinesAll.data, tenantId, setTenantId]);

  // When the Pipelines tree hands us a pipeline to edit, load its latest
  // version's spec into the graph (GET versions -> pick latestVersionId).
  useEffect(() => {
    const target = props.editing;
    if (!target || loadedFor.current === target.id) return;
    loadedFor.current = target.id;
    setPipelineId(target.id);
    setPipelineName(target.name);
    setOpenedViaTree(true);
    // Pull the pipeline row so the toolbar shows the real slug + description
    // (EditingPipeline only carries id + name).
    (async () => {
      try {
        const { pipeline } = await api.getPipeline(target.id);
        setPipelineSlug(pipeline.slug);
        // The URL hand-off only carries the id (`name: ""`), so the
        // toolbar's Name field is blank until we read the real row.
        setPipelineName(pipeline.name);
        setPipelineDescription(pipeline.description ?? "");
      } catch {
        setPipelineSlug(target.id);
      }
    })();
    const path = `/api/pipelines/${target.id}/versions`;
    (async () => {
      clog.request("GET", path);
      try {
        const res = await api.listVersions(target.id);
        const latest =
          res.versions.find((v) => v.id === res.latestVersionId) ??
          res.versions.find((v) => v.isLatest) ??
          res.versions[res.versions.length - 1];
        if (!latest) {
          // A pipeline that has never been saved should land on a TRULY
          // blank canvas — without this the editor still shows the
          // hard-coded STARTER_SPEC seeded into the initial useNodesState
          // (the warning below says "blank canvas", so honour it).
          setNodes([]);
          setEdges([]);
          clog.result(`Editing ${target.name}`, 200, res);
          clog.log(
            "warn",
            `${target.name} has no saved versions — starting from a blank canvas.`
          );
          return;
        }
        if (latest.spec && typeof latest.spec === "object") {
          const loaded = latest.spec as PipelineSpec;
          setPipelineName(loaded.metadata?.name ?? target.name);
          if (loaded.metadata?.description) {
            setPipelineDescription(loaded.metadata.description);
          }
          setNodes(toFlowNodes(loaded));
          setEdges(toFlowEdges(loaded));
          setVersion(latest.version);
          // Restore the saved zoom/pan after the loaded graph renders. Node
          // X/Y already came back via specToGraph -> node.ui.position; this
          // overrides the `fitView` prop only when a viewport was stored
          // (decodeViewport tolerates missing/garbage -> undefined). Runs once
          // per Edit hand-off (gated by loadedFor above).
          const savedViewport = decodeViewport(loaded);
          if (savedViewport) {
            pendingViewport.current = savedViewport;
            restorePendingViewport();
          }
          clog.result(
            `Loaded ${target.name} @ ${latest.version} (${
              loaded.spec?.nodes?.length ?? 0
            } nodes)`,
            200,
            { version: latest.version, nodes: loaded.spec?.nodes?.length ?? 0 }
          );
        } else {
          setVersion(latest.version);
          clog.result(`Editing ${target.name}`, 200, res);
          clog.log(
            "warn",
            `Latest version ${latest.version} carries no inline spec; canvas unchanged.`
          );
        }
      } catch (e) {
        clog.failure(`Load ${target.name} failed`, e, { method: "GET", path });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.editing]);

  const onConnect = useCallback(
    (connection: Connection) =>
      setEdges((current) => addEdge({ ...connection, ...EDGE_DEFAULTS }, current)),
    [setEdges]
  );

  const addNode = useCallback(
    (item: PaletteDragItem, position?: { x: number; y: number }) => {
      setNodes((current) => {
        const existing = new Set(current.map((n) => n.id));
        // Base id seed: the io kind, or the plugin id (so dropped nodes read
        // as e.g. `crawl4ai_crawler`, not `datasource`). Uniqueness preserved.
        const base = item.kind === "io" ? item.io : item.id;
        let id = base;
        let n = 1;
        while (existing.has(id)) id = `${base}_${n++}`;
        let pipelineNode: PipelineNode;
        if (item.kind === "io") {
          pipelineNode = newIoNode(item.io, id);
        } else {
          // Look the full PluginInfo back up so the dropped node arrives with
          // its schema-default config seeded for the inspector form.
          const info = pluginList.find(
            (p) =>
              p.category === item.category &&
              p.id === item.id &&
              p.version === item.version
          );
          pipelineNode = newNodeFromPlugin(
            {
              category: item.category,
              id: item.id,
              version: item.version,
              configSchema: info?.configSchema
            },
            id
          );
        }
        const flow = specToGraph({
          ...STARTER_SPEC,
          spec: { nodes: [pipelineNode], edges: [] }
        }).nodes[0];
        flow.position =
          position ?? { x: 160 + (current.length % 5) * 60, y: 360 + (current.length % 4) * 60 };
        setSelectedId(id);
        return [...current, { ...flow, type: "ragNode" } as unknown as Node];
      });
    },
    [setNodes, pluginList]
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const raw = event.dataTransfer.getData(DND_MIME);
      const item = decodePaletteDrag(raw);
      if (!item || !rfRef.current || !canvasRef.current) return;
      const bounds = canvasRef.current.getBoundingClientRect();
      const position = rfRef.current.project({
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top
      });
      addNode(item, position);
    },
    [addNode]
  );

  // Side-panel resizers. The builder grid lives INSIDE the app shell, which
  // has a fixed 220px sidebar to the left, so `clientX` is viewport-relative
  // but the palette's left edge is offset by the sidebar width. Compute new
  // widths relative to the grid's bounding rect — that way both resizers
  // work regardless of how the shell is laid out around the builder.
  const gridRef = useRef<HTMLDivElement | null>(null);
  const driveResize = useCallback(
    (
      compute: (clientX: number, rect: DOMRect) => void
    ): ((event: React.MouseEvent) => void) =>
      (event) => {
        event.preventDefault();
        const rect = gridRef.current?.getBoundingClientRect();
        if (!rect) return;
        const move = (ev: MouseEvent) => compute(ev.clientX, rect);
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      },
    []
  );

  const startResize = useMemo(
    () =>
      driveResize((clientX, rect) =>
        setInspectorWidth(
          clampInspectorWidth(rect.right - clientX, rect.width)
        )
      ),
    [driveResize]
  );

  const startPaletteResize = useMemo(
    () =>
      driveResize((clientX, rect) =>
        setPaletteWidth(clampPaletteWidth(clientX - rect.left, rect.width))
      ),
    [driveResize]
  );

  function updateSelectedNode(mutate: (node: PipelineNode) => PipelineNode) {
    if (!selectedId) return;
    setNodes((current) =>
      current.map((flow) => {
        if (flow.id !== selectedId) return flow;
        const fn = flow as unknown as FlowNode;
        const next = mutate(fn.data.node);
        return { ...flow, data: { ...fn.data, node: next } } as unknown as Node;
      })
    );
  }

  function setNodeConfig(config: Record<string, unknown>) {
    updateSelectedNode((node) => ({ ...node, config }));
  }

  function setNodeSecrets(secrets: Record<string, SecretRef>) {
    updateSelectedNode((node) => ({ ...node, secrets }));
  }

  function deleteSelected() {
    if (!selectedId) return;
    setEdges((current) =>
      current.filter((e) => e.source !== selectedId && e.target !== selectedId)
    );
    setNodes((current) => current.filter((n) => n.id !== selectedId));
    setSelectedId(undefined);
  }

  // Apply a homegrown layout to the current graph. The dropdown in the
  // upper-left of the canvas wires into this; positions are updated in
  // place and persisted through graphToSpec on the next save.
  const applyLayoutKind = useCallback(
    (kind: LayoutKind) => {
      const layoutNodes = (nodes as unknown as FlowNode[]).map((n) => ({
        id: n.id,
        position: n.position
      }));
      const layoutEdges = (edges as unknown as FlowEdge[]).map((e) => ({
        from: e.source,
        to: e.target
      }));
      const next = applyLayout(kind, layoutNodes, layoutEdges);
      setNodes((current) =>
        current.map((n) => {
          const p = next.get(n.id);
          return p ? { ...n, position: p } : n;
        })
      );
      // Re-center the viewport so the freshly-laid-out graph is visible.
      // Defer one tick so React Flow sees the new positions first.
      setTimeout(() => rfRef.current?.fitView({ duration: 300, padding: 0.15 }), 0);
    },
    [nodes, edges, setNodes]
  );

  async function validate() {
    const res = await withLog("Validation passed", "Validate failed", {
      method: "POST",
      path: "/api/pipelines/validate",
      body: spec,
      run: () => api.validateSpec(spec),
      ok: (r) =>
        r.valid
          ? "Validation passed"
          : `Validation found ${r.errors.length} error${
              r.errors.length === 1 ? "" : "s"
            }`
    });
    if (res && !res.valid) {
      clog.log("warn", `Spec is invalid — ${res.errors.length} error(s)`, {
        errors: res.errors,
        warnings: res.warnings
      });
    }
  }

  async function savePipeline() {
    const layoutSpec = specWithLayout();

    // A fresh builder points at a placeholder slug with no pipeline row yet.
    // The /save route only versions an *existing* pipeline (404s otherwise),
    // so create the pipeline first, adopt its real UUID, then mint v1.
    const description = pipelineDescription.trim() || undefined;
    let saveId = pipelineId;
    if (!hasRealPipeline({ pipelineId, openedViaTree })) {
      const slug = pipelineSlug.trim();
      const created = await withLog("Pipeline created", "Create failed", {
        method: "POST",
        path: "/api/pipelines",
        body: { slug, name: pipelineName, description },
        run: async () => {
          try {
            return (
              await api.createPipeline({ slug, name: pipelineName, description })
            ).pipeline;
          } catch (e) {
            // Slug already taken — adopt the existing pipeline rather than
            // failing, so a re-Save of the same name keeps working.
            if (e instanceof ApiError && e.status === 409) {
              const existing = (await api.listPipelines()).pipelines.find(
                (p) => p.slug === slug
              );
              if (existing) return existing;
            }
            throw e;
          }
        },
        ok: (p) => `Pipeline "${p.slug}" ready (${p.id})`
      });
      if (!created) return; // create failed; failure already logged
      saveId = created.id;
      setPipelineId(created.id);
      setPipelineSlug(created.slug);
      setPipelineName(created.name);
      setPipelineDescription(created.description ?? "");
      setOpenedViaTree(true);
    } else {
      // Existing pipeline: keep its row name/description in sync with the
      // toolbar before minting the new version (slug is immutable).
      await withLog("Metadata updated", "Metadata update failed", {
        method: "PUT",
        path: `/api/pipelines/${saveId}`,
        body: { name: pipelineName, description: description ?? "" },
        run: () =>
          api.updatePipeline(saveId, {
            name: pipelineName,
            description: description ?? ""
          })
      });
    }

    const res = await withLog("Saved", "Save failed", {
      method: "POST",
      path: `/api/pipelines/${saveId}/save`,
      body: { spec: layoutSpec, level: saveLevel },
      run: () => api.savePipeline(saveId, { spec: layoutSpec, level: saveLevel }),
      ok: (r) =>
        r.created
          ? `Saved — new version ${r.version.version} created`
          : `No change — already at ${r.version.version} (idempotent)`
    });
    if (res) setVersion(res.version.version);
  }

  async function saveDraft() {
    const layoutSpec = specWithLayout();
    await withLog("Draft saved", "Save draft failed", {
      method: "POST",
      path: `/api/pipelines/${pipelineId}/versions`,
      body: { version, spec: layoutSpec },
      run: () => api.saveVersion(pipelineId, { version, spec: layoutSpec }),
      ok: (r) => `Draft saved as ${r.version.version}`
    });
  }

  async function publish() {
    const layoutSpec = specWithLayout();
    await withLog("Published", "Publish failed", {
      method: "POST",
      path: `/api/pipelines/${pipelineId}/versions`,
      body: { version, spec: layoutSpec, publish: true },
      run: () => api.saveVersion(pipelineId, { version, spec: layoutSpec, publish: true }),
      ok: (r) => `Published ${r.version.version}`
    });
  }

  async function deploy() {
    await withLog("Deployed", "Deploy failed", {
      method: "POST",
      path: `/api/pipelines/${pipelineId}/deployments`,
      body: { version, environment, tenantId },
      run: () => api.deploy(pipelineId, { version, environment, tenantId }),
      ok: () =>
        `Deployed ${version} to ${environment} (tenant ${
          selectedTenant?.slug ?? tenantId
        })`
    });
  }

  function exportJson() {
    const layoutSpec = specWithLayout();
    download(`${pipelineName}.json`, JSON.stringify(layoutSpec, null, 2), "application/json");
    clog.log("success", `Exported ${pipelineName}.json`, {
      nodes: layoutSpec.spec?.nodes?.length ?? 0
    });
  }

  function exportYaml() {
    const layoutSpec = specWithLayout();
    download(`${pipelineName}.yaml`, stringifyYaml(layoutSpec), "application/yaml");
    clog.log("success", `Exported ${pipelineName}.yaml`, {
      nodes: layoutSpec.spec?.nodes?.length ?? 0
    });
  }

  function importSpecFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text()) as PipelineSpec;
        setPipelineName(parsed.metadata?.name ?? pipelineName);
        setNodes(toFlowNodes(parsed));
        setEdges(toFlowEdges(parsed));
        clog.log(
          "success",
          `Imported ${file.name} — ${parsed.spec?.nodes?.length ?? 0} nodes`,
          { name: parsed.metadata?.name, nodes: parsed.spec?.nodes?.length ?? 0 }
        );
      } catch (e) {
        clog.failure("Import failed", e);
      }
    };
    input.click();
  }

  function refreshResolved() {
    if (!tenantReady) {
      clog.log(
        "warn",
        "Resolve config unavailable — select a tenant first (no tenant context).",
        { tenantId, tenantsLoading }
      );
      return;
    }
    const path = `/api/config/resolved?pipeline_id=${pipelineId}&tenant_id=${tenantId}&environment=${environment}`;
    clog.request("GET", path, { pipeline_id: pipelineId, tenant_id: tenantId, environment });
    resolved
      .refetch()
      .then((r) => {
        if (r.error) clog.failure("Resolve config failed", r.error, { method: "GET", path });
        else clog.result("Resolved config refreshed", 200, r.data);
      })
      .catch((e) => clog.failure("Resolve config failed", e, { method: "GET", path }));
  }

  async function run() {
    // Tenant-scoped route: without an x-tenant-id (UUID) the API 422s with
    // "tenant context required". Surface a console hint instead of firing a
    // doomed request.
    if (!tenantReady) {
      clog.log(
        "warn",
        tenantsLoading
          ? "Run unavailable — still loading tenants. Pick a tenant once the list loads."
          : "Run unavailable — select a tenant first (no tenant context to scope the request).",
        { tenantId, tenantsLoading }
      );
      return;
    }

    let parsedInput: unknown;
    try {
      parsedInput = JSON.parse(testInput || "{}");
    } catch {
      clog.log(
        "error",
        "Run aborted — Test Input is not valid JSON.",
        { testInput }
      );
      return;
    }

    // Guard accidental doomed runs against the placeholder pipeline.
    if (!hasRealPipeline({ pipelineId, openedViaTree })) {
      clog.log(
        "warn",
        `No saved pipeline selected ("${pipelineId}" is not a saved id) — ` +
          "open one from Pipelines or Save first. Sending anyway on confirm.",
        { pipelineId, openedViaTree }
      );
      const proceed =
        typeof window === "undefined" ||
        window.confirm(
          `"${pipelineId}" doesn't look like a saved pipeline.\n\n` +
            "Run it anyway? (The API will likely return a 404/409 — the " +
            "result will be shown in the Console below.)"
        );
      if (!proceed) {
        clog.log("info", "Run cancelled by user (no saved pipeline).");
        return;
      }
    }

    const path = `/api/pipelines/${pipelineId}/run`;
    const tenantDesc = selectedTenant
      ? `${selectedTenant.slug} (${tenantId})`
      : tenantId;
    clog.log(
      "info",
      `Running pipeline "${pipelineId}" (v${version}) — tenant ${tenantDesc}, env ${environment}`,
      { pipelineId, version, tenantId, tenantSlug: selectedTenant?.slug, environment }
    );
    clog.request("POST", path, { input: parsedInput, environment });
    // A new run supersedes any poller still chasing a previous execution.
    stopPoll();
    try {
      const result = await api.run(pipelineId, { input: parsedInput, environment });
      clog.result(
        `Run accepted — execution ${result.executionId} (${result.status})`,
        202,
        result
      );
      clog.log(
        "info",
        `▶ tracing execution ${result.executionId} — polling every ${
          RUN_POLL_INTERVAL_MS / 1000
        }s for node progress…`,
        { executionId: result.executionId, jobId: result.jobId }
      );
      pollExecution(result.executionId);
    } catch (e) {
      clog.failure("Run failed", e, { method: "POST", path });
    }
  }

  const requiredConfig = extractConfigRefs(spec);
  const requiredSecrets = extractSecretRefs(spec);
  // Slug is the create-time identity; immutable once the pipeline row exists.
  const realPipeline = hasRealPipeline({ pipelineId, openedViaTree });

  // --- Collaborative editing (Builder room) ------------------------------
  // Join the room ONLY for saved pipelines; an unsaved draft has no shared
  // identity. Apply incoming edits with a flag that suppresses our own
  // re-broadcast on the next state-change cycle (last-writer-wins per
  // broadcast). Programmatic loads land via the same path; skipping the
  // first broadcast per (pipelineId, room-activation) avoids clobbering a
  // peer that already has unsaved edits when we join.
  const [roster, setRoster] = useState<BuilderPresence[]>([]);
  const applyingRemoteRef = useRef(false);
  const broadcastSeededRef = useRef(false);
  const collabPipelineId = realPipeline ? pipelineId : undefined;

  const applyRemoteEdit = useCallback(
    (edit: BuilderEdit) => {
      const spec = edit.spec as {
        nodes?: typeof nodes;
        edges?: typeof edges;
      };
      if (Array.isArray(spec?.nodes) || Array.isArray(spec?.edges)) {
        applyingRemoteRef.current = true;
      }
      if (Array.isArray(spec?.nodes)) setNodes(spec.nodes);
      if (Array.isArray(spec?.edges)) setEdges(spec.edges);
    },
    [setNodes, setEdges]
  );

  const room = useBuilderRoom(collabPipelineId, {
    onRoster: setRoster,
    onEdit: applyRemoteEdit
  });

  // Reset the seed flag when we (re)join a different room, so the first
  // post-join state tick doesn't clobber a peer.
  useEffect(() => {
    broadcastSeededRef.current = false;
  }, [collabPipelineId]);

  useEffect(() => {
    if (!collabPipelineId) return;
    if (applyingRemoteRef.current) {
      applyingRemoteRef.current = false;
      return;
    }
    if (!broadcastSeededRef.current) {
      broadcastSeededRef.current = true;
      return;
    }
    const t = window.setTimeout(() => {
      room.broadcastEdit({ nodes, edges });
    }, 300);
    return () => window.clearTimeout(t);
  }, [nodes, edges, room, collabPipelineId]);

  // Broadcast focus changes (selected node) as presence so other editors see
  // who is on which node.
  useEffect(() => {
    if (!collabPipelineId) return;
    room.setFocus(selectedId ?? null);
  }, [selectedId, room, collabPipelineId]);

  return (
    <section className="builder">
      <header className="toolbar">
        <strong>Visual Pipeline Builder</strong>

        <label>
          Name
          <input
            value={pipelineName}
            onChange={(e) => setPipelineName(e.target.value)}
            style={{ width: 140 }}
          />
        </label>

        <ToolbarMenu label="Details">
          <label>
            Slug
            <input
              value={pipelineSlug}
              disabled={realPipeline}
              title={
                realPipeline
                  ? "Slug is fixed once the pipeline is created"
                  : "URL-safe identifier; set on first Save"
              }
              onChange={(e) => {
                const v = e.target.value;
                setPipelineSlug(v);
                // Keep the API ref pointed at the slug until a real row exists.
                if (!realPipeline) setPipelineId(v);
              }}
            />
          </label>
          <label>
            Description
            <input
              value={pipelineDescription}
              placeholder="optional"
              onChange={(e) => setPipelineDescription(e.target.value)}
            />
          </label>
        </ToolbarMenu>

        <button className="primary" onClick={savePipeline}>
          Save
        </button>
        <button onClick={validate}>Validate</button>

        <ToolbarMenu label="Versioning">
          <label>
            Version
            <input
              value={version}
              onChange={(e) => setVersion(e.target.value)}
            />
          </label>
          <label>
            Level
            <select
              value={saveLevel}
              onChange={(e) =>
                setSaveLevel(e.target.value as "patch" | "minor" | "major")
              }
            >
              <option value="patch">patch</option>
              <option value="minor">minor</option>
              <option value="major">major</option>
            </select>
          </label>
          <div className="tb-menu-divider" />
          <button onClick={saveDraft}>Save Draft</button>
          <button onClick={publish}>Publish</button>
        </ToolbarMenu>

        <ToolbarMenu label="Deploy">
          <label>
            Environment
            <EnvironmentSelect
              environments={envs.environments}
              value={environment}
              onChange={setEnvironment}
              isLoading={envs.isLoading}
            />
          </label>
          <div className="tb-menu-divider" />
          <button onClick={deploy}>Deploy</button>
        </ToolbarMenu>

        <ToolbarMenu label="Import / Export">
          <button onClick={importSpecFile}>Import…</button>
          <div className="tb-menu-divider" />
          <button onClick={exportJson}>Export JSON</button>
          <button onClick={exportYaml}>Export YAML</button>
        </ToolbarMenu>

        <button
          onClick={run}
          disabled={!tenantReady}
          title={
            tenantReady
              ? "Run this pipeline"
              : tenantsLoading
                ? "Loading tenants…"
                : "Select a tenant first (no tenant context)"
          }
        >
          Run
        </button>
        <label>
          Tenant
          <TenantSelect
            tenants={tenants}
            value={tenantId}
            onChange={setTenantId}
            isLoading={tenantsLoading}
          />
        </label>
        {tenantsError && (
          <span className="error" title={String(tenantsError)}>
            tenants unavailable
          </span>
        )}
        {/* "Who else is editing this pipeline?" — pushed to the right by
            margin-left:auto so it sits at the top-right of the toolbar. */}
        <span style={{ marginLeft: "auto" }}>
          {collabPipelineId && (
            <BuilderRoster
              members={roster}
              selfConnectionId={room.connectionId}
            />
          )}
        </span>
      </header>
      <div className="builder-main">
      <div
        ref={gridRef}
        className="builder-grid"
        style={{
          gridTemplateColumns: `${paletteWidth}px 6px minmax(0, 1fr) 6px ${inspectorWidth}px`
        }}
      >
        <PalettePanel
          plugins={pluginList}
          isLoading={plugins.isLoading}
          isError={plugins.isError}
          onAdd={(item) => addNode(item)}
        />
        <div
          className="col-resizer"
          onMouseDown={startPaletteResize}
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize the node palette"
        />
        <div
          className="canvas"
          ref={canvasRef}
          onDrop={onDrop}
          onDragOver={onDragOver}
        >
          <PluginManifestContext.Provider value={pluginManifestMap}>
            <NodeValidationContext.Provider value={validationByNode}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onInit={(instance) => {
                rfRef.current = instance;
              }}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              defaultEdgeOptions={EDGE_DEFAULTS}
              onNodeClick={(_, node) => setSelectedId(node.id)}
              onPaneClick={() => setSelectedId(undefined)}
              deleteKeyCode={["Backspace", "Delete"]}
              fitView
            >
              <MiniMap pannable zoomable />
              <Controls />
              <Background />
              <LayoutMenu onApply={applyLayoutKind} />
            </ReactFlow>
            </NodeValidationContext.Provider>
          </PluginManifestContext.Provider>
        </div>
        <div
          className="col-resizer"
          onMouseDown={startResize}
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize the inspector"
        />
        <aside className="inspector">
          <h2>Inspector</h2>
          {!selectedNode && (
            <p className="muted">
              Select a node to edit its plugin ref, config and secrets.
            </p>
          )}
          {selectedNode && (
            <p>
              Node <strong>{selectedNode.id}</strong>{" "}
              {selectedNode.type ? `(${selectedNode.type})` : ""}
              {selectedNode.plugin && (
                <>
                  <br />
                  <span className="muted">
                    {selectedNode.plugin.category} / {selectedNode.plugin.id} @{" "}
                    {selectedNode.plugin.version}
                  </span>
                </>
              )}
            </p>
          )}

          {/* Three tabs: Config (default — edit), Resolved (preview the
              merged config/spec/test input), Docs (per-plugin reference). */}
          <div
            className="inspector-tabs"
            role="tablist"
            aria-label="Inspector sections"
          >
            <button
              role="tab"
              type="button"
              aria-selected={inspectorTab === "config"}
              className={
                "inspector-tab" +
                (inspectorTab === "config" ? " active" : "")
              }
              onClick={() => setInspectorTab("config")}
            >
              Config
            </button>
            <button
              role="tab"
              type="button"
              aria-selected={inspectorTab === "resolved"}
              className={
                "inspector-tab" +
                (inspectorTab === "resolved" ? " active" : "")
              }
              onClick={() => setInspectorTab("resolved")}
            >
              Resolved
            </button>
            <button
              role="tab"
              type="button"
              aria-selected={inspectorTab === "docs"}
              className={
                "inspector-tab" + (inspectorTab === "docs" ? " active" : "")
              }
              onClick={() => setInspectorTab("docs")}
            >
              Docs
            </button>
          </div>

          {inspectorTab === "config" && (
            <div className="inspector-tab-panel" role="tabpanel">
              {selectedNode && !selectedNode.type && (
                <>
                  <label>Plugin ref (JSON)</label>
                  <textarea
                    key={`plugin-${selectedNode.id}`}
                    defaultValue={JSON.stringify(
                      selectedNode.plugin ?? {},
                      null,
                      2
                    )}
                    onBlur={(e) => {
                      try {
                        const plugin = JSON.parse(e.target.value);
                        updateSelectedNode((node) => ({ ...node, plugin }));
                      } catch {
                        /* ignore */
                      }
                    }}
                  />
                  <h3>Config</h3>
                  {selectedPlugin.isLoading && (
                    <p className="muted">Loading plugin schema…</p>
                  )}
                  {selectedPlugin.isError && (
                    <p className="muted">
                      Plugin metadata unavailable — editing raw config.
                    </p>
                  )}
                  <PluginEditorSlot
                    key={`config-${selectedNode.id}`}
                    value={selectedNode.config}
                    schema={selectedPlugin.data?.configSchema}
                    ui={selectedPlugin.data?.ui}
                    onChange={setNodeConfig}
                  />
                  <h3>Secrets</h3>
                  <SecretsEditor
                    key={`secrets-${selectedNode.id}`}
                    secrets={selectedNode.secrets}
                    schema={selectedPlugin.data?.secretsSchema}
                    onChange={setNodeSecrets}
                  />
                </>
              )}
              {selectedNode && (
                <button onClick={deleteSelected}>Delete node</button>
              )}
              {!selectedNode && (
                <p className="muted">
                  Click a node on the canvas to edit it.
                </p>
              )}
            </div>
          )}

          {inspectorTab === "resolved" && (
            <div className="inspector-tab-panel" role="tabpanel">
              <h3>Required config</h3>
              <pre>{requiredConfig.join("\n") || "(none)"}</pre>
              <h3>Required secrets</h3>
              <pre>{requiredSecrets.join("\n") || "(none)"}</pre>
              <h3>
                Resolved Config{" "}
                <button
                  type="button"
                  className="link-btn"
                  onClick={refreshResolved}
                  title="Re-resolve config and log the result to the Console"
                >
                  refresh
                </button>
              </h3>
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
              <h3>Resolved spec preview</h3>
              <pre>{JSON.stringify(resolvedSpec.spec.nodes, null, 2)}</pre>
              <h3>Test Input (JSON)</h3>
              <textarea
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
              />
            </div>
          )}

          {inspectorTab === "docs" && (
            <div className="inspector-tab-panel" role="tabpanel">
              {selectedNode?.plugin ? (
                <NodeDocsTab
                  plugin={selectedPlugin.data}
                  loading={selectedPlugin.isLoading}
                  error={selectedPlugin.isError}
                />
              ) : (
                <p className="muted">
                  Select a plugin-backed node to see its docs. System nodes
                  (input/output) have no plugin manifest.
                </p>
              )}
            </div>
          )}
        </aside>
      </div>
      <BuilderConsole log={clog} />
      </div>
    </section>
  );
}
