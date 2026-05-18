import test from "node:test";
import assert from "node:assert/strict";
import {
  activationVersionLabel,
  buildFolderTree,
  buildScopeTree,
  findScopeNode,
  flattenFolders,
  rollupPipelineUsage,
  wouldCycle,
  type ActivationLike,
  type FolderNode,
  type PipelineLike,
  type TenantPipelinesResult
} from "../src/lib/orgtree.ts";

const PIPELINES: PipelineLike[] = [
  { id: "p1", slug: "alpha", name: "Alpha", folderId: "f1" },
  { id: "p2", slug: "beta", name: "Beta", folderId: "f2" },
  { id: "p3", slug: "gamma", name: "Gamma", folderId: null },
  { id: "p4", slug: "delta", name: "Delta", folderId: "ghost" }
];

test("buildFolderTree nests folders and buckets pipelines", () => {
  const folders: FolderNode[] = [
    {
      id: "f1",
      name: "Prod",
      parentId: null,
      children: [{ id: "f2", name: "Inner", parentId: "f1" }]
    }
  ];
  const tree = buildFolderTree(PIPELINES, folders);
  assert.equal(tree.folders.length, 1);
  const prod = tree.folders[0];
  assert.equal(prod.name, "Prod");
  assert.equal(prod.depth, 0);
  assert.deepEqual(
    prod.pipelines.map((p) => p.id),
    ["p1"]
  );
  assert.equal(prod.children.length, 1);
  const inner = prod.children[0];
  assert.equal(inner.name, "Inner");
  assert.equal(inner.depth, 1);
  assert.deepEqual(
    inner.pipelines.map((p) => p.id),
    ["p2"]
  );
  // p3 (no folder) and p4 (unknown folder) fall to uncategorized.
  assert.deepEqual(
    tree.uncategorized.map((p) => p.id).sort(),
    ["p3", "p4"]
  );
});

test("buildFolderTree also accepts a flat folder list", () => {
  const flat: FolderNode[] = [
    { id: "f1", name: "Prod", parentId: null },
    { id: "f2", name: "Inner", parentId: "f1" }
  ];
  const tree = buildFolderTree(PIPELINES, flat);
  assert.equal(tree.folders.length, 1);
  assert.equal(tree.folders[0].children[0].name, "Inner");
});

test("buildFolderTree sorts folders and pipelines by name", () => {
  const tree = buildFolderTree(
    [
      { id: "z", name: "Zeta", folderId: "root" },
      { id: "a", name: "Apex", folderId: "root" }
    ],
    [{ id: "root", name: "Root", parentId: null }]
  );
  assert.deepEqual(
    tree.folders[0].pipelines.map((p) => p.name),
    ["Apex", "Zeta"]
  );
});

test("flattenFolders walks depth-first", () => {
  const tree = buildFolderTree(
    [],
    [
      {
        id: "a",
        name: "A",
        parentId: null,
        children: [{ id: "b", name: "B", parentId: "a" }]
      },
      { id: "c", name: "C", parentId: null }
    ]
  );
  assert.deepEqual(
    flattenFolders(tree).map((f) => f.id),
    ["a", "b", "c"]
  );
});

test("wouldCycle blocks self / descendant reparents, allows others", () => {
  const tree = buildFolderTree(
    [],
    [
      {
        id: "a",
        name: "A",
        parentId: null,
        children: [
          {
            id: "b",
            name: "B",
            parentId: "a",
            children: [{ id: "c", name: "C", parentId: "b" }]
          }
        ]
      },
      { id: "d", name: "D", parentId: null }
    ]
  );
  assert.equal(wouldCycle(tree, "a", "a"), true); // self
  assert.equal(wouldCycle(tree, "a", "c"), true); // into own descendant
  assert.equal(wouldCycle(tree, "a", null), false); // to root
  assert.equal(wouldCycle(tree, "a", "d"), false); // to unrelated
  assert.equal(wouldCycle(tree, "c", "d"), false);
});

test("buildScopeTree builds Global -> Tenant -> Pipeline", () => {
  const root = buildScopeTree(
    [
      { id: "t2", name: "Beta Inc" },
      { id: "t1", name: "Acme" }
    ],
    [{ id: "p1", name: "Support RAG" }]
  );
  assert.equal(root.scope, "global");
  assert.equal(root.scopeId, undefined);
  // tenants sorted by name: Acme then Beta Inc
  assert.deepEqual(
    root.children.map((c) => c.label),
    ["Acme", "Beta Inc"]
  );
  const acme = root.children[0];
  assert.equal(acme.scope, "tenant");
  assert.equal(acme.scopeId, "t1");
  const pipe = acme.children[0];
  assert.equal(pipe.scope, "pipeline");
  assert.equal(pipe.scopeId, "p1");
  assert.equal(pipe.key, "tenant:t1|pipeline:p1");
});

test("findScopeNode locates nodes by key", () => {
  const root = buildScopeTree(
    [{ id: "t1", name: "Acme" }],
    [{ id: "p1", name: "P1" }]
  );
  assert.equal(findScopeNode(root, "global")?.scope, "global");
  assert.equal(findScopeNode(root, "tenant:t1")?.scopeId, "t1");
  assert.equal(
    findScopeNode(root, "tenant:t1|pipeline:p1")?.scope,
    "pipeline"
  );
  assert.equal(findScopeNode(root, "nope"), undefined);
});

test("activationVersionLabel describes pin / track-latest / disabled", () => {
  const base: ActivationLike = {
    id: "a1",
    label: "default",
    environment: "prod",
    trackLatest: false,
    enabled: true
  };
  assert.equal(
    activationVersionLabel({ ...base, enabled: false }),
    "disabled"
  );
  assert.equal(
    activationVersionLabel({ ...base, pipelineVersionId: "v9", effectiveVersionId: "v9" }),
    "pinned v9"
  );
  assert.equal(
    activationVersionLabel(
      { ...base, pipelineVersionId: "v9", effectiveVersionId: "v9" },
      (id) => (id === "v9" ? "1.2.0" : undefined)
    ),
    "pinned 1.2.0"
  );
  assert.equal(
    activationVersionLabel({
      ...base,
      trackLatest: true,
      effectiveVersionId: "vLatest"
    }),
    "latest -> vLatest"
  );
  assert.equal(
    activationVersionLabel({ ...base, trackLatest: true, effectiveVersionId: null }),
    "latest (unresolved)"
  );
  assert.equal(
    activationVersionLabel({ ...base, effectiveVersionId: null }),
    "unresolved"
  );
});

test("rollupPipelineUsage flattens tenant associations for one pipeline", () => {
  const results: TenantPipelinesResult[] = [
    {
      tenantId: "t1",
      pipelines: [
        {
          pipelineId: "p1",
          enabled: true,
          activations: [
            {
              id: "a1",
              label: "default",
              environment: "prod",
              trackLatest: true,
              enabled: true,
              effectiveVersionId: "v3"
            },
            {
              id: "a2",
              label: "canary",
              environment: "prod",
              trackLatest: false,
              pipelineVersionId: "v2",
              enabled: false,
              effectiveVersionId: "v2"
            }
          ]
        },
        { pipelineId: "other", enabled: true, activations: [] }
      ]
    },
    {
      tenantId: "t2",
      pipelines: [{ pipelineId: "p1", enabled: false, activations: [] }]
    }
  ];
  const rows = rollupPipelineUsage(results, "p1");
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    tenantId: "t1",
    pipelineId: "p1",
    associationEnabled: true,
    activationLabel: "default",
    environment: "prod",
    effectiveVersionId: "v3",
    enabled: true
  });
  // t2 has no activations -> a placeholder row
  const placeholder = rows.find((r) => r.tenantId === "t2");
  assert.equal(placeholder?.activationLabel, "(no activations)");
  assert.equal(placeholder?.effectiveVersionId, null);
});
