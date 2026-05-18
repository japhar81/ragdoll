/**
 * Pure, DOM-free SecretRef model: map a structured SecretRef to/from a flat
 * form shape, list the valid scopes, and validate. No React/DOM imports so it
 * is unit-testable with `node --test`, zero install.
 *
 * A node's `secrets` map is `Record<string, SecretRef>`; SecretsEditor edits
 * one SecretRef per declared slot. We NEVER model or carry a secret value here
 * — only the reference (scope + key + optional provider/version).
 */
import type { SecretRef, SecretScope } from "./types.ts";

/** All scopes the platform understands, in UI display order. */
export const SECRET_SCOPES: SecretScope[] = [
  "tenant",
  "environment",
  "global",
  "tenant_provider",
  "datasource"
];

export function isSecretScope(value: unknown): value is SecretScope {
  return typeof value === "string" && (SECRET_SCOPES as string[]).includes(value);
}

/** Flat, all-strings shape a form binds to (controlled inputs/selects). */
export interface SecretRefForm {
  scope: string;
  key: string;
  provider: string;
  version: string;
}

const EMPTY_FORM: SecretRefForm = {
  scope: "tenant",
  key: "",
  provider: "",
  version: ""
};

/** SecretRef (or anything ref-shaped) -> form. Defaults to a tenant slot. */
export function refToForm(ref: Partial<SecretRef> | undefined): SecretRefForm {
  if (!ref) return { ...EMPTY_FORM };
  return {
    scope: isSecretScope(ref.scope) ? ref.scope : "tenant",
    key: typeof ref.key === "string" ? ref.key : "",
    provider: typeof ref.provider === "string" ? ref.provider : "",
    version: ref.version != null ? String(ref.version) : ""
  };
}

/**
 * Form -> SecretRef. Blank optional fields are omitted so the spec stays
 * clean. `scope`/`key` are always present (key may be empty until validated).
 */
export function formToRef(form: SecretRefForm): SecretRef {
  const ref: SecretRef = {
    scope: isSecretScope(form.scope) ? form.scope : "tenant",
    key: form.key.trim()
  };
  const provider = form.provider.trim();
  const version = form.version.trim();
  if (provider) ref.provider = provider;
  if (version) ref.version = version;
  return ref;
}

export interface SecretRefValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a form: a usable key is required, scope must be known, and
 * `tenant_provider` scope requires a provider to disambiguate.
 */
export function validateSecretRefForm(form: SecretRefForm): SecretRefValidation {
  const errors: string[] = [];
  if (!form.key.trim()) errors.push("Secret key is required.");
  if (!isSecretScope(form.scope)) errors.push(`Unknown scope "${form.scope}".`);
  if (form.scope === "tenant_provider" && !form.provider.trim()) {
    errors.push("tenant_provider scope requires a provider.");
  }
  return { valid: errors.length === 0, errors };
}

/** Short human summary for a list row, e.g. "tenant · llm.api_key". */
export function describeRef(ref: Partial<SecretRef> | undefined): string {
  const f = refToForm(ref);
  const parts = [f.scope, f.key || "(unset)"];
  if (f.provider) parts.push(`provider=${f.provider}`);
  if (f.version) parts.push(`v${f.version}`);
  return parts.join(" · ");
}
