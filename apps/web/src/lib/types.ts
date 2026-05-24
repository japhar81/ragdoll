/**
 * Local mirror of the RAGdoll core domain types the web console depends on.
 *
 * These are intentionally a hand-maintained copy (not an import from
 * packages/core) so the web app stays a standalone Vite bundle that does not
 * pull the server workspace into the browser build. They must stay structurally
 * compatible with packages/core/src/index.ts.
 */

export type PluginCategory =
  | "datasource"
  | "loader"
  | "parser"
  | "chunker"
  | "embedder"
  | "vector_store"
  | "retriever"
  | "reranker"
  | "llm"
  | "prompt_template"
  | "tool"
  | "guardrail"
  | "evaluator"
  | "output_parser"
  | "transformer"
  | "router"
  | "control"
  | "memory"
  | "sink";

export interface PluginRef {
  category: PluginCategory;
  id: string;
  version: string;
}

export type SecretScope =
  | "tenant"
  | "environment"
  | "global"
  | "tenant_provider"
  | "datasource";

export interface SecretRef {
  provider?: string;
  scope: SecretScope;
  tenantId?: string;
  environment?: string;
  key: string;
  version?: string;
}

export interface PipelineNode {
  id: string;
  type?: "input" | "output";
  plugin?: PluginRef;
  config?: Record<string, unknown>;
  secrets?: Record<string, SecretRef>;
  ui?: Record<string, unknown>;
}

export interface PipelineEdge {
  from: string;
  to: string;
  fromPort?: string;
  toPort?: string;
}

/** Ordered, user-defined organizational group — purely a Builder
 *  concept. Stages don't change runtime semantics; they cluster nodes
 *  in the Tree View under named sections and render as Flow View group
 *  containers. Persisted on the pipeline spec so the layout survives
 *  reload + reopen across editors. */
export interface PipelineStage {
  id: string;
  label: string;
}

export interface PipelineSpec {
  apiVersion: "rag-platform/v1";
  kind: "Pipeline";
  metadata: {
    name: string;
    description?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    /** Optional, ordered list of user-defined stages. Pipeline nodes
     *  reference a stage by id via `node.ui.stageId`. */
    stages?: PipelineStage[];
  };
  spec: {
    nodes: PipelineNode[];
    edges: PipelineEdge[];
  };
}

export interface ValidationIssue {
  level: "error" | "warning";
  code: string;
  message: string;
  nodeId?: string;
  edge?: { from: string; to: string };
}

export interface PipelineValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  requiredSecrets: string[];
  requiredConfig: string[];
  missingPlugins: PluginRef[];
}

/** Minimal React Flow node/edge shapes the converter understands. */
export interface FlowNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: { label: string; node: PipelineNode };
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface ExecutionRecord {
  executionId: string;
  tenantId: string;
  pipelineId: string;
  pipelineVersionId: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: string;
  completedAt?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
}

export interface ExecutionNodeRecord {
  executionId: string;
  nodeId: string;
  status: "running" | "succeeded" | "failed" | "skipped";
  startedAt: string;
  completedAt?: string;
  latencyMs?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
}
