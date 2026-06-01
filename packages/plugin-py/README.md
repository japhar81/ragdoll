# `ragdoll-plugin-py`

Python author SDK for RAGdoll external plugins. The Python sibling of
`@ragdoll/plugin-sdk/author` — same one-call server shape, same .proto
contract, same shared concerns layer.

See [docs/developer/plugin-author-quickstart.md](../../docs/developer/plugin-author-quickstart.md)
for the end-to-end author walkthrough; this README is the install / structure
reference only.

## Install

```sh
pip install ragdoll-plugin-py            # core (Connect over ASGI)
pip install ragdoll-plugin-py[otel]      # + OpenTelemetry traceparent propagation
```

In the bundled `services/python-plugins` sidecar, this package is installed
as a poetry path dependency from `packages/plugin-py/`.

## Layout

- `ragdoll_plugin_py/__init__.py` — public API: `create_plugin_server`,
  `default_interceptors`, handler protocol types
- `ragdoll_plugin_py/proto/plugin_pb2.py` — generated protobuf message types
- `ragdoll_plugin_py/proto/plugin_connect.py` — generated Connect service stubs
- `scripts/gen-proto.sh` — regenerates the proto bindings from `proto/plugin.proto`

## Regenerating proto

The generated files are checked in (matches the Node `@ragdoll/proto-gen`
pattern — zero-step dev loop, codegen only when the .proto changes).

```sh
cd packages/plugin-py
./scripts/gen-proto.sh
```

Requires `protoc` + `protoc-gen-connectrpc` on PATH; the script will print
a friendly hint if either is missing.

## Intel-Mac dev

`connectrpc`'s `pyqwest` dependency publishes wheels for macOS arm64 +
Linux x86_64/aarch64 but NOT macOS x86_64. Intel Mac devs need a Rust
toolchain (`brew install rust` or `rustup`) to compile from source. Apple
Silicon + Linux + every prod target (`python:3.12-slim`) install from
wheels with no Rust. See the [main README](../../README.md) for details.
