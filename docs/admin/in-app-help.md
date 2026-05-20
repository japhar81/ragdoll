# Embedded help

This is the docs panel that opens from the Help button or by selecting any
`Docs · …` entry in the command palette. Every page-specific document lives
in `docs/admin/` in the repo; the web app bundles them in at build time, so
they're always offline-available and version-locked to your release.

## What's here

| Doc | When to open it |
| --- | --- |
| Access control · login, SSO, RBAC | Working with users, roles, identity providers, signup mode |
| Triggering pipelines | Running pipelines from the UI / REST / cron / webhooks / CLI / MCP |
| ragdoll CLI | Shell automation, CI, exporting data |
| MCP endpoint | Wiring an LLM client to operate the platform |
| Governance & security | Audit, secrets, tenant isolation, RBAC reference |

## Three help surfaces

The app has three discovery layers, each with a different commitment:

- **Tooltips & `?` field help.** Hover any icon or click the "?" beside a
  form field for short, contextual help. Most form descriptions come straight
  from the API's JSON-Schema / OpenAPI definitions.
- **Command palette (`⌘K` / `Ctrl-K`).** Type to jump to any screen, kick off
  a common action ("Create a pipeline", "Mint a webhook trigger"), or open
  one of these docs. Items are permission-gated — you only ever see actions
  the server will accept.
- **This Help drawer.** The button next to your account in the sidebar opens
  it pre-tuned to the page you're on. Use the navigator on the left to jump
  between topics.

## Keyboard shortcuts

Press **`?`** anywhere outside a text field for the full list. The most
useful are:

- `⌘K` / `Ctrl-K` — command palette
- `?` — keyboard shortcuts overlay
- `g p` — go to Pipelines
- `g s` — go to Scheduler
- `g e` — go to Executions
- `g u` — go to Users
- `Esc` — close any overlay

## Where the source lives

Every doc you read here lives at `docs/admin/<slug>.md` in the repo. PRs to
that directory ship to the in-app drawer on the next build, no extra step.
