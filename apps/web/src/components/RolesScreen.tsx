import React, { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.ts";
import type { RoleView } from "../lib/api.ts";
import { Screen } from "./Screen.tsx";
import { CascadeDeleteModal } from "./CascadeDeleteModal.tsx";

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const b = e.body as { error?: string; message?: string } | undefined;
    return `HTTP ${e.status}: ${b?.message ?? b?.error ?? JSON.stringify(e.body)}`;
  }
  return e instanceof Error ? e.message : String(e);
}

function RoleCard(props: { role: RoleView; allPermissions: string[] }) {
  const qc = useQueryClient();
  const [sel, setSel] = useState<Set<string>>(new Set(props.role.permissions));
  useEffect(() => {
    setSel(new Set(props.role.permissions));
  }, [props.role.permissions]);

  const dirty =
    sel.size !== props.role.permissions.length ||
    props.role.permissions.some((p) => !sel.has(p));

  const save = useMutation({
    mutationFn: () => api.setRolePermissions(props.role.name, [...sel]),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["roles"] })
  });
  // Cascade-aware delete: the modal handles the 409 → dependents → force
  // round-trip. We just pass `doDelete` and refresh on success.
  const [deleteOpen, setDeleteOpen] = useState(false);

  function toggle(p: string) {
    const next = new Set(sel);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setSel(next);
  }

  return (
    <div className="role-card">
      <div className="role-card-head">
        <div>
          <strong>{props.role.name}</strong>{" "}
          {props.role.builtin ? (
            <span className="status">built-in</span>
          ) : (
            <span className="status status-running">custom</span>
          )}
          {props.role.description && (
            <div className="muted">{props.role.description}</div>
          )}
        </div>
        <div className="row-actions">
          <button
            className="primary"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
          {!props.role.builtin && (
            <button
              className="link-btn danger"
              onClick={() => setDeleteOpen(true)}
            >
              delete
            </button>
          )}
        </div>
      </div>
      <div className="perm-grid">
        {props.allPermissions.map((p) => (
          <label key={p} className="perm-item">
            <input
              type="checkbox"
              checked={sel.has(p)}
              onChange={() => toggle(p)}
            />
            <code>{p}</code>
          </label>
        ))}
      </div>
      {save.isError && <div className="error">{errText(save.error)}</div>}
      <CascadeDeleteModal
        open={deleteOpen}
        resourceLabel={`role "${props.role.name}"`}
        description="Deleting a role with active grants is rejected by default; force-delete revokes every grant holding the role first."
        doDelete={({ force }) => api.deleteRole(props.role.name, { force })}
        onDeleted={() => {
          setDeleteOpen(false);
          qc.invalidateQueries({ queryKey: ["roles"] });
        }}
        onClose={() => setDeleteOpen(false)}
      />
    </div>
  );
}

export function RolesScreen() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.listRoles() });

  const create = useMutation({
    mutationFn: () => api.createRole({ name, description: description || undefined }),
    onSuccess: () => {
      setName("");
      setDescription("");
      qc.invalidateQueries({ queryKey: ["roles"] });
    }
  });

  return (
    <Screen
      title="Roles & Permissions"
      isLoading={roles.isLoading}
      error={roles.error}
    >
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <input
          placeholder="new role name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <input
          placeholder="description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <button type="submit" className="primary" disabled={create.isPending}>
          Create role
        </button>
        {create.isError && <span className="error">{errText(create.error)}</span>}
      </form>

      <div className="role-list">
        {(roles.data?.roles ?? []).map((r) => (
          <RoleCard
            key={r.name}
            role={r}
            allPermissions={roles.data?.allPermissions ?? []}
          />
        ))}
      </div>
    </Screen>
  );
}
