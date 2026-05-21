import type { InProcessPlugin } from "../../packages/plugin-sdk/src/index.ts";

export const sampleUppercaseTransformer: InProcessPlugin = {
  manifest: {
    id: "sample_uppercase_transformer",
    name: "Sample Uppercase Transformer",
    version: "1.0.0",
    category: "transformer",
    description: "Uppercases a configured field in the input payload.",
    configSchema: {
      type: "object",
      properties: {
        field: {
          type: "string",
          default: "text",
          description: "Name of the input field to uppercase."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "text", description: "Default field uppercased. Override with `config.field` to target a different key." }
    ],
    outputPorts: [
      { name: "text", description: "The configured field, uppercased." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "type",
      paletteGroup: "Transforms",
      formHints: { field: { widget: "text" } }
    }
  },
  async execute({ inputs, config }) {
    const field = String(config.field ?? "text");
    const value = String(inputs[field] ?? "");
    return { outputs: { ...inputs, [field]: value.toUpperCase() } };
  }
};
