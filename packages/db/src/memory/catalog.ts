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


export class InMemoryDatasourceConnectionRepository
  extends InMemoryCrudRepository<T.DatasourceConnectionRow>
  implements T.DatasourceConnectionRepository
{
  constructor() {
    super("datasource_connection");
  }
  async listByTenant(tenantId: UUID): Promise<T.DatasourceConnectionRow[]> {
    return (await this.list()).filter((row) => row.tenantId === tenantId);
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

