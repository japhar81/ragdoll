FROM node:22-alpine
WORKDIR /app
COPY . .
# Pure-JS runtime deps only; no native build needed on alpine.
RUN npm install --omit=dev
ENV NODE_ENV=production
CMD ["node", "--experimental-strip-types", "apps/worker/src/index.ts"]
