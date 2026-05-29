{{/*
Shared template helpers for the RAGdoll chart.

Keep these short and well-named — anything that isn't reused twice is
better inlined into the template that needs it.
*/}}

{{/* Effective service-account name. */}}
{{- define "ragdoll.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (printf "%s-ragdoll" .Release.Name) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Effective Secret name used by envFrom on every workload. Matches what
the generated `secret.yaml` produces (when secrets.create) OR the
operator-supplied name (when secrets.existingSecret is set).
*/}}
{{- define "ragdoll.secretName" -}}
{{- if .Values.secrets.create -}}
{{ printf "%s-ragdoll-secrets" .Release.Name }}
{{- else -}}
{{ default "ragdoll-secrets" .Values.secrets.existingSecret }}
{{- end -}}
{{- end -}}

{{/*
DATABASE_URL the chart pushes into the generated Secret. When bundled
Postgres is on, points at the subchart's Service (named
`<release>-bundledpostgres` — Bitnami's pattern is
`<release>-<alias>`). Otherwise empty so the operator's secret
provides it.
*/}}
{{- define "ragdoll.databaseUrl" -}}
{{- if .Values.bundledpostgres.enabled -}}
{{- $user := .Values.bundledpostgres.auth.username | default "ragdoll" -}}
{{- $db := .Values.bundledpostgres.auth.database | default "ragdoll" -}}
{{- $pwd := .Values.bundledpostgres.auth.password -}}
{{- $host := printf "%s-bundledpostgres" .Release.Name -}}
postgres://{{ $user }}:{{ $pwd | urlquery }}@{{ $host }}:5432/{{ $db }}
{{- end -}}
{{- end -}}

{{/* REDIS_URL pointing at the Bitnami redis subchart. */}}
{{- define "ragdoll.redisUrl" -}}
{{- if .Values.bundledredis.enabled -}}
{{- $host := printf "%s-bundledredis-master" .Release.Name -}}
redis://{{ $host }}:6379
{{- end -}}
{{- end -}}

{{/* QDRANT_URL when the bundled Qdrant is on. */}}
{{- define "ragdoll.qdrantUrl" -}}
{{- if .Values.bundledqdrant.enabled -}}
http://ragdoll-qdrant:6333
{{- else -}}
{{ .Values.qdrant.url }}
{{- end -}}
{{- end -}}

{{/* OPENSEARCH_URL when the bundled OpenSearch is on. */}}
{{- define "ragdoll.opensearchUrl" -}}
{{- if .Values.bundledopensearch.enabled -}}
http://{{ .Release.Name }}-bundledopensearch:9200
{{- else -}}
{{ .Values.opensearch.url }}
{{- end -}}
{{- end -}}

{{/*
Common labels emitted on every resource. Merges the chart's own
identity labels (`app.kubernetes.io/managed-by`, etc.) with whatever
the operator passed in `commonLabels`. Per-resource templates set
their `app:` / `role:` labels alongside this — those land on the
SAME labels map because helm `nindent`s us inside the existing block.

If a key collides between the chart-managed defaults and operator
commonLabels, the OPERATOR wins (Kyverno policies that mandate a
specific label value can't be silently overridden by the chart).
*/}}
{{- define "ragdoll.commonLabels" -}}
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/part-of: ragdoll
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/*
Common annotations from `commonAnnotations`. Emits nothing when the
map is empty so empty-annotation blocks don't litter every manifest.
Use as:
    metadata:
      annotations:
        {{- include "ragdoll.commonAnnotations" . | nindent 4 }}
*/}}
{{- define "ragdoll.commonAnnotations" -}}
{{- with .Values.commonAnnotations -}}
{{ toYaml . }}
{{- end -}}
{{- end -}}

{{/*
Convenience block for resources whose metadata sets only the standard
labels + annotations (no per-resource extras). Use as:

    metadata:
      name: foo
      {{- include "ragdoll.metadata" . | nindent 2 }}

…which expands to:

      labels:
        app.kubernetes.io/managed-by: Helm
        ...
        <commonLabels>
      annotations:
        <commonAnnotations>     # omitted when empty

Templates that need an app-specific label (most of them) inline the
`labels:` block manually and call `ragdoll.commonLabels` to merge.
This helper is for the few resources that don't.
*/}}
{{- define "ragdoll.metadata" -}}
labels:
  {{- include "ragdoll.commonLabels" . | nindent 2 }}
{{- with (include "ragdoll.commonAnnotations" . | trim) }}
annotations:
  {{- . | nindent 2 }}
{{- end }}
{{- end -}}

{{/*
Common env vars used by api and worker. Includes wiring for every
backend the docker-compose stack passes, so the helm install mirrors
the compose install instead of falling short. Sensitive values come
from the existing Secret via envFrom on the Deployment; this block
only emits the non-secret URLs / flags.

Args: . (top-level chart values context).
*/}}
{{- define "ragdoll.commonBackendEnv" -}}
- name: QDRANT_URL
  value: {{ include "ragdoll.qdrantUrl" . | quote }}
{{- $os := include "ragdoll.opensearchUrl" . -}}
{{- if $os }}
- name: OPENSEARCH_URL
  value: {{ $os | quote }}
{{- end }}
{{- if .Values.dgraph.url }}
- name: DGRAPH_URL
  value: {{ .Values.dgraph.url | quote }}
{{- end }}
- name: RAGDOLL_VECTOR_BACKEND
  value: {{ .Values.vectorBackend | quote }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ .Values.otel.endpoint | quote }}
- name: OTEL_RESOURCE_ATTRIBUTES
  value: {{ .Values.otel.resourceAttributes | quote }}
{{- if .Values.pythonPlugins.enabled }}
- name: PYTHON_PLUGIN_URL
  value: "http://{{ .Release.Name }}-python-plugins:{{ .Values.pythonPlugins.port }}"
- name: PYTHON_PLUGIN_TIMEOUT_MS
  value: {{ .Values.pythonPlugins.timeoutMs | quote }}
{{- end }}
{{- end -}}

{{/*
Init container that polls DATABASE_URL until the schema_migrations
table exists with at least one row. That's the minimal proof that the
db-init Job has finished — every chart deployment depends on this
before starting api / worker, which lets us avoid Job-watching RBAC
plumbing.

Uses the same image as api/worker because it already has psql in path
(node-alpine-bookworm + pg, plus a tiny shell loop). Falls back to a
short max-attempt cap so a misconfigured DSN fails fast instead of
hanging forever.
*/}}
{{- define "ragdoll.waitForDbInit" -}}
- name: wait-for-db-init
  image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
  imagePullPolicy: {{ .Values.image.pullPolicy }}
  envFrom:
    - secretRef:
        name: {{ include "ragdoll.secretName" . }}
  command:
    - sh
    - -ec
    - |
      # Poll the schema_migrations table until at least one row exists
      # — proves the pre-install / pre-upgrade db-init Job finished.
      # `pg` is in the api image's node_modules; using dynamic import
      # keeps this script self-contained (no workspace TS paths).
      i=0
      until node -e "
        import('pg').then(async (pg) => {
          const p = new (pg.default?.Pool || pg.Pool)({ connectionString: process.env.DATABASE_URL });
          const r = await p.query('select 1 from schema_migrations limit 1');
          await p.end();
          if (r.rowCount === 0) process.exit(2);
        }).catch(() => process.exit(3));
      " 2>/dev/null; do
        i=$((i + 1))
        if [ "$i" -gt 60 ]; then
          echo "wait-for-db-init: gave up after 60 attempts (~2m)" >&2
          exit 1
        fi
        echo "wait-for-db-init: attempt $i — schema_migrations not ready, sleeping 2s"
        sleep 2
      done
      echo "wait-for-db-init: schema ready; starting workload"
{{- end -}}
