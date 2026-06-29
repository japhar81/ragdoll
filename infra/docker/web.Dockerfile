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
# nginx.conf ships as a *.template so the official image entrypoint fills in
# ${NGINX_LOCAL_RESOLVERS} → /etc/nginx/conf.d/default.conf at startup. This
# makes the #4 per-request re-resolution of `api` work on Docker, Podman, and
# any runtime instead of hard-coding Docker's 127.0.0.11 (issues-log #12):
#   - NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 enables the image's built-in
#     15-local-resolvers.envsh, which derives NGINX_LOCAL_RESOLVERS from the
#     container's OWN /etc/resolv.conf nameserver(s) — whatever the runtime
#     provisioned (127.0.0.11 on Docker, the network DNS on Podman, …).
#   - NGINX_ENVSUBST_FILTER restricts 20-envsubst-on-templates.sh to ONLY
#     that var, so nginx's own $variables ($host, $http_upgrade, $api_upstream,
#     …) in the template are left intact.
COPY infra/docker/nginx.conf.template /etc/nginx/templates/default.conf.template
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 \
    NGINX_ENVSUBST_FILTER=NGINX_LOCAL_RESOLVERS
EXPOSE 8080
