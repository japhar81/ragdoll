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
Common env vars used by api and worker. Includes wiring for every
backend the docker-compose stack passes, so the helm install mirrors
the compose install instead of falling short. Sensitive values come
from the existing Secret via envFrom on the Deployment; this block
only emits the non-secret URLs / flags.

Args: . (top-level chart values context).
*/}}
{{- define "ragdoll.commonBackendEnv" -}}
- name: QDRANT_URL
  value: {{ .Values.qdrant.url | quote }}
{{- if .Values.opensearch.url }}
- name: OPENSEARCH_URL
  value: {{ .Values.opensearch.url | quote }}
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
        name: {{ .Values.secrets.existingSecret }}
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
