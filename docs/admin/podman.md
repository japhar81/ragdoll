# Running RAGdoll under Podman

The dev scripts (`make up`, `make refresh`, `make down`, `make crawl-up`)
and the smoke tests work with Podman in addition to Docker. The
auto-detector at `scripts/_compose.sh` looks for a working compose
runtime in this order:

1. `$COMPOSE` env override (explicit wins — e.g.
   `COMPOSE="podman-compose"`).
2. `docker compose` (Docker Desktop / Compose v2 plugin).
3. `podman compose` (Podman 4.7+).
4. `podman-compose` (Python wrapper installed via pip).
5. `docker-compose` (legacy Compose v1).

When the detected runtime is Podman, the scripts automatically include
`infra/docker/docker-compose.podman.yml` as an override on top of the
main `docker-compose.yml`.

## What's different on Podman

Podman doesn't expose `/var/run/docker.sock` or
`/var/lib/docker/containers`. The Docker config bind-mounts both into
the otel-collector container so it can:

- Tail every container's JSON log file (`filelog` receiver).
- Scrape engine-level container CPU/memory stats (`docker_stats` receiver).

Neither receiver works under Podman without manual setup. The podman
compose override replaces the otelcol config mount with
`infra/otel/otelcol-config.podman.yaml`, which simply omits those two
receivers and the matching service pipelines.

**Effect:** Grafana's "container CPU/memory" panels and the
per-container stdout/stderr log stream are empty under Podman. The
RAGdoll app's OTLP-exported logs/metrics/traces flow into
Loki/Mimir/Tempo as before — only the host-scraped slice is missing.

## Full parity (optional)

Operators who want the full container-log + container-stats slice on
Podman can wire the Podman socket explicitly:

1. Enable the rootless Podman socket service:
   ```sh
   systemctl --user enable --now podman.socket
   ```
   The socket path is `/run/user/$(id -u)/podman/podman.sock`.

2. Write your own compose override that:
   - Mounts the podman socket to where the otel-collector expects it,
     e.g. `/run/user/1000/podman/podman.sock:/var/run/docker.sock:ro`.
   - Mounts Podman's per-container log directory
     (`~/.local/share/containers/storage/overlay-containers/`) at the
     path the `filelog` glob expects.
   - Reverts the `otelcol-config` mount back to the Docker variant
     since `docker_stats` works against the Podman socket (Podman
     implements the Docker API).

3. Include your override:
   ```sh
   COMPOSE_FILE="infra/docker/docker-compose.yml" \
   COMPOSE="podman compose -f infra/docker/docker-compose.yml -f my.podman.override.yml" \
   make up
   ```

We don't ship a "podman with stats" override because the per-distro
socket paths and SELinux contexts vary too much to make one config
work everywhere. The simpler override that ships in-tree is a clean
no-engine-scrape baseline.

## Troubleshooting

**`make up` fails with `Error: short-name resolution enforced`** —
Podman requires fully-qualified image references. The compose file
already uses `docker.io/library/postgres:16-alpine` style names; if
you hit this on a custom image, add the `docker.io/` prefix.

**`podman compose` fails with mount errors on SELinux hosts** — add
the `:z` label (lower-case) to bind mounts that need to be shared, or
run with `--security-opt label=disable` for a dev box.

**Rootless port < 1024** — RAGdoll uses 3001 / 3300 / 4317 / 4318 /
8088 / 6333 / 9200 / 5432 / 6379 — all above the rootless threshold,
so no `sysctl net.ipv4.ip_unprivileged_port_start` change is needed.
