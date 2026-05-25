/**
 * End-to-end pipeline run using an API key (not the bootstrap admin
 * session). Proves the whole orchestration path:
 *
 *   pipeline create → version publish → deploy → mint API key →
 *   POST /run with the key → worker dispatch → execution succeeds →
 *   trace lists nodes → revoke the key.
 *
 * Uses a minimal `input → output` spec so no provider / vector store is
 * required — the DAG executor passes the input straight through and
 * writes a succeeded execution record. That covers everything the user
 * sees (status, trace shape) without depending on Ollama / Qdrant for
 * this particular test.
 */
import { test, expect } from "../helpers/fixtures.ts";
import { API_URL } from "../helpers/env.ts";

const RUN_SUFFIX = String(Date.now()).slice(-8);
const PIPELINE_SLUG = `pw_integration_e2e_${RUN_SUFFIX}`;
const KEY_NAME = `pw_integration_e2e_key_${RUN_SUFFIX}`;

interface RunResponse {
  executionId: string;
  jobId?: string;
  status: string;
}

interface TraceResponse {
  execution: {
    executionId: string;
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    output?: unknown;
    error?: string;
  };
  nodes: Array<{ nodeId: string; status: string }>;
}

async function pollUntilTerminal(
  apiKey: string,
  tenantId: string,
  executionId: string,
  timeoutMs = 60_000
): Promise<TraceResponse> {
  const deadline = Date.now() + timeoutMs;
  let last: TraceResponse | undefined;
  while (Date.now() < deadline) {
    const res = await fetch(
      `${API_URL}/api/executions/${executionId}/trace`,
      {
        headers: {
          authorization: `ApiKey ${apiKey}`,
          "x-tenant-id": tenantId
        }
      }
    );
    if (!res.ok) {
      // Right after enqueue the row may not exist yet — retry.
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    last = (await res.json()) as TraceResponse;
    const status = last.execution.status;
    if (status === "succeeded" || status === "failed" || status === "cancelled") {
      return last;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `execution ${executionId} never reached a terminal status within ${timeoutMs}ms — last status: ${
      last?.execution.status ?? "unknown"
    }`
  );
}

test.describe("end-to-end pipeline run via API key", () => {
  let pipelineId: string;
  let apiKeyId: string;
  let apiKeyPlaintext: string;

  test.beforeAll(async ({ rest, state }) => {
    // 1) Create the pipeline + minimal spec (input → output, no plugins).
    const pipeline = await rest.request<{ pipeline: { id: string } }>(
      "POST",
      "/api/pipelines",
      { slug: PIPELINE_SLUG, name: "E2E Run Test" }
    );
    pipelineId = pipeline.pipeline.id;
    await rest.request("POST", `/api/pipelines/${pipelineId}/versions`, {
      version: "1.0.0",
      spec: {
        apiVersion: "rag-platform/v1",
        kind: "Pipeline",
        metadata: { name: PIPELINE_SLUG },
        spec: {
          nodes: [
            { id: "in", type: "input" },
            { id: "out", type: "output" }
          ],
          edges: [{ from: "in", to: "out" }]
        }
      },
      publish: true
    });
    // 2) Deploy v1.0.0 to dev for the integration tenant.
    await rest.request("POST", `/api/pipelines/${pipelineId}/deployments`, {
      version: "1.0.0",
      environment: state.environment,
      tenantId: state.tenantId
    });
    // 3) Mint an API key. Platform_admin role is the simplest grant that
    // covers `pipeline:run` + `execution:view_logs` (for the trace poll).
    const key = await rest.request<{
      apiKey: { id: string };
      plaintext: string;
    }>("POST", "/api/api-keys", {
      name: KEY_NAME,
      role: "platform_admin",
      tenantId: state.tenantId
    });
    apiKeyId = key.apiKey.id;
    apiKeyPlaintext = key.plaintext;
    expect(apiKeyPlaintext.startsWith("rgd_")).toBe(true);
  });

  test.afterAll(async ({ rest }) => {
    // Revoke the key. The pipeline + deployment + execution row are
    // either tenant-scoped (cleaned up by tenant cascade) or pipeline-
    // scoped (cleaned up by the slug-prefix sweep in globalTeardown).
    try {
      if (apiKeyId) await rest.request("DELETE", `/api/api-keys/${apiKeyId}`);
    } catch {
      /* ignore */
    }
  });

  test("API key fires a run; execution reaches succeeded; trace lists nodes", async ({
    state
  }) => {
    // POST /run with the API key as Bearer. The API accepts both
    // Bearer-session tokens and `rgd_…` API keys on this Authorization
    // scheme; we use Bearer here.
    const runRes = await fetch(`${API_URL}/api/pipelines/${pipelineId}/run`, {
      method: "POST",
      headers: {
        authorization: `ApiKey ${apiKeyPlaintext}`,
        "content-type": "application/json",
        "x-tenant-id": state.tenantId
      },
      body: JSON.stringify({
        input: { hello: "world", _ts: Date.now() },
        environment: state.environment
      })
    });
    // Read the body once — `Response.text()` invalidates `json()` after
    // it. Parse later if the status is right; otherwise surface raw body.
    const body = await runRes.text();
    expect(runRes.status, body).toBe(202);
    const run = JSON.parse(body) as RunResponse;
    expect(run.executionId).toMatch(/^[0-9a-f-]{36}$/);

    // Poll the trace until terminal. The input → output pipeline should
    // finish in well under a second on a warm worker — give it 30s of
    // headroom anyway in case CI is slow.
    const trace = await pollUntilTerminal(
      apiKeyPlaintext,
      state.tenantId,
      run.executionId,
      30_000
    );
    expect(
      trace.execution.status,
      `execution failed: ${trace.execution.error ?? "(no error)"}`
    ).toBe("succeeded");
    // Both nodes must appear in the trace.
    const nodeIds = new Set(trace.nodes.map((n) => n.nodeId));
    expect(nodeIds.has("in")).toBe(true);
    expect(nodeIds.has("out")).toBe(true);
    // And every node should end terminal-succeeded too.
    for (const n of trace.nodes) {
      expect(
        ["succeeded", "skipped"].includes(n.status),
        `node ${n.nodeId} ended in status ${n.status}`
      ).toBe(true);
    }
  });

  test("revoked API key cannot fire another run", async ({ rest, state }) => {
    // Revoke and confirm a follow-up POST 401s.
    await rest.request("DELETE", `/api/api-keys/${apiKeyId}`);
    apiKeyId = ""; // prevent afterAll double-delete
    const res = await fetch(`${API_URL}/api/pipelines/${pipelineId}/run`, {
      method: "POST",
      headers: {
        authorization: `ApiKey ${apiKeyPlaintext}`,
        "content-type": "application/json",
        "x-tenant-id": state.tenantId
      },
      body: JSON.stringify({
        input: {},
        environment: state.environment
      })
    });
    expect([401, 403]).toContain(res.status);
  });
});
