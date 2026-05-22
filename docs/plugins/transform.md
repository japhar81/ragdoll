# Transform

Reshapes data flowing between nodes with a **JSONata** or **JMESPath**
expression. It is the pipeline's general-purpose glue: rename fields, project
arrays, aggregate, build new objects, split one payload across several
downstream branches — without writing a single-purpose plugin for each case.

It is also the deliberate, safe alternative to an "arbitrary JavaScript" node.
The expression engines evaluate against in-memory data only — there is no
`require`, no `eval`, no filesystem and no network surface — so a `transform`
is safe to expose in a shared multi-tenant runtime.

## Configurable ports

`transform` has no fixed ports. Each node defines its own:

- **Input ports** come from the `inputs` config (a list of names). Every wired
  input is delivered to the expression under its port name.
- **Output ports** come from the keys of the `outputs` config. Each output
  port gets its **own** expression and can be wired to a different downstream
  node — so one `transform` can fan a single input out into independently
  computed branches.

The builder reads these names straight from the node's config and draws a
handle per port, so renaming a port in the inspector immediately re-draws the
canvas.

## Inputs

Whatever you name in `inputs` (default: a single `in` port). The expression is
evaluated against an object whose keys are your input port names:

```
inputs: ["question", "documents"]
```

makes the expression context `{ "question": <value>, "documents": <value> }`,
so `question` selects the first port and `$count(documents)` counts the second.

## Outputs

Whatever you name as keys in `outputs` (default: a single `out` port carrying
the identity expression). Each port's value is the result of its expression.

An expression that **matches nothing yields `undefined`** — the port emits
nothing and the runtime's skip-cascading drops every node wired to it. That
makes `transform` usable as a filter or router, not just a reshaper: send a
payload to `kept` or `dropped` depending on a predicate.

## Config

- `engine` (default `jsonata`) — `jsonata` or `jmespath`. JSONata is a full
  transformation language (object construction, aggregation, conditionals,
  built-in functions); JMESPath is a smaller projection/query language. The
  engine applies to every output expression on the node.
- `inputs` (default `["in"]`) — input port names this node exposes.
- `outputs` — map of output port name → expression string. When unset, the
  node emits a single `out` port carrying the identity expression.

## Examples

Pull one field and derive another (JSONata):

```json
{
  "engine": "jsonata",
  "inputs": ["payload"],
  "outputs": {
    "title": "payload.article.title",
    "wordCount": "$count($split(payload.article.body, ' '))"
  }
}
```

Adapt a retriever's output to a prompt's `documents` port (JMESPath):

```json
{
  "engine": "jmespath",
  "inputs": ["hits"],
  "outputs": { "documents": "hits[*].{content: text, source: id}" }
}
```

Route by a predicate — only one port ends up live:

```json
{
  "inputs": ["doc"],
  "outputs": {
    "english": "doc[lang = 'en']",
    "other": "doc[lang != 'en']"
  }
}
```

## Typical position

```
retriever ──► transform ──► prompt_template      (reshape hits → context)

datasource ──► transform ──┬─► chunker            (one input, fanned out to
                           └─► metadata_sink       independently wired ports)
```

## Gotchas

- **The expression context is the inputs object, keyed by port name** — not
  the bare payload. With one input port named `in`, the identity expression
  returns `{ "in": <value> }`. Reference `in` to get the value itself.
- **Engine syntax differs.** JSONata identity is `$`, JMESPath identity is
  `@`. JSONata field access is `a.b`; JMESPath is also `a.b` but projections,
  functions and object construction differ. Pick one engine per node.
- Output values are normalised to plain JSON (objects, arrays, scalars).
  JSONata's native null-prototype objects are converted, so downstream nodes
  always get ordinary objects.
- A pathological JSONata expression (e.g. deep recursion) is bounded only by
  the execution deadline — there is no per-expression timeout. Keep
  expressions declarative.
- A bad expression fails the node with a `transform: JSONata …` /
  `transform: JMESPath …` error naming the offending expression.
