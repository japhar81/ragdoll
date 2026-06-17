# RAGdoll Python plugin service (crawl4ai + scrapy crawlers).
#
# Built from the repo root so it matches the other infra Dockerfiles:
#   docker build -f services/python-plugins/Dockerfile .
# (compose passes context: ../.. and this dockerfile path).
#
# Layer-caching mirrors infra/docker/api.Dockerfile: copy the dependency
# manifests first and install deps, then copy source — so an app/ edit does
# not bust the (slow) Poetry + Chromium layers.
#
# NOTE: `playwright install --with-deps chromium` pulls a full headless
# Chromium plus its OS libraries. This image is intentionally large and slow
# to build — that is acceptable for a browser-driven crawler service and is
# why it is excluded from the fast scripts/dev-refresh.sh path.
#
# PYTHON_BASE_IMAGE is parameterised so operators behind a Docker Hub proxy
# (or air-gapped clusters that mirror upstream into an internal registry)
# can override the base without patching this Dockerfile:
#   docker build --build-arg PYTHON_BASE_IMAGE=registry.internal/python:3.12-slim ...
# Default keeps the upstream image so unconfigured builds Just Work.
ARG PYTHON_BASE_IMAGE=python:3.12-slim
FROM ${PYTHON_BASE_IMAGE}

# - POETRY_VIRTUALENVS_CREATE=false: install into the system site so the
#   non-root runtime user can import without activating a venv.
# - PLAYWRIGHT_BROWSERS_PATH: a shared, world-readable location so Chromium
#   is installed once (as root, with OS deps) and usable by the app user.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    POETRY_VERSION=1.8.3 \
    POETRY_NO_INTERACTION=1 \
    POETRY_VIRTUALENVS_CREATE=false \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright \
    PORT=8000

WORKDIR /app

# curl is used by the compose/k8s health probes; ca-certificates for TLS
# crawling. playwright --with-deps pulls the rest of Chromium's libs.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install "poetry==${POETRY_VERSION}"

# Workspace plugin SDK as a poetry path dep. Copy it BEFORE `poetry install`
# so the dep resolves; the SDK + generated proto bindings are stable in the
# Phase B model (regen only when proto/plugin.proto changes), so its layer
# stays cached unless those files change.
COPY packages/plugin-py /opt/ragdoll-plugin-py

# Dependency manifests first → this layer (Poetry resolve + install) only
# re-runs when pyproject.toml / poetry.lock change, not on every app edit.
COPY services/python-plugins/pyproject.toml services/python-plugins/poetry.lock ./
# POETRY_INSTALL_ARGS lets `make crawl-up-reranker` build with
# `--with reranker` to pull sentence-transformers + torch in for the
# rerank_bge `provider: local` branch. The default build (and the
# baseline `make crawl-up`) stays slim.
ARG POETRY_INSTALL_ARGS="--no-root --only main"
RUN poetry install ${POETRY_INSTALL_ARGS}

# Headless Chromium + its system deps for crawl4ai/playwright. Installed
# once into a shared path, made world-readable so the non-root runtime user
# can launch it. Heavy layer, kept after deps so it is cached across source
# changes.
RUN poetry run playwright install --with-deps chromium \
    && chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH}"

# --- cartography: isolated venv (ADR-0026 #2 follow-up) -------------------
# cartography's intel package eagerly imports every cloud module
# (azure, gcp, etc.) at CLI startup, so a single transitive bump on
# one cloud SDK can brick the entire CLI for unrelated cloud crawls
# (e.g. azure-mgmt-resource>=23 dropping SubscriptionClient from the
# top-level namespace broke even AWS-only `cartography sync` runs).
# Keeping cartography in its own venv freezes its dep graph against
# crawl4ai / scrapy / sentence-transformers and any future tool we
# add to this image. The handler shells out to the venv's CLI —
# no `import cartography` from the main env.
#
# Pin to a release stable against the rest of the matrix; bump
# intentionally + verify `cartography --help` in the new image before
# merging the bump.
ARG CARTOGRAPHY_VERSION=0.96.2
# Pin azure-mgmt-resource alongside cartography. cartography itself
# declares the dep loosely; the resolver picks up the latest, and
# azure-mgmt-resource>=23 moved SubscriptionClient out of the top-
# level namespace so cartography.intel.azure.subscription fails at
# import — bricking the entire CLI even for AWS-only crawls. Pinning
# to 22.x keeps the import surface stable. Re-evaluate when bumping
# CARTOGRAPHY_VERSION (newer releases may move to the new namespace).
ARG AZURE_MGMT_RESOURCE_PIN=22.*
RUN python -m venv /opt/cartography-venv \
    && /opt/cartography-venv/bin/pip install --no-cache-dir \
         "cartography==${CARTOGRAPHY_VERSION}" \
         "azure-mgmt-resource==${AZURE_MGMT_RESOURCE_PIN}" \
    && /opt/cartography-venv/bin/cartography --help >/dev/null \
    && chmod -R a+rX /opt/cartography-venv

# --- cloudquery: static CLI binary -----------------------------------------
# cloudquery is a Go binary distributed as a single static artifact per
# platform. We install JUST the CLI here; the AWS source + postgresql
# destination plugins are downloaded by `cloudquery sync` on first use
# (cached under ~/.local/share/cloudquery), keyed by the versions the
# Python handler pins in its spec YAML. This keeps the build small and
# lets the source/destination plugin versions bump via env without
# rebuilding the image (the handler reads CLOUDQUERY_AWS_SOURCE_VERSION
# / CLOUDQUERY_POSTGRESQL_DEST_VERSION).
#
# By default we fetch GitHub's `latest` redirect so the build doesn't
# break when the pinned-version-in-the-Dockerfile drifts out of date
# (cloudquery cuts CLI releases frequently). PRODUCTION OPERATORS
# SHOULD PIN — pass --build-arg CLOUDQUERY_VERSION=X.Y.Z and the build
# pulls the matching tagged release. Same pin-intentionally rule as
# the cartography layer above; unpinned builds are only acceptable for
# dev/iteration. Architecture selected by TARGETARCH so multi-arch
# builds work; falls back to amd64.
ARG CLOUDQUERY_VERSION=latest
ARG TARGETARCH=amd64
# Note on `latest`: the cloudquery repo is a MONOREPO and most releases
# are individual source/destination plugin releases, NOT CLI releases.
# `/releases/latest/download/cloudquery_linux_amd64` therefore 404s when
# the most recent tag isn't a CLI release. We resolve the latest CLI tag
# (`cli-v*`) via the GitHub API + grep, then download from that tagged
# release. When the operator pins via `--build-arg CLOUDQUERY_VERSION=X.Y.Z`
# we skip the discovery and go straight to the pinned tag.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64)  CQ_ASSET="cloudquery_linux_amd64" ;; \
      arm64)  CQ_ASSET="cloudquery_linux_arm64" ;; \
      *)      CQ_ASSET="cloudquery_linux_amd64" ;; \
    esac; \
    if [ "${CLOUDQUERY_VERSION}" = "latest" ]; then \
      CLI_TAG=$(curl -fsSL "https://api.github.com/repos/cloudquery/cloudquery/releases?per_page=100" \
        | grep -oE '"tag_name": "cli-v[0-9.]+"' \
        | head -1 \
        | cut -d'"' -f4); \
      if [ -z "${CLI_TAG}" ]; then \
        echo "Failed to discover latest cloudquery CLI tag from GitHub API — pin --build-arg CLOUDQUERY_VERSION explicitly" >&2; \
        exit 1; \
      fi; \
      CQ_URL="https://github.com/cloudquery/cloudquery/releases/download/${CLI_TAG}/${CQ_ASSET}"; \
    else \
      CQ_URL="https://github.com/cloudquery/cloudquery/releases/download/cli-v${CLOUDQUERY_VERSION}/${CQ_ASSET}"; \
    fi; \
    echo "Installing cloudquery from ${CQ_URL}"; \
    mkdir -p /opt/cloudquery; \
    curl -fsSL "${CQ_URL}" -o /opt/cloudquery/cloudquery; \
    chmod a+x /opt/cloudquery/cloudquery; \
    /opt/cloudquery/cloudquery --version >/dev/null

# --- cloudquery OSS plugin binaries (registry: local) ----------------------
# Why bundled-in-the-image:
#   The cloudquery CLI defaults to `registry: cloudquery` which pulls
#   plugins from CloudQuery Hub (https://hub.cloudquery.io) — which now
#   REQUIRES an account + `cloudquery login` even for the Apache-2.0
#   licensed OSS plugins. Same applies to their `docker.cloudquery.io`
#   docker registry (auth-gated). To stay on the OSS path with zero
#   external auth at sync time, we pre-download the plugin binaries
#   from the cloudquery monorepo's GitHub releases and run them via
#   `registry: local` — cloudquery just exec()s the binary; no
#   credentials, no network, no docker-in-docker.
#
# Versions:
#   The Hub-distributed plugins are on v33/v8 (AWS source / PG
#   destination), but those tags are NOT published as GitHub release
#   assets — they live ONLY in the Hub / Docker registry. The LATEST
#   versions with public GitHub binaries are v22.19.2 (source-aws) and
#   v7.3.0 (destination-postgresql). Both serve cloudquery's plugin
#   protocol v3, which matches what the CLI v6.36.x speaks. Smoke-
#   tested: `Start sync` proceeds, plugin GetVersions handshakes
#   succeed, sync only fails on a real-network step (e.g. the
#   destination DSN), confirming the Hub-auth wall is gone.
#
# Sanity:
#   * Pin both versions explicitly; bump intentionally and re-verify
#     `Start sync` survives the GetVersions handshake before merging
#     a bump.
#   * If cloudquery ever re-publishes v33/v8 binaries to GitHub
#     releases (or exposes an anon Hub token), bump the pins and
#     drop this layer in favour of the on-demand download path.
ARG CQ_AWS_SOURCE_VERSION=22.19.2
ARG CQ_POSTGRESQL_DEST_VERSION=7.3.0
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64)  CQ_OS_ARCH="linux_amd64" ;; \
      arm64)  CQ_OS_ARCH="linux_arm64" ;; \
      *)      CQ_OS_ARCH="linux_amd64" ;; \
    esac; \
    mkdir -p /opt/cq-plugins /tmp/cq-dl; \
    # AWS source plugin -----------------------------------------------------
    curl -fsSL \
      "https://github.com/cloudquery/cloudquery/releases/download/plugins-source-aws-v${CQ_AWS_SOURCE_VERSION}/aws_${CQ_OS_ARCH}.zip" \
      -o /tmp/cq-dl/aws.zip; \
    python -m zipfile -e /tmp/cq-dl/aws.zip /tmp/cq-dl/aws/; \
    install -m 0755 /tmp/cq-dl/aws/plugins/source/aws /opt/cq-plugins/source-aws; \
    /opt/cq-plugins/source-aws info >/dev/null; \
    # PostgreSQL destination plugin ----------------------------------------
    curl -fsSL \
      "https://github.com/cloudquery/cloudquery/releases/download/plugins-destination-postgresql-v${CQ_POSTGRESQL_DEST_VERSION}/postgresql_${CQ_OS_ARCH}.zip" \
      -o /tmp/cq-dl/pg.zip; \
    python -m zipfile -e /tmp/cq-dl/pg.zip /tmp/cq-dl/pg/; \
    install -m 0755 /tmp/cq-dl/pg/plugins/destination/postgresql /opt/cq-plugins/destination-postgresql; \
    /opt/cq-plugins/destination-postgresql info >/dev/null; \
    rm -rf /tmp/cq-dl; \
    chmod -R a+rX /opt/cq-plugins

# Source last so edits only rebuild this cheap layer.
COPY services/python-plugins/app ./app

# Run as a non-root user (browsers already shared via PLAYWRIGHT_BROWSERS_PATH).
RUN useradd --create-home --uid 10001 appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

# Hypercorn (HTTP/1.1 + HTTP/2 + h2c via prior knowledge) replaces uvicorn so
# the sidecar serves native gRPC + true full-duplex bidi alongside Connect
# HTTP/JSON. Connect over HTTP/1.1 still works for unary + server-stream +
# client-stream; only full-duplex bidi requires h2 end-to-end. The two
# protocols share the same ASGI app — no extra port, no separate process.
CMD ["poetry", "run", "hypercorn", "app.main:app", "--bind", "0.0.0.0:8000"]
