import React from "react";
import type { JsonSchemaLike, PluginUi } from "../lib/api.ts";
import { ConfigForm } from "./ConfigForm.tsx";

/**
 * Tier-2 seam for plugin-provided custom config editors.
 *
 * If the plugin's `ui.module` is set we lazy-load that ES module and render
 * its default (or named `ConfigEditor`) export with `{ value, schema,
 * onChange }`. ANYTHING can go wrong with third-party code, so the loaded
 * editor is wrapped in a React error boundary AND the dynamic import is
 * try/caught; on import OR render failure we fall back to the built-in
 * <ConfigForm/>.
 *
 * SECURITY: `ui.module` is UNTRUSTED third-party code. It is only ever set by
 * admin-registered plugins (the registry is server-controlled) and NO plugin
 * ships one today — this is purely the wiring seam. We use a native dynamic
 * import (no single-spa, no new dependency) with `/* @vite-ignore *\/` so Vite
 * does not try to bundle/resolve the URL at build time.
 */
export interface PluginEditorSlotProps {
  value: Record<string, unknown> | undefined;
  schema: JsonSchemaLike | undefined;
  ui?: PluginUi;
  onChange: (next: Record<string, unknown>) => void;
}

interface CustomEditorModule {
  default?: React.ComponentType<CustomEditorProps>;
  ConfigEditor?: React.ComponentType<CustomEditorProps>;
}

interface CustomEditorProps {
  value: Record<string, unknown> | undefined;
  schema: JsonSchemaLike | undefined;
  onChange: (next: Record<string, unknown>) => void;
}

export function PluginEditorSlot(props: PluginEditorSlotProps) {
  const moduleUrl = props.ui?.module;
  const formHints = props.ui?.formHints;

  const fallback = (
    <ConfigForm
      value={props.value}
      schema={props.schema}
      formHints={formHints}
      onChange={props.onChange}
    />
  );

  if (!moduleUrl) return fallback;

  return (
    <CustomEditorBoundary fallback={fallback}>
      <LazyCustomEditor
        url={moduleUrl}
        value={props.value}
        schema={props.schema}
        onChange={props.onChange}
        fallback={fallback}
      />
    </CustomEditorBoundary>
  );
}

function LazyCustomEditor(props: {
  url: string;
  value: Record<string, unknown> | undefined;
  schema: JsonSchemaLike | undefined;
  onChange: (next: Record<string, unknown>) => void;
  fallback: React.ReactNode;
}) {
  const [state, setState] = React.useState<
    | { phase: "loading" }
    | { phase: "ready"; Comp: React.ComponentType<CustomEditorProps> }
    | { phase: "error" }
  >({ phase: "loading" });

  React.useEffect(() => {
    let live = true;
    setState({ phase: "loading" });
    (async () => {
      try {
        const m: CustomEditorModule = await import(
          /* @vite-ignore */ props.url
        );
        const Comp = m.default ?? m.ConfigEditor;
        if (!Comp) throw new Error("custom editor module has no default/ConfigEditor export");
        if (live) setState({ phase: "ready", Comp });
      } catch {
        if (live) setState({ phase: "error" });
      }
    })();
    return () => {
      live = false;
    };
  }, [props.url]);

  if (state.phase === "loading") return <p className="muted">Loading custom editor…</p>;
  if (state.phase === "error") return <>{props.fallback}</>;

  const { Comp } = state;
  return (
    <Comp value={props.value} schema={props.schema} onChange={props.onChange} />
  );
}

/** Class error boundary so a throwing custom editor degrades, not crashes. */
class CustomEditorBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { failed: boolean }
> {
  constructor(props: { fallback: React.ReactNode; children: React.ReactNode }) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    /* swallow: third-party editor failed; the fallback takes over */
  }
  render() {
    if (this.state.failed) return <>{this.props.fallback}</>;
    return <>{this.props.children}</>;
  }
}

export default PluginEditorSlot;
