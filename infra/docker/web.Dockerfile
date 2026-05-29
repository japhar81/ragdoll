FROM node:22-alpine AS build
WORKDIR /app
COPY . .
RUN npm install && npm --workspace @ragdoll/web run build

# nginx-unprivileged listens on 8080 as UID 101 — required by
# OpenShift's restricted-v2 SCC (random non-root namespace UID, no
# CAP_NET_BIND_SERVICE for ports < 1024). Drop-in compatible with the
# stock nginx image: same config path, same /usr/share/nginx/html
# document root.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
