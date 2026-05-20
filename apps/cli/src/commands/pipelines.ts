/**
 * `ragdoll pipelines ...` — pipelines, versions, deployments, run, validate,
 * plus the trigger lifecycle (mint a webhook URL / list / delete).
 *
 * The `run` command shows the full enqueue result; if the user wants the
 * execution outcome they can chain `ragdoll executions get <id>` or
 * `ragdoll executions trace <id>`.
 */
import type { Command } from "commander";
import { readFile } from "node:fs/promises";
import { api, emit, fail, type Ctx } from "../ctx.ts";

async function readJsonArg(arg: string): Promise<unknown> {
  if (!arg) return undefined;
  if (arg.startsWith("@")) {
    return JSON.parse(await readFile(arg.slice(1), "utf8"));
  }
  return JSON.parse(arg);
}

export function registerPipelines(program: Command, ctx: Ctx): void {
  const p = program.command("pipelines").description("Manage pipelines");

  p.command("list").action(async () => {
    try {
      emit(ctx, await api(ctx, "GET", "/api/pipelines"));
    } catch (e) {
      fail(e, "pipelines list");
    }
  });

  p.command("get <id>").action(async (id: string) => {
    try {
      emit(ctx, await api(ctx, "GET", `/api/pipelines/${id}`));
    } catch (e) {
      fail(e, "pipelines get");
    }
  });

  p.command("create")
    .requiredOption("--slug <slug>")
    .requiredOption("--name <name>")
    .option("--description <text>")
    .action(async (o: { slug: string; name: string; description?: string }) => {
      try {
        emit(
          ctx,
          await api(ctx, "POST", "/api/pipelines", {
            body: { slug: o.slug, name: o.name, description: o.description }
          })
        );
      } catch (e) {
        fail(e, "pipelines create");
      }
    });

  p.command("delete <id>").action(async (id: string) => {
    try {
      await api(ctx, "DELETE", `/api/pipelines/${id}`);
      emit(ctx, { ok: true });
    } catch (e) {
      fail(e, "pipelines delete");
    }
  });

  // ---- versions ---------------------------------------------------------
  p.command("versions <id>").action(async (id: string) => {
    try {
      emit(ctx, await api(ctx, "GET", `/api/pipelines/${id}/versions`));
    } catch (e) {
      fail(e, "pipelines versions");
    }
  });

  p.command("save <id>")
    .description("Save a new version. --spec @file.json or inline JSON.")
    .requiredOption("--version <semver>")
    .requiredOption("--spec <json|@file>", "spec JSON; prefix with @ to read from file")
    .option("--publish", "publish in addition to saving the draft", false)
    .action(
      async (
        id: string,
        o: { version: string; spec: string; publish: boolean }
      ) => {
        try {
          const spec = await readJsonArg(o.spec);
          emit(
            ctx,
            await api(ctx, "POST", `/api/pipelines/${id}/versions`, {
              body: { version: o.version, spec, publish: o.publish }
            })
          );
        } catch (e) {
          fail(e, "pipelines save");
        }
      }
    );

  p.command("validate")
    .requiredOption("--spec <json|@file>")
    .action(async (o: { spec: string }) => {
      try {
        const spec = await readJsonArg(o.spec);
        emit(ctx, await api(ctx, "POST", "/api/pipelines/validate", { body: spec }));
      } catch (e) {
        fail(e, "pipelines validate");
      }
    });

  // ---- deploy + run -----------------------------------------------------
  p.command("deploy <id>")
    .requiredOption("--version <semver>")
    .requiredOption("--environment <env>")
    .option("--tenant <uuid>", "override the active tenant for this deploy")
    .action(
      async (id: string, o: { version: string; environment: string; tenant?: string }) => {
        try {
          emit(
            ctx,
            await api(ctx, "POST", `/api/pipelines/${id}/deployments`, {
              body: {
                version: o.version,
                environment: o.environment,
                tenantId: o.tenant ?? ctx.config.tenantId
              }
            })
          );
        } catch (e) {
          fail(e, "pipelines deploy");
        }
      }
    );

  p.command("run <id>")
    .description("Enqueue a pipeline run with the given input")
    .option("--input <json|@file>", "input JSON; prefix with @ to read from file")
    .option("--environment <env>", "dev", "dev")
    .option("--activation <label>")
    .action(
      async (
        id: string,
        o: { input?: string; environment: string; activation?: string }
      ) => {
        try {
          const input = o.input ? await readJsonArg(o.input) : undefined;
          emit(
            ctx,
            await api(ctx, "POST", `/api/pipelines/${id}/run`, {
              body: {
                input,
                environment: o.environment,
                activation: o.activation
              }
            })
          );
        } catch (e) {
          fail(e, "pipelines run");
        }
      }
    );

  // ---- triggers ---------------------------------------------------------
  const triggers = p
    .command("triggers")
    .description("Webhook URLs that POST a body to start a pipeline run");

  triggers
    .command("list <pipelineId>")
    .action(async (pipelineId: string) => {
      try {
        emit(ctx, await api(ctx, "GET", `/api/pipelines/${pipelineId}/triggers`));
      } catch (e) {
        fail(e, "triggers list");
      }
    });

  triggers
    .command("create <pipelineId>")
    .requiredOption("--name <name>")
    .requiredOption("--environment <env>")
    .option("--activation <label>")
    .action(
      async (
        pipelineId: string,
        o: { name: string; environment: string; activation?: string }
      ) => {
        try {
          emit(
            ctx,
            await api(ctx, "POST", `/api/pipelines/${pipelineId}/triggers`, {
              body: {
                name: o.name,
                environment: o.environment,
                activationLabel: o.activation
              }
            })
          );
        } catch (e) {
          fail(e, "triggers create");
        }
      }
    );

  triggers
    .command("delete <triggerId>")
    .action(async (triggerId: string) => {
      try {
        await api(ctx, "DELETE", `/api/triggers/${triggerId}`);
        emit(ctx, { ok: true });
      } catch (e) {
        fail(e, "triggers delete");
      }
    });
}
