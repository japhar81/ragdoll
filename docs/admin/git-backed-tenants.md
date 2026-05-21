# Git-backed tenants

By default each tenant's pipelines, configs, and secrets live in
Postgres. You can flip an individual tenant to **git-backed** mode and
mirror all three to a Git repository instead — the repo becomes system
of record, the DB is a cache kept fresh by polling. This is the GitOps
workflow: every change is a commit, history is preserved per file, and
you can review diffs in a PR before they hit production.

## Repo layout

A git-mode tenant points at a single repository + branch + path
prefix. Multiple tenants can share one repo — they don't collide
because everything lives under `<tenantSlug>/<envSlug>/`.

```
{path-prefix}/
  {tenant-slug}/
    {env-slug}/
      manifest.yaml             # tenant + env header
      pipelines/
        {pipeline-slug}.yaml    # one PipelineSpec per file
      configs/
        values.yaml             # tenant- + tenant_pipeline-scoped values
      secrets/
        values.enc              # AES-256-GCM encrypted bundle (DEK in DB)
```

`pathPrefix` can be empty (repo root) or any folder string — pick
whichever fits your existing GitOps tree.

### What's in the files

- **manifest.yaml** — small header so a human cloning the repo can see
  which tenant/env they're looking at:

  ```yaml
  apiVersion: rag-platform/v1
  kind: Manifest
  tenant:
    slug: acme
    name: Acme Inc.
  environment:
    slug: dev
  format: 1
  ```

- **pipelines/&lt;slug&gt;.yaml** — full RAGdoll `PipelineSpec`, plus a
  small `metadata` header. The spec field is identical to what the
  Builder exports.

- **configs/values.yaml** — sorted list of every tenant-scoped and
  tenant-pipeline-scoped config value:

  ```yaml
  apiVersion: rag-platform/v1
  kind: ConfigValues
  values:
    - key: retrieval.top_k
      value: 5
      scope: tenant
    - key: model.temperature
      value: 0.2
      scope: tenant_pipeline
      scopeId: pipeline-uuid
  ```

- **secrets/values.enc** — opaque ciphertext:
  `base64(iv | tag | aes-256-gcm(plaintext-json))`. The key (DEK) is
  generated per tenant the first time you enable git mode, wrapped
  with the process env `SECRET_ENCRYPTION_KEY` (KEK), and stored in
  `tenant_git_configs.dek_wrapped`. Without the DB, the file is
  useless. The KEK never leaves the host.

## Enable git mode

1. Create a secret in the **Secrets** screen that holds your auth
   credential:
   - **HTTPS**: a Personal Access Token with `repo` scope (GitHub,
     GitLab, Bitbucket; or any other server's equivalent).
   - **SSH**: the PEM-encoded private key. The corresponding public
     key must be a deploy key on the repo.

   Note the secret's UUID.

2. Open the **Tenants** screen → click *Manage* on a tenant → the
   *Storage* section.

3. Fill the form:
   - **Remote URL**: `https://github.com/org/repo.git` or
     `git@github.com:org/repo.git`. (The schema selects the auth
     method automatically — pick HTTPS for the first, SSH for the
     second.)
   - **Branch**: usually `main`.
   - **Path prefix**: where in the repo this tenant lives. Can be
     empty.
   - **Auth method**: HTTPS or SSH.
   - **Auth secret UUID**: from step 1.
   - **Poll interval**: how often the worker pulls the repo (default
     60 s; min 10 s, max 1 h).

4. Click **Enable git mode**. The tenant's `storageMode` flips to
   `git` and a fresh data-encryption key is generated.

## Sync semantics

- **App → git**: today's MVP runs the reconcile on each poll tick.
  Mutations made through the API land in the DB immediately, then the
  next poll (within `pollIntervalSec`) writes them to the repo. Click
  **Sync now** to flip `last_synced_at` to the epoch so the very next
  worker tick reconciles this tenant.

- **Git → app**: the worker poller pulls every `pollIntervalSec`. The
  diff (`last_synced_sha..HEAD`) is walked, and recognized files are
  reimported into the DB. Manifest format mismatches are logged but
  don't kill the loop.

- **Conflicts**: pull-then-write-then-push. If push fails because the
  remote moved, the worker pulls --rebase and retries once. If still
  failing, the next reconcile picks up the remote-side change and
  applies it to the DB (**git wins** — matches GitOps convention).
  Every overwrite is logged via the standard audit trail
  (`tenant_git.sync`, `tenant_git.sync_failed`, `tenant_git.import_error`).

## Operational notes

- The api + worker container images bundle `git` + `openssh-client` for
  the shell-out backend; no Node-side git client is required.
- Worktrees live under `/var/lib/ragdoll/git/<tenantId>` inside each
  container. They persist across pod restarts when the directory is a
  volume.
- The auth credential (PAT or SSH key) is rendered to a per-call
  ASKPASS script / 0600 key file under the worktree and removed when
  the reconcile finishes — never written to the persistent disk.
- **Rotation**: deleting the auth secret blocks future syncs (the
  reconcile records `last_sync_error`); replace the secret and the
  next tick recovers.

## Rollback

Click **Disable git mode** on the Storage section. `storageMode` goes
back to `db`; the row in `tenant_git_configs` is dropped (including
the wrapped DEK — so the bundle in the repo becomes undecryptable
unless you saved the wrapping key). The DB copy of pipelines / configs
/ secrets is unchanged.

## Limits in this drop

- One full reconcile per tick — incremental writes are queued via the
  poll cycle rather than per-mutation. A future PR can wire a "push
  this entity" hook on each write for tighter latency.
- File deletions in the repo aren't pruned out of the DB; the next
  poller pass treats absent files as "no change" rather than "delete".
- Multi-instance deployments need leader election on the poller — same
  caveat as the existing scheduler.
