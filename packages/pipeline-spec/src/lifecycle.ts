import type { PipelineSpec } from "../../core/src/index.ts";
import { stableHash } from "../../core/src/index.ts";
import { parseYaml, stringifyYaml } from "./yaml.ts";

/* ----------------------------- spec loading ------------------------------- */

export class PipelineSpecParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineSpecParseError";
  }
}

/**
 * Heuristic: a JSON document starts (after whitespace) with `{` or `[`.
 * Everything else is treated as YAML. (YAML is a JSON superset but our minimal
 * emitter/parser handles JSON-looking input fine either way.)
 */
function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

export function loadPipelineSpecFromYaml(text: string): PipelineSpec {
  const parsed = parseYaml(text);
  return asPipelineSpec(parsed);
}

/**
 * Parses a pipeline spec from either JSON or YAML text (autodetected).
 */
export function loadPipelineSpec(text: string): PipelineSpec {
  if (looksLikeJson(text)) {
    return asPipelineSpec(JSON.parse(text));
  }
  return loadPipelineSpecFromYaml(text);
}

function asPipelineSpec(value: unknown): PipelineSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PipelineSpecParseError("pipeline spec must be a mapping");
  }
  const obj = value as Record<string, unknown>;
  if (obj.apiVersion === undefined || obj.kind === undefined) {
    throw new PipelineSpecParseError("pipeline spec must define apiVersion and kind");
  }
  if (!obj.metadata || typeof obj.metadata !== "object") {
    throw new PipelineSpecParseError("pipeline spec must define metadata");
  }
  if (!obj.spec || typeof obj.spec !== "object") {
    throw new PipelineSpecParseError("pipeline spec must define spec");
  }
  return value as PipelineSpec;
}

/* ------------------------------- checksum --------------------------------- */

/**
 * Recursively sorts object keys so that the resulting structure hashes
 * identically regardless of key ordering or insignificant formatting.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Stable, formatting-independent checksum of a pipeline spec. Uses the core
 * `stableHash` over a deeply key-sorted canonical JSON form so that two specs
 * differing only in key order / whitespace produce the same checksum.
 */
export function specChecksum(spec: PipelineSpec): string {
  return stableHash(JSON.stringify(canonicalize(spec)));
}

/* ------------------------------ versioning -------------------------------- */

export type PipelineVersionStatus = "draft" | "published" | "archived";

export interface PipelineVersionRecord {
  pipelineId: string;
  version: string;
  status: PipelineVersionStatus;
  spec: PipelineSpec;
  checksum: string;
  createdAt: string;
  publishedAt?: string;
}

export class ImmutableVersionError extends Error {
  constructor(version: string) {
    super(`Published version ${version} is immutable and cannot be changed`);
    this.name = "ImmutableVersionError";
  }
}

export interface PublishOptions {
  pipelineId?: string;
  now?: () => string;
}

/**
 * Publishes `spec` as `version`.
 *
 * - If a *published* record with the same `version` already exists and its
 *   checksum DIFFERS from the new spec, throws `ImmutableVersionError`.
 * - If a published record with the same `version` exists with the SAME
 *   checksum, the operation is idempotent and returns that existing record.
 * - Otherwise returns a new published `PipelineVersionRecord` (does not mutate
 *   the input array).
 */
export function publishVersion(
  existing: PipelineVersionRecord[],
  spec: PipelineSpec,
  version: string,
  options: PublishOptions = {}
): PipelineVersionRecord {
  const now = options.now ?? (() => new Date().toISOString());
  const pipelineId = options.pipelineId ?? spec.metadata.name;
  const checksum = specChecksum(spec);

  const prior = existing.find(
    (record) => record.pipelineId === pipelineId && record.version === version && record.status === "published"
  );
  if (prior) {
    if (prior.checksum !== checksum) throw new ImmutableVersionError(version);
    return prior; // idempotent: identical content republished.
  }

  const timestamp = now();
  return {
    pipelineId,
    version,
    status: "published",
    spec,
    checksum,
    createdAt: timestamp,
    publishedAt: timestamp
  };
}

/**
 * Returns a copy of `record` marked archived. Idempotent for already-archived
 * records.
 */
export function archiveVersion(record: PipelineVersionRecord): PipelineVersionRecord {
  if (record.status === "archived") return record;
  return { ...record, status: "archived" };
}

/* ----------------------------- deployments -------------------------------- */

export interface PipelineDeployment {
  pipelineId: string;
  environment: string;
  version: string;
  /** When set, this deployment is tenant-scoped and beats env-wide ones. */
  tenantId?: string;
}

export interface DeploymentSelector {
  environment: string;
  tenantId?: string;
  pipelineId?: string;
}

/**
 * Resolves the pinned version for a `(environment, tenantId)` request.
 * Tenant-specific deployments take precedence over environment-wide ones.
 * Returns `undefined` if nothing matches.
 */
export function selectDeployedVersion(
  deployments: PipelineDeployment[],
  selector: DeploymentSelector
): PipelineDeployment | undefined {
  const candidates = deployments.filter((deployment) => {
    if (deployment.environment !== selector.environment) return false;
    if (selector.pipelineId !== undefined && deployment.pipelineId !== selector.pipelineId) return false;
    return true;
  });

  if (selector.tenantId !== undefined) {
    const tenantMatch = candidates.find((deployment) => deployment.tenantId === selector.tenantId);
    if (tenantMatch) return tenantMatch;
  }

  return candidates.find((deployment) => deployment.tenantId === undefined);
}

/* --------------------------- import / export ------------------------------ */

export type SpecFormat = "json" | "yaml";

/**
 * Serializes a pipeline spec to JSON or YAML text. The YAML emitter is minimal
 * but is guaranteed to round-trip back through `importSpec` / `loadPipelineSpec`
 * for valid pipeline specs.
 */
export function exportSpec(spec: PipelineSpec, format: SpecFormat): string {
  if (format === "json") return JSON.stringify(spec, null, 2) + "\n";
  return stringifyYaml(spec);
}

/**
 * Parses a pipeline spec from JSON or YAML text (autodetected). Alias of
 * `loadPipelineSpec` kept for API symmetry with `exportSpec`.
 */
export function importSpec(text: string): PipelineSpec {
  return loadPipelineSpec(text);
}
