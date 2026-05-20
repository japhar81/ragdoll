/** `ragdoll schedules ...` — cron schedules (delegates to croner server-side). */
import type { Command } from "commander";
import { api, emit, fail, type Ctx } from "../ctx.ts";

export function registerSchedules(program: Command, ctx: Ctx): void {
  const s = program.command("schedules").description("Cron schedules");

  s.command("list")
    .option("--tenant <uuid>")
    .option("--pipeline <uuid>")
    .action(async (o: { tenant?: string; pipeline?: string }) => {
      try {
        const qs = new URLSearchParams();
        if (o.tenant) qs.set("tenant", o.tenant);
        if (o.pipeline) qs.set("pipeline", o.pipeline);
        const q = qs.toString() ? `?${qs}` : "";
        emit(ctx, await api(ctx, "GET", `/api/schedules${q}`));
      } catch (e) {
        fail(e, "schedules list");
      }
    });

  s.command("create")
    .requiredOption("--tenant <uuid>")
    .requiredOption("--pipeline <uuid>")
    .requiredOption("--environment <env>")
    .requiredOption("--cron <expr>")
    .option("--timezone <iana>", "UTC", "UTC")
    .option("--activation <label>")
    .option("--input <json>", "JSON passed to every run", "{}")
    .option("--disabled", "create in a disabled state", false)
    .action(async (o: Record<string, string | boolean>) => {
      try {
        const input = JSON.parse(String(o.input ?? "{}"));
        emit(
          ctx,
          await api(ctx, "POST", "/api/schedules", {
            body: {
              tenantId: o.tenant,
              pipelineId: o.pipeline,
              environment: o.environment,
              cron: o.cron,
              timezone: o.timezone,
              activationLabel: o.activation,
              input,
              enabled: !o.disabled
            }
          })
        );
      } catch (e) {
        fail(e, "schedules create");
      }
    });

  s.command("toggle <id>")
    .description("Enable or disable a schedule")
    .requiredOption("--enabled <bool>", "true | false")
    .action(async (id: string, o: { enabled: string }) => {
      try {
        emit(
          ctx,
          await api(ctx, "PATCH", `/api/schedules/${id}`, {
            body: { enabled: o.enabled === "true" }
          })
        );
      } catch (e) {
        fail(e, "schedules toggle");
      }
    });

  s.command("delete <id>").action(async (id: string) => {
    try {
      await api(ctx, "DELETE", `/api/schedules/${id}`);
      emit(ctx, { ok: true });
    } catch (e) {
      fail(e, "schedules delete");
    }
  });
}
