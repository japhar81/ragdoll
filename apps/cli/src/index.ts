#!/usr/bin/env node
/**
 * RAGdoll CLI: a thin wrapper around the control-plane HTTP API.
 *
 * Run `ragdoll --help` for the command tree, `ragdoll <group> --help` to drill
 * in. Auth and the selected tenant live in `~/.ragdoll/config.json` (or in
 * `RAGDOLL_TOKEN` / `RAGDOLL_TENANT_ID` env vars for CI). Each subcommand
 * registers itself with a shared commander root so adding a new resource is a
 * single `register(program, ctx)` call.
 */
import { Command } from "commander";
import { loadConfig } from "./config.ts";
import type { Ctx } from "./ctx.ts";
import { registerAuth } from "./commands/auth.ts";
import { registerTenants } from "./commands/tenants.ts";
import { registerPipelines } from "./commands/pipelines.ts";
import { registerSchedules } from "./commands/schedules.ts";
import { registerExecutions } from "./commands/executions.ts";
import { registerAccess } from "./commands/access.ts";
import { registerObservability } from "./commands/observability.ts";
import { registerKeys } from "./commands/keys.ts";

async function main(): Promise<void> {
  const config = await loadConfig();
  const program = new Command();
  program
    .name("ragdoll")
    .description("Command-line client for the RAGdoll control plane")
    .version("0.1.0")
    .option("-o, --output <format>", "json | table | yaml (default: json)", "json")
    .option("--api-url <url>", "override API base URL", config.apiUrl)
    .option("--tenant <uuid>", "override selected tenant UUID", config.tenantId);

  // The opts object is populated AFTER parseAsync runs; we keep a reference
  // so commands can read --output / --tenant / --api-url through ctx.opts().
  const ctx: Ctx = {
    config,
    opts: () => program.opts<{ output: string; apiUrl: string; tenant?: string }>()
  };

  registerAuth(program, ctx);
  registerTenants(program, ctx);
  registerPipelines(program, ctx);
  registerSchedules(program, ctx);
  registerExecutions(program, ctx);
  registerAccess(program, ctx);
  registerKeys(program, ctx);
  registerObservability(program, ctx);

  await program.parseAsync(process.argv);
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`ragdoll: ${msg}\n`);
  process.exit(1);
});
