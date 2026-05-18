# syntax=docker/dockerfile:1.7-labs
FROM node:22-alpine
WORKDIR /app
# Copy only the workspace manifests first (structure preserved via --parents)
# so `npm install` is cached and only re-runs when a package.json changes,
# not on every source edit.
COPY --parents package.json apps/*/package.json packages/*/package.json plugins/*/package.json ./
# All runtime deps are pure-JS (fastify/pg/bullmq/ioredis/@qdrant/js-client-rest/
# @opentelemetry/*/openai/@anthropic-ai/sdk/zod) so no native build toolchain
# is needed on alpine.
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "--experimental-strip-types", "apps/api/src/server.ts"]
