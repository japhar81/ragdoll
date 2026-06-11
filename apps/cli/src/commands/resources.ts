/**
 * `ragdoll folders|datasets|connections ...` — minimal list/delete CLI
 * for the resource families that previously had no CLI surface at all.
 *
 * Scope is intentionally narrow: list (so the operator can find an id)
 * + delete (with --force where the server's cascade contract applies).
 * Full CRUD lives in the web UI and the openapi.yaml spec — these
 * commands exist so an operator can clean things up from a shell when
 * `make refresh` is gone or the UI is unreachable.
 */
import type { Command } from "commander";
import { api, emit, fail, type Ctx } from "../ctx.ts";
import { runDelete } from "../cascade.ts";

export function registerResources(program: Command, ctx: Ctx): void {
  // ---- folders ---------------------------------------------------------
  const folders = program
    .command("folders")
    .description("Pipeline folders");

  folders
    .command("list")
    .description("List the nested pipeline-folder tree.")
    .action(async () => {
      try {
        emit(ctx, await api(ctx, "GET", "/api/folders"));
      } catch (e) {
        fail(e, "folders list");
      }
    });

  folders
    .command("delete <id>")
    .option("--force", "Cascade-delete: recursively nuke every pipeline + sub-folder inside (pipeline FK chain cascades versions / deployments / activations / schedules / triggers).")
    .action(async (id: string, o: { force?: boolean }) => {
      await runDelete(ctx, "folders delete", `/api/folders/${id}`, { force: o.force });
      emit(ctx, { ok: true });
    });

  // ---- datasets --------------------------------------------------------
  const datasets = program
    .command("datasets")
    .description("Datasets (corpus + bindings)");

  datasets
    .command("list")
    .description("List datasets visible at the current scope.")
    .action(async () => {
      try {
        emit(ctx, await api(ctx, "GET", "/api/datasets"));
      } catch (e) {
        fail(e, "datasets list");
      }
    });

  datasets
    .command("delete <id>")
    .option("--force", "Cascade-delete: versions + aliases cascade via FK; pipeline specs that reference the slug become dangling refs (operator opt-in). Default refuses with the pipeline-reference count.")
    .action(async (id: string, o: { force?: boolean }) => {
      await runDelete(ctx, "datasets delete", `/api/datasets/${id}`, { force: o.force });
      emit(ctx, { ok: true });
    });

  datasets
    .command("used-by <id>")
    .description("Show pipelines that reference this dataset's slug (the same walk DELETE uses to count dependents).")
    .action(async (id: string) => {
      try {
        emit(ctx, await api(ctx, "GET", `/api/datasets/${id}/used-by`));
      } catch (e) {
        fail(e, "datasets used-by");
      }
    });

  // ---- connections -----------------------------------------------------
  const connections = program
    .command("connections")
    .description("Unified Connections registry (ADR-0023).");

  connections
    .command("list")
    .description("List connections visible at the current scope.")
    .action(async () => {
      try {
        emit(ctx, await api(ctx, "GET", "/api/connections"));
      } catch (e) {
        fail(e, "connections list");
      }
    });

  connections
    .command("delete <id>")
    .option(
      "--force",
      "Hard-delete the row + drop pooled driver client. WITHOUT --force, the route soft-archives (sets archivedAt; row remains so historical traces still resolve). With --force, the server refuses 409 if any dataset binding or pipeline spec still references the slug — clean those first."
    )
    .action(async (id: string, o: { force?: boolean }) => {
      await runDelete(
        ctx,
        o.force ? "connections delete" : "connections archive",
        `/api/connections/${id}`,
        { force: o.force }
      );
      emit(ctx, { ok: true });
    });

  connections
    .command("probe <id>")
    .description("Trigger an on-demand health probe (POST /api/connections/:id/probe). Result cached on the row.")
    .action(async (id: string) => {
      try {
        emit(ctx, await api(ctx, "POST", `/api/connections/${id}/probe`));
      } catch (e) {
        fail(e, "connections probe");
      }
    });
}
