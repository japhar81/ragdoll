import React, { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type JsonSchemaLike } from "../lib/api.ts";
import {
  SECRET_SCOPES,
  formToRef,
  refToForm,
  validateSecretRefForm,
  type SecretRefForm
} from "../lib/secretRef.ts";
import type { SecretRef } from "../lib/types.ts";

/**
 * Visual secrets editor for a single node. One row per declared secret slot —
 * slot names come from the plugin's secretsSchema.properties when present,
 * else the node's existing `secrets` keys — plus an "add binding" affordance.
 *
 * Each row binds a proper SecretRef ({scope,key,provider?,version?}) into
 * `node.secrets`. A "pick existing" select is populated from GET /api/secrets
 * (metadata only — NEVER a value) and an inline mini-form can create one via
 * POST /api/secrets. No JSON anywhere.
 */
export interface SecretsEditorProps {
  secrets: Record<string, SecretRef> | undefined;
  schema: JsonSchemaLike | undefined;
  onChange: (next: Record<string, SecretRef>) => void;
}

function declaredSlots(
  schema: JsonSchemaLike | undefined,
  secrets: Record<string, SecretRef> | undefined
): string[] {
  const slots = new Set<string>();
  if (schema?.properties) for (const k of Object.keys(schema.properties)) slots.add(k);
  if (secrets) for (const k of Object.keys(secrets)) slots.add(k);
  return [...slots];
}

export function SecretsEditor({ secrets, schema, onChange }: SecretsEditorProps) {
  const slots = useMemo(
    () => declaredSlots(schema, secrets),
    [schema, secrets]
  );
  const [newSlot, setNewSlot] = useState("");

  const stored = useQuery({
    queryKey: ["secrets"],
    queryFn: () => api.listSecrets(),
    retry: false
  });

  const requiredSlots = new Set(schema?.required ?? []);

  function setSlot(name: string, ref: SecretRef) {
    onChange({ ...(secrets ?? {}), [name]: ref });
  }

  function removeSlot(name: string) {
    const next = { ...(secrets ?? {}) };
    delete next[name];
    onChange(next);
  }

  function addSlot() {
    const name = newSlot.trim();
    if (!name || slots.includes(name)) return;
    setSlot(name, { scope: "tenant", key: "" });
    setNewSlot("");
  }

  return (
    <div className="secrets-editor">
      {slots.length === 0 && (
        <p className="muted">No secret slots declared for this plugin.</p>
      )}
      {slots.map((name) => (
        <SecretSlotRow
          key={name}
          name={name}
          required={requiredSlots.has(name)}
          ref={secrets?.[name]}
          stored={stored.data?.secrets ?? []}
          storedError={stored.isError}
          onChange={(r) => setSlot(name, r)}
          onRemove={() => removeSlot(name)}
        />
      ))}
      <div className="add-secret">
        <input
          placeholder="add secret binding (name)"
          value={newSlot}
          onChange={(e) => setNewSlot(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addSlot();
            }
          }}
        />
        <button type="button" onClick={addSlot} disabled={!newSlot.trim()}>
          + Add binding
        </button>
      </div>
    </div>
  );
}

function SecretSlotRow(props: {
  name: string;
  required: boolean;
  ref: SecretRef | undefined;
  stored: Array<{ id: string; provider?: string; updatedAt?: string }>;
  storedError: boolean;
  onChange: (ref: SecretRef) => void;
  onRemove: () => void;
}) {
  const { name, required, ref, stored, storedError, onChange, onRemove } = props;
  const form = refToForm(ref);
  const validation = validateSecretRefForm(form);

  function patch(p: Partial<SecretRefForm>) {
    onChange(formToRef({ ...form, ...p }));
  }

  return (
    <div className="secret-slot">
      <div className="secret-slot-head">
        <strong>{name}</strong>
        {required && <span className="req"> *</span>}
        <button
          type="button"
          className="link-btn"
          title="Remove this binding"
          onClick={onRemove}
        >
          remove
        </button>
      </div>

      <label className="field-label">Scope</label>
      <select value={form.scope} onChange={(e) => patch({ scope: e.target.value })}>
        {SECRET_SCOPES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>

      <label className="field-label">Key</label>
      <input
        placeholder="e.g. llm.api_key"
        value={form.key}
        onChange={(e) => patch({ key: e.target.value })}
      />

      {form.scope === "tenant_provider" && (
        <>
          <label className="field-label">Provider</label>
          <input
            placeholder="e.g. openai"
            value={form.provider}
            onChange={(e) => patch({ provider: e.target.value })}
          />
        </>
      )}

      <label className="field-label">Pick existing (metadata only)</label>
      {storedError ? (
        <p className="muted">Secrets API unavailable.</p>
      ) : (
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) patch({ key: e.target.value });
          }}
        >
          <option value="">— pick a stored secret —</option>
          {stored.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id}
              {s.provider ? ` · ${s.provider}` : ""}
              {s.updatedAt ? ` · ${s.updatedAt}` : ""}
            </option>
          ))}
        </select>
      )}

      {!validation.valid && (
        <p className="error">{validation.errors.join(" ")}</p>
      )}

      <CreateSecretInline scope={form.scope} defaultKey={form.key} />
    </div>
  );
}

/**
 * Inline "create a secret" mini-form. POSTs to /api/secrets (the value is
 * write-only; the response is REDACTED and we never echo it back). On success
 * we invalidate the shared ["secrets"] query so every "pick existing" select
 * refreshes.
 */
function CreateSecretInline(props: { scope: string; defaultKey: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(props.defaultKey);
  const [value, setValue] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api.createSecret({ key: key.trim(), value, scope: props.scope }),
    onSuccess: () => {
      setValue("");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["secrets"] });
    }
  });

  if (!open) {
    return (
      <button
        type="button"
        className="link-btn"
        onClick={() => {
          setKey(props.defaultKey);
          setOpen(true);
        }}
      >
        + Create secret
      </button>
    );
  }

  return (
    <form
      className="inline-form create-secret"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <input
        placeholder="key"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        required
      />
      <input
        placeholder="value (never displayed back)"
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        required
      />
      <button type="submit" disabled={create.isPending || !key.trim()}>
        Save
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {create.isError && <span className="error">{String(create.error)}</span>}
    </form>
  );
}

export default SecretsEditor;
