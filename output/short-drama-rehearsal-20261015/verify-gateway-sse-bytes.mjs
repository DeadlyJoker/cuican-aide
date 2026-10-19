import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { parseResponsesSse } from "../../packages/agent-responses/src/responses-sse.ts";
import { DirectResponsesTransport } from "../../packages/agent-responses/src/direct-responses-transport.ts";

// Named synthetic bytes captured from actual Rust regression execution, never a customer response.
const [brokenPath, fixedPath] = process.argv.slice(2);
const broken = readFileSync(brokenPath),
  fixed = readFileSync(fixedPath);
const body = (bytes) =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
await assert.rejects(Array.fromAsync(parseResponsesSse(body(broken))), {
  code: "responses_event_json_invalid",
});
const frames = await Array.fromAsync(parseResponsesSse(body(fixed)));
assert.equal(frames.length, 1);
assert.equal(frames[0].value.type, "response.completed");
assert.equal(frames[0].value.sequence_number, 1);

const created = {
  type: "response.created",
  sequence_number: 0,
  response: { id: "named_response" },
};
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify(created)}\n\n`);
  response.write(fixed);
  // Intentionally keep the HTTP response open: trusted protocol completion must own release.
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const transport = new DirectResponsesTransport({
  endpoint: `http://127.0.0.1:${address.port}/v1/responses`,
  model: "named-gateway-wire-fixture",
  idleTimeoutMs: 500,
});
try {
  const started = performance.now();
  const events = await Array.fromAsync(
    transport.stream(
      {
        schemaVersion: "crewon.model-request.v0",
        runId: "named-gateway-run",
        segmentId: "named-gateway-segment",
        agentVersionId: "named-gateway-agent",
        instructions: null,
        input: {
          strategy: "manual",
          items: [
            {
              type: "message",
              role: "user",
              content: "Named protocol fixture only.",
            },
          ],
        },
        tools: [],
        maxOutputBytes: 4096,
      },
      AbortSignal.timeout(1000),
    ),
  );
  assert.equal(events.filter((event) => event.type === "completed").length, 1);
  console.log(
    JSON.stringify(
      {
        boundary:
          "Actual Rust captured synthetic byte output, real CrewON SSE parser and direct HTTP transport; no live model, store, tool or commercial footage.",
        before: {
          bytes: broken.length,
          outcome: "responses_event_json_invalid",
        },
        after: {
          bytes: fixed.length,
          sseEvents: frames.length,
          protocolCompleted: 1,
          responseKeptOpen: true,
          elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
        },
      },
      null,
      2,
    ),
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
