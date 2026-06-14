# ADR 0029: cartography_crawl module outcomes — `complete` / `excluded` / `failed`

## Status

**Accepted + implemented.** Revises the post-#228 posture where every
module failure was non-fatal (which was unsafe — see Context). Adopts
the same per-collection completeness model used by `k8s_list_pull`
(ADR-0028), specialised for cartography's module structure.

Companions:
- [ADR 0025 — Neo4j driver + property-graph plugins (cartography first
  shipped here)](./0025-neo4j-driver.md)
- [ADR 0028 — k8s driver + completeness-aware list-pull](./0028-k8s-driver.md)
  (the per-collection completeness pattern this ADR follows)
- ADR-0026 §#2 (cartography in the python-plugins sidecar — handler
  location)

## Context

The post-#228 implementation made every module failure non-fatal:
exit 0 with the partial inventory and a `metadata.warning`. That
fixed the immediate "one module's `ValidationException` kills the
whole crawl" symptom but **introduced a worse failure mode**:

bulwark's Cartography projection still does full close-by-absence
against the spine — i.e. an entity present last run and absent this
run gets its `RUNS_ON` / placement edges closed. A *partial* crawl
caused by a transient blip (throttling, a 503, a network glitch
mid-page) looks **exactly like mass deletion** to that projection.
The result would be **tombstoning live assets** because RAGdoll
silently shipped partial data labelled "succeeded."

We need to distinguish two failure modes with **opposite safety
properties**:

| Outcome  | Safety property | Example |
|---|---|---|
| `complete`  | Module ran fully. Absences are real → safe to close-by-absence. | cartography exited 0; sync log shows activity. |
| `excluded`  | Module is **structurally absent** from this account/config. **The crawl is still COMPLETE for every other module** — bulwark just skips close-by-absence on the entity types this module would have collected. | `identitycenter` → `ValidationException: not supported for account instances of IAM Identity Center` on a non-org-root account. |
| `failed`    | Module *might* have produced data; absence is **not informative**. Partial → would tombstone if reconciled. | 503 throttling, network glitch, generic API error, timeout. |

The user's directive: classify the outcome, **continue on `excluded`**
(real fix for the stale-inventory symptom), but **stay fatal on
`failed`** until bulwark gates close-by-absence on per-module
completeness. **Loud failure is safer than silent partial.**

## Decisions

### 1. Three-way classification

After each module's invocation, the handler runs
`classify_module_outcome(returncode, stderr_tail)`:

- `returncode == 0` → `complete`.
- non-zero + stderr matches a known structurally-permanent pattern →
  `excluded`.
- otherwise → `failed`.

The classifier matches against a tight whitelist of substrings
(`_EXCLUDED_SUBSTRINGS` in
`services/python-plugins/app/plugins/cartography_crawl_plugin.py`).
**When in doubt, leave a pattern out** — the safety-default is
`failed`. Every entry on that list represents an operator-classified
"this error is structurally permanent for this account/config; can
never succeed here regardless of retries."

Current excluded patterns (case-insensitive substring match):

- `not supported for account instances` — AWS IAM Identity Center
  on a non-org-root account.
- `is not supported for this account` — generic AWS pattern.
- `is not supported in this region` — service unavailable in this
  region.
- `operation is not supported in this region` — operation-scoped
  variant.
- `the subscription is not registered` — Azure resource-provider
  not registered.
- `service is not supported in this region` — generic regional.
- `this api method only works on iam identity center instances of type`
  — specific identitycenter API surface.
- `has not been used in project` — GCP API not enabled for project.
- `api has not been enabled` — generic GCP "API not enabled."
- `consumer has been disabled` — GCP service-consumer disabled.

Examples of patterns DELIBERATELY NOT excluded (stay `failed` →
fatal):

- `AccessDenied` / `UnauthorizedOperation` — could be a fixable IAM
  policy gap; operator must SEE this.
- `ThrottlingException` / `RateExceeded` — transient; retry.
- `ConnectionTimeoutError` — transient.
- Timeouts (any subprocess `TimeoutExpired`) — could be slow account
  or hung sync; not informative either way.

### Known-fragile surface — audit on cloud-SDK string changes

**`_EXCLUDED_SUBSTRINGS` is a known-fragile surface.** Matching vendor
error prose by case-insensitive substring is pragmatic and honest —
it catches the strings as they actually appear today — but the
failure direction is **asymmetric and dangerous**:

- **Too STRICT** = a real `excluded` slips through as `failed` → loud
  failure. Operator notices; classifier list grows. Self-correcting.
- **Too LOOSE** = a real `failed` is misclassified `excluded` → the
  crawl reports complete-without-it → bulwark close-by-absences the
  module's entity types → **silent partial / tombstoning**. The
  exact failure mode this whole revision exists to prevent. Does not
  self-correct.

The two ways this drifts to "too loose" without anyone noticing:

1. **Vendor rewording.** AWS / GCP / Azure update an error message and
   one of our substrings now matches a *transient* error too. The
   classifier silently demotes throttling to "excluded" and bulwark
   tombstones live assets.
2. **New transient errors.** A future API throws a new transient
   exception whose message coincidentally contains one of our
   substrings (e.g. a generic "this operation is not supported in
   this region right now" 503 message).

Required audits:

- **When this list is touched at all** — re-read every entry against
  the current cloud SDK error catalogs, not the historical phrasing.
- **When a cloud SDK we use is upgraded** — sweep their changelog
  for error-message changes.
- **When a new module is added** to `CARTOGRAPHY_MODULES` — do that
  vendor's structurally-permanent errors hit any of our substrings?
  Do they need new ones?

**Prefer structured codes over prose** for any future entry. Both AWS
(`error.response['Error']['Code'] == 'ValidationException'`,
specific `Code` strings like `OptInRequired`) and GCP (the
`google.api_core.exceptions` class hierarchy +
`error.reason` / `error.details` enums) expose stable structured
codes. Cartography sometimes hides those by re-raising the underlying
`botocore.exceptions.ClientError` with the body in the message — when
the structured code IS exposed in stderr (e.g. `Error Code:
ValidationException`) match the code, not the prose. Add the structured
match alongside the prose match, then remove the prose match in a
follow-up once we're confident the structured form covers every real
occurrence.

Substring matching is what we ship today because it's what works
against the strings actually printed; the route to less fragility is
structured-code-first matching as we encounter each. Naming the
fragility here means the list gets audited by reflex when it's
touched — not trusted forever because nobody flagged it.

### 2. Per-module envelope shape

```jsonc
metadata.modules = [
  {
    "module": "aws",
    "status": "complete",
    "entityTypes": ["EC2Instance", "VPC", "S3Bucket", ...],
    "durationMs": 12340
  },
  {
    "module": "identitycenter",
    "status": "excluded",
    "reason": "ValidationException ... not supported for account instances of IAM Identity Center",
    "entityTypes": ["AWSIdentityCenter", "AWSPermissionSet", ...],
    "exitCode": 1,
    "stderrTail": "...",
    "durationMs": 1820
  },
  {
    "module": "gcp",
    "status": "failed",
    "reason": "timed out after 360s ...",
    "entityTypes": ["GCPProject", "GCPInstance", ...],
    "exitCode": -1,
    "stderrTail": "",
    "durationMs": 360000
  }
]
```

`entityTypes` is the load-bearing field for bulwark's projection:
when a module is `excluded` or `failed`, bulwark's diff **MUST refuse
close-by-absence on these entity types** for this run.

### 3. Outcome → handler behaviour

| Aggregate | Handler |
|---|---|
| Every module `complete` (with possible `excluded` ones) | Return normally. `exitCode` is the first excluded exit (or 0 if no exclusions). `excludedSummary` attached when any module excluded. |
| Any module `failed` | **Raise `ValueError`** with the full per-module breakdown in the message. The complete metadata envelope is attached as `err.metadata` so a debugger can pluck it off. |

The "fail loud" posture is intentional and stays until bulwark's
projection gates close-by-absence on per-module completeness.
**Until then, the existing crawl from the prior tick is the safest
ground truth** — better than a partial that risks tombstoning.

### 4. Why not just trust cartography's exit code?

Cartography exits 1 on the first module that raises. If we accepted
that as "the crawl failed, drop everything," we'd lose the AWS / GCP /
GitHub data when `identitycenter` couldn't run on a non-org account
— exactly the bulwark report's stale-inventory complaint. Per-module
invocation + classification lets us be precise: the structural failure
is acknowledged (and bulwark's projection knows to skip its types),
but the rest of the crawl is delivered whole.

## Verification

Tests in `services/python-plugins/tests/test_cartography_crawl.py`:

- `test_structurally_incompatible_module_is_excluded_crawl_completes`
  — the bulwark report scenario: aws + identitycenter + gcp. The
  identitycenter stderr matches `_EXCLUDED_SUBSTRINGS`; classifier
  produces `excluded`; the handler returns normally; per-module
  statuses are `["complete", "excluded", "complete"]`; entityTypes on
  every entry; `excludedSummary` attached.
- `test_excluded_recognises_each_canonical_pattern` — 5 excluded
  phrases + 3 transient counter-examples; ensures the whitelist is
  applied correctly and the safety-default holds for transient
  errors.
- `test_transient_module_failure_is_fatal_loud` — 503 mid-crawl →
  handler RAISES with the full per-module breakdown in the exception
  message + `err.metadata` carrying the envelope.
- `test_timeout_is_transient_and_therefore_fatal` — timeout is not a
  structural error; classifier produces `failed`; handler raises.
- `test_all_modules_complete_returns_normally_with_per_module_status`
  — happy path; entityTypes carried; no excludedSummary / warning.

## Future work

When bulwark ships the per-module completeness gate (refuse close-by-
absence for any entity type whose source module isn't `complete` this
tick), the handler can downgrade `failed` from "raise" to "log warning,
return partial." That is intentionally NOT done in this ADR — the
gate must come first, or the safety-property reversal we just avoided
would land.

## Amendment (Phase C1) — exposure + network-control entity types

The `MODULE_ENTITY_TYPES["aws"]` list in
`services/python-plugins/app/plugins/cartography_crawl_plugin.py` was
extended with the rows bulwark's correlation engine reads as the
**exposure** dimension of `service → endpoint → control`:

- `LoadBalancer` + `LoadBalancerV2` (classic ELB + ALB/NLB)
- `ElasticIPAddress` + `NetworkInterface` (public-reachability)
- `EC2SecurityGroup` + `IpRule` + `IpPermissionInbound` (the
  network control — rules belong with their group so a "SG present
  but missing its rules" case isn't a false-positive close)
- `WAFv2WebACL` + `WAFv2RuleGroup` (the WAF control — without
  these on the entityTypes list, bulwark's WAF-coverage scenarios
  silently couldn't gate close-by-absence on WAFv2 entities, which
  is the projection bug the Phase C1 amendment closes)

Module identifier remains `aws` — these are cartography sub-syncs
of a single AWS module, not separate modules. The list is
contracts-only: it tells bulwark "these entity types belong to a
module that this run reported as `complete`" — actual graph
writing is cartography's, not the handler's.

`NetworkPolicy` / `Ingress` / `Route` / `Service` are the analogous
**k8s** entries; those live in `BUILTIN_RESOURCES` in
`plugins/builtin-rag/src/k8s.ts` and ship per-kind `complete`
flags from `k8s_list_pull` per ADR-0028 §"Per-resource
completeness" — same shape, different surface.

## References

- ADR-0028 §"Completeness rule" — the per-collection completeness
  pattern this ADR specialises.
- ADR-0031 — wazuh-pull provenance contract (the sibling stamp on
  the wazuh side).
- Cartography module catalog — https://cartography-cncf.github.io/cartography/
- AWS IAM Identity Center API reference (`ListPermissionSets`
  ValidationException) — https://docs.aws.amazon.com/singlesignon/latest/APIReference/API_ListPermissionSets.html
