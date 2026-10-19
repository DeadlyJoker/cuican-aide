import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { parseResponsesSse } from "../../packages/agent-responses/src/responses-sse.ts";
import { DirectResponsesTransport } from "../../packages/agent-responses/src/direct-responses-transport.ts";

// Named fixture captured from the actual isolated Go gateway regression, not a live model response.
const bytes = readFileSync(process.argv[2]);
const frames = await Array.fromAsync(
  parseResponsesSse(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  ),
);
assert.deepEqual(
  frames.map((frame) => frame.value.type),
  ["response.created", "response.completed"],
);
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(bytes);
  // HTTP remains open; the actual client terminal must end future reads.
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const transport = new DirectResponsesTransport({
  endpoint: `http://127.0.0.1:${server.address().port}/v1/responses`,
  model: "named-new-api-wire-fixture",
  idleTimeoutMs: 500,
});
try {
  const started = performance.now();
  const events = await Array.fromAsync(
    transport.stream(
      {
        schemaVersion: "crewon.model-request.v0",
        runId: "named-new-api-run",
        segmentId: "named-new-api-segment",
        agentVersionId: "named-new-api-agent",
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
          "Actual Go gateway captured named fixture bytes, real CrewON parser and direct local HTTP; no real model, client UI or business Run.",
        bytes: bytes.length,
        frameTypes: frames.map((frame) => frame.value.type),
        protocolCompleted: 1,
        responseKeptOpen: true,
        elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
      },
      null,
      2,
    ),
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
