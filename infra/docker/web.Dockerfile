FROM node:22-alpine AS build
WORKDIR /app
COPY . .
RUN npm install && npm --workspace @ragdoll/web run build

FROM nginx:1.27-alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
