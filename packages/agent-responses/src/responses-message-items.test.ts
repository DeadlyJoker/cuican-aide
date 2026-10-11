import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentKernelError,
  CrewONAgentKernel,
  ModelTransportError,
  type KernelAgentEvent,
  type ModelTransportEvent,
} from "@crewon/agent-kernel";

import { DirectResponsesTransport } from "./direct-responses-transport.ts";
import { ResponsesProtocolDecoder } from "./responses-protocol.ts";

const first = "first \n";
const second = " second\t";
const responseId = "response-message-items";

for (const sequencePolicy of ["required", "whenPresent"] as const) {
  test(`${sequencePolicy} validates each completed message against its own indexed deltas`, () => {
    const fixture = decoderFixture(sequencePolicy);
    fixture.accept(delta(0, first));
    assertCompletedItem(fixture.accept(done(0, first)), first);
    fixture.accept(delta(3, second));
    assertCompletedItem(fixture.accept(done(3, second)), second);
    assert.deepEqual(fixture.accept(terminal([first, second])), [
      { type: "completed", checkpoint: null },
    ]);
    fixture.decoder.finish();
    assert.deepEqual(fixture.decoder.completedHistoryItems, [
      historyMessage(first),
      historyMessage(second),
    ]);
  });
}

test("multiple text content parts in one message preserve whitespace and item ownership", () => {
  const fixture = decoderFixture();
  fixture.accept({ ...delta(2, first), content_index: 0 });
  fixture.accept({ ...delta(2, second), content_index: 1 });
  assertCompletedItem(
    fixture.accept({
      type: "response.output_item.done",
      output_index: 2,
      item: {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: first },
          { type: "output_text", text: second },
        ],
      },
    }),
    first + second,
  );
  fixture.accept(terminal([first + second]));
  fixture.decoder.finish();
});

for (const shape of [
  "no-indices",
  "done-only",
  "delta-only",
  "mixed",
] as const) {
  test(`single-message compatibility retains ${shape} output indices`, () => {
    const fixture = decoderFixture();
    fixture.accept({
      type: "response.output_text.delta",
      ...(shape === "delta-only" || shape === "mixed"
        ? { output_index: 0 }
        : {}),
      delta: first,
    });
    fixture.accept({ type: "response.output_text.delta", delta: second });
    assertCompletedItem(
      fixture.accept({
        type: "response.output_item.done",
        ...(shape === "done-only" || shape === "mixed"
          ? { output_index: 0 }
          : {}),
        item: message(first + second),
      }),
      first + second,
    );
    fixture.accept(terminal([first + second]));
    fixture.decoder.finish();
  });
}

test("a second message cannot claim the full response's cumulative output", () => {
  const fixture = decoderFixture();
  fixture.accept(delta(0, first));
  fixture.accept(done(0, first));
  fixture.accept(delta(1, second));
  assert.throws(
    () => fixture.accept(done(1, first + second)),
    hasProtocolCode("responses_final_output_mismatch"),
  );
  assert.equal(fixture.decoder.terminal, false);
});

test("a completed message cannot claim a different indexed item's output", () => {
  const fixture = decoderFixture();
  fixture.accept(delta(0, first));
  fixture.accept(delta(1, second));
  assert.throws(
    () => fixture.accept(done(2, first + second)),
    hasProtocolCode("responses_final_output_mismatch"),
  );
});

test("indexed completed messages reject duplicate completion and subsequent deltas", () => {
  const duplicate = decoderFixture();
  duplicate.accept(delta(0, first));
  duplicate.accept(done(0, first));
  assert.throws(
    () => duplicate.accept(done(0, first)),
    hasProtocolCode("responses_output_item_duplicate"),
  );
  const lateDelta = decoderFixture();
  lateDelta.accept(delta(0, first));
  lateDelta.accept(done(0, first));
  assert.throws(
    () => lateDelta.accept(delta(0, second)),
    hasProtocolCode("responses_delta_after_item_done"),
  );
});

test("unindexed deltas cannot extend a completed message or be assigned to another message", () => {
  for (const shape of ["no-indices", "done-only", "delta-only"]) {
    const fixture = decoderFixture();
    fixture.accept({
      type: "response.output_text.delta",
      ...(shape === "delta-only" ? { output_index: 0 } : {}),
      delta: first,
    });
    fixture.accept({
      type: "response.output_item.done",
      ...(shape === "done-only" ? { output_index: 0 } : {}),
      item: message(first),
    });
    assert.throws(
      () =>
        fixture.accept({ type: "response.output_text.delta", delta: second }),
      hasProtocolCode("responses_delta_after_item_done"),
    );
  }
});

test("ambiguous unindexed completion cannot bypass multiple indexed message ownership", () => {
  const fixture = decoderFixture();
  fixture.accept(delta(0, first));
  fixture.accept(delta(1, second));
  assert.throws(
    () =>
      fixture.accept({
        type: "response.output_item.done",
        item: message(first + second),
      }),
    hasProtocolCode("responses_final_output_mismatch"),
  );
});

test("output indices fail closed when present but not nonnegative safe integers", () => {
  for (const index of [null, "0", -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    for (const event of [delta(index, first), done(index, first)]) {
      assert.throws(
        () => decoderFixture().accept(event),
        hasProtocolCode("responses_output_index_invalid"),
      );
    }
  }
});

test("sparse output indices do not allocate by index and tracking has a bounded item count", () => {
  const sparse = decoderFixture();
  sparse.accept(delta(Number.MAX_SAFE_INTEGER, first));
  sparse.accept(done(Number.MAX_SAFE_INTEGER, first));
  sparse.accept(terminal([first]));
  sparse.decoder.finish();

  const bounded = decoderFixture();
  for (let index = 0; index < 512; index += 1)
    bounded.accept(delta(index, "x"));
  assert.throws(
    () => bounded.accept(delta(512, "x")),
    hasProtocolCode("responses_output_items_exceeded"),
  );
});

test("the response terminal still validates the complete combined output", () => {
  const fixture = decoderFixture();
  fixture.accept(delta(0, first));
  fixture.accept(done(0, first));
  fixture.accept(delta(1, second));
  fixture.accept(done(1, second));
  assert.throws(
    () => fixture.accept(terminal([first, "different"])),
    hasProtocolCode("responses_output_mismatch"),
  );
});

test("portable Standard completes multiple messages once in the Kernel without resampling", async () => {
  // Preserve the Kernel's existing linear contract: each message completes
  // before the next message's deltas. Cross-message interleaving is not added.
  const fixture = executionFixture(multipleMessageFrames());
  await fixture.execute();
  assert.deepEqual(fixture.methods, ["POST"]);
  assert.deepEqual(
    fixture.events.flatMap((event) =>
      event.type === "model.output.delta" ? [event.data.delta] : [],
    ),
    [first, second],
  );
  assert.deepEqual(
    fixture.events
      .filter((event) => event.type === "segment.completed")
      .map((event) => event.data),
    [{ output: first + second }],
  );
  assert.equal(
    fixture.events.filter((event) => event.type === "usage.recorded").length,
    1,
  );
  assert.equal(
    fixture.events.some((event) => event.type === "model.sampling.retry"),
    false,
  );
});

test("multiple validated items still require a protocol terminal", async () => {
  const fixture = executionFixture(multipleMessageFrames().slice(0, -1));
  await assert.rejects(
    fixture.execute,
    hasKernelCode("responses_stream_incomplete", false),
  );
  assertNoCompletion(fixture);
});

test("post-terminal frames still withhold public completion and usage for multiple messages", async () => {
  const fixture = executionFixture([
    ...multipleMessageFrames(),
    delta(2, "illegal"),
  ]);
  await assert.rejects(
    fixture.execute,
    hasKernelCode("responses_event_after_terminal", false),
  );
  assertNoCompletion(fixture);
});

test("an unindexed late delta cannot complete through an empty portable terminal output", async () => {
  const fixture = executionFixture([
    { type: "response.created", response: { id: responseId } },
    { type: "response.output_text.delta", delta: first },
    { type: "response.output_item.done", item: message(first) },
    { type: "response.output_text.delta", delta: second },
    terminal([]),
  ]);
  await assert.rejects(
    fixture.execute,
    hasKernelCode("responses_delta_after_item_done", false),
  );
  assertNoCompletion(fixture);
});

function decoderFixture(
  sequencePolicy: "required" | "whenPresent" = "whenPresent",
) {
  const decoder = new ResponsesProtocolDecoder({
    sequencePolicy,
    completedCheckpoint: () => null,
  });
  let sequence = 0;
  const accept = (event: Record<string, unknown>) =>
    decoder.accept({
      ...event,
      ...(sequencePolicy === "required" ? { sequence_number: sequence++ } : {}),
    });
  accept({ type: "response.created", response: { id: responseId } });
  return { decoder, accept };
}
function delta(index: unknown, text: string): Record<string, unknown> {
  return {
    type: "response.output_text.delta",
    output_index: index,
    content_index: 0,
    delta: text,
  };
}
function done(index: unknown, text: string): Record<string, unknown> {
  return {
    type: "response.output_item.done",
    output_index: index,
    item: message(text),
  };
}
function message(text: string) {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
}
function historyMessage(content: string) {
  return { type: "message", role: "assistant", content };
}
function terminal(messages: string[]): Record<string, unknown> {
  return {
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output: messages.map(message),
    },
  };
}
function assertCompletedItem(
  events: readonly ModelTransportEvent[],
  text: string,
) {
  assert.deepEqual(events, [
    { type: "output.item.completed", item: historyMessage(text) },
  ]);
}
function hasProtocolCode(code: string) {
  return (error: unknown) =>
    error instanceof ModelTransportError &&
    error.category === "protocol" &&
    error.code === code &&
    !error.retryable;
}
function hasKernelCode(code: string, retryable: boolean) {
  return (error: unknown) =>
    error instanceof AgentKernelError &&
    error.code === code &&
    error.retryable === retryable;
}
function multipleMessageFrames(): Record<string, unknown>[] {
  const completed = terminal([first, second]);
  return [
    { type: "response.created", response: { id: responseId } },
    delta(0, first),
    done(0, first),
    delta(1, second),
    done(1, second),
    {
      ...completed,
      response: {
        ...(completed.response as Record<string, unknown>),
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      },
    },
  ];
}
function executionFixture(frames: Record<string, unknown>[]) {
  const methods: string[] = [];
  const events: KernelAgentEvent[] = [];
  const transport = new DirectResponsesTransport(
    {
      endpoint: "https://gateway.example/v1/responses",
      model: "model",
      requestProfile: "standard",
      sequencePolicy: "whenPresent",
      identityPolicy: "terminalAuthoritative",
      storeResponses: false,
    },
    {
      fetch: async (_url, init) => {
        methods.push(init?.method ?? "GET");
        return new Response(
          frames.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    },
  );
  const kernel = new CrewONAgentKernel({ transport, streamMaxRetries: 0 });
  const execute = async () => {
    for await (const event of kernel.runSegment(
      {
        schemaVersion: "crewon.agent-segment.v0",
        purpose: "agent",
        runId: "run-message-items",
        segmentId: "segment",
        attempt: 1,
        agentVersionId: "agent",
        policySnapshotId: "policy",
        collaborationMode: "default",
        allowedTools: null,
        history: [{ type: "message", role: "user", content: "hello" }],
        continuation: { kind: "manual" },
        budget: { maxOutputBytes: 8192 },
      },
      new AbortController().signal,
    ))
      events.push(event);
  };
  return { methods, events, execute };
}
function assertNoCompletion(fixture: ReturnType<typeof executionFixture>) {
  assert.deepEqual(fixture.methods, ["POST"]);
  assert.equal(
    fixture.events.some(
      (event) =>
        event.type === "segment.completed" || event.type === "usage.recorded",
    ),
    false,
  );
}
