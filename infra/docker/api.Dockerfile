FROM node:22-alpine
WORKDIR /app
COPY . .
# All runtime deps are pure-JS (fastify/pg/bullmq/ioredis/@qdrant/js-client-rest/
# @opentelemetry/*/openai/@anthropic-ai/sdk/zod) so no native build toolchain
# is needed on alpine.
RUN npm install --omit=dev
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "--experimental-strip-types", "apps/api/src/server.ts"]
