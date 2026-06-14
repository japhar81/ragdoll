# ADR 0032: Reference-ontology ETL — ATT&CK / D3FEND pattern

## Status

**Accepted + implemented.** Pattern documented; composing pipeline
is configured per-tenant (not bundled). The one new built-in plugin
this ADR introduces is `http_source` — the rest is composition of
existing plugins (`transform`, `delta_filter`, `neo4j_write`).

Companions:
- [ADR 0025 — Neo4j driver + property-graph plugins (the write
  target)](./0025-neo4j-driver.md)
- [ADR 0027 — Wazuh driver + pulls (estate evidence — the
  CONTRAST to this ADR's reference pattern)](./0027-wazuh-driver.md)
- [ADR 0030 — Cartography crawl provenance (estate; same
  contrast)](./0030-cartography-crawl-provenance.md)
- [ADR 0031 — Wazuh pull provenance (estate)](./0031-wazuh-pull-provenance.md)

## Context

bulwark needs ATT&CK Techniques and D3FEND Countermeasures
(+ the MITIGATES edges between them) loaded into the spine so its
correlation engine can map an observed `T1059.001` (PowerShell) to
the defensive controls that would have mitigated it. These are
**versioned reference ontologies** — vendor-published, immutable
once released. They are categorically different from estate
evidence (wazuh CVE rows, Cartography crawls of an AWS account):

| dimension                    | estate (wazuh / cartography)                    | reference (ATT&CK / D3FEND)      |
| ---------------------------- | ----------------------------------------------- | -------------------------------- |
| upstream is                  | live tenant infrastructure                      | a versioned vendor release       |
| cadence                      | minutes / hours                                 | months (per release)             |
| absence means                | "asset went away"                               | nothing — the ontology is closed |
| close-by-absence applies     | yes (ADR-0030 / ADR-0031)                       | NO                               |
| `pullId` / `crawlId` matters | yes — gates close-by-absence                    | no — versioned bundle is the id  |
| tenant boundary              | per-tenant (their estate)                       | shared (the same ATT&CK)         |
| pulls block on               | live API (Wazuh / cartography modules)          | HTTP URL                         |

These distinctions justify a **second** ETL pattern, distinct from
the wazuh/cartography evidence pattern, with explicit operator
guardrails so a future contributor doesn't accidentally apply
close-by-absence to ATT&CK and tombstone half the framework on a
HEAD-request failure.

## Decisions

### 1. Reference ETL is a composition, not a new plugin family

A reference ETL pipeline is exactly four nodes:

```
http_source  →  transform  →  delta_filter  →  neo4j_write
   ↑              ↑             ↑                 ↑
   fetch          JSONata       skip the         write nodes +
   the bundle    reshape       run on unchanged  MITIGATES edges
                 STIX 2.x or   bundles
                 OWL/JSON-LD
                 into spine
                 node + edge
                 docs
```

All four were already present except `http_source`. Justifications
for adding it (rather than overloading `github_source`):

- `github_source` is GitHub-specific — REST API + raw.github URLs
  + repo-tree enumeration. ATT&CK lives on `attack.mitre.org`'s
  own release URLs; D3FEND lives on `d3fend.mitre.org`. Bending
  github_source to "single arbitrary URL" loses every property
  that made github_source clean.
- A generic `http_source` is also useful beyond reference ETL —
  any single-URL fetch (a public STIX bundle, a vendor JSON feed)
  uses it.

### 2. `http_source` security posture

Reference URLs come from the operator at pipeline-config time. But
in a multi-tenant runtime the fetch originates from the worker
process — that's classic SSRF territory. The plugin's default
posture refuses:

- Literal RFC1918 / loopback / link-local / unspecified IPv4
  (10/8, 127/8, 169.254/16, 192.168/16, 172.16-31/12, 0.0.0.0).
- IPv6 loopback (`::1`), link-local (fe80::/10), ULA (fc00::/7).
- `localhost`, `*.local`, `*.internal`, cloud-metadata literals
  (`metadata.google.internal`, `metadata`, `169.254.169.254`).
- Non-http(s) schemes (`file://`, `ftp://`, `gopher://`, `data:`).

`allowPrivateNetworks: true` opts in to the **literal IP** range.
The always-blocked list (`localhost` + cloud-metadata literals)
stays on regardless — that override has zero legitimate use case
even on a private vendor server.

What this is NOT: a full SSRF guard. A DNS name that resolves to a
private IP slips through (DNS rebinding adds yet another layer).
For the reference-ETL use case (versioned vendor bundles from
public URLs the operator typed once) the literal-IP gate is the
load-bearing protection. If/when we open `http_source` to wider
tenant-supplied URLs, the plan is to fold in undici Agent +
connect-hook resolution-time validation.

### 3. Doc shape on the wire

`http_source` emits a **single-element array** named `documents`
— same shape as `github_source` — so the next-stage
`delta_filter` wires identically against either source. The
element:

```jsonc
{
  "docId":       "<url, or operator-supplied>",
  "url":         "<full URL>",
  "content":     "<UTF-8 body>",
  "contentType": "application/json",
  "status":      200,
  "headers":     { "etag": "\"...\"", "last-modified": "...", ... },
  "fetchedAt":   "2026-06-13T18:42:07Z"
}
```

`docId` defaults to the URL itself, which keeps version-keyed
delta detection trivial: ATT&CK release URLs embed the version
(`.../v15.1/enterprise-attack.json`), so a new release naturally
produces a new `docId`.

### 4. Composing the pipeline (the operator-facing pattern)

A representative ATT&CK pipeline spec (illustrative — operator
edits in the Builder):

```jsonc
{
  "nodes": [
    {
      "id": "fetch_attack",
      "pluginId": "http_source",
      "config": {
        "url": "https://raw.githubusercontent.com/mitre/cti/master/enterprise-attack/enterprise-attack.json",
        "acceptHeader": "application/json"
      }
    },
    {
      "id": "reshape_techniques",
      "pluginId": "transform",
      "config": {
        // JSONata reshapes STIX 2.x attack-pattern objects into the
        // spine's Technique shape. Filter to attack-patterns only;
        // pull external_id from the mitre-attack external_references
        // entry.
        "expression": "documents[0].(\n  $parse := $eval(content);\n  $parse.objects[type='attack-pattern'].{\n    'id':         id,\n    'kind':       'Technique',\n    'attackId':   external_references[source_name='mitre-attack'].external_id,\n    'name':       name,\n    'tactics':    kill_chain_phases.phase_name\n  }\n)"
      }
    },
    {
      "id": "skip_if_unchanged",
      "pluginId": "delta_filter",
      "config": { "key": "id" }
    },
    {
      "id": "write_techniques",
      "pluginId": "neo4j_write",
      "config": {
        "kind": "Technique",
        "idField": "id",
        "merge": true
      }
    }
  ],
  "edges": [
    { "from": "fetch_attack",         "to": "reshape_techniques" },
    { "from": "reshape_techniques",   "to": "skip_if_unchanged" },
    { "from": "skip_if_unchanged",    "to": "write_techniques" }
  ]
}
```

The D3FEND pipeline is the same shape with a different URL
(`https://d3fend.mitre.org/ontologies/d3fend.owl` or the JSON-LD
release) and a JSONata that emits both `Countermeasure` nodes and
`MITIGATES` edges. The Builder lets the operator save this as a
named pipeline; the scheduler runs it on a slow cron (e.g. weekly).

### 5. Provenance contract: explicitly NOT pullId/pulledAt

Reference observations carry the **bundle version** as their
provenance, not a per-run id. The URL embeds the version
(`.../v15.1/enterprise-attack.json`), `delta_filter` skips the
re-write when the docId is unchanged, and `neo4j_write` MERGEs by
`attackId`. There is no `pullId` on a Technique node and there
will not be — adding one would invite a future contributor to
write a close-by-absence rule, which is exactly the contract this
ADR forbids.

The wazuh/cartography provenance contracts (ADR-0030, ADR-0031)
are for **estate** observations; this ADR is the
acknowledgement-of-existence that a different domain takes a
different shape.

### 6. Close-by-absence is FORBIDDEN for reference observations

A future bulwark change MUST NOT apply close-by-absence to nodes
written through this pattern. The reasoning:

- A 404 on `attack.mitre.org` would tombstone half the framework.
- A new vendor release ships with techniques renamed / merged —
  the right behavior is "MERGE new + keep old until operator
  decides," not "absent → close." Bulwark surfaces drift via the
  reference UI, never via tombstones.
- The Versioned bundle IS the cutoff. "Absent from v15.1" is a
  human decision (deprecated by MITRE) recorded in the bundle,
  not an inference RAGdoll can make from a failed fetch.

This is enforced by separation, not by code: reference pipelines
write `Technique` / `Countermeasure` nodes, estate pipelines do
not. If a contributor blurs that line, the ADR is the artefact
that gets cited in the PR review.

## Verification

Tests in `plugins/builtin-rag/test/http-source.test.ts`:

- `ssrfReason: public DNS name → null (allowed)` — happy path.
- `ssrfReason: localhost is always refused, even with
  allowPrivateNetworks=true` — load-bearing always-block invariant.
- `ssrfReason: cloud metadata literals are always refused` — same
  invariant for the AWS / GCP / Azure metadata URLs.
- `ssrfReason: literal RFC1918 IPv4 → refused by default, allowed
  with allowPrivateNetworks` — each range covered explicitly,
  including the 172.16-31 boundary cases.
- `ssrfReason: 0.0.0.0 (unspecified) is refused` — bind-to-all
  guard.
- `ssrfReason: IPv6 loopback + link-local + ULA are refused; with
  brackets too` — the bracketed form `[::1]` operators paste from
  the Wazuh/k8s docs.
- `ssrfReason: .local and .internal suffixes refused` — mDNS +
  AWS-internal blind spot.
- `ssrfReason: case-insensitive` — `LocalHost` and `FE80::1` both
  refused.
- `http_source: missing / malformed / non-http(s) URL → loud error`.
- `http_source: cloud metadata URL refused even with
  allowPrivateNetworks=true` — the override does NOT relax the
  always-block list.
- `http_source: localhost URL refused even with
  allowPrivateNetworks=true` — same.
- `http_source: manifest is in the Sources palette group` — the
  PALETTE_GROUP_ORDER closed-set test from the palette ADR will
  catch a regression that drops the new plugin into "Other," but
  this catches it at the source.

The actual fetch path (timeout, maxBytes, header capture) is
covered by branch-level review rather than a stood-up local HTTP
server — `http_source` calls global `fetch` directly with no
test-injection seam and the branches are linear.

## Consequences

- Operators can ship ATT&CK + D3FEND into the spine using only
  built-in plugins. No new node category, no proto change.
- The pipeline runs on a slow cron (operator schedules
  weekly/monthly), and `delta_filter` skips the write when the
  vendor hasn't released. Cost is bounded.
- Bulwark's reference-ETL projection has a stable wire shape to
  consume — same `delta_filter` → `neo4j_write` tail every other
  graph-write pipeline uses.
- A clear contract line between estate and reference observations
  is now written down. A future "we should close-by-absence
  ATT&CK" review comment has an ADR to cite back at it.

## Future work

- A small Builder UI affordance: "this pipeline writes reference
  data — disable absence-rules" sticker. Today the boundary is
  documented and enforced by separation only.
- If a vendor ontology lands behind a paywall or requires Bearer
  auth, `http_source.config.headers` already supports `Authorization`
  — but the operator MUST resolve the secret via the
  `input.secrets` channel and splice it through a transform-by-
  config pattern. Don't put bearer tokens in the plain headers map
  — that goes to the trace UI.
- D3FEND ships OWL/JSON-LD natively. A small `owl_to_jsonld`
  transform helper might be worth pulling into builtin-rag if
  operator-authored JSONata gets too gnarly. Defer until a
  second-domain ontology shows up.

## References

- ADR-0030 §"Per-row stamping is bulwark's job" — the contrast
  shape for estate; reference uses MERGE-by-stable-id instead.
- ADR-0031 §"Per-row stamping is bulwark's job" — same.
- `plugins/builtin-rag/src/http-source.ts` — the new fetch plugin.
- `plugins/builtin-rag/src/github-source.ts` — sibling pattern;
  emission shape (`documents` single-element array) was copied
  here for downstream wiring compatibility.
- MITRE ATT&CK STIX 2.x releases —
  `https://github.com/mitre-attack/attack-stix-data`.
- MITRE D3FEND ontology — `https://d3fend.mitre.org/`.
