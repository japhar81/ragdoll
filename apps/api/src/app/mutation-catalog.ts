/**
 * Central map of mutating routes → their audited action, for the ADR 0036
 * PRE-lane mutation gate. The router looks up the matched (method, pattern)
 * here and runs `interceptMutation` before dispatching, so a platform plugin
 * (or gate webhook) can veto ANY resource mutation from ONE place — no
 * per-route wiring. `idParam` names the path param carrying the target id
 * (absent on creates → target id is "").
 *
 * Excluded on purpose: executions (run/ingest/invoke/stream — gated by
 * `execution.accept` instead), auth flows (login/logout/password/signup/sso),
 * self-service (`/auth/me`), non-mutations (validate/probe/refresh), and
 * event-subscription management itself (so a gate can't lock operators out).
 *
 * A few routes pick their audit action at runtime (a version save may publish
 * OR draft); they're mapped to a representative name — a hook using a glob
 * (`pipeline_version.*`, `pipeline.*`) matches regardless.
 */
export interface MutationRoute {
  action: string;
  targetType: string;
  idParam?: string;
}

export const MUTATION_ROUTES: Record<string, MutationRoute> = {
  // ---- tenants / environments / associations ----
  "POST /api/tenants": { action: "tenant.create", targetType: "tenant" },
  "PUT /api/tenants/:id": { action: "tenant.update", targetType: "tenant", idParam: "id" },
  "DELETE /api/tenants/:id": { action: "tenant.delete", targetType: "tenant", idParam: "id" },
  "PUT /api/tenants/:id/storage": { action: "tenant_git.upsert", targetType: "tenant_git_config", idParam: "id" },
  "DELETE /api/tenants/:id/storage": { action: "tenant_git.delete", targetType: "tenant_git_config", idParam: "id" },
  "POST /api/tenants/:id/storage/sync": { action: "tenant_git.sync_requested", targetType: "tenant_git_config", idParam: "id" },
  "POST /api/tenants/:id/environments": { action: "environment.create", targetType: "environment", idParam: "id" },
  "PUT /api/tenants/:id/environments/:envId": { action: "environment.update", targetType: "environment", idParam: "envId" },
  "DELETE /api/tenants/:id/environments/:envId": { action: "environment.delete", targetType: "environment", idParam: "envId" },
  "POST /api/tenants/:id/pipelines": { action: "tenant_pipeline.associate", targetType: "tenant_pipeline", idParam: "id" },
  "PATCH /api/tenants/:id/pipelines/:pid": { action: "tenant_pipeline.update", targetType: "tenant_pipeline", idParam: "pid" },
  "POST /api/tenants/:id/pipelines/:pid/activations": { action: "pipeline_activation.create", targetType: "pipeline_activation", idParam: "pid" },

  // ---- pipelines / versions / deployments / folders ----
  "POST /api/pipelines": { action: "pipeline.create", targetType: "pipeline" },
  "PUT /api/pipelines/:id": { action: "pipeline.update", targetType: "pipeline", idParam: "id" },
  "DELETE /api/pipelines/:id": { action: "pipeline.delete", targetType: "pipeline", idParam: "id" },
  "PUT /api/pipelines/:id/folder": { action: "pipeline.set_folder", targetType: "pipeline", idParam: "id" },
  "POST /api/pipelines/:id/deployments": { action: "pipeline.deploy", targetType: "pipeline_deployment", idParam: "id" },
  "DELETE /api/pipelines/:id/deployments/:envOrId": { action: "pipeline.deployment_delete", targetType: "pipeline_deployment", idParam: "envOrId" },
  "POST /api/pipelines/:id/versions": { action: "pipeline_version.save", targetType: "pipeline_version", idParam: "id" },
  "POST /api/pipelines/:id/save": { action: "pipeline_version.save", targetType: "pipeline_version", idParam: "id" },
  "POST /api/pipelines/:id/rollback": { action: "pipeline_version.rollback", targetType: "pipeline", idParam: "id" },
  "POST /api/pipelines/:id/versions/:version/archive": { action: "pipeline_version.archive", targetType: "pipeline_version", idParam: "id" },
  "POST /api/folders": { action: "pipeline_folder.create", targetType: "pipeline_folder" },
  "PUT /api/folders/:id": { action: "pipeline_folder.update", targetType: "pipeline_folder", idParam: "id" },
  "DELETE /api/folders/:id": { action: "pipeline_folder.delete", targetType: "pipeline_folder", idParam: "id" },

  // ---- schedules ----
  "POST /api/schedules": { action: "schedule.create", targetType: "schedule" },
  "PUT /api/schedules/:id": { action: "schedule.update", targetType: "schedule", idParam: "id" },
  "PATCH /api/schedules/:id": { action: "schedule.toggle", targetType: "schedule", idParam: "id" },
  "DELETE /api/schedules/:id": { action: "schedule.delete", targetType: "schedule", idParam: "id" },

  // ---- secrets ----
  "POST /api/secrets": { action: "secret.create", targetType: "secret" },
  "PUT /api/secrets/:id": { action: "secret.rotate", targetType: "secret", idParam: "id" },
  "DELETE /api/secrets/:id": { action: "secret.delete", targetType: "secret", idParam: "id" },

  // ---- users / roles / idp / api keys / auth settings ----
  "POST /api/users": { action: "user.create", targetType: "user" },
  "PATCH /api/users/:id": { action: "user.update", targetType: "user", idParam: "id" },
  "DELETE /api/users/:id": { action: "user.delete", targetType: "user", idParam: "id" },
  "POST /api/users/:id/grants": { action: "user.grant", targetType: "user", idParam: "id" },
  "DELETE /api/users/:id/grants/:grantId": { action: "user.revoke", targetType: "user", idParam: "id" },
  "POST /api/roles": { action: "role.create", targetType: "role" },
  "PUT /api/roles/:name/permissions": { action: "role.set_permissions", targetType: "role", idParam: "name" },
  "DELETE /api/roles/:name": { action: "role.delete", targetType: "role", idParam: "name" },
  "POST /api/identity-providers": { action: "idp.create", targetType: "identity_provider" },
  "PUT /api/identity-providers/:id": { action: "idp.update", targetType: "identity_provider", idParam: "id" },
  "DELETE /api/identity-providers/:id": { action: "idp.delete", targetType: "identity_provider", idParam: "id" },
  "POST /api/api-keys": { action: "apikey.create", targetType: "api_key" },
  "DELETE /api/api-keys/:id": { action: "apikey.revoke", targetType: "api_key", idParam: "id" },
  "PUT /api/auth/settings": { action: "auth.settings.update", targetType: "auth_settings" },

  // ---- datasets / bindings ----
  "POST /api/datasets": { action: "dataset.create", targetType: "dataset" },
  "PATCH /api/datasets/:id": { action: "dataset.update", targetType: "dataset", idParam: "id" },
  "DELETE /api/datasets/:id": { action: "dataset.delete", targetType: "dataset", idParam: "id" },
  "POST /api/datasets/:id/versions": { action: "dataset_version.create", targetType: "dataset_version", idParam: "id" },
  "POST /api/pipelines/:id/dataset-bindings": { action: "pipeline_dataset_binding.create", targetType: "pipeline_dataset_binding", idParam: "id" },
  "PATCH /api/dataset-bindings/:id": { action: "pipeline_dataset_binding.update", targetType: "pipeline_dataset_binding", idParam: "id" },
  "DELETE /api/dataset-bindings/:id": { action: "pipeline_dataset_binding.delete", targetType: "pipeline_dataset_binding", idParam: "id" },

  // ---- connections ----
  "POST /api/connections": { action: "connection.create", targetType: "connection" },
  "PUT /api/connections/:id": { action: "connection.update", targetType: "connection", idParam: "id" },
  "DELETE /api/connections/:id": { action: "connection.delete", targetType: "connection", idParam: "id" },

  // ---- config ----
  "PUT /api/config/definitions/:key": { action: "config_definition.upsert", targetType: "config_definition", idParam: "key" },
  "DELETE /api/config/definitions/:key": { action: "config_definition.delete", targetType: "config_definition", idParam: "key" },
  "POST /api/config/values": { action: "config_value.upsert", targetType: "config_value" },
  "DELETE /api/config/values/:id": { action: "config_value.delete", targetType: "config_value", idParam: "id" },

  // ---- webhook triggers / retention ----
  "POST /api/pipelines/:id/triggers": { action: "webhook_trigger.create", targetType: "webhook_trigger", idParam: "id" },
  "DELETE /api/triggers/:id": { action: "webhook_trigger.delete", targetType: "webhook_trigger", idParam: "id" },
  "PATCH /api/retention/:resource": { action: "retention.update", targetType: "retention", idParam: "resource" }
};
