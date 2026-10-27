/**
 * ADR-0039 end-to-end at the runtime seam: a pipeline with an EXTERNAL node
 * that references a connection. The executor must resolve the connection,
 * materialise a credential via the injected hook, mint a refresh grant, and
 * ship the whole envelope to the sidecar over the real connect-rpc transport —
 * then revoke the run's grants when it finishes. An external node WITHOUT a
 * connection triggers none of it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { create } from "@bufbuild/protobuf";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { ExecuteResponseSchema, PluginRuntime } from "@ragdoll/proto-gen/plugin";
import { DagExecutor, InMemoryExecutionStore } from "../src/index.ts";
import { PluginRegistry } from "../../plugin-sdk/src/index.ts";
import {
  DatabaseEncryptedSecretProvider,
  InMemorySecretRepository,
  StaticKeyProvider
} from "../../secrets/src/index.ts";
import type { PipelineSpec } from "../../core/src/index.ts";

/** Sidecar stub that records the `connection` it received on Execute. */
function startSidecar(): Promise<{
  baseUrl: string;
  seen: () => unknown;
  close: () => Promise<void>;
}> {
  let seen: unknown = "unset";
  const handler = connectNodeAdapter({
    routes: (r) => {
      r.service(PluginRuntime, {
        async health() {
          return { ok: true, plugins: ["crawl_worker"], message: "" };
        },
        async execute(req) {
          seen = req.connection ?? null;
          return create(ExecuteResponseSchema, { outputs: { pages: 3 } });
        },
        async *executeServerStream() { throw new Error("unused"); },
        async executeClientStream() { throw new Error("unused"); },
        async *executeBidi() { throw new Error("unused"); }
      });
    }
  });
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        seen: () => seen,
        close: () => new Promise<void>((done) => server.close(() => done()))
      });
    });
  });
}

function registryWithExternal(baseUrl: string): PluginRegistry {
  const reg = new PluginRegistry();
  const manifest = {
    id: "crawl_worker",
    name: "Crawl Worker",
    version: "1.0.0" as const,
    category: "datasource" as const,
    contract: 2 as const,
    description: "external crawler"
  };
  reg.register({ mode: "external", manifest, external: { baseUrl } });
  return reg;
}

function makeExecutor(
  reg: PluginRegistry,
  extra: Record<string, unknown>
): DagExecutor {
  return new DagExecutor({
    pluginRegistry: reg,
    secretProvider: new DatabaseEncryptedSecretProvider(
      new InMemorySecretRepository(),
      new StaticKeyProvider("k")
    ),
    store: new InMemoryExecutionStore(),
    externalConnectionResolver: {
      async resolve({ slug }) {
        return {
          id: "c1",
          slug,
          kind: "identity_http",
          secret: undefined,
          options: { region: "eu" },
          cascadeReason: "tenant" as const
        };
      }
    },
    ...extra
  });
}

function spec(withConnection: boolean): PipelineSpec {
  const ext: PipelineSpec["spec"]["nodes"][number] = {
    id: "ext",
    plugin: { category: "datasource", id: "crawl_worker", version: "1.0.0" },
    // ADR-0040: the per-run selector lives on the node config, not the
    // connection — so one connection serves many tenants.
    config: { tenantRef: "acme" },
    ...(withConnection ? { connection: { slug: "crm-identity" } } : {})
  };
  return {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "ext-conn" },
    spec: {
      nodes: [{ id: "in", type: "input" }, ext, { id: "out", type: "output" }],
      edges: [{ from: "in", to: "ext" }, { from: "ext", to: "out" }]
    }
  };
}

const ctx = {
  requestId: "r",
  executionId: "exec-9",
  tenantId: "tenant-a",
  pipelineId: "p1",
  pipelineVersionId: "v1",
  environment: "prod",
  resolvedConfig: {
    pipelineId: "p1", pipelineVersionId: "v1", tenantId: "tenant-a",
    environment: "prod", values: {}, violations: []
  }
};

test("external node with a connection: materialise + grant + envelope to sidecar, revoke on finish", async () => {
  const sidecar = await startSidecar();
  try {
    const materializeCalls: Array<{
      slug: string;
      context?: { config: Record<string, unknown>; inputs: Record<string, unknown>; nodeId?: string };
    }> = [];
    const issueCalls: Array<Record<string, unknown>> = [];
    const revoked: string[] = [];
    const executor = makeExecutor(registryWithExternal(sidecar.baseUrl), {
      materializeExternalCredential: async (
        c: { slug: string },
        context?: { config: Record<string, unknown>; inputs: Record<string, unknown>; nodeId?: string }
      ) => {
        materializeCalls.push({ slug: c.slug, context });
        // ADR-0040: resolve the per-run credential from the run context and
        // stash the selector for the refresh callback.
        const tenantRef = context?.config.tenantRef as string | undefined;
        return {
          value: `fresh-token-${tenantRef}`,
          expiresAt: "2030-01-01T00:00:00.000Z",
          refreshContext: { tenantRef }
        };
      },
      issueConnectionRefreshGrant: async (args: Record<string, unknown>) => {
        issueCalls.push(args);
        return { url: "https://api.internal/refresh", token: "grant-xyz", expiresAt: "2030-01-01T00:00:00.000Z" };
      },
      revokeConnectionRefreshGrants: async (executionId: string) => {
        revoked.push(executionId);
      }
    });

    await executor.execute({ spec: spec(true), context: ctx, input: {} });

    // The sidecar received the full envelope — credential resolved from the run
    // context, and crucially WITHOUT the core-only refreshContext.
    assert.deepEqual(sidecar.seen(), {
      slug: "crm-identity",
      kind: "identity_http",
      options: { region: "eu" },
      credential: { value: "fresh-token-acme", expiresAt: "2030-01-01T00:00:00.000Z" },
      refresh: { url: "https://api.internal/refresh", token: "grant-xyz", expiresAt: "2030-01-01T00:00:00.000Z" }
    });
    // The hook was driven with the right identity AND the node's run context.
    assert.equal(materializeCalls.length, 1);
    assert.equal(materializeCalls[0].slug, "crm-identity");
    assert.equal(materializeCalls[0].context?.config.tenantRef, "acme");
    assert.equal(materializeCalls[0].context?.nodeId, "ext");
    // The issuer received the driver's refreshContext to persist on the grant.
    assert.equal(issueCalls.length, 1);
    assert.equal(issueCalls[0].executionId, "exec-9");
    assert.equal(issueCalls[0].nodeId, "ext");
    assert.equal(issueCalls[0].connectionSlug, "crm-identity");
    assert.deepEqual(issueCalls[0].refreshContext, { tenantRef: "acme" });
    // Grants revoked when the run finished.
    assert.deepEqual(revoked, ["exec-9"]);
  } finally {
    await sidecar.close();
  }
});

test("external node WITHOUT a connection: no materialise, no grant, no connection on the wire", async () => {
  const sidecar = await startSidecar();
  try {
    let materialized = false;
    let issued = false;
    const executor = makeExecutor(registryWithExternal(sidecar.baseUrl), {
      materializeExternalCredential: async () => {
        materialized = true;
        return { value: "x" };
      },
      issueConnectionRefreshGrant: async () => {
        issued = true;
        return { url: "u", token: "t" };
      }
    });

    await executor.execute({ spec: spec(false), context: ctx, input: {} });

    assert.equal(sidecar.seen(), null, "no connection field on the wire");
    assert.equal(materialized, false);
    assert.equal(issued, false);
  } finally {
    await sidecar.close();
  }
});
