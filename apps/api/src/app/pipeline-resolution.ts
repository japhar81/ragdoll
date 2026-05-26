/**
 * Pipeline `:id` resolver — accepts either a UUID or a slug/name and
 * returns the canonical `PipelineRow`. Without this, a route that
 * blindly fed `:id` into a Postgres `uuid` query would throw
 * `invalid input syntax for type uuid` for slug-based requests like
 * `POST /api/pipelines/<slug>/run`.
 */
import type {
  PipelineRepository,
  PipelineRow,
  PipelineFolderRepository
} from "../../../../packages/db/src/index.ts";
import { error, isUuid } from "./http-utils.ts";
import type { AppResponse } from "./types.ts";

export async function resolvePipelineRef(
  pipelines: PipelineRepository,
  ref: string
): Promise<PipelineRow | AppResponse> {
  let pipeline: PipelineRow | undefined;
  if (isUuid(ref)) {
    pipeline = await pipelines.get(ref);
  }
  if (!pipeline) {
    pipeline = await pipelines.findBySlug(ref);
  }
  if (!pipeline) {
    return error(404, "pipeline_not_found", {
      message: `no pipeline with id or slug '${ref}'`
    });
  }
  return pipeline;
}

/** Narrow the union returned by `resolvePipelineRef`. */
export function isAppResponse(
  v: PipelineRow | AppResponse
): v is AppResponse {
  return (
    typeof (v as AppResponse).status === "number" &&
    (v as AppResponse).headers !== undefined
  );
}

/**
 * Record which folder a pipeline lives in so a non-empty folder delete
 * raises 409. The InMemory folder repo exposes a `trackPipelineFolder`
 * hook; a Postgres-backed repo derives emptiness from the pipelines
 * table via its own FK so the call is a no-op there.
 */
export function trackFolder(
  pipelineFolders: PipelineFolderRepository,
  pipelineId: string,
  folderId: string | null
): void {
  const repo = pipelineFolders as unknown as {
    trackPipelineFolder?: (p: string, f: string | null) => void;
  };
  repo.trackPipelineFolder?.(pipelineId, folderId);
}
