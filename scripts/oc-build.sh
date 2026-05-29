#!/usr/bin/env bash
# Generic OpenShift in-cluster Docker-build helper. Builds an image
# from the repo root, with a configurable Dockerfile path + image name.
#
# Defaults: ragdoll-python-plugins from services/python-plugins/Dockerfile.
# Override via env or by symlinking + setting NAME/DOCKERFILE.
#
# Why an in-cluster build vs `docker build && docker push`:
#   - No host Docker daemon required (works under Podman / Lima / WSL).
#   - No external registry credentials / mirror config — the cluster
#     already has push access to its own internal registry.
#   - Same TLS cert as the API server (no extra trust setup).
#
# Idempotent: the first run creates a BuildConfig + ImageStream;
# subsequent runs start a new binary build against the existing
# BuildConfig. Pass `--no-follow` to background the build.

set -euo pipefail

NAME="${NAME:-ragdoll-python-plugins}"
PROJECT="${PROJECT:-$(oc project -q)}"
DOCKERFILE="${DOCKERFILE:-services/python-plugins/Dockerfile}"
FOLLOW="${FOLLOW:---follow}"
if [[ "${1:-}" == "--no-follow" ]]; then FOLLOW=""; fi

if ! command -v oc >/dev/null 2>&1; then
  echo "ERROR: oc CLI not found on PATH" >&2
  exit 1
fi

if [[ ! -f "${DOCKERFILE}" ]]; then
  echo "ERROR: ${DOCKERFILE} not found (run from repo root)" >&2
  exit 1
fi

echo "→ project: ${PROJECT}"
echo "→ build: ${NAME}"
echo "→ dockerfile: ${DOCKERFILE}"

# Create the BuildConfig + ImageStream on first run. `oc new-build`
# auto-detects the strategy from the Dockerfile and wires the ImageStream
# output. Re-running is a no-op (the BuildConfig already exists) — we
# swallow the AlreadyExists.
if ! oc get bc/"${NAME}" >/dev/null 2>&1; then
  echo "→ creating BuildConfig + ImageStream..."
  # --binary: source is uploaded from the local directory at start-build time.
  # --strategy=docker: use the in-repo Dockerfile, not s2i.
  # The Dockerfile expects the build context to be the REPO ROOT (it
  # does `COPY services/python-plugins/...`), so we set the build's
  # context-dir to "." (the repo root) via start-build.
  oc new-build --binary --name="${NAME}" --strategy=docker \
    --image-stream="" \
    >/dev/null
fi

# Patch the BuildConfig's Dockerfile path so it picks up our nested
# Dockerfile (we upload the whole repo root as build context).
# `oc patch` is idempotent — a no-op when the value already matches.
oc patch bc/"${NAME}" \
  --type=merge \
  -p "{\"spec\":{\"strategy\":{\"dockerStrategy\":{\"dockerfilePath\":\"${DOCKERFILE}\"}}}}" \
  >/dev/null

echo "→ starting build (uploading repo root as build context)..."
# `--from-dir=.` uploads the current directory (repo root) as the
# build context. Heavy first run (~Chromium pulls); fast on subsequent
# runs thanks to layer caching inside the build pod.
# shellcheck disable=SC2086
oc start-build "${NAME}" --from-dir=. ${FOLLOW}

echo
echo "✔ image available at:"
echo "  image-registry.openshift-image-registry.svc:5000/${PROJECT}/${NAME}:latest"
