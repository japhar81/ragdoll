/**
 * Builder JSON view — an editable, syntax-highlighted CodeMirror 6 editor over
 * the pipeline spec that runs the SAME `validatePipelineSpec` the visual builder
 * runs (live, inline) and applies valid edits back onto the canvas.
 *
 * Why this exists: patching a node (e.g. adding a `connection` to a sink) meant
 * pulling the spec via the API, editing, and POSTing it back. This gives the
 * round-trip in-app, gated by identical validation.
 *
 * Design notes:
 *   - The CodeMirror view is created once on mount; live values (validator,
 *     completion lists, onChange) are read through refs so the extensions never
 *     go stale without recreating the editor.
 *   - The parent re-seeds by remounting (a `key` bump), so `initialDoc` is only
 *     read at mount — no controlled-doc fight with the user's typing.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { ValidationIssue } from "../../../../packages/pipeline-spec/src/index.ts";
import type { PipelineSpec } from "../lib/types.ts";
import {
  detectCompletion,
  issuesToRanges,
  parsePipelineJson,
  specToPrettyJson
} from "../lib/pipelineJson.ts";

export interface PipelineJsonEditorProps {
  /** Seed document (current spec as pretty JSON). Read only at mount. */
  initialDoc: string;
  /** Lifted on every edit so the parent can preserve the draft across tabs. */
  onChange: (text: string) => void;
  /** The SAME validator the visual builder uses; null while plugins load. */
  validate: (parsed: unknown) => { errors: ValidationIssue[]; warnings: ValidationIssue[] } | null;
  /** Completion lists for the two fields operators patch by hand. */
  connectionSlugs: string[];
  pluginIds: string[];
  /** Apply the parsed spec back onto the canvas. */
  onApply: (spec: PipelineSpec) => void;
  /** Re-seed the editor from the current canvas (discards unapplied edits). */
  onReload: () => void;
  /** Surfaced under the editor when Apply couldn't hydrate the canvas. */
  applyError?: string | null;
}

interface Summary {
  parseError: string | null;
  errors: number;
  warnings: number;
}

export function PipelineJsonEditor(props: PipelineJsonEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Live refs so the once-built extensions always see current props.
  const validateRef = useRef(props.validate);
  const connsRef = useRef(props.connectionSlugs);
  const pluginsRef = useRef(props.pluginIds);
  const onChangeRef = useRef(props.onChange);
  validateRef.current = props.validate;
  connsRef.current = props.connectionSlugs;
  pluginsRef.current = props.pluginIds;
  onChangeRef.current = props.onChange;

  const [summary, setSummary] = useState<Summary>({ parseError: null, errors: 0, warnings: 0 });

  const recomputeSummary = useMemo(
    () =>
      (text: string) => {
        const parsed = parsePipelineJson(text);
        if (!parsed.ok) {
          setSummary({ parseError: parsed.error, errors: 0, warnings: 0 });
          return;
        }
        const result = validateRef.current(parsed.spec);
        setSummary({
          parseError: null,
          errors: result?.errors.length ?? 0,
          warnings: result?.warnings.length ?? 0
        });
      },
    []
  );

  useEffect(() => {
    if (!hostRef.current) return;

    const parseLint = jsonParseLinter();
    const semanticLinter = linter((view): Diagnostic[] => {
      const text = view.state.doc.toString();
      // Precise JSON syntax errors win — no point running the semantic pass on
      // a doc that doesn't parse.
      const syntax = parseLint(view);
      if (syntax.length > 0) return syntax;
      const parsed = parsePipelineJson(text);
      if (!parsed.ok) {
        return [{ from: 0, to: Math.min(text.length, 1), severity: "error", message: parsed.error }];
      }
      const result = validateRef.current(parsed.spec);
      if (!result) return [];
      return issuesToRanges(text, [...result.errors, ...result.warnings]).map((r) => ({
        from: r.from,
        to: r.to,
        severity: r.severity,
        message: `[${r.code}] ${r.message}`
      }));
    });

    const complete = (ctx: CompletionContext): CompletionResult | null => {
      const prefix = ctx.state.sliceDoc(0, ctx.pos);
      const target = detectCompletion(prefix);
      if (!target) return null;
      const list = target.kind === "connection" ? connsRef.current : pluginsRef.current;
      if (list.length === 0) return null;
      return {
        from: target.from,
        options: list.map((label) => ({
          label,
          type: target.kind === "connection" ? "variable" : "function"
        })),
        validFor: /^[a-zA-Z0-9_.-]*$/
      };
    };

    const jsonSupport = json();
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: props.initialDoc,
        extensions: [
          basicSetup,
          jsonSupport,
          // Register our completion source on the JSON language so
          // basicSetup's autocompletion picks it up (no second config).
          jsonSupport.language.data.of({ autocomplete: complete }),
          lintGutter(),
          semanticLinter,
          EditorView.theme({
            "&": { height: "100%", fontSize: "13px" },
            ".cm-scroller": {
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              lineHeight: "1.5"
            },
            "&.cm-focused": { outline: "none" }
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              const text = u.state.doc.toString();
              onChangeRef.current(text);
              recomputeSummary(text);
            }
          })
        ]
      })
    });
    viewRef.current = view;
    recomputeSummary(props.initialDoc);
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Mount-once: initialDoc is intentionally read only here (see file header).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apply = () => {
    const text = viewRef.current?.state.doc.toString() ?? props.initialDoc;
    const parsed = parsePipelineJson(text);
    if (!parsed.ok) {
      setSummary((s) => ({ ...s, parseError: parsed.error }));
      return;
    }
    props.onApply(parsed.spec);
  };

  const format = () => {
    const view = viewRef.current;
    if (!view) return;
    const parsed = parsePipelineJson(view.state.doc.toString());
    if (!parsed.ok) return; // can't format invalid JSON — the marker already shows why
    const pretty = specToPrettyJson(parsed.spec);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: pretty }
    });
  };

  const clean = summary.parseError === null && summary.errors === 0;

  return (
    <div className="pjson-view">
      <div className="pjson-editor" ref={hostRef} />
      <div className="pjson-footer">
        <div className="pjson-status">
          {summary.parseError ? (
            <span className="pjson-badge pjson-badge-error">Invalid JSON — {summary.parseError}</span>
          ) : (
            <>
              <span
                className={"pjson-badge " + (summary.errors > 0 ? "pjson-badge-error" : "pjson-badge-ok")}
              >
                {summary.errors} {summary.errors === 1 ? "error" : "errors"}
              </span>
              <span
                className={
                  "pjson-badge " + (summary.warnings > 0 ? "pjson-badge-warn" : "pjson-badge-ok")
                }
              >
                {summary.warnings} {summary.warnings === 1 ? "warning" : "warnings"}
              </span>
              <span className="pjson-hint">validated by the same rules as the canvas</span>
            </>
          )}
        </div>
        <div className="pjson-actions">
          <button type="button" className="link-btn" onClick={format} title="Reformat / pretty-print">
            Format
          </button>
          <button
            type="button"
            className="link-btn"
            onClick={props.onReload}
            title="Reload the JSON from the current canvas (discards unapplied edits here)"
          >
            Reload from canvas
          </button>
          <button
            type="button"
            className="primary"
            onClick={apply}
            disabled={summary.parseError !== null}
            title={
              clean
                ? "Apply this JSON to the canvas"
                : "Applies even with validation errors — the canvas shows them too; Save/Publish stay gated"
            }
          >
            Apply to canvas
          </button>
        </div>
      </div>
      {props.applyError && <p className="error pjson-apply-error">{props.applyError}</p>}
    </div>
  );
}
