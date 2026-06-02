# Minimal Dockerfile for the node-echo example plugin.
#
# Build from the repo root so the workspace symlink to @ragdoll/plugin-sdk
# resolves (the example uses the in-tree SDK package via npm workspaces):
#   docker build -f examples/plugins/node-echo/Dockerfile -t node-echo .
# Run:
#   docker run --rm -p 8001:8001 node-echo
#
# NODE_BASE_IMAGE is parameterised like the rest of the repo's Dockerfiles
# so operators behind a Docker Hub mirror can override the base:
#   docker build --build-arg NODE_BASE_IMAGE=registry.internal/node:22-alpine ...
ARG NODE_BASE_IMAGE=node:22-alpine
FROM ${NODE_BASE_IMAGE}

WORKDIR /app
COPY package.json ./
COPY apps ./apps
COPY packages ./packages
COPY plugins ./plugins
COPY proto ./proto
COPY examples ./examples

# npm install at the workspace root resolves @ragdoll/plugin-sdk + its
# transitive deps from the in-tree workspaces. --omit=dev keeps the image
# small (no playwright/vitest/etc).
RUN npm install --omit=dev

ENV NODE_ENV=production
ENV PORT=8001
EXPOSE 8001

CMD ["node", "--experimental-strip-types", "examples/plugins/node-echo/src/server.ts"]
