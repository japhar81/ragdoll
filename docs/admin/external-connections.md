# External Connections (ADR-0021)

A named, RBAC'd, health-tracked pointer to an external database. Two
plugin families ship today: **MongoDB** and **ClickHouse**. The same
registry hosts the future Postgres / MySQL / Snowflake / HTTP-as-DB
families once they're added.

## Why this exists

Before ADR-0021, every pipeline node that talked to an external DB
carried its own `secrets.dsn`-shaped field. There was no shared
identity ("this is Acme's reporting warehouse"), no health, no RBAC,
no auditable usage. The connection was effectively defined by whatever
string the author typed.

The registry promotes a connection to a first-class resource — same
shape as a Dataset (ADR-0016): global / tenant / environment scopes,
slug-resolved env -> tenant -> global, owned by operators rather than
authors.

## Lifecycle

1. **Create** the connection (admin). The connection row carries the
   slug, kind, and a `secretRefId` pointing at the DSN/URI/credential.
   The secret itself lives in `secrets` and is never returned in
   responses.
2. **Reference** the connection from a pipeline node:
   ```yaml
   - id: outages
     plugin: { category: retriever, id: mongo_find, version: 1.0.0 }
     connection: { slug: acme-reporting }
     config:
       collection: outages
       filter: { project: ${input.project} }
   ```
3. **Run**. The runtime resolves the slug, fetches the secret, hands
   the plugin a `ResolvedExternalConnection`, and (defense-in-depth)
   enforces `external_connection:use` on the executing principal.

## REST surface

| Method | Path | Purpose | Permission |
|---|---|---|---|
| GET | `/api/external-connections` | List visible at caller's scope | `external_connection:read` |
| GET | `/api/external-connections/:id` | Single | `external_connection:read` |
| POST | `/api/external-connections` | Create | `external_connection:admin` |
| PUT | `/api/external-connections/:id` | Update | `external_connection:admin` |
| DELETE | `/api/external-connections/:id` | Soft-archive | `external_connection:admin` |
| POST | `/api/external-connections/:id/probe` | Health probe | `external_connection:admin` |

`external_connection:use` is enforced at pipeline execute time when a
node references a connection slug — it is NOT a REST endpoint.

## Plugin families

### MongoDB (`kind: "mongodb"`)

- `secret` → `mongodb://...` URI (credentials embedded if used)
- `options` → `{ database: string, appName?: string, maxPoolSize?: number }`
- Plugins: `mongo_find`, `mongo_insert`, `mongo_delete`, `mongo_aggregate`
- Probe: `db("admin").command({ ping: 1 })`

### ClickHouse (`kind: "clickhouse"`)

- `secret` → password (optional; default user has no password)
- `options` → `{ url: "http://host:port", database?: string, username?: string }`
- Plugins: `clickhouse_query`, `clickhouse_insert`, `clickhouse_delete`
- Probe: `client.ping()`
- Tenant safety: `clickhouse_delete` AND-s `tenant_id = {__rgd_tenant_id:String}`
  onto the user's WHERE clause by default. Override the column name via
  `tenantColumn`; set to `""` to disable (NOT recommended).

## Adding a new family

1. Pick a `kind` string (e.g. `"snowflake"`).
2. Author the plugin file in `plugins/builtin-rag/src/plugins/<kind>.ts`.
3. At module load, call `registerConnectionDriver(<kind>, { create, dispose?, probe? })`.
   - `create(conn)` builds a client from the resolved connection. Lazy-
     import the npm driver inside `create` so unit tests stay
     install-free.
   - The factory's return value is cached per `connection.id`. Two
     pipelines using the same connection share one client.
4. Export the plugin manifests from `plugins/builtin-rag/src/index.ts`.
5. Done. The registry, REST routes, RBAC, audit, and probe job all
   pick the new kind up automatically.

## Back-compat with ADR-0020 (postgres-core)

The existing `postgres-core.ts` path keeps working unchanged. A node
without a `connection:` field falls back to its legacy
`secrets.dsn`-shaped contract. Migrating a pipeline to the registry is
a one-line spec edit (`connection: { slug: ... }`); migrating
`postgres-core` itself to consume the registry is a planned follow-up.
