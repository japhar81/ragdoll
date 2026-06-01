# syntax=docker/dockerfile:1.7-labs
# See api.Dockerfile for the NODE_BASE_IMAGE rationale (mirror /
# air-gapped registries). Default = upstream node:22-alpine.
ARG NODE_BASE_IMAGE=node:22-alpine
FROM ${NODE_BASE_IMAGE}
WORKDIR /app
# Pure-JS, no native deps. Only the file-watcher source is needed at
# runtime — we don't ship the worker registry or any plugin code so the
# image stays small and starts fast.
COPY apps/file-watcher/package.json apps/file-watcher/package.json
COPY apps/file-watcher/src ./apps/file-watcher/src
ENV NODE_ENV=production
CMD ["node", "--experimental-strip-types", "apps/file-watcher/src/main.ts"]
