import React, { useMemo, useState } from "react";
import type { JsonSchemaLike } from "../lib/api.ts";
import {
  applyFieldEdit,
  bindExpressionFor,
  deriveFields,
  hasUsableSchema,
  type FieldDescriptor
} from "../lib/schemaForm.ts";

/**
 * Schema-driven config editor for a single node. Renders one widget per field
 * from the plugin's configSchema; honours `ui.formHints` (e.g. range slider,
 * secret-styled input); shows descriptions as helper text; marks required.
 *
 * Each field has a "bind" toggle that swaps the typed input for a
 * `${config.<path>}` text expression (and back). A collapsible "raw JSON"
 * escape hatch always lets power users edit the whole object, kept in sync.
 *
 * If the plugin has no usable schema we fall straight back to the raw-JSON
 * editor so nothing regresses vs. the old textarea behaviour.
 */
export interface ConfigFormProps {
  value: Record<string, unknown> | undefined;
  schema: JsonSchemaLike | undefined;
  formHints?: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}

interface FieldHint {
  widget?: string;
  min?: number;
  max?: number;
  step?: number;
}

function hintFor(
  formHints: Record<string, unknown> | undefined,
  key: string
): FieldHint {
  const raw = formHints?.[key];
  if (raw && typeof raw === "object") return raw as FieldHint;
  return {};
}

export function ConfigForm({ value, schema, formHints, onChange }: ConfigFormProps) {
  const usable = hasUsableSchema(schema);
  const fields = useMemo(
    () => (usable ? deriveFields(schema, value) : []),
    [usable, schema, value]
  );
  const [showRaw, setShowRaw] = useState(!usable);

  function editField(field: FieldDescriptor, raw: unknown) {
    onChange(applyFieldEdit(value, field, raw));
  }

  if (!usable) {
    return (
      <div className="config-form">
        <p className="muted">
          No config schema for this plugin — editing raw JSON.
        </p>
        <RawJsonEditor value={value} onChange={onChange} />
      </div>
    );
  }

  return (
    <div className="config-form">
      {fields.map((field) => (
        <FieldRow
          key={field.key}
          field={field}
          hint={hintFor(formHints, field.key)}
          onChange={(raw) => editField(field, raw)}
          onBindToggle={(bind) =>
            editField(field, bind ? bindExpressionFor(field) : "")
          }
        />
      ))}
      <button
        type="button"
        className="link-btn"
        onClick={() => setShowRaw((s) => !s)}
      >
        {showRaw ? "▾ Hide raw JSON" : "▸ Edit raw JSON"}
      </button>
      {showRaw && <RawJsonEditor value={value} onChange={onChange} />}
    </div>
  );
}

function FieldRow(props: {
  field: FieldDescriptor;
  hint: FieldHint;
  onChange: (raw: unknown) => void;
  onBindToggle: (bind: boolean) => void;
}) {
  const { field, hint, onChange, onBindToggle } = props;
  const secretStyled = hint.widget === "secret";

  return (
    <div className="field-row">
      <label className="field-label">
        {field.label}
        {field.required && <span className="req"> *</span>}
        <span className="field-tools">
          {field.bound && <span className="bound-tag">bound</span>}
          <button
            type="button"
            className="link-btn"
            title="Bind this field to a ${config.*} expression"
            onClick={() => onBindToggle(!field.bound)}
          >
            {field.bound ? "unbind" : "bind"}
          </button>
        </span>
      </label>
      {field.bound ? (
        <input
          type="text"
          className="bound-input"
          value={String(field.value ?? "")}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <FieldWidget
          field={field}
          hint={hint}
          secretStyled={secretStyled}
          onChange={onChange}
        />
      )}
      {field.description && <p className="muted field-help">{field.description}</p>}
    </div>
  );
}

function FieldWidget(props: {
  field: FieldDescriptor;
  hint: FieldHint;
  secretStyled: boolean;
  onChange: (raw: unknown) => void;
}) {
  const { field, hint, secretStyled, onChange } = props;
  const v = field.value;

  if (field.kind === "boolean") {
    return (
      <input
        type="checkbox"
        checked={v === true}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }

  if (field.kind === "enum") {
    return (
      <select
        value={v == null ? "" : String(v)}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{field.required ? "— select —" : "(unset)"}</option>
        {(field.enumValues ?? []).map((opt) => (
          <option key={String(opt)} value={String(opt)}>
            {String(opt)}
          </option>
        ))}
      </select>
    );
  }

  if (
    (field.kind === "number" || field.kind === "integer") &&
    hint.widget === "range"
  ) {
    const num = typeof v === "number" ? v : Number(hint.min ?? 0);
    return (
      <span className="range-row">
        <input
          type="range"
          min={hint.min ?? 0}
          max={hint.max ?? 1}
          step={hint.step ?? (field.kind === "integer" ? 1 : 0.01)}
          value={Number.isNaN(num) ? 0 : num}
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="range-val">{Number.isNaN(num) ? "" : num}</span>
      </span>
    );
  }

  if (field.kind === "number" || field.kind === "integer") {
    return (
      <input
        type="number"
        step={field.kind === "integer" ? 1 : "any"}
        value={v == null ? "" : String(v)}
        placeholder={field.default != null ? String(field.default) : ""}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  if (field.kind === "object" || field.kind === "array-string") {
    const text =
      field.kind === "array-string" && Array.isArray(v)
        ? (v as unknown[]).join(", ")
        : v == null
          ? ""
          : typeof v === "string"
            ? v
            : JSON.stringify(v, null, 2);
    return (
      <textarea
        className="field-json"
        value={text}
        placeholder={
          field.kind === "array-string"
            ? "comma or newline separated, or a JSON array"
            : "JSON"
        }
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  // string / unknown
  return (
    <input
      type={secretStyled ? "password" : "text"}
      value={v == null ? "" : String(v)}
      placeholder={field.default != null ? String(field.default) : ""}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * The always-available power-user escape hatch. Keeps the textarea controlled
 * by a local draft so partial/invalid JSON doesn't get discarded mid-edit; on
 * every parse success we push the parsed object up.
 */
function RawJsonEditor(props: {
  value: Record<string, unknown> | undefined;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const serialized = useMemo(
    () => JSON.stringify(props.value ?? {}, null, 2),
    [props.value]
  );
  const [draft, setDraft] = useState(serialized);
  const [lastSeen, setLastSeen] = useState(serialized);
  const [err, setErr] = useState<string | undefined>();

  // Re-sync when the upstream object changes from outside this textarea.
  if (serialized !== lastSeen) {
    setLastSeen(serialized);
    setDraft(serialized);
    setErr(undefined);
  }

  return (
    <div className="raw-json">
      <textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          try {
            const parsed = JSON.parse(e.target.value || "{}");
            setErr(undefined);
            props.onChange(parsed as Record<string, unknown>);
          } catch (ex) {
            setErr(ex instanceof Error ? ex.message : "Invalid JSON");
          }
        }}
      />
      {err && <p className="error">{err}</p>}
    </div>
  );
}

export default ConfigForm;
