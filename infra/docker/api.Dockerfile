FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "--experimental-strip-types", "apps/api/src/server.ts"]
