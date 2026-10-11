import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentKernelError,
  CrewONAgentKernel,
  type AgentSegmentContract,
  type KernelAgentEvent,
} from "@crewon/agent-kernel";

import {
  DirectResponsesTransport,
  type DirectResponsesTransportConfig,
} from "./direct-responses-transport.ts";

const deltas = ["first", " ", "line", "\n", "next", "\n"];
const text = deltas.join("");
const responseId = "response-format-compatibility";
const contract: AgentSegmentContract = {
  schemaVersion: "crewon.agent-segment.v0",
  purpose: "agent",
  runId: "run-format-compatibility",
  segmentId: "segment-format-compatibility",
  attempt: 1,
  agentVersionId: "agent-format-compatibility",
  policySnapshotId: "policy",
  collaborationMode: "default",
  allowedTools: null,
  history: [
    { type: "message", role: "user", content: "first question" },
    { type: "message", role: "assistant", content: "previous answer" },
    { type: "message", role: "user", content: "continue" },
  ],
  continuation: { kind: "manual" },
  budget: { maxOutputBytes: 8192 },
};
const portableStandard = {
  endpoint: "https://gateway.example/v1/responses",
  model: "model",
  requestProfile: "standard",
  sequencePolicy: "whenPresent",
  identityPolicy: "terminalAuthoritative",
  storeResponses: false,
} as const satisfies DirectResponsesTransportConfig;

test("portable Standard accepts a validated streamed item with an empty terminal output in one Kernel call", async () => {
  const fixture = executionFixture(portableStandard, frames("empty"));
  await assertCompleted(fixture);
  assertStandardRequest(fixture);
});

test("portable Standard still accepts a matching nonempty terminal output", async () => {
  const fixture = executionFixture(portableStandard, frames("matching"));
  await assertCompleted(fixture);
  assertStandardRequest(fixture);
});

test("default strict Standard still rejects an empty terminal output", async () => {
  const { identityPolicy: _portableIdentity, ...strictStandard } =
    portableStandard;
  const fixture = executionFixture(strictStandard, frames("empty"));
  await assertRejected(fixture, "responses_output_mismatch");
  assertStandardRequest(fixture);
});

test("strict Lite preserves its existing streamed-output compatibility", async () => {
  const { identityPolicy: _portableIdentity, ...strict } = portableStandard;
  const fixture = executionFixture(
    { ...strict, requestProfile: "responsesLite" },
    frames("empty"),
  );
  await assertCompleted(fixture);
  assert.equal(fixture.bodies[0]?.store, false);
  assert.deepEqual(fixture.bodies[0]?.reasoning, { context: "all_turns" });
  assert.equal(fixture.bodies[0]?.parallel_tool_calls, false);
});

test("portable Standard rejects conflicting nonempty terminal output without a retry", async () => {
  const fixture = executionFixture(portableStandard, frames("conflicting"));
  await assertRejected(fixture, "responses_output_mismatch");
  assertStandardRequest(fixture);
});

test("portable Standard still validates output_item.done against all streamed whitespace", async () => {
  const fixture = executionFixture(
    portableStandard,
    frames("empty", text.trim()),
  );
  await assertRejected(fixture, "responses_final_output_mismatch");
  assertStandardRequest(fixture);
});

test("portable Standard rejects a received post-terminal frame and withholds public usage and completion", async () => {
  const fixture = executionFixture(
    portableStandard,
    frames("matching") +
      frame({
        type: "response.output_text.delta",
        delta: "illegal tail",
      }),
  );
  await assertRejected(fixture, "responses_event_after_terminal");
  assertStandardRequest(fixture);
});

test("portable Standard cannot complete from a full done item without a protocol terminal", async () => {
  // One physical attempt isolates terminal validation rather than exercising retry scheduling.
  const fixture = executionFixture(portableStandard, frames("absent"), 0);
  await assertRejected(fixture, "responses_stream_incomplete");
  assertStandardRequest(fixture);
});

function message(content: string): Readonly<Record<string, unknown>> {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: content }],
  };
}

function frames(
  terminalOutput: "empty" | "matching" | "conflicting" | "absent",
  doneText = text,
): string {
  return [
    { type: "response.created", response: { id: responseId } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "message-format",
        type: "message",
        role: "assistant",
        content: [],
      },
    },
    ...deltas.map((delta) => ({ type: "response.output_text.delta", delta })),
    {
      type: "response.output_item.done",
      output_index: 0,
      item: message(doneText),
    },
    ...(terminalOutput === "absent"
      ? []
      : [
          {
            type: "response.completed",
            response: {
              id: responseId,
              status: "completed",
              output:
                terminalOutput === "empty"
                  ? []
                  : [
                      message(
                        terminalOutput === "matching"
                          ? text
                          : "different output",
                      ),
                    ],
              usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
            },
          },
        ]),
  ]
    .map(frame)
    .join("");
}

function frame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function executionFixture(
  config: DirectResponsesTransportConfig,
  wire: string,
  streamMaxRetries = 5,
) {
  const methods: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const events: KernelAgentEvent[] = [];
  const transport = new DirectResponsesTransport(config, {
    fetch: async (_url, init) => {
      methods.push(init?.method ?? "GET");
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            // One physical chunk also exercises validation of the already received terminal tail.
            controller.enqueue(new TextEncoder().encode(wire));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const kernel = new CrewONAgentKernel({
    transport,
    streamMaxRetries,
    retryScheduler: {
      wait: async () => {
        assert.fail("unexpected sampling retry");
      },
    },
  });
  const execute = async () => {
    for await (const event of kernel.runSegment(
      contract,
      new AbortController().signal,
    ))
      events.push(event);
  };
  return { execute, methods, bodies, events, transport };
}

async function assertCompleted(
  fixture: ReturnType<typeof executionFixture>,
): Promise<void> {
  await fixture.execute();
  assert.deepEqual(fixture.methods, ["POST"]);
  assert.equal(fixture.transport.supportsResponseRetrieve, false);
  assert.deepEqual(
    fixture.events.flatMap((event) =>
      event.type === "model.output.delta" ? [event.data.delta] : [],
    ),
    deltas,
  );
  assert.equal(
    fixture.events.filter((event) => event.type === "model.sampling.retry")
      .length,
    0,
  );
  assert.equal(
    fixture.events.filter((event) => event.type === "usage.recorded").length,
    1,
  );
  const completed = fixture.events.filter(
    (event) => event.type === "segment.completed",
  );
  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0]?.data, { output: text });
  assert.equal(
    fixture.events.some(
      (event) =>
        event.type === "segment.provider_response_created" ||
        event.type === "segment.checkpointed",
    ),
    false,
  );
}

async function assertRejected(
  fixture: ReturnType<typeof executionFixture>,
  code: string,
): Promise<void> {
  await assert.rejects(
    fixture.execute,
    (error) =>
      error instanceof AgentKernelError &&
      error.code === code &&
      !error.retryable,
  );
  assert.deepEqual(fixture.methods, ["POST"]);
  assert.equal(
    fixture.events.some(
      (event) =>
        event.type === "usage.recorded" ||
        event.type === "segment.completed" ||
        event.type === "segment.checkpointed" ||
        event.type === "model.sampling.retry",
    ),
    false,
  );
}

function assertStandardRequest(
  fixture: ReturnType<typeof executionFixture>,
): void {
  assert.equal(fixture.bodies.length, 1);
  const body = fixture.bodies[0]!;
  assert.equal(body.store, false);
  for (const key of [
    "reasoning",
    "parallel_tool_calls",
    "previous_response_id",
  ])
    assert.equal(Object.hasOwn(body, key), false, key);
  assert.deepEqual(body.input, [
    { role: "user", content: "first question" },
    { role: "assistant", content: "previous answer" },
    { role: "user", content: "continue" },
  ]);
}
