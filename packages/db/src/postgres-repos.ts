/**
 * Postgres repository implementations — barrel re-export.
 *
 * Each repository's code lives in ./postgres/<domain>.ts (tenancy /
 * datasets / pipelines / catalog / config / observability / auth).
 * The base CRUD class + UUID helpers live in ./postgres/base.ts.
 * Re-export everything from one file so the existing import path
 * (`from "./postgres-repos.ts"`) keeps working without churn at
 * every call site.
 */
export {
  PostgresCrudRepository,
  toUuidOrNull
} from "./postgres/base.ts";

export {
  PostgresTenantRepository,
  PostgresTenantGitConfigRepository,
  PostgresEnvironmentRepository
} from "./postgres/tenancy.ts";

export {
  PostgresDatasetRepository,
  PostgresDatasetVersionRepository,
  PostgresDatasetAliasRepository
} from "./postgres/datasets.ts";

export {
  PostgresPipelineRepository,
  PostgresPipelineVersionRepository,
  PostgresPipelineDeploymentRepository,
  PostgresPipelineFolderRepository,
  PostgresPipelineActivationRepository,
  PostgresTenantPipelineRepository,
  PostgresScheduleRepository
} from "./postgres/pipelines.ts";

export {
  PostgresProviderRepository,
  PostgresProviderModelRepository,
  PostgresDatasourceConnectionRepository,
  PostgresVectorCollectionRepository
} from "./postgres/catalog.ts";

export {
  PostgresConfigDefinitionRepository,
  PostgresConfigValueRepository
} from "./postgres/config.ts";

export {
  PostgresAuditLogRepository,
  PostgresUsageRecordRepository,
  PostgresRetentionSettingsRepository,
  PostgresIngestStateRepository
} from "./postgres/observability.ts";

export {
  PostgresApiKeyRepository,
  PostgresUserRepository,
  PostgresRoleRepository,
  PostgresUserIdentityRepository,
  PostgresIdentityProviderRepository,
  PostgresRbacPolicyRepository,
  PostgresAuthSettingsRepository,
  PostgresWebhookTriggerRepository
} from "./postgres/auth.ts";
