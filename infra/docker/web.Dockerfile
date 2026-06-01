# Both base images are parameterised so operators behind a Docker Hub
# proxy (or air-gapped clusters that mirror upstream into an internal
# registry) can override without patching this file:
#   docker build \
#     --build-arg NODE_BASE_IMAGE=registry.internal/node:22-alpine \
#     --build-arg NGINX_BASE_IMAGE=registry.internal/nginx-unprivileged:1.27-alpine \
#     ...
# Defaults keep the upstream images so unconfigured builds Just Work.
ARG NODE_BASE_IMAGE=node:22-alpine
ARG NGINX_BASE_IMAGE=nginxinc/nginx-unprivileged:1.27-alpine

FROM ${NODE_BASE_IMAGE} AS build
WORKDIR /app
COPY . .
RUN npm install && npm --workspace @ragdoll/web run build

# nginx-unprivileged listens on 8080 as UID 101 — required by
# OpenShift's restricted-v2 SCC (random non-root namespace UID, no
# CAP_NET_BIND_SERVICE for ports < 1024). Drop-in compatible with the
# stock nginx image: same config path, same /usr/share/nginx/html
# document root.
FROM ${NGINX_BASE_IMAGE}
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
