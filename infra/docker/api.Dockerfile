# Portable multi-stage build that mirrors what `COPY --parents` used to
# do — install npm deps in a layer that's cached unless workspace
# manifests change — but without depending on Docker BuildKit's
# `--parents` syntax. Required because OpenShift's Buildah backend
# (`oc start-build --strategy=docker`) does not support `--parents`.
#
# Stage layout:
#   manifests  → copies the WHOLE repo, then deletes everything that
#                isn't a `package.json`. The final filesystem of this
#                stage contains only the manifests in their original
#                tree.
#   final      → COPY --from=manifests of just the package.jsons. The
#                stage-2 layer hash is content-addressable on those
#                manifests, so npm install is cached across source-only
#                changes even though stage 1 rebuilt.
#
# Net: same fast-iteration property as the old `--parents` pattern, and
# the same image runs identically under both docker compose and the
# OpenShift in-cluster build.

# NODE_BASE_IMAGE is parameterised so operators behind a corporate
# Docker Hub proxy (or air-gapped clusters that mirror upstream images
# into an internal registry) can override the base without patching
# this Dockerfile:
#   docker build --build-arg NODE_BASE_IMAGE=registry.internal/node:22-alpine ...
# Default keeps the upstream image so unconfigured builds Just Work.
# Declared once before the first FROM: a global ARG is visible in every
# FROM instruction in the file, no re-declaration needed.
ARG NODE_BASE_IMAGE=node:22-alpine

FROM ${NODE_BASE_IMAGE} AS manifests
WORKDIR /src
COPY package.json ./
COPY apps ./apps
COPY packages ./packages
COPY plugins ./plugins
# Strip everything except package.json. `-not -path */node_modules/*`
# is defensive — node_modules should be excluded by .dockerignore but
# don't trust the operator's local state.
RUN find apps packages plugins \
      -type f -not -name package.json -not -path '*/node_modules/*' -delete \
    && find apps packages plugins -type d -empty -delete

FROM ${NODE_BASE_IMAGE}
WORKDIR /app
# git + openssh-client are required by @ragdoll/git-storage (it shells out
# to `git` so HTTPS-with-PAT and SSH-with-key both work without a JS git
# client). Pure-JS deps in this image otherwise — no compiler toolchain.
RUN apk add --no-cache git openssh-client
# Just the manifests. This layer's hash depends ONLY on package.json
# content; source-only changes don't bust it.
COPY --from=manifests /src ./
# All runtime deps are pure-JS (fastify/pg/bullmq/ioredis/@qdrant/js-client-rest/
# @opentelemetry/*/openai/@anthropic-ai/sdk/zod) so no native build toolchain
# is needed on alpine.
RUN npm install --omit=dev
# Source comes last so application edits only rebuild this cheap layer.
COPY . .
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "--experimental-strip-types", "apps/api/src/server.ts"]
