# Filesystem Source

Reads a directory tree from the **worker's** filesystem and emits one
document per file matching the include globs. The right starting point for
codebase / docs ingestion.

## Inputs

None — this is a root datasource.

## Outputs

- `documents` — array of `{ docId, path, content, mtime, sha256?, size }`.
  - `docId` and `path` are the forward-slashed path relative to `rootPath`
    (so the same docId on Windows and Linux).
  - `mtime` is the file's last-modified time as an ISO-8601 string.
  - `sha256` is present only when `computeHash: true`.
- `rootPath` — the resolved absolute root, for downstream auditing.

## Config

- `rootPath` (required) — absolute path on the worker filesystem to walk.
- `include` (default `["**/*"]`) — glob patterns; a file is included iff it
  matches at least one. Supports `**`, `*`, `?`, and `{a,b,c}` alternation.
- `exclude` — extra excludes; appended to a built-in heavy-directory
  list (`.git`, `node_modules`, `dist`, `build`, `target`, `__pycache__`,
  `.venv`, `.idea`, `.vscode`, …).
- `maxFileSize` (default 1 MiB) — files larger than this are skipped.
- `encoding` (default `utf8`) — text encoding for `readFile`.
- `computeHash` (default `false`) — compute sha256 of each file. Turn on
  when downstream [`delta_filter`](delta_filter.md) is in `hash` or
  `mtime+hash` mode.

## Security

The plugin resolves every path to absolute form and refuses to walk the
filesystem root. It double-checks that each emitted file is inside the
resolved `rootPath` after symlink resolution, so a symlink pointing outside
the tree is ignored. The worker container limits what's mountable in the
first place; treat `rootPath` as the perimeter, not the only barrier.

## Typical position

`filesystem_source` → `path_classifier` (split docs / code / tests) →
`delta_filter` (only new + modified) → chunker → embed → vector store.

## Gotchas

- **Zero documents in Kubernetes.** `rootPath` (default `/workspace`) is read
  off the *worker's* filesystem. docker-compose bind-mounts the repo there; a
  Helm worker pod has none, so the walk finds nothing and downstream chunkers
  chunk nothing. Provide the tree with the chart's `worker.workspace` knob —
  see [Kubernetes deployment → Empty crawler / chunker
  results](../admin/kubernetes-deployment.md#empty-crawler--chunker-results-in-kubernetes).
- Glob matching is a deliberate subset of minimatch — no character classes,
  no negation. If you need `!pattern`, use `exclude` instead.
- mtimes from `stat()` are millisecond-precision on most filesystems; ext4
  and APFS preserve them through normal save operations. Network mounts can
  surprise you — see [delta_filter](delta_filter.md) for the trade-offs.
