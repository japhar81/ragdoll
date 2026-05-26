/**
 * Pick which pipeline version a run_pipeline job should execute, with
 * activation-table awareness for schedule-originated runs.
 */

import {
  resolveActivation,
  effectiveVersionId
} from "../../../../packages/pipeline-spec/src/index.ts";
import type { WorkerDeps } from "./types.ts";

export interface ResolveRunVersionArgs {
  tenantId: string;
  pipelineId: string;
  environment: string;
  /** Org-versioning activation label; resolved via `resolveActivation`. */
  activationLabel?: string;
  /** When already resolved by the API, this wins and nothing else runs. */
  pipelineVersionId?: string;
}

/**
 * Resolves the concrete pipeline version a `run_pipeline` job should execute.
 *
 * Precedence (highest first):
 *  1. An explicit `pipelineVersionId` on the job — the API already resolved
 *     it. Returned as-is so existing /api/.../run behavior and the local-demo
 *     e2e are byte-for-byte unchanged.
 *  2. Org-versioning activations: if `repositories.activations` +
 *     `repositories.pipelines` are wired AND the tenant has activations for
 *     (tenant, pipeline, environment), pick one via `resolveActivation(...,
 *     activationLabel)` and resolve `effectiveVersionId(activation,
 *     pipeline.latestVersionId)` (track-latest follows the pipeline pointer;
 *     pinned uses the activation's own version). Schedule-originated jobs
 *     (no `pipelineVersionId`) land here.
 *  3. Fallback: `undefined` — the caller then defers to the existing
 *     `selectVersion` deployment/`selectDeployedVersion` resolution exactly as
 *     `run_pipeline` does today (no activations table, or none for this key).
 *
 * Returning `undefined` (not throwing) for case 3 keeps the legacy
 * deployment path and its error messages intact.
 */
export async function resolveRunVersion(
  deps: WorkerDeps,
  args: ResolveRunVersionArgs
): Promise<string | undefined> {
  if (args.pipelineVersionId) return args.pipelineVersionId;

  const activationsRepo = deps.repositories.activations;
  const pipelinesRepo = deps.repositories.pipelines;
  if (!activationsRepo) return undefined;

  const activations = await activationsRepo.listByTenantPipelineEnv(
    args.tenantId,
    args.pipelineId,
    args.environment
  );
  if (activations.length === 0) return undefined;

  const activation = resolveActivation(activations, args.activationLabel);
  let latestVersionId: string | null | undefined;
  if (pipelinesRepo) {
    const pipeline = await pipelinesRepo.get(args.pipelineId);
    latestVersionId = pipeline?.latestVersionId ?? null;
  }
  return effectiveVersionId(activation, latestVersionId);
}
