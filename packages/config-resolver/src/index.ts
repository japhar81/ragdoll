import {
  CONFIG_SCOPE_PRECEDENCE,
  type ConfigDefinition,
  type ConfigScope,
  type ConfigValue,
  type ConfigViolation,
  type ResolvedConfig,
  type ResolvedConfigValue,
  redactValue
} from "../../core/src/index.ts";

export interface ResolveConfigInput {
  pipelineId: string;
  pipelineVersionId?: string;
  tenantId: string;
  environment: string;
  environmentId?: string;
  executionScopeId?: string;
  values: ConfigValue[];
  runtimeOverrides?: Record<string, unknown>;
}

export interface ConfigResolverOptions {
  strict?: boolean;
  redactSecrets?: boolean;
}

export class ConfigResolver {
  private definitions: Map<string, ConfigDefinition>;

  constructor(definitions: ConfigDefinition[]) {
    this.definitions = new Map(definitions.map((definition) => [definition.key, definition]));
  }

  resolve(input: ResolveConfigInput, options: ConfigResolverOptions = {}): ResolvedConfig {
    const runtimeValues: ConfigValue[] = Object.entries(input.runtimeOverrides ?? {}).map(([key, value]) => ({
      key,
      value,
      scope: "runtime" as const,
      scopeId: input.executionScopeId ?? "invocation"
    }));
    const candidateValues = [...input.values, ...runtimeValues];
    const violations: ConfigViolation[] = [];
    const values: Record<string, ResolvedConfigValue> = {};

    for (const definition of this.definitions.values()) {
      const relevant = candidateValues
        .filter((candidate) => candidate.key === definition.key)
        .filter((candidate) => this.matchesScope(candidate, input))
        .sort((left, right) => CONFIG_SCOPE_PRECEDENCE.indexOf(left.scope) - CONFIG_SCOPE_PRECEDENCE.indexOf(right.scope));

      for (const candidate of relevant) {
        violations.push(...this.validateCandidate(definition, candidate, relevant));
      }

      const applicable = relevant.filter((candidate) => !this.candidateIsRejected(definition, candidate, relevant));
      const winning = applicable.at(-1);
      const defaulted = !winning;
      const rawValue = winning ? winning.value : definition.defaultValue;

      if ((rawValue === undefined || rawValue === null) && definition.required && !definition.nullable) {
        violations.push({ key: definition.key, scope: winning?.scope ?? "global", reason: "required config value is missing" });
      }

      if (rawValue !== undefined) {
        const secret = Boolean(definition.secret || winning?.secret);
        const sensitive = Boolean(definition.sensitive || winning?.sensitive || secret);
        values[definition.key] = {
          value: secret && options.redactSecrets !== false
            ? "REDACTED"
            : sensitive && options.redactSecrets !== false
              ? redactValue(rawValue)
              : rawValue,
          sourceScope: winning?.scope ?? "global",
          sourceObjectId: winning?.scopeId,
          defaulted,
          locked: this.isLocked(definition, winning, applicable),
          secret,
          sensitive,
          redacted: (secret || sensitive) && options.redactSecrets !== false,
          inherited: winning ? winning.scope !== "runtime" : Boolean(definition.inherited ?? true)
        };
      }
    }

    if (options.strict && violations.length > 0) {
      throw new ConfigResolutionError(violations);
    }

    return {
      pipelineId: input.pipelineId,
      pipelineVersionId: input.pipelineVersionId,
      tenantId: input.tenantId,
      environment: input.environment,
      values,
      violations
    };
  }

  private matchesScope(candidate: ConfigValue, input: ResolveConfigInput): boolean {
    switch (candidate.scope) {
      case "global":
      case "runtime":
        return true;
      case "environment":
        return candidate.scopeId === input.environment || candidate.scopeId === input.environmentId;
      case "pipeline":
        return candidate.scopeId === input.pipelineId;
      case "pipeline_version":
        return candidate.scopeId === input.pipelineVersionId;
      case "tenant":
        return candidate.scopeId === input.tenantId;
      case "tenant_pipeline":
        return candidate.scopeId === `${input.tenantId}:${input.pipelineId}`;
    }
  }

  private validateCandidate(definition: ConfigDefinition, candidate: ConfigValue, allCandidates: ConfigValue[]): ConfigViolation[] {
    const violations: ConfigViolation[] = [];
    if (!definition.allowedScopes.includes(candidate.scope)) {
      violations.push({ key: candidate.key, scope: candidate.scope, reason: `scope ${candidate.scope} is not allowed` });
    }
    if (candidate.scope === "tenant" || candidate.scope === "tenant_pipeline") {
      if (!definition.tenantOverridable) {
        violations.push({ key: candidate.key, scope: candidate.scope, reason: "tenant override is not allowed" });
      }
    }
    if (candidate.scope === "runtime" && !definition.runtimeOverridable) {
      violations.push({ key: candidate.key, scope: candidate.scope, reason: "runtime override is not allowed" });
    }
    const lockedByHigherTrustScope = allCandidates.some((other) =>
      other.locked &&
      CONFIG_SCOPE_PRECEDENCE.indexOf(other.scope) < CONFIG_SCOPE_PRECEDENCE.indexOf(candidate.scope)
    );
    if (lockedByHigherTrustScope) {
      violations.push({ key: candidate.key, scope: candidate.scope, reason: "value is locked by a higher-trust scope" });
    }
    if (candidate.value === null && !definition.nullable) {
      violations.push({ key: candidate.key, scope: candidate.scope, reason: "null value is not allowed" });
    }
    if (definition.allowedValues && !definition.allowedValues.some((allowed) => Object.is(allowed, candidate.value))) {
      violations.push({ key: candidate.key, scope: candidate.scope, reason: "value is outside allowed values" });
    }
    if (!typeMatches(definition.type, candidate.value, definition.nullable)) {
      violations.push({ key: candidate.key, scope: candidate.scope, reason: `value does not match type ${definition.type}` });
    }
    return violations;
  }

  private candidateIsRejected(definition: ConfigDefinition, candidate: ConfigValue, allCandidates: ConfigValue[]): boolean {
    return this.validateCandidate(definition, candidate, allCandidates).length > 0;
  }

  private isLocked(definition: ConfigDefinition, winning: ConfigValue | undefined, applicable: ConfigValue[]): boolean {
    if (winning?.locked) return true;
    if (definition.overridable === false) return true;
    return applicable.some((candidate) => candidate.key === definition.key && candidate.locked);
  }
}

export class ConfigResolutionError extends Error {
  violations: ConfigViolation[];

  constructor(violations: ConfigViolation[]) {
    super(`Config resolution failed: ${violations.map((violation) => `${violation.key} ${violation.reason}`).join("; ")}`);
    this.name = "ConfigResolutionError";
    this.violations = violations;
  }
}

function typeMatches(type: ConfigDefinition["type"], value: unknown, nullable?: boolean): boolean {
  if (value === null || value === undefined) return Boolean(nullable || value === undefined);
  switch (type) {
    case "string":
    case "secret_ref":
      return typeof value === "string" || typeof value === "object";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
  }
}
