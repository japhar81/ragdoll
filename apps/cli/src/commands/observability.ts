/** `ragdoll audit / usage ...` — observability shortcuts. */
import type { Command } from "commander";
import { api, emit, fail, type Ctx } from "../ctx.ts";

export function registerObservability(program: Command, ctx: Ctx): void {
  program
    .command("audit")
    .description("Recent audit log entries (auditor / audit:view)")
    .option("--tenant <uuid>")
    .option("--limit <n>", "default 50", "50")
    .action(async (o: { tenant?: string; limit: string }) => {
      try {
        const qs = new URLSearchParams();
        if (o.tenant) qs.set("tenant_id", o.tenant);
        if (o.limit) qs.set("limit", o.limit);
        const q = qs.toString() ? `?${qs}` : "";
        emit(ctx, await api(ctx, "GET", `/api/audit${q}`));
      } catch (e) {
        fail(e, "audit");
      }
    });

  program
    .command("usage")
    .description("Token / cost usage records (with a small summary)")
    .option("--tenant <uuid>")
    .option("--execution <uuid>")
    .action(async (o: { tenant?: string; execution?: string }) => {
      try {
        const qs = new URLSearchParams();
        if (o.tenant) qs.set("tenant_id", o.tenant);
        if (o.execution) qs.set("execution_id", o.execution);
        const q = qs.toString() ? `?${qs}` : "";
        emit(ctx, await api(ctx, "GET", `/api/usage${q}`));
      } catch (e) {
        fail(e, "usage");
      }
    });
}
