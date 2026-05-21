# Path Classifier

Splits an input documents array onto multiple named output ports based on
per-port glob patterns matched against each document's `path`. Useful for
fanning a single `filesystem_source` into a docs branch (→ OpenSearch) and
a code branch (→ Qdrant) without running two pipelines.

## Inputs

- `documents` (required) — source documents (each must carry a `path` or
  `docId`).

## Outputs

The plugin declares a fixed port set so the manifest stays static; pick
the names that fit your repo and leave unused ports unwired. Empty ports
emit `undefined`, so the runtime's skip-cascading kicks downstream
branches off the DAG.

- `docs` — documents matching the `docs` glob.
- `code` — documents matching the `code` glob.
- `tests` — documents matching the `tests` glob.
- `config` — documents matching the `config` glob.
- `other` — catch-all; defaults to `**/*`.

## Config

- `docs` — glob for the docs route (e.g. `docs/**/*.md`).
- `code` — glob for the code route (e.g. `**/*.{ts,py,go,rs}`).
- `tests` — glob for the tests route (e.g. `**/{tests,__tests__}/**`).
- `config` — glob for config files (e.g. `**/*.{json,yaml,toml}`).
- `other` (default `**/*`) — catch-all glob.

## Precedence

Each document is delivered to the **first** port whose pattern matches,
in declaration order: `docs → code → tests → config → other`. Pick your
globs with this in mind — if you want tests routed separately, exclude
them from the `code` glob (e.g. `code: "**/*.ts"` plus
`tests: "**/*.test.ts"` will route `.test.ts` to `code` because `code` is
checked first; use `code: "src/**/*.ts"` to keep them apart).

## Typical position

```
filesystem_source
  └── path_classifier
        ├── docs  → basic_text_chunker → embed → opensearch_output
        └── code  → code_chunker       → embed → qdrant_vector_store
```

## Gotchas

- The port set is fixed (`docs`, `code`, `tests`, `config`, `other`). If
  you need more buckets, chain a second `path_classifier` on `other` or
  use a custom router plugin.
- Globs follow the same subset documented in
  [`filesystem_source`](filesystem_source.md) — `**`, `*`, `?`, and
  `{a,b,c}` alternation.
