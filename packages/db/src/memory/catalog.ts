/**
 * In-memory repositories — catalog domain.
 *
 * Extracted from memory.ts so each domain's in-memory store lives
 * next to its sibling repos. The public barrel (memory.ts) re-exports
 * everything here so the existing import path keeps working.
 */
import { randomUUID } from "node:crypto";
import type { ExecutionNodeRecord, ExecutionRecord, ExecutionStore } from "../../../runtime/src/index.ts";
import type { UsageRecord, UUID } from "../../../core/src/index.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import { InMemoryCrudRepository } from "./base.ts";
import type * as T from "../types.ts";


export class InMemoryPluginRepository
  extends InMemoryCrudRepository<T.PluginRow>
  implements T.PluginRepository
{
  constructor() {
    super("plugin");
  }
  async findByPluginId(
    pluginId: string,
    category: T.PluginRow["category"]
  ): Promise<T.PluginRow | undefined> {
    return (await this.list()).find(
      (row) => row.pluginId === pluginId && row.category === category
    );
  }
}


export class InMemoryPluginVersionRepository
  extends InMemoryCrudRepository<T.PluginVersionRow>
  implements T.PluginVersionRepository
{
  constructor() {
    super("plugin_version");
  }
  async listByPlugin(pluginId: UUID): Promise<T.PluginVersionRow[]> {
    return (await this.list()).filter((row) => row.pluginId === pluginId);
  }
}


export class InMemoryProviderRepository
  extends InMemoryCrudRepository<T.ProviderRow>
  implements T.ProviderRepository
{
  constructor() {
    super("provider");
  }
  async findByProviderId(providerId: string): Promise<T.ProviderRow | undefined> {
    return (await this.list()).find((row) => row.providerId === providerId);
  }
}


export class InMemoryProviderModelRepository
  extends InMemoryCrudRepository<T.ProviderModelRow>
  implements T.ProviderModelRepository
{
  constructor() {
    super("provider_model");
  }
  async listByProvider(providerId: UUID): Promise<T.ProviderModelRow[]> {
    return (await this.list()).filter((row) => row.providerId === providerId);
  }
}


// InMemoryDatasourceConnectionRepository is gone — superseded by
// InMemoryConnectionRepository in ./connections.ts (ADR-0023).


export class InMemoryPipelineDatasetBindingRepository
  extends InMemoryCrudRepository<T.PipelineDatasetBindingRow>
  implements T.PipelineDatasetBindingRepository
{
  constructor() {
    super("pipeline_dataset_binding");
  }
  async listByPipeline(pipelineId: UUID): Promise<T.PipelineDatasetBindingRow[]> {
    return (await this.list()).filter((r) => r.pipelineId === pipelineId);
  }
  async resolveBinding(args: {
    pipelineId: UUID;
    tenantId: UUID;
    environmentId?: string;
    sourceSlug: string;
  }): Promise<T.PipelineDatasetBindingRow | undefined> {
    const candidates = (await this.list()).filter(
      (r) =>
        r.pipelineId === args.pipelineId &&
        r.tenantId === args.tenantId &&
        r.sourceSlug === args.sourceSlug
    );
    // env-specific row beats env=null row.
    return (
      candidates.find((r) => r.environmentId === args.environmentId) ??
      candidates.find((r) => r.environmentId === null || r.environmentId === undefined)
    );
  }
}


export class InMemoryVectorCollectionRepository
  extends InMemoryCrudRepository<T.VectorCollectionRow>
  implements T.VectorCollectionRepository
{
  constructor() {
    super("vector_collection");
  }
  async findByName(collectionName: string): Promise<T.VectorCollectionRow | undefined> {
    return (await this.list()).find((row) => row.collectionName === collectionName);
  }
  async listByTenantPipeline(
    tenantId: UUID,
    pipelineId: UUID,
    environment: string
  ): Promise<T.VectorCollectionRow[]> {
    return (await this.list()).filter(
      (row) =>
        row.tenantId === tenantId &&
        row.pipelineId === pipelineId &&
        row.environment === environment
    );
  }
}

