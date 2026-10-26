/**
 * ADR-0039: the external-plugin transport must carry `input.externalConnection`
 * (the materialised credential + revocable refresh grant) into the proto
 * `connection` field — and carry nothing when the node has no connection. We
 * assert against a REAL connect-rpc server stub so the test exercises the
 * genuine Struct wire encoding, not a mock of it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { create } from "@bufbuild/protobuf";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { ExecuteResponseSchema, PluginRuntime } from "@ragdoll/proto-gen/plugin";
import {
  type ExternalConnectionEnvelope,
  type PluginExecutionInput,
  type RegisteredPlugin
} from "../src/index.ts";
import { executeRegisteredPlugin } from "../src/transport.ts";

/** Start a stub that records the `connection` field of the request it last saw
 *  and echoes it straight back so the test can assert both directions. */
function startConnectionStub(): Promise<{
  baseUrl: string;
  lastConnection: () => unknown;
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
          return create(ExecuteResponseSchema, {
            outputs: { connection: (req.connection ?? null) as never }
          });
        },
        async *executeServerStream() {
          throw new Error("unused");
        },
        async executeClientStream() {
          throw new Error("unused");
        },
        async *executeBidi() {
          throw new Error("unused");
        }
      });
    }
  });
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        lastConnection: () => seen,
        close: () => new Promise<void>((done) => server.close(() => done()))
      });
    });
  });
}

function baseInput(overrides?: Partial<PluginExecutionInput>): PluginExecutionInput {
  return {
    context: {
      requestId: "req-1",
      executionId: "exec-1",
      tenantId: "tenant-a",
      pipelineId: "pipe-1",
      pipelineVersionId: "ver-1",
      environment: "prod",
      resolvedConfig: {
        pipelineId: "pipe-1",
        pipelineVersionId: "ver-1",
        tenantId: "tenant-a",
        environment: "prod",
        values: {},
        violations: []
      }
    },
    node: { id: "n1", plugin: { category: "datasource", id: "crawl_worker", version: "1.0.0" } },
    inputs: {},
    config: {},
    secrets: {},
    ...overrides
  };
}

function externalPlugin(baseUrl: string): RegisteredPlugin {
  return {
    mode: "external",
    manifest: {
      id: "crawl_worker",
      name: "Crawl Worker",
      version: "1.0.0",
      category: "datasource",
      description: "test"
    },
    external: { baseUrl }
  };
}

test("transport serialises externalConnection into the proto connection field", async () => {
  const stub = await startConnectionStub();
  try {
    const envelope: ExternalConnectionEnvelope = {
      slug: "crm-identity",
      kind: "identity_http",
      options: { baseUrl: "https://api.internal", region: "eu" },
      credential: {
        value: "tok-abc123",
        headers: { Authorization: "Bearer tok-abc123" },
        expiresAt: "2030-01-01T00:00:00.000Z"
      },
      refresh: {
        url: "https://api.internal/api/internal/connection-credentials/refresh",
        token: "grant-xyz",
        expiresAt: "2030-01-01T00:00:00.000Z"
      }
    };
    const out = await executeRegisteredPlugin(
      externalPlugin(stub.baseUrl),
      baseInput({ externalConnection: envelope })
    );
    // The sidecar received the full envelope, intact across the Struct wire.
    assert.deepEqual(stub.lastConnection(), envelope);
    assert.deepEqual(out.outputs.connection, envelope);
  } finally {
    await stub.close();
  }
});

test("transport sends no connection field when the node has no externalConnection", async () => {
  const stub = await startConnectionStub();
  try {
    const out = await executeRegisteredPlugin(externalPlugin(stub.baseUrl), baseInput());
    // Unset proto Struct decodes to undefined on the server → our stub records null.
    assert.equal(stub.lastConnection(), null);
    assert.equal(out.outputs.connection, null);
  } finally {
    await stub.close();
  }
});
