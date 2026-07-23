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

{{/* NATS_URL pointing at the bundled NATS service (the job queue). Empty
     when neither bundled NATS nor an external nats.url is configured — the
     worker/api then fall back to the in-process queue. */}}
{{- define "ragdoll.natsUrl" -}}
{{- if .Values.bundlednats.enabled -}}
nats://{{ .Release.Name }}-nats:4222
{{- else -}}
{{ .Values.nats.url }}
{{- end -}}
{{- end -}}

{{/* QDRANT_URL when the bundled Qdrant is on. */}}
{{- define "ragdoll.qdrantUrl" -}}
{{- if .Values.bundledqdrant.enabled -}}
http://{{ .Release.Name }}-qdrant:6333
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

{{/* OLLAMA_BASE_URL — bundled service when enabled, override otherwise. */}}
{{- define "ragdoll.ollamaBaseUrl" -}}
{{- if .Values.bundledollama.enabled -}}
http://{{ .Release.Name }}-ollama:{{ .Values.bundledollama.port }}
{{- else -}}
{{ .Values.ollama.baseUrl }}
{{- end -}}
{{- end -}}

{{/* DGRAPH_URL — bundled service when enabled, override otherwise. */}}
{{- define "ragdoll.dgraphUrl" -}}
{{- if .Values.bundleddgraph.enabled -}}
http://{{ .Release.Name }}-dgraph:{{ .Values.bundleddgraph.httpPort }}
{{- else -}}
{{ .Values.dgraph.url }}
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
{{- $nats := include "ragdoll.natsUrl" . -}}
{{- if $nats }}
# Job queue (NATS JetStream — replaced BullMQ/Redis). api enqueues, the
# worker consumes. Empty → in-process queue (single-pod only). Redis still
# backs the change bus + scheduler leader-election lease (separate URLs).
- name: NATS_URL
  value: {{ $nats | quote }}
{{- end }}
{{- $os := include "ragdoll.opensearchUrl" . -}}
{{- if $os }}
- name: OPENSEARCH_URL
  value: {{ $os | quote }}
{{- end }}
{{- $dgraph := include "ragdoll.dgraphUrl" . -}}
{{- if $dgraph }}
- name: DGRAPH_URL
  value: {{ $dgraph | quote }}
{{- end }}
- name: RAGDOLL_VECTOR_BACKEND
  value: {{ .Values.vectorBackend | quote }}
{{- $ollama := include "ragdoll.ollamaBaseUrl" . -}}
{{- if $ollama }}
# Bundled Ollama → resolved automatically; external Ollama → pin
# `ollama.baseUrl` in values. Used by api LLM/embedder calls AND by
# the worker's warm-models loop.
- name: OLLAMA_BASE_URL
  value: {{ $ollama | quote }}
{{- end }}
# OTEL metric/log/trace push path. The endpoint is always set so
# traces + logs continue to flow even when metric PUSH is off; the
# OTEL_METRICS_ENABLED flag below specifically gates only the metrics
# reader in wireOtelMetrics() (see packages/observability/src/index.ts).
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ .Values.otel.endpoint | quote }}
- name: OTEL_RESOURCE_ATTRIBUTES
  value: {{ .Values.otel.resourceAttributes | quote }}
- name: OTEL_METRICS_ENABLED
  value: {{ ternary "true" "false" (default true .Values.otel.enabled) | quote }}
# Prometheus pull path. When enabled, the OTel SDK additionally
# attaches a PrometheusExporter that starts an HTTP listener on the
# configured port and serves the SAME metric stream as the OTLP push
# (single MeterProvider, multiple readers — no double-invocation).
- name: PROMETHEUS_METRICS_ENABLED
  value: {{ ternary "true" "false" .Values.prometheus.enabled | quote }}
{{- if .Values.prometheus.enabled }}
- name: PROMETHEUS_METRICS_PORT
  value: {{ .Values.prometheus.port | quote }}
{{- end }}
{{- if .Values.pythonPlugins.enabled }}
{{- if eq .Values.pythonPlugins.mode "sidecar" }}
# Per-pod sidecar: talk to the python-plugins container co-located in THIS
# pod over localhost. A reload pushed from here reaches the exact instance
# that serves this process's plugin calls — no cross-replica fan-out. (#8)
- name: PYTHON_PLUGIN_URL
  value: "http://localhost:{{ .Values.pythonPlugins.port }}"
{{- else }}
# Standalone: the shared python-plugins Service (one instance — keep
# pythonPlugins.replicas at 1; a reload can't fan out behind a ClusterIP).
- name: PYTHON_PLUGIN_URL
  value: "http://{{ .Release.Name }}-python-plugins:{{ .Values.pythonPlugins.port }}"
{{- end }}
- name: PYTHON_PLUGIN_TIMEOUT_MS
  value: {{ .Values.pythonPlugins.timeoutMs | quote }}
{{- end }}
{{- end -}}

{{/*
Plugin cache: env + volumeMount + volume, shared by api and worker (both run
the plugin loader).

The loader clones every plugin source (git:// AND file://) into
RAGDOLL_PLUGIN_CACHE_DIR and runs `npm ci` there for any source with a
package.json. Two things must be writable: the working copies, and npm's own
cache — which npm derives from $HOME. Under OpenShift's restricted SCC the
assigned uid has no /etc/passwd entry, so $HOME is `/` and npm dies with
"EACCES mkdir /.npm". The loader now pins its npm cache under
RAGDOLL_PLUGIN_CACHE_DIR, so mounting ONE writable volume there fixes both.

Backing it with an emptyDir (rather than leaning on the container's writable
layer) means the cache is a real, size-capped volume, survives
`readOnlyRootFilesystem: true`, and is scrubbed on pod restart — a fresh clone
+ install per pod, which is what the content-addressed cache expects anyway.
Set pluginCache.medium: Memory for a tmpfs.
*/}}
{{- define "ragdoll.pluginCacheEnv" -}}
{{- if .Values.pluginCache.enabled }}
- name: RAGDOLL_PLUGIN_CACHE_DIR
  value: {{ .Values.pluginCache.path | quote }}
{{- end }}
{{- end -}}

{{- define "ragdoll.pluginCacheMount" -}}
{{- if .Values.pluginCache.enabled }}
- name: plugin-cache
  mountPath: {{ .Values.pluginCache.path | quote }}
{{- end }}
{{- end -}}

{{- define "ragdoll.pluginCacheVolume" -}}
{{- if .Values.pluginCache.enabled }}
- name: plugin-cache
  emptyDir:
    {{- with .Values.pluginCache.medium }}
    medium: {{ . | quote }}
    {{- end }}
    sizeLimit: {{ .Values.pluginCache.sizeLimit | quote }}
{{- end }}
{{- end -}}

{{/*
The python-plugins container spec, shared by the standalone Deployment
AND the per-pod sidecar injected into api/worker pods (pythonPlugins.mode
== "sidecar"). Extracted so the two render IDENTICAL containers — image,
probes, resources. Caller nindents it under a `containers:` list, e.g.
  {{- include "ragdoll.pythonPluginsContainer" . | nindent 8 }}
*/}}
{{- define "ragdoll.pythonPluginsContainer" -}}
- name: python-plugins
  image: "{{ .Values.pythonPlugins.image.repository }}:{{ .Values.pythonPlugins.image.tag }}"
  imagePullPolicy: {{ .Values.pythonPlugins.image.pullPolicy }}
  {{- with .Values.containerSecurityContext }}
  securityContext:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  ports:
    - containerPort: {{ .Values.pythonPlugins.port }}
  env:
    - name: PORT
      value: "{{ .Values.pythonPlugins.port }}"
  readinessProbe:
    httpGet:
      path: /healthz
      port: {{ .Values.pythonPlugins.port }}
    # Chromium-bearing image is slow to come up.
    initialDelaySeconds: 20
    periodSeconds: 10
  livenessProbe:
    httpGet:
      path: /healthz
      port: {{ .Values.pythonPlugins.port }}
    initialDelaySeconds: 30
    periodSeconds: 15
  resources:
    requests:
      cpu: {{ .Values.pythonPlugins.resources.requests.cpu }}
      memory: {{ .Values.pythonPlugins.resources.requests.memory }}
    limits:
      cpu: {{ .Values.pythonPlugins.resources.limits.cpu | quote }}
      memory: {{ .Values.pythonPlugins.resources.limits.memory }}
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
        if [ "$i" -gt 180 ]; then
          echo "wait-for-db-init: gave up after 180 attempts (~6m)" >&2
          exit 1
        fi
        echo "wait-for-db-init: attempt $i — schema_migrations not ready, sleeping 2s"
        sleep 2
      done
      echo "wait-for-db-init: schema ready; starting workload"
{{- end -}}
