/**
 * In-memory repository implementations — barrel re-export.
 *
 * Each domain's stores live in ./memory/<domain>.ts. The base
 * CRUD class lives in ./memory/base.ts. Re-export everything from
 * one file so the existing import path (`from "./memory.ts"`)
 * keeps working without churn at every call site.
 */
export { InMemoryCrudRepository } from "./memory/base.ts";

export {
  InMemoryTenantRepository,
  InMemoryTenantGitConfigRepository,
  InMemoryEnvironmentRepository
} from "./memory/tenancy.ts";

export {
  InMemoryDatasetRepository,
  InMemoryDatasetVersionRepository,
  InMemoryDatasetAliasRepository
} from "./memory/datasets.ts";

export {
  InMemoryPipelineRepository,
  InMemoryPipelineVersionRepository,
  InMemoryPipelineDeploymentRepository,
  InMemoryPipelineFolderRepository,
  InMemoryPipelineActivationRepository,
  InMemoryScheduleRepository,
  InMemoryTenantPipelineRepository
} from "./memory/pipelines.ts";

export {
  InMemoryPluginRepository,
  InMemoryPluginVersionRepository,
  InMemoryProviderRepository,
  InMemoryProviderModelRepository,
  InMemoryDatasourceConnectionRepository,
  InMemoryPipelineDatasetBindingRepository,
  InMemoryVectorCollectionRepository
} from "./memory/catalog.ts";

export {
  InMemoryConfigDefinitionRepository,
  InMemoryConfigValueRepository
} from "./memory/config.ts";

export {
  InMemoryAuditLogRepository,
  InMemoryUsageRecordRepository,
  InMemoryRetentionSettingsRepository,
  InMemoryExecutionStore
} from "./memory/observability.ts";

export {
  InMemoryApiKeyRepository,
  InMemoryUserRepository,
  InMemoryRoleRepository,
  InMemoryUserRoleRepository,
  InMemoryUserIdentityRepository,
  InMemoryIdentityProviderRepository,
  InMemoryRbacPolicyRepository,
  InMemoryAuthSettingsRepository,
  InMemoryWebhookTriggerRepository
} from "./memory/auth.ts";
