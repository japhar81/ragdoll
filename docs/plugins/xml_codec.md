# XML Codec

Converts between XML and JSON in either direction. Use it to ingest XML feeds,
catalogs and SOAP-style payloads into a JSON-shaped pipeline, or to emit XML
from a JSON result. Pair it with [`transform`](transform.md) to reshape the
parsed tree into whatever the next node expects.

The plugin runs one direction per node, chosen by `mode`. Only one input/output
port pair is live per mode; leave the other pair unwired.

## Modes

- **`parse`** (default) — reads an XML string on the `xml` input port and emits
  a JSON object on the `json` output port.
- **`serialize`** — reads a JSON value on the `json` input port and emits an
  XML string on the `xml` output port.

## Inputs

- `xml` — XML string to parse. Live in `parse` mode.
- `json` — JSON value to serialize. Live in `serialize` mode.

## Outputs

- `json` — parsed JSON object tree. Emitted in `parse` mode.
- `xml` — serialized XML string. Emitted in `serialize` mode.

## Config

- `mode` (default `parse`) — `parse` or `serialize`.
- `ignoreAttributes` (default `false`) — when true, XML attributes are dropped
  on parse and never written on serialize. When false, attributes round-trip
  as prefixed keys.
- `attributePrefix` (default `@_`) — key prefix for attribute-derived keys, so
  `<book id="42">` parses to `{ "book": { "@_id": "42" } }`.
- `textNodeName` (default `#text`) — key holding an element's text content when
  the element *also* has attributes or children.
- `format` (default `true`) — `serialize` only: pretty-print with indentation.
- `rootName` — `serialize` only: wrap the JSON under a single root element with
  this name. XML requires exactly one root element, so set this when the JSON
  has zero or multiple top-level keys.

## Examples

Parse an XML feed, then project items with `transform`:

```
xml_codec(parse) ──► transform ──► chunker
```

```json
// xml_codec config
{ "mode": "parse" }
// transform config (jsonata): lift <item> elements into documents
{ "inputs": ["json"], "outputs": { "documents": "json.feed.item.{ 'content': description, 'docId': guid }" } }
```

Serialize a JSON result back to XML:

```json
{ "mode": "serialize", "rootName": "response", "format": true }
```

## Typical position

```
datasource ──► xml_codec(parse) ──► transform ──► …       (XML ingestion)

…rag pipeline… ──► transform ──► xml_codec(serialize) ──► webhook_output
```

## Gotchas

- **One direction per node.** A `parse` node ignores its `json` input port and
  a `serialize` node ignores its `xml` input port — the manifest declares both
  pairs only so the builder can show them; wire the pair that matches `mode`.
- **XML has exactly one root element.** Serializing JSON with multiple
  top-level keys produces invalid XML unless you set `rootName`.
- Parsing is lenient — malformed XML yields a best-effort partial tree rather
  than an error. Validate upstream if strictness matters.
- Repeated child elements become a JSON array; a single child becomes a scalar
  or object. `<feed><item>a</item></feed>` and `<feed><item>a</item><item>b
  </item></feed>` therefore parse to different shapes — handle both in the
  downstream `transform`.
- Numbers and booleans in text content parse as strings unless your downstream
  expression coerces them.
