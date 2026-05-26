/**
 * Pipeline folder CRUD. The "move pipeline to folder" endpoint
 * (`PUT /api/pipelines/:id/folder`) lives with the pipelines routes
 * because it mutates a pipeline; only the four pure-folder endpoints
 * are here.
 */
import { randomUUID } from "node:crypto";
import { enforce } from "../../../../../packages/auth/src/index.ts";
import type {
  PipelineFolderRow,
  PipelineFolderRepository
} from "../../../../../packages/db/src/index.ts";
import { ok, error, isObject, nowIso } from "../http-utils.ts";
import type { RouteRegistry, AuditWriter } from "./types.ts";

interface FoldersServices {
  pipelineFolders: PipelineFolderRepository;
  audit: AuditWriter;
}

export function registerFoldersRoutes(
  api: RouteRegistry,
  svc: FoldersServices
): void {
  const { pipelineFolders, audit } = svc;

  api.route("GET", "/api/folders", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    return ok({ folders: await pipelineFolders.tree() });
  });

  api.route("POST", "/api/folders", async (ctx) => {
    enforce(ctx.principal, "pipeline:create");
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.name !== "string" || body.name.length === 0) {
      return error(422, "validation_failed", {
        issues: [{ path: "name", message: "name is required" }]
      });
    }
    const parentId = typeof body.parentId === "string" ? body.parentId : null;
    if (parentId !== null && !(await pipelineFolders.get(parentId))) {
      return error(404, "not_found", { message: "parent folder not found" });
    }
    const row: PipelineFolderRow = {
      id: typeof body.id === "string" ? body.id : randomUUID(),
      parentId,
      name: body.name,
      createdAt: nowIso()
    };
    const created = await pipelineFolders.create(row);
    await audit(ctx, "pipeline_folder.create", "pipeline_folder", created.id, undefined, created);
    return ok({ folder: created }, 201);
  });

  api.route("PUT", "/api/folders/:id", async (ctx) => {
    enforce(ctx.principal, "pipeline:update");
    const before = await pipelineFolders.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    const body = ctx.request.body;
    if (!isObject(body)) return error(422, "validation_failed", { issues: [] });
    let updated = before;
    if (typeof body.name === "string" && body.name.length > 0) {
      updated = await pipelineFolders.rename(ctx.params.id, body.name);
    }
    if ("parentId" in body) {
      const parentId =
        typeof body.parentId === "string" ? body.parentId : null;
      if (parentId === ctx.params.id) {
        return error(422, "validation_failed", {
          issues: [{ path: "parentId", message: "folder cannot be its own parent" }]
        });
      }
      if (parentId !== null && !(await pipelineFolders.get(parentId))) {
        return error(404, "not_found", { message: "parent folder not found" });
      }
      updated = await pipelineFolders.update(ctx.params.id, {
        parentId
      } as Partial<PipelineFolderRow>);
    }
    await audit(ctx, "pipeline_folder.update", "pipeline_folder", updated.id, before, updated);
    return ok({ folder: updated });
  });

  api.route("DELETE", "/api/folders/:id", async (ctx) => {
    enforce(ctx.principal, "pipeline:delete");
    const before = await pipelineFolders.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    // Repo throws ConflictError when the folder still has children/pipelines;
    // the global handler maps that to 409 conflict.
    await pipelineFolders.delete(ctx.params.id);
    await audit(ctx, "pipeline_folder.delete", "pipeline_folder", ctx.params.id, before, undefined);
    return { status: 204, body: undefined, headers: {} };
  });
}
