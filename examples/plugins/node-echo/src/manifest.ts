/**
 * Manifest for the node-echo example plugin.
 *
 * Exported separately from the server so the runtime side (which registers
 * the plugin in `plugin-loader`) can import just the type without pulling
 * in the @connectrpc/connect-node server stack.
 */
import type { PluginManifest } from "@ragdoll/plugin-sdk";

export const ECHO_MANIFEST: PluginManifest = {
  id: "node_echo",
  name: "Node Echo (example)",
  version: "0.1.0",
  category: "transformer",
  description:
    "Bare-minimum external Node plugin. Receives `{ text }` on the `text` input port and emits `{ echoed, length }` on the outputs. Exists to document the shape of an external plugin — copy-paste this directory as the starting point for your own.",
  inputPorts: [
    { name: "text", required: true, description: "String to echo back." }
  ],
  outputPorts: [
    { name: "echoed", description: "The input text, unchanged." },
    { name: "length", description: "Character length of the input." }
  ]
  // Not declaring `streaming: true` — this is the unary baseline. See
  // docs/developer/plugin-author-quickstart.md §4 for the streaming variant.
};
