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
