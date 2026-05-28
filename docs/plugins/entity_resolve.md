# entity_resolve

Normalises free-text mentions against an authoritative canonical list.
Exact match first, then alias match, then fuzzy (Damerau-Levenshtein
similarity). An optional LLM fallback handles the long tail of
ambiguous mentions.

## Inputs

- **`records`** *(required)* — records with mentions to resolve. Each
  must carry the configured `mentionField` (default `mention`).
- **`canonical`** *(optional)* — the canonical entity list. When
  omitted here, falls back to `config.canonical` (inline) — supply ONE
  of the two; the inline form takes precedence.

## Outputs

- **`records`** — resolved records, each augmented with `entityId`,
  `entityName`, `matchScore`, and `matchMethod` (`"exact"` / `"fuzzy"`
  / `"llm"`).
- **`unresolved`** — records whose mention couldn't be confidently
  resolved.

## Gotchas

- **The fuzzy scorer is O(n × m)** for n mentions and m canonical
  entries. For large catalogs (>10k), pre-filter via `postgres_query`
  (e.g. by first letter or token) before this plugin.
- **LLM fallback truncates the catalog to 200 entries.** The model
  can't reliably pick from a longer list in one prompt; for bigger
  catalogs the operator should narrow upstream.
- **Exact match always wins over fuzzy**, regardless of fuzzy score.
- **Alias matching is structural.** The matcher checks every
  configured `matchFields` entry; arrays are flattened, so an
  entity's `aliases: ["acme-prod", "acme"]` produces two separate
  match candidates.

## Typical position

Right after `extract_entities`, before any write that should reference
the canonical entity id rather than the free-text mention.

```
extract_entities → entity_resolve → postgres_upsert(facts_table)
```
