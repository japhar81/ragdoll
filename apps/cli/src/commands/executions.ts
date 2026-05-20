/** `ragdoll executions ...` — list, fetch, and trace pipeline runs. */
import type { Command } from "commander";
import { api, emit, fail, type Ctx } from "../ctx.ts";

export function registerExecutions(program: Command, ctx: Ctx): void {
  const e = program.command("executions").description("Pipeline executions");

  e.command("list")
    .option("--pipeline <uuid>")
    .option("--status <state>", "filter by status")
    .option("--limit <n>", "default 25", "25")
    .action(async (o: { pipeline?: string; status?: string; limit: string }) => {
      try {
        const qs = new URLSearchParams();
        if (o.pipeline) qs.set("pipeline_id", o.pipeline);
        if (o.status) qs.set("status", o.status);
        if (o.limit) qs.set("limit", o.limit);
        const q = qs.toString() ? `?${qs}` : "";
        emit(ctx, await api(ctx, "GET", `/api/executions${q}`));
      } catch (err) {
        fail(err, "executions list");
      }
    });

  e.command("get <id>").action(async (id: string) => {
    try {
      emit(ctx, await api(ctx, "GET", `/api/executions/${id}`));
    } catch (err) {
      fail(err, "executions get");
    }
  });

  e.command("trace <id>")
    .description("Per-node trace + status timeline")
    .action(async (id: string) => {
      try {
        emit(ctx, await api(ctx, "GET", `/api/executions/${id}/trace`));
      } catch (err) {
        fail(err, "executions trace");
      }
    });
}
