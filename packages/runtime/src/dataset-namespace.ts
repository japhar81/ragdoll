/**
 * Dataset namespace-policy helpers.
 *
 * A dataset's `backends[modality]` block carries an optional `namespace`
 * policy (`shared` / `by-tenant` / `by-tenant-env` / `by-env`). The
 * resolver appends a deterministic suffix to the collection / index /
 * predicate name from `dataset_versions.backend_collections.<modality>`
 * before plugins ever see it.
 *
 * Why on the dataset and not the connection? A single OpenSearch or
 * Qdrant cluster can legitimately host both shared org-wide indices and
 * per-tenant ones. Putting the policy on the dataset lets each dataset
 * pick its own isolation level, and a connection stays a pure host +
 * credentials abstraction.
 *
 * The scope of the dataset constrains which policies make sense:
 *
 * | dataset scope | shared | by-tenant | by-tenant-env | by-env |
 * | ------------- | ------ | --------- | ------------- | ------ |
 * | global        |  ✓     |     ✓     |       ✓       |   —    |
 * | tenant        |  ✓     |     —     |       —       |   ✓    |
 * | environment   |  ✓     |     —     |       —       |   —    |
 *
 * (Tenant-scope rows already pin a tenant, so `by-tenant` adds nothing;
 * environment-scope rows already pin both, so any non-`shared` policy
 * is a no-op.)
 *
 * Missing / undefined policy on a backend block ALWAYS resolves to
 * `shared` — that preserves legacy behaviour for rows created before
 * this column existed, and keeps the JSONB block forward-compatible.
 */

import type { DatasetNamespacePolicy } from "../../plugin-sdk/src/index.ts";

export type DatasetScope = "global" | "tenant" | "environment";

export interface NamespaceValidationResult {
  ok: boolean;
  /** Populated when `ok=false`. Suitable for surfacing in a 422 issue. */
  message?: string;
}

/**
 * Returns `{ok:true}` when the policy is one of the legal values for
 * that dataset scope, `{ok:false, message}` otherwise. Used by the API
 * to reject illegal combinations at write time so the resolver never
 * has to defend against them at read time.
 */
export function validateNamespacePolicyForScope(
  scope: DatasetScope,
  policy: unknown
): NamespaceValidationResult {
  if (policy === undefined || policy === null || policy === "shared") {
    return { ok: true };
  }
  if (typeof policy !== "string") {
    return {
      ok: false,
      message: `namespace must be a string, got ${typeof policy}`
    };
  }
  const allowedForScope: Record<DatasetScope, DatasetNamespacePolicy[]> = {
    global: ["shared", "by-tenant", "by-tenant-env"],
    tenant: ["shared", "by-env"],
    environment: ["shared"]
  };
  const allowed = allowedForScope[scope];
  if (!allowed.includes(policy as DatasetNamespacePolicy)) {
    return {
      ok: false,
      message: `namespace="${policy}" is not allowed on a ${scope}-scope dataset; legal values: ${allowed.join(", ")}`
    };
  }
  return { ok: true };
}

/**
 * Slug sanitiser. Different stores have different rules (OpenSearch
 * index names can't start with `_`, Dgraph predicate names are
 * restrictive, Qdrant collection names accept most things), so we use
 * the strictest common subset: lowercase ASCII alphanumerics +
 * underscore, with anything else collapsed to a single `_` and runs
 * deduplicated. Empty result falls back to `unknown` so the suffix is
 * always present and deterministic.
 */
export function sanitiseForCollectionSuffix(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "unknown";
}

export interface ApplyNamespacePolicyArgs {
  /** The base collection / index name from `backend_collections.<modality>`. */
  baseName: string;
  /** Effective policy. `undefined` is treated as `shared`. */
  policy: DatasetNamespacePolicy | undefined;
  /** Caller's tenant slug. Required for `by-tenant` / `by-tenant-env`. */
  tenantSlug?: string;
  /** Caller's environment name. Required for `by-tenant-env` / `by-env`. */
  environmentName?: string;
}

/**
 * Apply the namespace policy to a base collection name. Returns the
 * base name unchanged when the policy is `shared` (or missing) or when
 * the required context (tenantSlug / environmentName) is absent — the
 * resolver guarantees the context is wired before calling, so a missing
 * context here means the dataset was resolved without a tenant (e.g. a
 * cluster-admin tool walking globals), in which case the safe behaviour
 * is to fall back to the base name rather than fabricate a suffix.
 */
export function applyNamespacePolicy(args: ApplyNamespacePolicyArgs): string {
  const { baseName, policy, tenantSlug, environmentName } = args;
  if (!policy || policy === "shared") return baseName;
  switch (policy) {
    case "by-tenant":
      return tenantSlug
        ? `${baseName}_${sanitiseForCollectionSuffix(tenantSlug)}`
        : baseName;
    case "by-tenant-env":
      if (!tenantSlug || !environmentName) return baseName;
      return `${baseName}_${sanitiseForCollectionSuffix(tenantSlug)}_${sanitiseForCollectionSuffix(environmentName)}`;
    case "by-env":
      return environmentName
        ? `${baseName}_${sanitiseForCollectionSuffix(environmentName)}`
        : baseName;
    default:
      // Unknown policy = treat as shared. Validation should have caught
      // this at write-time; if we reach here at resolve-time the safest
      // thing is to preserve the base name rather than throw and break
      // a running pipeline.
      return baseName;
  }
}
