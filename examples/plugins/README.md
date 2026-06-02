# Example external plugins

Two bare-minimum templates for writing your own external plugin. Same
contract (`ragdoll.plugin.v1.PluginRuntime` — ADR
[0022](../../docs/adr/0022-connect-rpc-plugin-transport.md)), same
echo behaviour, one per language:

| Directory                  | Language | Port | SDK                               |
|----------------------------|----------|------|-----------------------------------|
| [`node-echo/`](./node-echo)     | Node 22  | 8001 | `@ragdoll/plugin-sdk/author`      |
| [`python-echo/`](./python-echo) | Python 3.12 | 8002 | `ragdoll-plugin-py`               |

Both echo plugins:

- Accept `{ text: string }` on the `text` input port
- Return `{ echoed: text, length: number }` on the outputs
- Implement only the `Execute` RPC (the SDK's default fallbacks cover
  the other three RPC kinds with sensible defaults)
- Are intentionally trivial — the goal is to show the SHAPE of an
  external plugin, not to demonstrate features

## Use as a starting template

Both directories are designed to be copy-paste-able as your starting
point. Quick path:

```sh
# from the repo root
mkdir -p ../my-plugin
cp -r examples/plugins/node-echo/. ../my-plugin/
# … then rename `node_echo` to your plugin id, fill in the handler.
```

Or with `degit` (if you want to grab the template via npx without
cloning the whole repo):

```sh
npx degit japhar81/ragdoll/examples/plugins/node-echo my-plugin
npx degit japhar81/ragdoll/examples/plugins/python-echo my-plugin
```

## Author walkthrough

For step-by-step coverage of the SDK shape (manifests, handlers,
streaming variants, shared concerns, testing patterns), see
[`docs/developer/plugin-author-quickstart.md`](../../docs/developer/plugin-author-quickstart.md).

Both example READMEs duplicate the curl smoke probes + registration
snippet you'd find there — they're the minimum a new author needs to
verify their plugin is alive and reachable from the runtime.

## CI coverage

The round-trip test at
[`tests/e2e/example-plugins.test.ts`](../../tests/e2e/example-plugins.test.ts)
spins up each example and calls it through the full
`executeRegisteredPlugin` Connect transport. This catches SDK contract
drift before the examples bit-rot.
