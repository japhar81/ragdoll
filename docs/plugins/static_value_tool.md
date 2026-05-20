# Static Value Tool

Returns a configured constant. No network, no filesystem, no surprises —
safe to drop anywhere, including in a multi-tenant config you don't fully
trust. Useful for mocking out a slow upstream during pipeline development.

## Inputs

Ignored.

## Outputs

- `result` — exactly what you put in `config.value`. String, object,
  array — whatever shape you configured.

## Gotchas

- Because the value lives in the spec, it's visible to anyone with view
  access to the pipeline. Don't stuff secrets here — use Secrets fields
  instead, or the resolved-config keys.
- Two identical static-value nodes in one pipeline emit the same payload,
  so they can stand in for a config-driven branch when designing routes.

## Typical position

Wherever a downstream node needs a placeholder upstream value during
development.
