/**
 * Pipeline execution endpoints (the "actually start a run" routes):
 *
 * - POST /api/pipelines/:id/run     — async queue-backed
 * - POST /api/pipelines/:id/invoke  — synchronous, returns terminal output
 * - POST /api/pipelines/:id/stream  — chunked SSE with per-token frames
 * - POST /api/pipelines/:id/ingest  — async ingest_datasource job
 *
 * Plus the webhook trigger lifecycle:
 * - POST /api/pipelines/:id/triggers, GET listForPipeline
 * - DELETE /api/triggers/:id
 * - POST /api/triggers/webhook/:token (public — token IS the auth)
 *
 * All five share `enqueuePipelineRun` / `runSyncPipeline` which live
 * in ../pipeline-execution.ts as standalone functions taking deps as
 * args.
 */
import { randomUUID } from "node:crypto";
import {
  enforce,
  WebhookTokenService,
  InvalidWebhookTokenError
} from "../../../../../packages/auth/src/index.ts";
import {
  redactValue,
  type PipelineSpec
} from "../../../../../packages/core/src/index.ts";
import { validatePipelineSpec } from "../../../../../packages/pipeline-spec/src/index.ts";
import type {
  WebhookTriggerRow,
  WebhookTriggerRepository
} from "../../../../../packages/db/src/index.ts";
import type {
  QueueJob
} from "../../../../worker/src/index.ts";
import type { DatasetResolver } from "../../../../../packages/plugin-sdk/src/index.ts";
import {
  ok,
  error,
  isObject,
  nowIso,
  headerValue
} from "../http-utils.ts";
import { resolveDeployedVersion } from "../spec-helpers.ts";
import {
  resolvePipelineRef,
  isAppResponse
} from "../pipeline-resolution.ts";
import { requestOrigin } from "../projections.ts";
import {
  enqueuePipelineRun,
  runSyncPipeline
} from "../pipeline-execution.ts";
import type { AppDeps } from "../types.ts";
import type {
  RouteContext,
  RouteRegistry,
  AuditWriter
} from "./types.ts";
import type { PipelineActivationRepository } from "../../../../../packages/db/src/index.ts";

interface PipelineRunsServices {
  deps: AppDeps;
  audit: AuditWriter;
  pipelineActivations: PipelineActivationRepository;
  webhookTriggers: WebhookTriggerRepository;
  apiDatasetResolver: DatasetResolver | undefined;
  tenantScope: (ctx: RouteContext) => string | undefined;
}

export function registerPipelineRunsRoutes(
  api: RouteRegistry,
  svc: PipelineRunsServices
): void {
  const {
    deps,
    audit,
    pipelineActivations,
    webhookTriggers,
    apiDatasetResolver,
    tenantScope
  } = svc;

  api.route("POST", "/api/pipelines/:id/run", async (ctx) => {
    const pipeline = await resolvePipelineRef(deps.pipelines, ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    enforce(ctx.principal, "pipeline:run", {
      tenantId: ctx.principal.tenantId,
      pipelineId: pipeline.id
    });
    const body = isObject(ctx.request.body) ? ctx.request.body : {};
    const tenantId = tenantScope(ctx);
    if (!tenantId) {
      return error(422, "validation_failed", {
        issues: [{ message: "tenant context required (x-tenant-id or principal tenant)" }]
      });
    }
    const environment =
      (typeof body.environment === "string" && body.environment) ||
      ctx.request.query.environment ||
      "dev";
    const activationLabel =
      typeof body.activation === "string" ? body.activation : undefined;

    const outcome = await enqueuePipelineRun({
      deps,
      pipelineActivations,
      tenantId,
      pipeline,
      environment,
      activationLabel,
      input: body.input
    });
    if (!outcome.ok) return outcome.response;
    await audit(ctx, "pipeline.run", "execution", outcome.executionId, undefined, {
      pipelineId: pipeline.id,
      version: outcome.version,
      resolvedVia: outcome.resolvedVia,
      activationLabel: outcome.activationLabel ?? null,
      input: redactValue(body.input)
    });
    return ok(
      {
        executionId: outcome.executionId,
        jobId: outcome.jobId,
        pipelineId: pipeline.id,
        pipelineVersionId: outcome.versionId,
        version: outcome.version,
        resolvedVia: outcome.resolvedVia,
        ...(outcome.activationLabel !== undefined
          ? { activationLabel: outcome.activationLabel }
          : {}),
        status: "accepted"
      },
      202
    );
  });

  // ---- webhook triggers ---------------------------------------------------
  api.route("POST", "/api/pipelines/:id/triggers", async (ctx) => {
    const pipeline = await resolvePipelineRef(deps.pipelines, ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const tenantId = tenantScope(ctx);
    if (!tenantId) {
      return error(422, "validation_failed", {
        issues: [{ message: "tenant context required" }]
      });
    }
    enforce(ctx.principal, "pipeline:run", {
      tenantId,
      pipelineId: pipeline.id
    });
    const body = isObject(ctx.request.body) ? ctx.request.body : {};
    if (typeof body.environment !== "string" || typeof body.name !== "string") {
      return error(422, "validation_failed", {
        issues: [{ message: "environment and name are required" }]
      });
    }
    const id = randomUUID();
    const issued = WebhookTokenService.issue(id);
    const row: WebhookTriggerRow = {
      id,
      tenantId,
      pipelineId: pipeline.id,
      environment: body.environment,
      activationLabel:
        typeof body.activationLabel === "string" ? body.activationLabel : null,
      name: body.name,
      prefix: issued.prefix,
      hash: issued.hash,
      enabled: body.enabled !== false,
      createdBy: ctx.principal.id,
      createdAt: nowIso()
    };
    const created = await webhookTriggers.create(row);
    await audit(
      ctx,
      "webhook_trigger.create",
      "webhook_trigger",
      created.id,
      undefined,
      { name: created.name, environment: created.environment, prefix: created.prefix }
    );
    return ok(
      {
        trigger: {
          id: created.id,
          name: created.name,
          environment: created.environment,
          activationLabel: created.activationLabel,
          prefix: created.prefix,
          enabled: created.enabled,
          createdAt: created.createdAt
        },
        // The plaintext is returned ONCE; the server only persists the hash.
        token: issued.plaintext,
        url: `${requestOrigin(ctx.request)}/api/triggers/webhook/${issued.plaintext}`
      },
      201
    );
  });

  api.route("GET", "/api/pipelines/:id/triggers", async (ctx) => {
    const pipeline = await resolvePipelineRef(deps.pipelines, ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const tenantId = tenantScope(ctx);
    if (!tenantId) {
      return error(422, "validation_failed", {
        issues: [{ message: "tenant context required" }]
      });
    }
    enforce(ctx.principal, "pipeline:run", {
      tenantId,
      pipelineId: pipeline.id
    });
    const rows = await webhookTriggers.listForPipeline(tenantId, pipeline.id);
    return ok({
      triggers: rows.map((r) => ({
        id: r.id,
        name: r.name,
        environment: r.environment,
        activationLabel: r.activationLabel,
        prefix: r.prefix,
        enabled: r.enabled,
        createdAt: r.createdAt,
        lastTriggeredAt: r.lastTriggeredAt ?? null
      }))
    });
  });

  api.route("DELETE", "/api/triggers/:id", async (ctx) => {
    const row = await webhookTriggers.get(ctx.params.id);
    if (!row) return error(404, "not_found");
    enforce(ctx.principal, "pipeline:run", {
      tenantId: row.tenantId,
      pipelineId: row.pipelineId
    });
    await webhookTriggers.delete(row.id);
    await audit(
      ctx,
      "webhook_trigger.delete",
      "webhook_trigger",
      row.id,
      { name: row.name, environment: row.environment },
      undefined
    );
    return { status: 204, body: undefined, headers: {} };
  });

  /**
   * Public webhook trigger. The path token is the bearer; no other
   * auth runs. Body is forwarded verbatim as the run's `input`.
   */
  api.route("POST", "/api/triggers/webhook/:token", async (ctx) => {
    let record;
    try {
      record = await WebhookTokenService.verify(ctx.params.token, {
        findByPrefix: async (prefix) => {
          const row = await webhookTriggers.findByPrefix(prefix);
          if (!row) return undefined;
          return {
            id: row.id,
            prefix: row.prefix,
            hash: row.hash,
            enabled: row.enabled,
            revokedAt: row.revokedAt
          };
        }
      });
    } catch (e) {
      if (e instanceof InvalidWebhookTokenError) {
        return error(401, "invalid_webhook_token", { message: e.message });
      }
      throw e;
    }
    const trigger = await webhookTriggers.get(record.id);
    if (!trigger) return error(404, "not_found");
    const pipeline = await deps.pipelines.get(trigger.pipelineId);
    if (!pipeline) {
      return error(404, "not_found", { message: "pipeline no longer exists" });
    }
    const outcome = await enqueuePipelineRun({
      deps,
      pipelineActivations,
      tenantId: trigger.tenantId,
      pipeline,
      environment: trigger.environment,
      activationLabel: trigger.activationLabel ?? undefined,
      input: ctx.request.body
    });
    if (!outcome.ok) return outcome.response;
    await webhookTriggers.touch(trigger.id);
    await deps.auditLogs.append({
      actorId: null,
      tenantId: trigger.tenantId,
      pipelineId: trigger.pipelineId,
      action: "pipeline.run",
      targetType: "execution",
      targetId: outcome.executionId,
      beforeRedacted: undefined,
      afterRedacted: {
        source: "webhook",
        triggerId: trigger.id,
        version: outcome.version,
        resolvedVia: outcome.resolvedVia,
        input: redactValue(ctx.request.body)
      },
      requestId: headerValue(ctx.request.headers, "x-request-id") ?? null,
      sourceIp: headerValue(ctx.request.headers, "x-forwarded-for") ?? null,
      userAgent: headerValue(ctx.request.headers, "user-agent") ?? null,
      createdAt: nowIso()
    });
    return ok(
      {
        executionId: outcome.executionId,
        pipelineId: pipeline.id,
        version: outcome.version,
        resolvedVia: outcome.resolvedVia,
        ...(outcome.activationLabel !== undefined
          ? { activationLabel: outcome.activationLabel }
          : {}),
        status: "accepted"
      },
      202
    );
  });

  // ---- ingest -------------------------------------------------------------
  api.route("POST", "/api/pipelines/:id/ingest", async (ctx) => {
    const pipeline = await resolvePipelineRef(deps.pipelines, ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const pipelineId = pipeline.id;
    enforce(ctx.principal, "pipeline:run", {
      tenantId: ctx.principal.tenantId,
      pipelineId
    });
    const body = isObject(ctx.request.body) ? ctx.request.body : {};
    const tenantId = tenantScope(ctx);
    if (!tenantId) {
      return error(422, "validation_failed", {
        issues: [{ message: "tenant context required" }]
      });
    }
    const environment =
      (typeof body.environment === "string" && body.environment) ||
      ctx.request.query.environment ||
      "dev";
    const resolved = await resolveDeployedVersion(deps, pipelineId, environment, tenantId);
    if (!resolved) {
      return error(409, "no_active_deployment", {
        message: `no active deployment for pipeline ${pipelineId} in ${environment}`
      });
    }
    const jobId = randomUUID();
    const job: QueueJob<{
      tenantId: string;
      pipelineId: string;
      pipelineVersionId: string;
      environment: string;
      datasource: unknown;
    }> = {
      id: jobId,
      type: "ingest_datasource",
      payload: {
        tenantId,
        pipelineId,
        pipelineVersionId: resolved.id,
        environment,
        datasource: body.datasource ?? body.input
      }
    };
    await deps.queue.enqueue(job);
    await audit(ctx, "pipeline.ingest", "ingestion", jobId, undefined, {
      pipelineId,
      datasource: redactValue(body.datasource ?? body.input)
    });
    return ok(
      { jobId, pipelineId, pipelineVersionId: resolved.id, status: "accepted" },
      202
    );
  });

  // ---- synchronous /invoke ------------------------------------------------
  api.route("POST", "/api/pipelines/:id/invoke", async (ctx) => {
    const pipeline = await resolvePipelineRef(deps.pipelines, ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    enforce(ctx.principal, "pipeline:run", {
      tenantId: ctx.principal.tenantId,
      pipelineId: pipeline.id
    });
    const tenantId = tenantScope(ctx);
    if (!tenantId) {
      return error(422, "validation_failed", {
        issues: [{ message: "tenant context required" }]
      });
    }
    const body = isObject(ctx.request.body) ? ctx.request.body : {};
    const environment =
      (typeof body.environment === "string" && body.environment) ||
      ctx.request.query.environment ||
      "dev";
    const resolved = await resolveDeployedVersion(deps, pipeline.id, environment, tenantId);
    if (!resolved) {
      return error(409, "no_active_deployment", {
        message: `no active deployment for pipeline ${pipeline.id} in ${environment}`
      });
    }
    const validation = validatePipelineSpec(
      resolved.spec as PipelineSpec,
      deps.pluginRegistry
    );
    if (!validation.valid) {
      return error(422, "validation_failed", { issues: validation.errors });
    }
    try {
      const { executionId, output } = await runSyncPipeline({
        deps,
        apiDatasetResolver,
        tenantId,
        pipeline,
        versionRow: resolved,
        environment,
        input: body.input,
        actorId: ctx.principal.id,
        requestId: headerValue(ctx.request.headers, "x-request-id") ?? undefined,
        deadlineMs:
          typeof body.deadlineMs === "number" ? body.deadlineMs : undefined
      });
      await audit(ctx, "pipeline.invoke", "execution", executionId, undefined, {
        pipelineId: pipeline.id,
        version: resolved.version,
        kind: "synchronous",
        input: redactValue(body.input)
      });
      return ok({
        executionId,
        pipelineId: pipeline.id,
        pipelineVersionId: resolved.id,
        version: resolved.version,
        status: "succeeded",
        output
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return error(500, "execution_failed", { message });
    }
  });

  // ---- stream (SSE) -------------------------------------------------------
  api.route("POST", "/api/pipelines/:id/stream", async (ctx) => {
    const pipeline = await resolvePipelineRef(deps.pipelines, ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    enforce(ctx.principal, "pipeline:run", {
      tenantId: ctx.principal.tenantId,
      pipelineId: pipeline.id
    });
    const tenantId = tenantScope(ctx);
    if (!tenantId) {
      return error(422, "validation_failed", {
        issues: [{ message: "tenant context required" }]
      });
    }
    const body = isObject(ctx.request.body) ? ctx.request.body : {};
    const environment =
      (typeof body.environment === "string" && body.environment) ||
      ctx.request.query.environment ||
      "dev";
    const resolved = await resolveDeployedVersion(deps, pipeline.id, environment, tenantId);
    if (!resolved) {
      return error(409, "no_active_deployment", {
        message: `no active deployment for pipeline ${pipeline.id} in ${environment}`
      });
    }
    const validation = validatePipelineSpec(
      resolved.spec as PipelineSpec,
      deps.pluginRegistry
    );
    if (!validation.valid) {
      return error(422, "validation_failed", { issues: validation.errors });
    }
    // Capture the narrowed locals before the generator closes over them
    // so TS doesn't widen `pipeline` back to (PipelineRow | AppResponse).
    const pipelineForStream = pipeline;
    const resolvedForStream = resolved;
    const tenantIdForStream = tenantId;
    async function* streamFrames(): AsyncGenerator<string> {
      function f(event: string, data: unknown): string {
        return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      }
      // Producer/consumer pattern: the run executes in the background
      // and pushes token frames into the queue via onToken; the
      // generator drains the queue between yield points.
      const queue: string[] = [];
      let resolveNext: (() => void) | undefined;
      let done = false;
      function push(frame: string): void {
        queue.push(frame);
        resolveNext?.();
        resolveNext = undefined;
      }
      yield f("execution.started", {
        pipelineId: pipelineForStream.id,
        pipelineVersionId: resolvedForStream.id
      });
      const runPromise = runSyncPipeline({
        deps,
        apiDatasetResolver,
        tenantId: tenantIdForStream,
        pipeline: pipelineForStream,
        versionRow: resolvedForStream,
        environment,
        input: body.input,
        actorId: ctx.principal.id,
        requestId: headerValue(ctx.request.headers, "x-request-id") ?? undefined,
        deadlineMs:
          typeof body.deadlineMs === "number" ? body.deadlineMs : undefined,
        onToken: ({ nodeId, token }) => push(f("token", { nodeId, token }))
      })
        .then(async (result) => {
          push(
            f("execution.completed", {
              executionId: result.executionId,
              status: "succeeded"
            })
          );
          push(f("output", { output: result.output }));
          push(
            f("done", {
              executionId: result.executionId,
              pipelineId: pipelineForStream.id,
              pipelineVersionId: resolvedForStream.id
            })
          );
          await audit(
            ctx,
            "pipeline.invoke",
            "execution",
            result.executionId,
            undefined,
            {
              pipelineId: pipelineForStream.id,
              version: resolvedForStream.version,
              kind: "stream",
              input: redactValue(body.input)
            }
          );
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          push(f("execution.failed", { error: message }));
          push(f("error", { message }));
        })
        .finally(() => {
          done = true;
          resolveNext?.();
          resolveNext = undefined;
        });
      try {
        while (true) {
          while (queue.length > 0) {
            yield queue.shift()!;
          }
          if (done) break;
          await new Promise<void>((resolve) => {
            resolveNext = resolve;
          });
        }
      } finally {
        // If the consumer hung up early, let the run finish so the
        // audit log + execution record stay consistent.
        await runPromise.catch(() => undefined);
      }
    }
    return {
      status: 200,
      body: streamFrames(),
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      }
    };
  });
}
