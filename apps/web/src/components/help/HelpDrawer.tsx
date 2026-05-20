/**
 * Right-side Help drawer that renders bundled markdown docs from
 * `docs/admin/*.md`. The left nav lists every doc; the right pane shows the
 * one you picked. Open it from the sidebar Help button or via Cmd-K
 * (`Docs · …` entries).
 *
 * Markdown rendering is `react-markdown` + `rehype-highlight` so the
 * fenced-code samples in our docs (curl / bash) get a light syntax-highlight
 * matching the slate aesthetic. No remote calls; everything is inlined at
 * build time.
 */
import React, { useEffect, useState } from "react";
import * as RDialog from "@radix-ui/react-dialog";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
// Light syntax theme for the bash / curl snippets in our docs.
import "highlight.js/styles/github.css";
import { getHelpDoc, listHelpDocs } from "../../help/docs.ts";
import type { HelpDocSlug } from "../../lib/help.ts";

export function HelpDrawer(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Doc to focus when the drawer opens. */
  slug?: HelpDocSlug | null;
}) {
  const [active, setActive] = useState<HelpDocSlug | null>(props.slug ?? null);
  useEffect(() => {
    // Whenever the requested slug changes (a new screen, or a new Cmd-K
    // selection), follow it — but let the user navigate freely afterwards.
    if (props.open && props.slug) setActive(props.slug);
  }, [props.open, props.slug]);

  const docs = listHelpDocs();
  const fallback = docs[0]?.slug ?? null;
  const current = active ?? fallback;
  const doc = current ? getHelpDoc(current) : undefined;

  return (
    <RDialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="dlg-overlay" />
        <RDialog.Content className="help-drawer" aria-describedby={undefined}>
          <header className="help-drawer-head">
            <RDialog.Title className="help-drawer-title">Help</RDialog.Title>
            <RDialog.Close asChild>
              <button className="link-btn" aria-label="Close help">
                Close
              </button>
            </RDialog.Close>
          </header>
          <div className="help-drawer-body">
            <nav className="help-drawer-nav" aria-label="Help topics">
              {docs.map((d) => (
                <button
                  key={d.slug}
                  className={
                    "help-drawer-nav-item" +
                    (d.slug === current ? " active" : "")
                  }
                  onClick={() => setActive(d.slug)}
                >
                  {d.title}
                </button>
              ))}
            </nav>
            <article className="help-drawer-md">
              {doc ? (
                <ReactMarkdown
                  rehypePlugins={[rehypeHighlight]}
                  components={{
                    a: (p) => (
                      <a
                        {...p}
                        target={p.href?.startsWith("http") ? "_blank" : undefined}
                        rel="noreferrer"
                      />
                    )
                  }}
                >
                  {doc.body}
                </ReactMarkdown>
              ) : (
                <p className="muted">No docs bundled with this build.</p>
              )}
            </article>
          </div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
