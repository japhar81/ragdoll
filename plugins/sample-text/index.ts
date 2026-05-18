import type { InProcessPlugin } from "../../packages/plugin-sdk/src/index.ts";

export const sampleUppercaseTransformer: InProcessPlugin = {
  manifest: {
    id: "sample_uppercase_transformer",
    name: "Sample Uppercase Transformer",
    version: "1.0.0",
    category: "transformer",
    description: "Uppercases a configured field in the input payload.",
    capabilities: ["query"]
  },
  async execute({ inputs, config }) {
    const field = String(config.field ?? "text");
    const value = String(inputs[field] ?? "");
    return { outputs: { ...inputs, [field]: value.toUpperCase() } };
  }
};
