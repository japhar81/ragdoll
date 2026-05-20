# Webhook Trigger

Marks the start of a pipeline that is invoked by an external HTTP POST.
The node itself simply emits the run's input payload as its output — the
actual trigger lives at `POST /api/triggers/webhook/<token>`, where the
request body becomes the run input.

Mint a token via `POST /api/pipelines/:id/triggers`; revoke with
`DELETE /api/triggers/:id`. See the [triggers admin doc](../admin/triggers.md)
for the full lifecycle.

## Inputs

The POST body of the webhook invocation.

## Outputs

The same payload, untouched. Downstream nodes consume it just like any
other source.

## Gotchas

- Putting this node on the canvas does NOT create a webhook — you still
  have to mint a trigger. It's a visual signal that this pipeline expects
  to be driven externally.
- The webhook endpoint enforces a per-token HMAC; tokens look like
  `wht_<prefix>_<secret>` and the secret half is shown only once at
  mint time.
- Use the `description` config to remind future-you (or your team) what
  payload shape this webhook accepts.

## Typical position

(Webhook Trigger) → rest of pipeline → optional Webhook Output for the
return leg
