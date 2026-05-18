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
  /** Optional id of this record (used for pointer/parent linkage). */
  id?: string;
  /** Optional id of the version this one was saved on top of. */
  parentVersionId?: string | null;
}

export class ImmutableVersionError extends Error {
  constructor(version: string) {
    super(`Published version ${version} is immutable and cannot be changed`);
    this.name = "ImmutableVersionError";
  }
}

export class VersionNotFoundError extends Error {
  constructor(versionId: string) {
    super(`Pipeline version ${versionId} was not found`);
    this.name = "VersionNotFoundError";
  }
}

export class ActivationResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActivationResolutionError";
  }
}

/* ---------------------------- semver helpers ------------------------------ */

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parses a strict `major.minor.patch` semver (no pre-release / build
 * metadata). Returns `null` for anything that does not match.
 */
export function parseSemver(v: string): Semver | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(typeof v === "string" ? v.trim() : "");
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  return { major, minor, patch };
}

/**
 * Orders two version strings. Unparseable versions sort below any valid
 * semver (and equal to each other). Returns <0, 0, or >0.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

/**
 * Returns the greatest parseable semver in `versions`, or `"0.0.0"` when the
 * list is empty / contains no parseable versions.
 */
export function maxSemver(versions: string[]): string {
  let best: string | null = null;
  for (const candidate of versions) {
    if (parseSemver(candidate) === null) continue;
    if (best === null || compareSemver(candidate, best) > 0) best = candidate;
  }
  return best ?? "0.0.0";
}

/**
 * Increments `base` by one level. `minor` resets patch to 0; `major` resets
 * both minor and patch to 0. An unparseable `base` is treated as `0.0.0`.
 */
export function semverBump(base: string, level: "patch" | "minor" | "major"): string {
  const parsed = parseSemver(base) ?? { major: 0, minor: 0, patch: 0 };
  if (level === "major") return `${parsed.major + 1}.0.0`;
  if (level === "minor") return `${parsed.major}.${parsed.minor + 1}.0`;
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
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

/* -------------------------- save / rollback ------------------------------- */

export interface NextVersionOnSaveArgs {
  /** All known version records for the pipeline (any status). */
  existingVersions: PipelineVersionRecord[];
  /** The record the pipeline's "latest" pointer currently references. */
  latest?: PipelineVersionRecord;
  spec: PipelineSpec;
  level?: "patch" | "minor" | "major";
  pipelineId?: string;
  now?: () => string;
}

export type NextVersionOnSaveResult =
  | { kind: "idempotent"; version: PipelineVersionRecord }
  | { kind: "new"; record: PipelineVersionRecord };

/**
 * Computes the outcome of a "save" against the current latest pointer.
 *
 * - If `latest` exists and its checksum equals the new spec's checksum the
 *   save is idempotent and returns the existing `latest` record unchanged.
 * - Otherwise a new published record is produced. Its version is the GLOBAL
 *   max version across `existingVersions` bumped by `level` (default
 *   `"patch"`). Bumping from the global max — not from `latest` — keeps
 *   version numbers unique and monotonic even when the latest pointer was
 *   rolled back to an older version. `parentVersionId` links to `latest`.
 *
 * Pure: never mutates inputs.
 */
export function nextVersionOnSave(args: NextVersionOnSaveArgs): NextVersionOnSaveResult {
  const now = args.now ?? (() => new Date().toISOString());
  const pipelineId = args.pipelineId ?? args.latest?.pipelineId ?? args.spec.metadata.name;
  const checksum = specChecksum(args.spec);

  if (args.latest && args.latest.checksum === checksum) {
    return { kind: "idempotent", version: args.latest };
  }

  const version = semverBump(
    maxSemver(args.existingVersions.map((record) => record.version)),
    args.level ?? "patch"
  );

  const record: PipelineVersionRecord = {
    pipelineId,
    version,
    status: "published",
    spec: args.spec,
    checksum,
    createdAt: now(),
    parentVersionId: args.latest?.id ?? null
  };
  return { kind: "new", record };
}

/**
 * Validates that `versionId` exists among `versions` and returns it as the
 * new "latest" pointer value. Throws `VersionNotFoundError` otherwise. This
 * is a pointer move only — it creates NO new version record.
 */
export function rollbackPointer(versions: PipelineVersionRecord[], versionId: string): string {
  const found = versions.some((record) => record.id === versionId);
  if (!found) throw new VersionNotFoundError(versionId);
  return versionId;
}

/* ------------------------------ activations ------------------------------- */

/**
 * Resolves which activation a request targets.
 *
 * Precedence:
 *  1. An explicit `label` — it must exist and be enabled.
 *  2. The activation labelled `"default"`, if enabled.
 *  3. Exactly one enabled activation.
 *  4. Otherwise throw `ActivationResolutionError`.
 */
export function resolveActivation<T extends { label: string; enabled: boolean }>(
  activations: T[],
  label?: string
): T {
  if (label !== undefined) {
    const match = activations.find((activation) => activation.label === label);
    if (!match) {
      throw new ActivationResolutionError(`No activation labelled "${label}"`);
    }
    if (!match.enabled) {
      throw new ActivationResolutionError(`Activation "${label}" is disabled`);
    }
    return match;
  }

  const enabled = activations.filter((activation) => activation.enabled);

  const byDefault = enabled.find((activation) => activation.label === "default");
  if (byDefault) return byDefault;

  if (enabled.length === 1) return enabled[0];

  if (enabled.length === 0) {
    throw new ActivationResolutionError("No enabled activation to resolve");
  }
  throw new ActivationResolutionError(
    "Ambiguous activation: multiple enabled activations and no explicit or default label"
  );
}

/**
 * Resolves the concrete pipeline version id an activation points at.
 * `trackLatest` activations follow the pipeline's latest pointer; pinned
 * activations use their own `pipelineVersionId`. Throws
 * `ActivationResolutionError` if the resolved id is missing.
 */
export function effectiveVersionId(
  activation: { trackLatest: boolean; pipelineVersionId?: string | null },
  pipelineLatestVersionId?: string | null
): string {
  const resolved = activation.trackLatest ? pipelineLatestVersionId : activation.pipelineVersionId;
  if (resolved === null || resolved === undefined) {
    throw new ActivationResolutionError(
      activation.trackLatest
        ? "Activation tracks latest but pipeline has no latest version"
        : "Pinned activation has no pipelineVersionId"
    );
  }
  return resolved;
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
