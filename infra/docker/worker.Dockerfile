# Same portable multi-stage shape as api.Dockerfile — see that file
# for the rationale (Buildah doesn't grok `COPY --parents`, so we
# extract manifests in stage 1 and let stage 2's npm-install layer
# cache on their content alone).

FROM node:22-alpine AS manifests
WORKDIR /src
COPY package.json ./
COPY apps ./apps
COPY packages ./packages
COPY plugins ./plugins
RUN find apps packages plugins \
      -type f -not -name package.json -not -path '*/node_modules/*' -delete \
    && find apps packages plugins -type d -empty -delete

FROM node:22-alpine
WORKDIR /app
# git + openssh-client for @ragdoll/git-storage (the worker's poller
# clones and pushes per-tenant repos). Same justification as the api
# Dockerfile — pure-JS deps otherwise.
RUN apk add --no-cache git openssh-client
COPY --from=manifests /src ./
# Pure-JS runtime deps only; no native build needed on alpine.
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
CMD ["node", "--experimental-strip-types", "apps/worker/src/index.ts"]
