/**
 * `ragdoll tenants ...` — tenant + per-tenant environment CRUD plus a small
 * `use` helper that pins the selected tenant in the config so subsequent
 * commands no longer need `--tenant`.
 */
import type { Command } from "commander";
import { patchConfig } from "../config.ts";
import { api, emit, fail, type Ctx } from "../ctx.ts";

export function registerTenants(program: Command, ctx: Ctx): void {
  const tenants = program.command("tenants").description("Manage tenants");

  tenants
    .command("list")
    .action(async () => {
      try {
        emit(ctx, await api(ctx, "GET", "/api/tenants"));
      } catch (e) {
        fail(e, "tenants list");
      }
    });

  tenants
    .command("create")
    .requiredOption("--slug <slug>")
    .requiredOption("--name <name>")
    .option("--status <status>", "active | inactive", "active")
    .action(async (o: { slug: string; name: string; status: string }) => {
      try {
        emit(
          ctx,
          await api(ctx, "POST", "/api/tenants", {
            body: { slug: o.slug, name: o.name, status: o.status }
          })
        );
      } catch (e) {
        fail(e, "tenants create");
      }
    });

  tenants
    .command("get <id>")
    .action(async (id: string) => {
      try {
        emit(ctx, await api(ctx, "GET", `/api/tenants/${id}`));
      } catch (e) {
        fail(e, "tenants get");
      }
    });

  tenants
    .command("delete <id>")
    .action(async (id: string) => {
      try {
        await api(ctx, "DELETE", `/api/tenants/${id}`);
        emit(ctx, { ok: true });
      } catch (e) {
        fail(e, "tenants delete");
      }
    });

  tenants
    .command("use <id>")
    .description("Persist a tenant UUID as the default `x-tenant-id`")
    .action(async (id: string) => {
      const next = await patchConfig({ tenantId: id });
      emit(ctx, { ok: true, tenantId: next.tenantId });
    });

  // ---- environments ------------------------------------------------------
  const envs = program
    .command("environments")
    .description("Per-tenant environments");

  envs
    .command("list <tenantId>")
    .action(async (tenantId: string) => {
      try {
        emit(ctx, await api(ctx, "GET", `/api/tenants/${tenantId}/environments`));
      } catch (e) {
        fail(e, "environments list");
      }
    });

  envs
    .command("create <tenantId>")
    .requiredOption("--name <name>", "e.g. dev | prod")
    .option("--description <text>")
    .option("--production", "mark as a production environment", false)
    .action(
      async (
        tenantId: string,
        o: { name: string; description?: string; production: boolean }
      ) => {
        try {
          emit(
            ctx,
            await api(ctx, "POST", `/api/tenants/${tenantId}/environments`, {
              body: {
                name: o.name,
                description: o.description,
                isProduction: o.production
              }
            })
          );
        } catch (e) {
          fail(e, "environments create");
        }
      }
    );

  envs
    .command("delete <tenantId> <envId>")
    .action(async (tenantId: string, envId: string) => {
      try {
        await api(
          ctx,
          "DELETE",
          `/api/tenants/${tenantId}/environments/${envId}`
        );
        emit(ctx, { ok: true });
      } catch (e) {
        fail(e, "environments delete");
      }
    });
}
