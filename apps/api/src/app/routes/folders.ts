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
  PipelineFolderRepository,
  PipelineRepository
} from "../../../../../packages/db/src/index.ts";
import { ok, error, isObject, nowIso } from "../http-utils.ts";
import { parseForce } from "../cascade-utils.ts";
import type { RouteRegistry, AuditWriter } from "./types.ts";

interface FoldersServices {
  pipelineFolders: PipelineFolderRepository;
  pipelines: PipelineRepository;
  audit: AuditWriter;
}

export function registerFoldersRoutes(
  api: RouteRegistry,
  svc: FoldersServices
): void {
  const { pipelineFolders, pipelines, audit } = svc;

  /** Walk every descendant folder (depth-first). Returns the bottom-up
   *  order so callers can delete leaves before parents without tripping
   *  parent-id FKs. The starting folder is the FIRST element of the
   *  returned array; reverse to delete safely. */
  async function descendantsBottomUp(rootId: string): Promise<string[]> {
    const order: string[] = [];
    async function visit(id: string): Promise<void> {
      const children = await pipelineFolders.listChildren(id);
      for (const child of children) await visit(child.id);
      order.push(id);
    }
    await visit(rootId);
    return order;
  }

  /** Count direct + transitive pipelines + child folders under `rootId`.
   *  Used to populate the 409 envelope when ?force is unset. */
  async function countDependents(rootId: string): Promise<{
    pipelines: number;
    subfolders: number;
  }> {
    const folderIds = (await descendantsBottomUp(rootId)).filter((id) => id !== rootId);
    let pipelineCount = 0;
    const allPipelines = await pipelines.list();
    const allFolderIds = new Set([rootId, ...folderIds]);
    for (const p of allPipelines) {
      if (p.folderId && allFolderIds.has(p.folderId)) pipelineCount += 1;
    }
    return { pipelines: pipelineCount, subfolders: folderIds.length };
  }

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
    const force = parseForce(ctx.request);
    const deps = await countDependents(ctx.params.id);
    if (!force && (deps.pipelines > 0 || deps.subfolders > 0)) {
      // Refuse: enumerate what would be orphaned. The repo's own
      // pipelineFolders.delete also throws ConflictError on child
      // folders, but our 409 is richer (counts + cascade hint) and
      // surfaces BEFORE the SQL constraint fires.
      const { hasDependents } = await import("../cascade-utils.ts");
      return hasDependents(`folder "${before.name}"`, {
        pipelines: deps.pipelines,
        subfolders: deps.subfolders
      });
    }
    // Cascade order: leaf folders first (bottom-up), and inside each
    // delete pipelines BEFORE the folder itself (pipelines.folder_id
    // is ON DELETE SET NULL, so an in-place delete would orphan them
    // to folder_id=NULL instead of nuking them). Pipeline delete
    // already cascades to versions / deployments / activations /
    // schedules / triggers via the FK chain (migrations 001-013).
    const order = await descendantsBottomUp(ctx.params.id);
    const allPipelines = await pipelines.list();
    const folderSet = new Set(order);
    const pipelinesToDelete = allPipelines.filter(
      (p) => p.folderId && folderSet.has(p.folderId)
    );
    // The InMemory folder repo carries an internal pipelines-by-folder
    // map (so its own delete() can refuse a non-empty folder without
    // coupling to the pipeline repo). Pipeline delete doesn't notify
    // the folder repo, so we have to release the association
    // explicitly OR the bottom-up folder cascade below would trip on
    // ConflictError "folder still has pipelines". The track method is
    // optional (postgres repo has no use for it); call it via a guard.
    const trackable = pipelineFolders as PipelineFolderRepository & {
      trackPipelineFolder?: (p: string, f: string | null) => void;
    };
    for (const p of pipelinesToDelete) {
      trackable.trackPipelineFolder?.(p.id, null);
      await pipelines.delete(p.id);
      await audit(ctx, "pipeline.delete", "pipeline", p.id, p, undefined);
    }
    for (const folderId of order) {
      // The root is included as the last element of `order` (bottom-up).
      await pipelineFolders.delete(folderId);
    }
    await audit(
      ctx,
      "pipeline_folder.delete",
      "pipeline_folder",
      ctx.params.id,
      { ...before, cascaded: { pipelines: pipelinesToDelete.length, subfolders: order.length - 1 } },
      undefined
    );
    return { status: 204, body: undefined, headers: {} };
  });
}
