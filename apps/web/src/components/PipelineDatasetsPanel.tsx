import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api.ts";
import type { DatasetView } from "../lib/api.ts";

/**
 * Pipeline-level Datasets tab. Shows every dataset slug the spec
 * references, which nodes pin it (with alias), and lets the operator
 * edit the alias or jump to the node — all without leaving the Builder.
 *
 * Re-pinning a node to a different slug still happens in the per-node
 * Config tab (DatasetPickerSection) — this panel surfaces the cross-
 * pipeline view of bindings. The point isn't to hide that picker; it's
 * to make "which nodes touch this dataset?" a one-glance question
 * instead of a tour of every node card.
 */
export interface DatasetSlot {
  nodeId: string;
  slug: string;
  alias: string;
}

interface SlugGroup {
  slug: string;
  variants: DatasetView[];
  slots: DatasetSlot[];
}

export function PipelineDatasetsPanel(props: {
  slots: DatasetSlot[];
  onSelectNode: (nodeId: string) => void;
  onRebind: (
    nodeId: string,
    dataset: { slug: string; alias?: string } | undefined
  ) => void;
}) {
  const datasets = useQuery({
    queryKey: ["datasets-slugs"],
    queryFn: () => api.listDatasets({})
  });
  const groups = useMemo<SlugGroup[]>(() => {
    const slugMap = new Map<string, SlugGroup>();
    for (const slot of props.slots) {
      const entry = slugMap.get(slot.slug) ?? {
        slug: slot.slug,
        variants: [] as DatasetView[],
        slots: [] as DatasetSlot[]
      };
      entry.slots.push(slot);
      slugMap.set(slot.slug, entry);
    }
    for (const d of datasets.data?.datasets ?? []) {
      const entry = slugMap.get(d.slug);
      if (entry) entry.variants.push(d);
    }
    return [...slugMap.values()].sort((a, b) =>
      a.slug.localeCompare(b.slug)
    );
  }, [props.slots, datasets.data]);

  if (groups.length === 0) {
    return (
      <p className="muted">
        This pipeline doesn't pin any datasets yet. Drop a storage-touching
        node (qdrant, opensearch, …) and the picker in its Config tab will
        offer one.
      </p>
    );
  }

  return (
    <div className="pipeline-datasets-panel">
      <p className="muted" style={{ fontSize: "0.85em" }}>
        Every dataset slug referenced by this pipeline and which nodes pin
        it. Click <em>open</em> to jump to the node's Config tab; rename
        the alias inline.
      </p>
      {groups.map((group) => {
        const modalities = new Set<string>();
        for (const v of group.variants)
          for (const m of v.modalities ?? []) modalities.add(m);
        const anyVariant = group.variants[0];
        return (
          <section
            key={group.slug}
            className="settings-card"
            style={{ marginBottom: 12, padding: 10 }}
          >
            <header
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline"
              }}
            >
              <div>
                <strong>
                  <code>{group.slug}</code>
                </strong>
                <span className="muted" style={{ marginLeft: 6 }}>
                  {modalities.size > 0
                    ? [...modalities].join(" / ")
                    : "no modalities declared"}
                  {" · "}
                  {group.variants.length === 0
                    ? "no rows yet — create on deploy"
                    : `${group.variants.length} scope variant${
                        group.variants.length === 1 ? "" : "s"
                      }`}
                </span>
              </div>
              {anyVariant && (
                <Link
                  to={`/datasets/${encodeURIComponent(anyVariant.id)}`}
                  className="link-btn"
                  title="Open this dataset on the Datasets screen"
                >
                  open dataset
                </Link>
              )}
            </header>
            <table
              className="grid"
              style={{ marginTop: 6, fontSize: "0.9em" }}
            >
              <thead>
                <tr>
                  <th style={{ width: "30%" }}>Node</th>
                  <th style={{ width: "30%" }}>Alias</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {group.slots.map((slot) => (
                  <tr key={`${slot.nodeId}-${slot.slug}`}>
                    <td>
                      <code>{slot.nodeId}</code>
                    </td>
                    <td>
                      <input
                        value={slot.alias}
                        onChange={(e) =>
                          props.onRebind(slot.nodeId, {
                            slug: slot.slug,
                            alias: e.target.value || "stable"
                          })
                        }
                        style={{ width: "100%" }}
                      />
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button
                        className="link-btn"
                        onClick={() => props.onSelectNode(slot.nodeId)}
                        title="Open this node in the Inspector"
                      >
                        open
                      </button>{" "}
                      <button
                        className="link-btn danger"
                        onClick={() => props.onRebind(slot.nodeId, undefined)}
                        title="Clear the dataset pin (badge turns red until re-pinned)"
                      >
                        unbind
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
    </div>
  );
}
