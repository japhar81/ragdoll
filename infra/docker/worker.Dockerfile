FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production
CMD ["node", "--experimental-strip-types", "apps/worker/src/index.ts"]
