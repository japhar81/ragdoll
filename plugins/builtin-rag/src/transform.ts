/**
 * Data-shaping plugins: `transform` and `xml_codec`.
 *
 *   transform  — reshapes data between nodes with a JSONata or JMESPath
 *                expression per output port. Input and output ports are
 *                config-driven (see `dynamicPorts` on the manifest), so one
 *                node can fan a single input out to several independently
 *                wired, independently computed outputs.
 *   xml_codec  — converts between XML and JSON in either direction.
 *
 * Both are pure, in-process, and side-effect-free: they touch no network or
 * filesystem. The expression engines (JSONata / JMESPath) evaluate against
 * in-memory data only — there is no host/`require`/`eval` surface, which is
 * why this is a safe alternative to an "arbitrary JS" node in a multi-tenant
 * runtime.
 */
import jsonata from "jsonata";
import jmespath from "jmespath";
import { XMLParser, XMLBuilder } from "fast-xml-parser";
import type { InProcessPlugin } from "../../../packages/plugin-sdk/src/index.ts";

// ===========================================================================
// transform
// ===========================================================================

export type TransformEngine = "jsonata" | "jmespath";

/** Identity expression per engine (selects the whole evaluation context). */
const IDENTITY: Record<TransformEngine, string> = { jsonata: "$", jmespath: "@" };

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Normalise an expression result to plain JSON-safe data. JSONata builds
 * objects with a `null` prototype and its own sequence wrappers; round-tripping
 * through JSON yields ordinary objects/arrays so downstream nodes (and the
 * runtime's JSON boundary) see consistent values from either engine.
 * `undefined` is preserved verbatim — the runtime treats an undefined port as
 * a dead branch, so it must survive normalisation.
 */
function toPlainJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Evaluate one expression against `data` with the chosen engine. `data` is the
 * node's `inputs` bag — an object keyed by input-port name — so an expression
 * like `documents.content` reads the `documents` input port. The result is
 * normalised to plain JSON-safe data (see {@link toPlainJson}), so both
 * engines return ordinary objects/arrays. `undefined` is preserved.
 *
 * Exported so the evaluation contract is unit-tested directly. Throws a
 * plugin-prefixed error (never a bare engine error) so failures point at the
 * offending expression in execution logs.
 */
export async function evaluateExpression(
  engine: TransformEngine,
  expression: string,
  data: unknown
): Promise<unknown> {
  if (engine === "jmespath") {
    try {
      // jmespath has no async surface and treats `null`/`undefined` roots the
      // same; normalise undefined to null so `search` never throws on root.
      return toPlainJson(jmespath.search(data === undefined ? null : data, expression));
    } catch (error) {
      throw new Error(`transform: JMESPath error in \`${expression}\`: ${errMessage(error)}`);
    }
  }
  // jsonata (default): the constructor throws on a parse error, evaluate()
  // throws on a runtime error — keep the two messages distinct.
  let compiled: ReturnType<typeof jsonata>;
  try {
    compiled = jsonata(expression);
  } catch (error) {
    throw new Error(`transform: JSONata parse error in \`${expression}\`: ${errMessage(error)}`);
  }
  try {
    return toPlainJson(await compiled.evaluate(data));
  } catch (error) {
    throw new Error(`transform: JSONata evaluation error in \`${expression}\`: ${errMessage(error)}`);
  }
}

/**
 * Normalise the `outputs` config into an ordered list of `[port, expression]`
 * pairs. Accepts either a real object (the usual case, from the JSON form
 * widget) or a JSON string. Falls back to a single identity output on the
 * `out` port when nothing usable is configured.
 */
export function resolveOutputExpressions(
  rawOutputs: unknown,
  engine: TransformEngine
): Array<[string, string]> {
  let outputs = rawOutputs;
  if (typeof outputs === "string") {
    try {
      outputs = JSON.parse(outputs);
    } catch {
      outputs = undefined;
    }
  }
  const pairs: Array<[string, string]> = [];
  if (outputs && typeof outputs === "object" && !Array.isArray(outputs)) {
    for (const [port, expr] of Object.entries(outputs as Record<string, unknown>)) {
      if (typeof expr === "string" && expr.trim().length > 0) pairs.push([port, expr]);
    }
  }
  return pairs.length > 0 ? pairs : [["out", IDENTITY[engine]]];
}

export const transformPlugin: InProcessPlugin = {
  manifest: {
    id: "transform",
    name: "Transform",
    version: "1.0.0",
    category: "transformer",
    description:
      "Reshapes data flowing between nodes with a JSONata or JMESPath expression. Input and output ports are fully configurable: name your input ports, then map each named output port to its own expression evaluated against the inputs. An expression that yields `undefined` leaves that port empty, so a transform can also gate or route a branch. Safe in a multi-tenant runtime — the expression engines evaluate against in-memory data only and expose no filesystem, network, or eval surface.",
    configSchema: {
      type: "object",
      properties: {
        engine: {
          type: "string",
          enum: ["jsonata", "jmespath"],
          default: "jsonata",
          description:
            "Expression language. `jsonata` is a full transformation language (object construction, aggregation, conditionals, functions); `jmespath` is a simpler projection/query language. Both run per output port."
        },
        inputs: {
          type: "array",
          items: { type: "string" },
          default: ["in"],
          description:
            "Names of the input ports this node exposes. Each wired input is delivered to the expression context under its port name (the expression sees `{ <portName>: <value>, ... }`)."
        },
        outputs: {
          type: "object",
          additionalProperties: true,
          description:
            "Map of output port name → expression. Each expression is evaluated against the inputs object and its result is emitted on that port. Defaults to `{ \"out\": \"<identity>\" }` when unset."
        }
      },
      additionalProperties: false
    },
    // Ports are config-driven (see `inputs` / `outputs`). `inputPorts` /
    // `outputPorts` are intentionally NOT declared: leaving the static port
    // contract empty keeps validatePipelineSpec from warning about the
    // author-named ports, and `dynamicPorts` tells the builder to render
    // handles from this node's config instead.
    dynamicPorts: { inputsFrom: "inputs", outputsFrom: "outputs" },
    capabilities: ["query", "ingestion"],
    ui: {
      icon: "shuffle",
      color: "#9333ea",
      paletteGroup: "Transform",
      formHints: {
        engine: { widget: "select" },
        inputs: { widget: "tags" },
        outputs: { widget: "json" }
      }
    }
  },
  async execute({ inputs, config }) {
    const engine: TransformEngine = config.engine === "jmespath" ? "jmespath" : "jsonata";
    const expressions = resolveOutputExpressions(config.outputs, engine);

    // The evaluation context is the inputs bag itself — keyed by input-port
    // name. The runtime delivers each wired edge's payload under its `toPort`,
    // so an expression references inputs by the port names declared in config.
    const outputs: Record<string, unknown> = {};
    for (const [port, expression] of expressions) {
      // An output expression yielding `undefined` is deliberate: the port
      // emits nothing and the runtime's skip-cascading drops that branch.
      outputs[port] = await evaluateExpression(engine, expression, inputs);
    }
    return {
      outputs,
      metadata: { engine, outputPorts: expressions.map(([port]) => port) }
    };
  }
};

// ===========================================================================
// xml_codec
// ===========================================================================

export type XmlMode = "parse" | "serialize";

export const xmlCodecPlugin: InProcessPlugin = {
  manifest: {
    id: "xml_codec",
    name: "XML Codec",
    version: "1.0.0",
    category: "transformer",
    description:
      "Converts between XML and JSON. In `parse` mode it reads an XML string on the `xml` port and emits a JSON object on the `json` port. In `serialize` mode it reads a JSON value on the `json` port and emits an XML string on the `xml` port. Only one port pair is live per mode; leave the other pair unwired.",
    configSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["parse", "serialize"],
          default: "parse",
          description:
            "`parse`: XML string → JSON object (input `xml`, output `json`). `serialize`: JSON value → XML string (input `json`, output `xml`)."
        },
        ignoreAttributes: {
          type: "boolean",
          default: false,
          description:
            "When true, XML attributes are dropped on parse and never written on serialize. When false (default) attributes round-trip as prefixed keys."
        },
        attributePrefix: {
          type: "string",
          default: "@_",
          description: "Key prefix used for keys derived from XML attributes."
        },
        textNodeName: {
          type: "string",
          default: "#text",
          description: "Key holding an element's text content when the element also has attributes or children."
        },
        format: {
          type: "boolean",
          default: true,
          description: "serialize mode only: pretty-print the XML output with indentation."
        },
        rootName: {
          type: "string",
          description:
            "serialize mode only: wrap the JSON under a single root element with this name. Use when the JSON has zero or multiple top-level keys (XML requires exactly one root element)."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "xml", description: "XML string to parse. Live in `parse` mode." },
      { name: "json", description: "JSON value to serialize. Live in `serialize` mode." }
    ],
    outputPorts: [
      { name: "json", description: "Parsed JSON object. Emitted in `parse` mode." },
      { name: "xml", description: "Serialized XML string. Emitted in `serialize` mode." }
    ],
    capabilities: ["ingestion", "query"],
    ui: {
      icon: "file-code",
      color: "#9333ea",
      paletteGroup: "Transform",
      formHints: {
        mode: { widget: "select" },
        ignoreAttributes: { widget: "checkbox" },
        format: { widget: "checkbox" },
        attributePrefix: { widget: "text" },
        textNodeName: { widget: "text" },
        rootName: { widget: "text" }
      }
    }
  },
  async execute({ inputs, config }) {
    const mode: XmlMode = config.mode === "serialize" ? "serialize" : "parse";
    const ignoreAttributes = config.ignoreAttributes === true;
    const attributeNamePrefix = String(config.attributePrefix ?? "@_");
    const textNodeName = String(config.textNodeName ?? "#text");

    if (mode === "serialize") {
      const builder = new XMLBuilder({
        ignoreAttributes,
        attributeNamePrefix,
        textNodeName,
        format: config.format !== false
      });
      let value: unknown = inputs.json !== undefined ? inputs.json : inputs.input;
      if (value === undefined) value = {};
      if (typeof config.rootName === "string" && config.rootName.length > 0) {
        value = { [config.rootName]: value };
      }
      let xml: string;
      try {
        xml = builder.build(value);
      } catch (error) {
        throw new Error(`xml_codec: failed to serialize JSON to XML: ${errMessage(error)}`);
      }
      return { outputs: { xml }, metadata: { mode } };
    }

    // parse mode
    const raw = inputs.xml !== undefined ? inputs.xml : inputs.input !== undefined ? inputs.input : inputs.text;
    const xmlString = typeof raw === "string" ? raw : String(raw ?? "");
    const parser = new XMLParser({ ignoreAttributes, attributeNamePrefix, textNodeName });
    let json: unknown;
    try {
      json = parser.parse(xmlString);
    } catch (error) {
      throw new Error(`xml_codec: failed to parse XML: ${errMessage(error)}`);
    }
    return { outputs: { json }, metadata: { mode } };
  }
};
