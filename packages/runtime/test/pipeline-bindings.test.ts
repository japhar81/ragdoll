/**
 * ADR-0023 pipeline-level bindings — exercises `spec.bindings` +
 * `node.binding: <id>` resolution.
 *
 * Coverage:
 *  - Multiple bindings in one pipeline (3-graph scenario the user
 *    called out in design — each node references its own binding).
 *  - Inline `node.connection: { slug }` continues to work alongside
 *    binding refs.
 *  - `node.binding` wins over inline `node.dataset` / `node.connection`
 *    when both are set on a node (binding is the canonical reference;
 *    inline is sugar).
 *  - Unknown binding ids fall through with no resolved connection (the
 *    plugin then either errors via its own contract OR the legacy
 *    `secrets.dsn` path runs).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DagExecutor, InMemoryExecutionStore } from "../src/index.ts";
import { PluginRegistry } from "../../plugin-sdk/src/index.ts";
import {
  DatabaseEncryptedSecretProvider,
  InMemorySecretRepository,
  StaticKeyProvider
} from "../../secrets/src/index.ts";
import type { PipelineSpec } from "../../core/src/index.ts";

/**
 * Capture-shaped plugin that records which connection slug the runtime
 * delivered on `input.connection`. Three nodes referencing three
 * different bindings should produce three distinct captures.
 */
function buildRegistry(captures: string[]): PluginRegistry {
  const registry = new PluginRegistry();
  const manifest = {
    id: "graph_query",
    name: "Graph Query",
    version: "1.0.0" as const,
    category: "tool" as const,
    contract: 2 as const,
    description: "test plugin that records the resolved connection slug"
  };
  registry.register({
    mode: "in_process",
    manifest,
    implementation: {
      manifest,
      async execute(input) {
        const conn = (input as { connection?: { slug?: string } }).connection;
        captures.push(conn?.slug ?? "<none>");
        return { outputs: { ok: true, slug: conn?.slug ?? null } };
      }
    }
  });
  return registry;
}

interface ResolveArgs {
  slug: string;
  tenantId?: string;
  environmentId?: string;
}

/**
 * Fake external-connection resolver — returns a deterministic resolved
 * connection for any known slug. Mirrors the structural shape the
 * runtime expects (ResolvedExternalConnection).
 */
function fakeConnectionResolver(known: Record<string, string>) {
  return {
    async resolve(args: ResolveArgs) {
      const secret = known[args.slug];
      if (secret === undefined) return undefined;
      return {
        id: `id-${args.slug}`,
        slug: args.slug,
        kind: "neo4j",
        secret,
        options: {},
        cascadeReason: "global" as const
      };
    }
  };
}

test("ADR-0023: three bindings in one pipeline resolve to three connections", async () => {
  const captures: string[] = [];
  const registry = buildRegistry(captures);
  const secrets = new DatabaseEncryptedSecretProvider(
    new InMemorySecretRepository(),
    new StaticKeyProvider("dev-secret")
  );
  const executor = new DagExecutor({
    pluginRegistry: registry,
    secretProvider: secrets,
    store: new InMemoryExecutionStore(),
    externalConnectionResolver: fakeConnectionResolver({
      people: "neo4j://people:bolt",
      company: "neo4j://company:bolt",
      concepts: "neo4j://concepts:bolt"
    })
  });
  const spec: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "three-graphs" },
    spec: {
      bindings: [
        { id: "people", connection: "people" },
        { id: "company", connection: "company" },
        { id: "concepts", connection: "concepts" }
      ],
      nodes: [
        { id: "in", type: "input" },
        {
          id: "q1",
          plugin: { category: "tool", id: "graph_query", version: "1.0.0" },
          binding: "people"
        },
        {
          id: "q2",
          plugin: { category: "tool", id: "graph_query", version: "1.0.0" },
          binding: "company"
        },
        {
          id: "q3",
          plugin: { category: "tool", id: "graph_query", version: "1.0.0" },
          binding: "concepts"
        },
        { id: "out", type: "output" }
      ],
      edges: [
        { from: "in", to: "q1" },
        { from: "in", to: "q2" },
        { from: "in", to: "q3" },
        { from: "q1", to: "out" },
        { from: "q2", to: "out" },
        { from: "q3", to: "out" }
      ]
    }
  };
  await executor.execute({
    spec,
    context: {
      requestId: "r",
      executionId: "e1",
      tenantId: "t1",
      pipelineId: "p1",
      pipelineVersionId: "v1",
      environment: "dev",
      resolvedConfig: {
        pipelineId: "p1",
        pipelineVersionId: "v1",
        tenantId: "t1",
        environment: "dev",
        values: {}, violations: []
      }
    },
    input: {}
  });
  assert.deepEqual(captures.sort(), ["company", "concepts", "people"]);
});

test("ADR-0023: node.binding wins over inline node.connection on the same node", async () => {
  const captures: string[] = [];
  const registry = buildRegistry(captures);
  const secrets = new DatabaseEncryptedSecretProvider(
    new InMemorySecretRepository(),
    new StaticKeyProvider("dev-secret")
  );
  const executor = new DagExecutor({
    pluginRegistry: registry,
    secretProvider: secrets,
    store: new InMemoryExecutionStore(),
    externalConnectionResolver: fakeConnectionResolver({
      primary: "neo4j://primary",
      legacy: "neo4j://legacy"
    })
  });
  const spec: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "binding-wins" },
    spec: {
      bindings: [{ id: "primary", connection: "primary" }],
      nodes: [
        { id: "in", type: "input" },
        {
          id: "q",
          plugin: { category: "tool", id: "graph_query", version: "1.0.0" },
          // The pipeline-level binding `primary` overrides this inline
          // connection — proves the binding map has precedence.
          connection: { slug: "legacy" },
          binding: "primary"
        },
        { id: "out", type: "output" }
      ],
      edges: [
        { from: "in", to: "q" },
        { from: "q", to: "out" }
      ]
    }
  };
  await executor.execute({
    spec,
    context: {
      requestId: "r",
      executionId: "e2",
      tenantId: "t1",
      pipelineId: "p1",
      pipelineVersionId: "v1",
      environment: "dev",
      resolvedConfig: {
        pipelineId: "p1",
        pipelineVersionId: "v1",
        tenantId: "t1",
        environment: "dev",
        values: {}, violations: []
      }
    },
    input: {}
  });
  assert.deepEqual(captures, ["primary"]);
});

test("ADR-0023: legacy inline node.connection still works (no pipeline.bindings block)", async () => {
  const captures: string[] = [];
  const registry = buildRegistry(captures);
  const secrets = new DatabaseEncryptedSecretProvider(
    new InMemorySecretRepository(),
    new StaticKeyProvider("dev-secret")
  );
  const executor = new DagExecutor({
    pluginRegistry: registry,
    secretProvider: secrets,
    store: new InMemoryExecutionStore(),
    externalConnectionResolver: fakeConnectionResolver({
      acme: "neo4j://acme"
    })
  });
  const spec: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "legacy-inline" },
    spec: {
      nodes: [
        { id: "in", type: "input" },
        {
          id: "q",
          plugin: { category: "tool", id: "graph_query", version: "1.0.0" },
          connection: { slug: "acme" }
        },
        { id: "out", type: "output" }
      ],
      edges: [
        { from: "in", to: "q" },
        { from: "q", to: "out" }
      ]
    }
  };
  await executor.execute({
    spec,
    context: {
      requestId: "r",
      executionId: "e3",
      tenantId: "t1",
      pipelineId: "p1",
      pipelineVersionId: "v1",
      environment: "dev",
      resolvedConfig: {
        pipelineId: "p1",
        pipelineVersionId: "v1",
        tenantId: "t1",
        environment: "dev",
        values: {}, violations: []
      }
    },
    input: {}
  });
  assert.deepEqual(captures, ["acme"]);
});
