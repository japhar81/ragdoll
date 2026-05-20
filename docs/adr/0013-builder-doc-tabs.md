# ADR 0013 — Builder inspector: per-node Docs tab

Status: Accepted (2026-05-20)

## Context

The Builder's right-hand inspector previously stacked five sections —
plugin ref, schema-driven config form, secrets editor, required-config /
required-secret lists, resolved config, resolved spec preview, test input —
into one long scrollable column. Newcomers had to click around or read
source to know:

- what a given plugin's inputs and outputs are,
- which config keys are *required* vs. just present in the form,
- what a minimal sample config looks like,
- and where this node typically sits in a DAG.

Field-level help (the existing `?` popovers and tooltip layer) addresses
"what is this single field for?" but not "what does this whole node do?".

## Decision

The inspector becomes a three-tab layout:

1. **Config** — the existing editor surface unchanged: plugin-ref textarea,
   schema-driven config form, secrets editor, delete button. Default tab.
2. **Resolved** — required configs/secrets list, the live resolved config
   object, resolved spec preview, and the test-input editor. All the
   "see what's actually about to run" plumbing, separated from the edit
   surface so a long config form doesn't push it offscreen.
3. **Docs** — per-plugin reference for the selected node, composed of:
   - **manifest header**: name, category, version, capabilities, mode.
   - **manifest `description`**: short authoritative one-liner.
   - **narrative markdown** from `docs/plugins/<plugin_id>.md`: inputs,
     outputs, gotchas, typical position.
   - **required-config / required-secret** lists derived live from the
     manifest's `required` arrays.
   - **field tables** for `configSchema` and `secretsSchema`: key, type,
     default, notes, with `required` chips and enum lists inline.
   - **sample JSON**: object built from each field's `default`, falling
     back to the first `enum` value when no default is set.

Schema-derived sections are NOT in the markdown — they read the manifest
at render time. Adding a config field to a plugin automatically updates
the docs tab; the markdown stays narrative-only.

## Why these three tabs (and not more)

- **Config / Resolved / Docs** maps cleanly onto the three user intents:
  *edit*, *preview*, *learn*. A fourth tab (e.g. for the test input)
  would just split the preview surface arbitrarily.
- The Resolved tab keeps the test-input editor because "I'm about to run
  this — what input am I sending?" is a preview concern, not an edit
  concern.

## Bundling strategy

Per-plugin docs are bundled via Vite's `import.meta.glob('?raw')`, the
same pattern admin docs already use (ADR 0012 / `apps/web/src/help/`).
This keeps the in-app docs offline-available and version-locked to the
deployed web bundle. No new runtime fetch.

A new pure module — `apps/web/src/lib/nodeDocs.ts` — exposes
`summarizeSchema`, `requiredFields`, and `buildSampleConfig`. DOM-free,
testable with `node --test` and zero install (matching the existing web
test pattern at `apps/web/test/`).

## Alternatives considered

- **Add the docs section to the existing single-column inspector.** Makes
  the panel even longer; the docs scroll off the top while editing.
- **Side-by-side docs drawer in the Help drawer.** The Help drawer is for
  app-level docs; per-node docs need to follow the selected node. Mixing
  the two breaks the "drawer = global" mental model.
- **Generate the narrative docs from the manifest description alone.** The
  description is one sentence; inputs / outputs / gotchas need prose. The
  markdown is small (25 files, < 1 KB each) and easy to maintain.

## Consequences

- Each new built-in plugin gets a markdown stub at
  `docs/plugins/<id>.md`. Missing docs fall back gracefully (the tab
  surfaces a "no narrative bundled" message), so there is no build-time
  enforcement — `docs/plugins/README.md` is the human checklist.
- Web bundle gains the bundled markdown (≈ 25 KB raw, gzip ≈ 8 KB) plus
  the new pure helper module. `react-markdown` and `rehype-highlight`
  are already in the dependency tree for the Help drawer.
- The previous single-column inspector layout is gone; deep-link callers
  that scripted DOM selectors against the old `<h2>Required config</h2>`
  marker need to switch to the Resolved tab.
