import test from "node:test";
import assert from "node:assert/strict";
import {
  PLUGIN_CATEGORIES,
  VIEWPORT_ANNOTATION,
  applyResolved,
  decodeViewport,
  defaultPluginRef,
  encodeViewport,
  extractConfigRefs,
  extractDeclaredSecrets,
  extractSecretRefs,
  graphToSpec,
  newIoNode,
  newNodeForCategory,
  specToGraph,
  withViewportAnnotation
} from "../src/lib/spec.ts";
import type { FlowEdge, FlowNode, PipelineSpec } from "../src/lib/types.ts";

const SAMPLE: PipelineSpec = {
  apiVersion: "rag-platform/v1",
  kind: "Pipeline",
  metadata: { name: "support-rag", labels: { domain: "support" } },
  spec: {
    nodes: [
      { id: "input", type: "input", ui: { position: { x: 10, y: 20 } } },
      {
        id: "retrieve",
        plugin: { category: "retriever", id: "qdrant_retriever", version: "1.0.0" },
        config: { top_k: "${config.retrieval.top_k}" },
        ui: { position: { x: 250, y: 20 } }
      },
      {
        id: "llm",
        plugin: { category: "llm", id: "provider_chat", version: "1.0.0" },
        config: { provider: "${config.llm.provider}", model: "${config.llm.model}" },
        secrets: { apiKey: { scope: "tenant", key: "llm.api_key" } },
        ui: { position: { x: 500, y: 20 } }
      },
      { id: "output", type: "output" }
    ],
    edges: [
      { from: "input", to: "retrieve" },
      { from: "retrieve", to: "llm" },
      { from: "llm", to: "output" }
    ]
  }
};

test("specToGraph maps nodes, io types, positions and edges", () => {
  const { nodes, edges } = specToGraph(SAMPLE);
  assert.equal(nodes.length, 4);
  assert.equal(edges.length, 3);

  const input = nodes.find((n) => n.id === "input");
  assert.equal(input?.type, "input");
  assert.deepEqual(input?.position, { x: 10, y: 20 });

  const retrieve = nodes.find((n) => n.id === "retrieve");
  assert.equal(retrieve?.type, undefined);
  assert.equal(retrieve?.data.label, "retriever: qdrant_retriever");

  const e0 = edges[0];
  assert.equal(e0.source, "input");
  assert.equal(e0.target, "retrieve");
});

test("specToGraph lays out nodes left-to-right when ui.position absent", () => {
  const noUi: PipelineSpec = {
    ...SAMPLE,
    spec: {
      nodes: [
        { id: "a", type: "input" },
        { id: "b", type: "output" }
      ],
      edges: []
    }
  };
  const { nodes } = specToGraph(noUi);
  assert.notDeepEqual(nodes[0].position, nodes[1].position);
});

test("graphToSpec is a faithful inverse of specToGraph (round-trip)", () => {
  const graph = specToGraph(SAMPLE);
  const spec = graphToSpec(graph.nodes, graph.edges, {
    name: "support-rag",
    labels: { domain: "support" },
    annotations: { "ragdoll.ui/viewport": '{"x":1,"y":2,"zoom":3}' }
  });
  assert.equal(spec.apiVersion, "rag-platform/v1");
  assert.equal(spec.kind, "Pipeline");
  assert.equal(spec.metadata.name, "support-rag");
  assert.deepEqual(spec.metadata.labels, { domain: "support" });
  // graphToSpec PRESERVES (does not drop) metadata.annotations.
  assert.deepEqual(spec.metadata.annotations, {
    "ragdoll.ui/viewport": '{"x":1,"y":2,"zoom":3}'
  });
  assert.equal(spec.spec.nodes.length, 4);
  assert.equal(spec.spec.edges.length, 3);

  const llm = spec.spec.nodes.find((n) => n.id === "llm");
  assert.deepEqual(llm?.plugin, {
    category: "llm",
    id: "provider_chat",
    version: "1.0.0"
  });
  assert.deepEqual(llm?.secrets, { apiKey: { scope: "tenant", key: "llm.api_key" } });
  // Layout is persisted under ui.position so re-import preserves it.
  const input = spec.spec.nodes.find((n) => n.id === "input");
  assert.deepEqual((input?.ui as { position: unknown }).position, { x: 10, y: 20 });
});

test("graphToSpec omits labels/annotations keys entirely when not passed", () => {
  const graph = specToGraph(SAMPLE);
  const spec = graphToSpec(graph.nodes, graph.edges, { name: "support-rag" });
  assert.equal(spec.metadata.name, "support-rag");
  assert.equal("labels" in spec.metadata, false);
  assert.equal("annotations" in spec.metadata, false);
});

test("graphToSpec preserves labels AND annotations together (no drop)", () => {
  const graph = specToGraph(SAMPLE);
  const labels = { domain: "support", team: "core" };
  const annotations = { "x.io/owner": "me", [VIEWPORT_ANNOTATION]: "{}" };
  const spec = graphToSpec(graph.nodes, graph.edges, {
    name: "p",
    labels,
    annotations
  });
  assert.deepEqual(spec.metadata.labels, labels);
  assert.deepEqual(spec.metadata.annotations, annotations);
});

test("node.ui.position round-trips through specToGraph -> graphToSpec unchanged", () => {
  const graph = specToGraph(SAMPLE);
  const spec = graphToSpec(graph.nodes, graph.edges, { name: "support-rag" });
  for (const original of SAMPLE.spec.nodes) {
    const back = spec.spec.nodes.find((n) => n.id === original.id);
    const origPos = (original.ui as { position?: unknown } | undefined)?.position;
    const backPos = (back?.ui as { position?: unknown } | undefined)?.position;
    if (origPos) {
      // Positions that existed in the source survive the round-trip exactly.
      assert.deepEqual(backPos, origPos);
    } else {
      // No source position -> specToGraph synthesized a layout coordinate
      // which graphToSpec then persists (so re-import is stable).
      assert.equal(typeof (backPos as { x: number }).x, "number");
      assert.equal(typeof (backPos as { y: number }).y, "number");
    }
  }
});

test("encodeViewport / decodeViewport round-trip", () => {
  const vp = { x: 12.5, y: -340, zoom: 1.75 };
  const encoded = encodeViewport(vp);
  assert.equal(typeof encoded, "string");
  const spec = withViewportAnnotation(SAMPLE, vp);
  assert.deepEqual(decodeViewport(spec), vp);
  // encodeViewport only keeps x/y/zoom (no extra keys leak through).
  assert.deepEqual(JSON.parse(encodeViewport({ ...vp, junk: 1 } as never)), vp);
});

test("decodeViewport tolerates missing / garbage annotations -> undefined", () => {
  // No annotations at all.
  assert.equal(decodeViewport(SAMPLE), undefined);
  // Annotation present but not valid JSON.
  const garbage: PipelineSpec = {
    ...SAMPLE,
    metadata: {
      ...SAMPLE.metadata,
      annotations: { [VIEWPORT_ANNOTATION]: "not json {{{" }
    }
  };
  assert.equal(decodeViewport(garbage), undefined);
  // Valid JSON but wrong shape (missing numeric fields).
  const wrongShape: PipelineSpec = {
    ...SAMPLE,
    metadata: {
      ...SAMPLE.metadata,
      annotations: { [VIEWPORT_ANNOTATION]: '{"x":"a","y":1}' }
    }
  };
  assert.equal(decodeViewport(wrongShape), undefined);
  // Non-finite numbers are rejected too.
  const nonFinite: PipelineSpec = {
    ...SAMPLE,
    metadata: {
      ...SAMPLE.metadata,
      annotations: { [VIEWPORT_ANNOTATION]: '{"x":1,"y":2,"zoom":null}' }
    }
  };
  assert.equal(decodeViewport(nonFinite), undefined);
});

test("withViewportAnnotation is immutable and a no-op when vp undefined", () => {
  const before = JSON.stringify(SAMPLE);
  const noop = withViewportAnnotation(SAMPLE, undefined);
  // Same reference back, source untouched.
  assert.equal(noop, SAMPLE);
  assert.equal(JSON.stringify(SAMPLE), before);

  const vp = { x: 5, y: 6, zoom: 2 };
  const next = withViewportAnnotation(SAMPLE, vp);
  assert.notEqual(next, SAMPLE);
  assert.notEqual(next.metadata, SAMPLE.metadata);
  // Source spec still has no annotations (no mutation).
  assert.equal(SAMPLE.metadata.annotations, undefined);
  assert.equal(JSON.stringify(SAMPLE), before);
  assert.equal(next.metadata.annotations?.[VIEWPORT_ANNOTATION], encodeViewport(vp));
  // Existing annotations are merged, not clobbered.
  const withExisting: PipelineSpec = {
    ...SAMPLE,
    metadata: { ...SAMPLE.metadata, annotations: { keep: "yes" } }
  };
  const merged = withViewportAnnotation(withExisting, vp);
  assert.equal(merged.metadata.annotations?.keep, "yes");
  assert.equal(
    merged.metadata.annotations?.[VIEWPORT_ANNOTATION],
    encodeViewport(vp)
  );
  assert.equal(withExisting.metadata.annotations?.[VIEWPORT_ANNOTATION], undefined);
});

test("graphToSpec preserves edge ports when present", () => {
  const nodes: FlowNode[] = [
    { id: "a", position: { x: 0, y: 0 }, data: { label: "a", node: { id: "a" } } },
    { id: "b", position: { x: 1, y: 0 }, data: { label: "b", node: { id: "b" } } }
  ];
  const edges: FlowEdge[] = [
    { id: "a->b", source: "a", target: "b", sourceHandle: "out1", targetHandle: "in1" }
  ];
  const spec = graphToSpec(nodes, edges, { name: "p" });
  assert.deepEqual(spec.spec.edges[0], {
    from: "a",
    to: "b",
    fromPort: "out1",
    toPort: "in1"
  });
});

test("extractConfigRefs and extractSecretRefs collect templated refs (sorted, deduped)", () => {
  assert.deepEqual(extractConfigRefs(SAMPLE), [
    "llm.model",
    "llm.provider",
    "retrieval.top_k"
  ]);
  // SAMPLE uses structured node.secrets, not ${secret.*} templates.
  assert.deepEqual(extractSecretRefs(SAMPLE), []);

  const withSecretTemplate: PipelineSpec = {
    ...SAMPLE,
    spec: {
      nodes: [
        {
          id: "x",
          plugin: { category: "tool", id: "t", version: "1.0.0" },
          config: { token: "${secret.api.token}", dup: "${config.a}", a2: "${config.a}" }
        }
      ],
      edges: []
    }
  };
  assert.deepEqual(extractSecretRefs(withSecretTemplate), ["api.token"]);
  assert.deepEqual(extractConfigRefs(withSecretTemplate), ["a"]);
});

test("extractDeclaredSecrets returns structured node.secrets entries", () => {
  assert.deepEqual(extractDeclaredSecrets(SAMPLE), [
    { nodeId: "llm", name: "apiKey", key: "llm.api_key", scope: "tenant" }
  ]);
});

test("applyResolved substitutes ${config.*} placeholders and preserves types", () => {
  const resolved = applyResolved(SAMPLE, {
    "retrieval.top_k": 5,
    "llm.provider": "openai",
    "llm.model": "gpt-4o-mini"
  });
  const retrieve = resolved.spec.nodes.find((n) => n.id === "retrieve");
  // A lone placeholder resolves to the typed value (number, not string).
  assert.equal(retrieve?.config?.top_k, 5);
  const llm = resolved.spec.nodes.find((n) => n.id === "llm");
  assert.equal(llm?.config?.provider, "openai");
  assert.equal(llm?.config?.model, "gpt-4o-mini");
  // Unknown refs are left untouched.
  const partial = applyResolved(SAMPLE, {});
  const r2 = partial.spec.nodes.find((n) => n.id === "retrieve");
  assert.equal(r2?.config?.top_k, "${config.retrieval.top_k}");
});

test("newNodeForCategory / newIoNode / defaultPluginRef produce valid nodes", () => {
  const node = newNodeForCategory("retriever", "r1");
  assert.equal(node.id, "r1");
  assert.deepEqual(node.plugin, {
    category: "retriever",
    id: "qdrant_retriever",
    version: "1.0.0"
  });
  const io = newIoNode("input", "in");
  assert.equal(io.type, "input");
  assert.equal(io.plugin, undefined);

  // Every category yields a ref whose category matches the request.
  for (const cat of PLUGIN_CATEGORIES) {
    const ref = defaultPluginRef(cat);
    assert.equal(ref.category, cat);
    assert.ok(ref.id.length > 0);
    assert.ok(ref.version.length > 0);
  }
});

test("graph round-trip is stable across two passes", () => {
  const g1 = specToGraph(SAMPLE);
  const s1 = graphToSpec(g1.nodes, g1.edges, { name: "support-rag" });
  const g2 = specToGraph(s1);
  const s2 = graphToSpec(g2.nodes, g2.edges, { name: "support-rag" });
  assert.deepEqual(s2.spec.edges, s1.spec.edges);
  assert.deepEqual(
    s2.spec.nodes.map((n) => n.id),
    s1.spec.nodes.map((n) => n.id)
  );
});
