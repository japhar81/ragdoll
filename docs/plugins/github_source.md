# GitHub Source

Pulls a GitHub repository tree at a given ref and emits one document
per file under the include / exclude globs. Drop-in alternative to
`filesystem_source` when the corpus lives on GitHub rather than the
worker's local disk.

## Inputs

None — this is a root datasource.

## Outputs

- `documents` — array of `{ docId, path, content, mtime, sha256?, size }`.
  - `docId` / `path` are the forward-slashed path relative to the repo root.
  - `mtime` is stamped at fetch time (GitHub's tree response doesn't
    expose per-file mtimes cheaply); pair this plugin with
    `delta_filter` in **hash** mode rather than mtime mode.
  - `sha256` is present only when `computeHash: true`.
- `repo` — the resolved `owner/name@ref`, for downstream auditing.

## Config

- `repo` (required) — `owner/name`, e.g. `anthropics/claude-code`.
- `ref` (default `main`) — branch, tag, or commit SHA. Forwarded to
  the GitHub API's `/git/trees/{ref}` and to
  `raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}` for content.
- `include` (default `["**/*"]`) — glob patterns; a file is included
  iff it matches at least one. Supports `**`, `*`, `?`, and `{a,b,c}`.
- `exclude` — extra excludes; appended to a built-in list covering
  `.git`, `node_modules`, `dist`, `build`, `__pycache__`, etc. plus
  common binary file extensions (images, archives, native binaries,
  fonts, sqlite, git pack files).
- `maxFileSize` (default 1 MiB) — files larger than this are skipped
  before content is fetched (the tree carries `size`, so big blobs
  cost zero round-trips).
- `computeHash` (default `false`) — adds a `sha256` field to each
  document so a downstream `delta_filter` can use content-hash mode.

## Secrets

- `token` — a GitHub personal access token (classic or
  fine-grained). **Optional for public repos** (the anonymous rate
  limit is 60 requests/hour); required for private repos.

## Cost shape

Two phases:

1. One `GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1` to
   list every blob in the tree.
2. One `GET https://raw.githubusercontent.com/.../{path}` per file
   that survives the include / exclude filter + maxFileSize cap.

For a 1k-file repo with default globs, that's 1 API call + ~1k raw
fetches. Sequential to avoid GitHub's secondary rate limit; supplying
a token lifts the limits to 5k/hr.

## When to use

- Indexing GitHub-hosted code or docs without needing the repo on
  the worker's local disk.
- Pulling a curated subset of files (set `include` to e.g.
  `["docs/**/*.md", "README.md"]`).
- Snapshotting a repo at a specific tag for compliance reasons.

## When NOT to use

- High-frequency polling of a private repo — burn through your token's
  rate limit fast. Use a webhook + the filesystem path on a checked-out
  worker instead.
- Repos with > 100k entries — GitHub truncates the recursive tree
  response. The plugin logs a warning but only ingests the partial
  list; clone the repo and use `filesystem_source` instead.

## NUL / binary handling

Same logic as `filesystem_source`: when a file decodes to text whose
NUL-density exceeds the threshold (max(8, 1% of bytes)), the plugin
skips it. Below the threshold, stray NULs are scrubbed to `U+FFFD`
before storage so Postgres JSONB writes don't 22P02.
