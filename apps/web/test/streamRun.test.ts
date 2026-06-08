import test from "node:test";
import assert from "node:assert/strict";
import { parseSseFrames } from "../src/lib/streamRun.ts";

test("parseSseFrames: parses a single token frame", () => {
  const buf = `event: token\ndata: {"nodeId":"llm","token":"Hi"}\n\n`;
  const { frames, remainder } = parseSseFrames(buf);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].event, "token");
  assert.deepEqual(frames[0].data, { nodeId: "llm", token: "Hi" });
  assert.equal(remainder, "");
});

test("parseSseFrames: emits multiple events in one chunk", () => {
  const buf =
    `event: execution.started\ndata: {"pipelineId":"p1"}\n\n` +
    `event: token\ndata: {"nodeId":"a","token":"x"}\n\n` +
    `event: token\ndata: {"nodeId":"a","token":"y"}\n\n`;
  const { frames, remainder } = parseSseFrames(buf);
  assert.equal(frames.length, 3);
  assert.equal(frames[0].event, "execution.started");
  assert.equal(frames[1].event, "token");
  assert.equal(frames[2].event, "token");
  assert.equal(remainder, "");
});

test("parseSseFrames: returns partial frame as remainder", () => {
  // No double-newline terminator — buffer should be carried forward.
  const buf = `event: token\ndata: {"nodeId":"a","token":"`;
  const { frames, remainder } = parseSseFrames(buf);
  assert.equal(frames.length, 0);
  assert.equal(remainder, buf);
});

test("parseSseFrames: handles CRLF normalization", () => {
  const buf = `event: token\r\ndata: {"token":"hi"}\r\n\r\n`;
  const { frames } = parseSseFrames(buf);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].data, { token: "hi" });
});

test("parseSseFrames: defaults event to 'message' when omitted", () => {
  const buf = `data: {"k":1}\n\n`;
  const { frames } = parseSseFrames(buf);
  assert.equal(frames[0].event, "message");
});

test("parseSseFrames: ignores comment lines starting with ':'", () => {
  const buf = `:heartbeat\nevent: ping\ndata: {}\n\n`;
  const { frames } = parseSseFrames(buf);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].event, "ping");
});

test("parseSseFrames: keeps non-JSON data as raw string", () => {
  const buf = `event: text\ndata: hello world\n\n`;
  const { frames } = parseSseFrames(buf);
  assert.equal(frames[0].data, "hello world");
});

test("parseSseFrames: joins multi-line data with newline", () => {
  const buf = `event: multi\ndata: line1\ndata: line2\n\n`;
  const { frames } = parseSseFrames(buf);
  assert.equal(frames[0].data, "line1\nline2");
});

test("parseSseFrames: incrementally produces frames across chunks", () => {
  // Simulate the reader producing the SSE stream in chunks; ensure the
  // boundary handling matches what streamRun() does.
  const chunks = [
    "event: token\n",
    'data: {"t":"a"}\n\n',
    "event: token\n",
    'data: {"t":"',
    'b"}\n\n'
  ];
  let buffer = "";
  const collected: string[] = [];
  for (const c of chunks) {
    buffer += c;
    const { frames, remainder } = parseSseFrames(buffer);
    buffer = remainder;
    for (const f of frames) collected.push((f.data as { t: string }).t);
  }
  assert.deepEqual(collected, ["a", "b"]);
});
