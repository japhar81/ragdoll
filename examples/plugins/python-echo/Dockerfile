# Minimal Dockerfile for the python-echo example plugin.
#
# Build from the repo root (the workspace SDK at packages/plugin-py/ is
# copied in by path):
#   docker build -f examples/plugins/python-echo/Dockerfile -t python-echo .
# Run:
#   docker run --rm -p 8002:8002 python-echo
#
# PYTHON_BASE_IMAGE is parameterised like the rest of the repo's
# Dockerfiles so operators behind a Docker Hub mirror can override:
#   docker build --build-arg PYTHON_BASE_IMAGE=registry.internal/python:3.12-slim ...
ARG PYTHON_BASE_IMAGE=python:3.12-slim
FROM ${PYTHON_BASE_IMAGE}

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    POETRY_VERSION=1.8.3 \
    POETRY_NO_INTERACTION=1 \
    POETRY_VIRTUALENVS_CREATE=false \
    PORT=8002

WORKDIR /app

RUN pip install "poetry==${POETRY_VERSION}"

# Workspace SDK installed from /opt as a path dep (mirror of the host
# packages/plugin-py layout). Copied BEFORE poetry install so the path
# dep resolves.
COPY packages/plugin-py /opt/ragdoll-plugin-py

# Manifest first → poetry install layer caches when only app/ changes.
COPY examples/plugins/python-echo/pyproject.toml ./
RUN poetry install --no-root --only main

# App source last — cheap layer rebuilt on every edit.
COPY examples/plugins/python-echo/app ./app

# Run as non-root.
RUN useradd --create-home --uid 10001 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8002

CMD ["poetry", "run", "hypercorn", "app.server:app", "--bind", "0.0.0.0:8002"]
