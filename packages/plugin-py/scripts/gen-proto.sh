#!/usr/bin/env bash
# Regenerate the Python proto bindings from proto/plugin.proto.
#
# Outputs:
#   ragdoll_plugin_py/proto/plugin_pb2.py     — protobuf message types
#   ragdoll_plugin_py/proto/plugin_connect.py — connectrpc service stubs
#
# The protoc-gen-connectrpc plugin generates flat imports (the generated
# plugin_connect.py does `import plugin_pb2 as plugin__pb2`), so the
# emitted files share one directory. Both files are flat at
# `ragdoll_plugin_py/proto/`; a `from .proto import plugin_pb2` import
# from the SDK pulls them in.
#
# Requires on PATH:
#   - protoc           (Google's protocol-buffer compiler)
#   - protoc-gen-connectrpc  (`pip install protoc-gen-connectrpc`)
#   - grpc_tools.protoc shim is bundled with grpcio-tools (we use raw protoc here)
set -euo pipefail

if ! command -v protoc-gen-connectrpc >/dev/null 2>&1; then
  echo "ERROR: protoc-gen-connectrpc not found on PATH" >&2
  echo "  pip install protoc-gen-connectrpc" >&2
  exit 1
fi
# Use `python -m grpc_tools.protoc` instead of system protoc — grpc_tools
# bundles the google/protobuf well-known types (struct.proto etc.) which
# the system `protobuf-compiler` package on most distros does NOT ship.
# This also pins the protoc version to whatever grpcio-tools provides,
# avoiding the system-protoc version drift across dev machines.
if ! python -c "import grpc_tools.protoc" >/dev/null 2>&1; then
  echo "ERROR: grpcio-tools not installed (provides protoc + wkt protos)" >&2
  echo "  pip install grpcio-tools" >&2
  exit 1
fi

PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROTO_DIR="$(cd "$PKG_DIR/../../proto" && pwd)"
OUT_DIR="$PKG_DIR/ragdoll_plugin_py/proto"
mkdir -p "$OUT_DIR"

# grpc_tools bundles the wkt proto files under its `_proto/` resource dir;
# we ask Python where that lives so the include path stays portable.
WKT_DIR="$(python -c 'import grpc_tools, os; print(os.path.join(os.path.dirname(grpc_tools.__file__), "_proto"))')"

echo "→ proto: $PROTO_DIR/plugin.proto"
echo "→ wkt:   $WKT_DIR"
echo "→ out:   $OUT_DIR"

python -m grpc_tools.protoc \
  -I "$PROTO_DIR" \
  -I "$WKT_DIR" \
  --python_out="$OUT_DIR" \
  --plugin=protoc-gen-connectrpc="$(command -v protoc-gen-connectrpc)" \
  --connectrpc_out="$OUT_DIR" \
  "$PROTO_DIR/plugin.proto"

touch "$OUT_DIR/__init__.py"

# protoc-gen-connectrpc emits an ABSOLUTE flat import (`import plugin_pb2`)
# in the generated _connect.py. That breaks when the package is installed
# under a parent module (`ragdoll_plugin_py.proto`) because Python's
# absolute-import resolver can't find `plugin_pb2` at top level. Rewrite
# the offending line to a relative import so the generated file is
# importable from inside the package without sys.path tricks.
python - "$OUT_DIR/plugin_connect.py" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
src = p.read_text()
fixed = src.replace(
    "import plugin_pb2 as plugin__pb2",
    "from . import plugin_pb2 as plugin__pb2",
)
if fixed == src:
    print(f"WARN: no rewrite applied to {p.name} — generator output changed?", file=sys.stderr)
p.write_text(fixed)
PY

echo "✔ generated:"
ls -1 "$OUT_DIR"
