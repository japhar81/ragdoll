import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import {
  AnthropicProvider,
  OllamaCompatibleProvider,
  OpenAIProvider
} from "../src/index.ts";

/**
 * Fake provider HTTP server. The path determines the wire format the server
 * emits — each `streamChat` test points its provider at the route that
 * matches its expected format.
 */
function startFakeProvider(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/chat/completions" || req.url === "/v1/chat/completions") {
      // OpenAI: SSE with `data: <json>` lines + `data: [DONE]` sentinel.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: " world" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "!" } }] })}\n\n`);
      res.write(`data: [DONE]\n\n`);
      res.end();
      return;
    }
    if (req.url === "/v1/messages") {
      // Anthropic: SSE with `event: <name>` + `data: <json>` framing.
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (name: string, data: unknown) =>
        `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
      res.write(ev("content_block_delta", { type: "content_block_delta", delta: { type: "text_delta", text: "Bonjour" } }));
      res.write(ev("content_block_delta", { type: "content_block_delta", delta: { type: "text_delta", text: " monde" } }));
      res.write(ev("message_stop", { type: "message_stop" }));
      res.end();
      return;
    }
    if (req.url === "/api/chat") {
      // Ollama: NDJSON (one JSON object per line), terminating on `done:true`.
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(JSON.stringify({ message: { content: "Hallo" }, done: false }) + "\n");
      res.write(JSON.stringify({ message: { content: " Welt" }, done: false }) + "\n");
      res.write(JSON.stringify({ done: true }) + "\n");
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done()))
      });
    });
  });
}

function makeChatRequest(model = "test-model") {
  return {
    tenantId: "t1",
    model,
    messages: [{ role: "user" as const, content: "hi" }],
    temperature: 0.2,
    maxTokens: 32,
    timeoutMs: 5000
  };
}

test("OpenAIProvider.streamChat parses SSE data lines into token events", async () => {
  const fake = await startFakeProvider();
  try {
    const provider = new OpenAIProvider();
    const tokens: string[] = [];
    let saw = { done: false, errored: false };
    for await (const event of provider.streamChat({
      ...makeChatRequest(),
      baseUrl: fake.baseUrl
    })) {
      if (event.type === "token" && event.token) tokens.push(event.token);
      if (event.type === "done") saw.done = true;
      if (event.type === "error") saw.errored = true;
    }
    assert.deepEqual(tokens, ["Hello", " world", "!"]);
    assert.equal(saw.done, true);
    assert.equal(saw.errored, false);
  } finally {
    await fake.close();
  }
});

test("AnthropicProvider.streamChat extracts content_block_delta text", async () => {
  const fake = await startFakeProvider();
  try {
    const provider = new AnthropicProvider();
    // AnthropicProvider hard-codes https://api.anthropic.com — we can't
    // redirect via baseUrl. So we mock fetch globally for this test only.
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      const rewritten = String(url).replace("https://api.anthropic.com", fake.baseUrl);
      return realFetch(rewritten, init);
    }) as typeof fetch;
    try {
      const tokens: string[] = [];
      let done = false;
      for await (const event of provider.streamChat(makeChatRequest())) {
        if (event.type === "token" && event.token) tokens.push(event.token);
        if (event.type === "done") done = true;
      }
      assert.deepEqual(tokens, ["Bonjour", " monde"]);
      assert.equal(done, true);
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    await fake.close();
  }
});

test("OllamaCompatibleProvider.streamChat reads NDJSON message.content frames", async () => {
  const fake = await startFakeProvider();
  try {
    const provider = new OllamaCompatibleProvider();
    const tokens: string[] = [];
    let done = false;
    for await (const event of provider.streamChat({
      ...makeChatRequest(),
      baseUrl: fake.baseUrl
    })) {
      if (event.type === "token" && event.token) tokens.push(event.token);
      if (event.type === "done") done = true;
    }
    assert.deepEqual(tokens, ["Hallo", " Welt"]);
    assert.equal(done, true);
  } finally {
    await fake.close();
  }
});

test("streamChat yields an error event when the upstream rejects", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("provider down");
  });
  const baseUrl: string = await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    })
  );
  try {
    const provider = new OpenAIProvider();
    let errorMessage: string | undefined;
    for await (const event of provider.streamChat({
      ...makeChatRequest(),
      baseUrl
    })) {
      if (event.type === "error") errorMessage = event.error;
    }
    assert.match(errorMessage ?? "", /HTTP 503/);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});
