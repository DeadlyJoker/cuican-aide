import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_AUTOMATION_INSTRUCTION_BYTES,
  createAutomationDefinition,
  renderAutomationInstruction,
} from "./automation.ts";
import {
  TURN_ABORTED_HISTORY_MARKER,
  isModelHistoryInstructionBoundary,
  isModelHistoryMessageBacked,
  isModelHistoryRetainedUserMessage,
  ModelHistoryError,
  validateModelHistoryItem,
  type ModelHistoryItem,
} from "./model-history.ts";

test("accepts bounded canonical message and Tool history items", () => {
  const items: readonly ModelHistoryItem[] = [
    messageItem(),
    {
      ...base(2),
      type: "tool_call",
      kind: "function",
      callId: "call-1",
      name: "shell_command",
      input: '{"command":"pwd"}',
    },
    {
      ...base(3),
      type: "tool_result",
      kind: "function",
      callId: "call-1",
      output: "ok",
      isError: false,
      status: "completed",
    },
    {
      ...base(4),
      type: "compaction",
      mode: "auto",
      replacesThroughSequence: 3,
      sourceDigest: `sha256:${"b".repeat(64)}`,
      summary: "Summary of the conversation",
      summaryDigest: `sha256:${"c".repeat(64)}`,
      retainedUserMessages: [
        {
          content: "hello",
          contentDigest: `sha256:${"a".repeat(64)}`,
        },
      ],
    },
  ];

  for (const item of items) {
    assert.doesNotThrow(() => validateModelHistoryItem(item));
  }
});

test("fails closed on malformed execution identity and aborted results", () => {
  assert.throws(
    () =>
      validateModelHistoryItem({ ...messageItem(), segmentId: "segment-1" }),
    isHistoryError,
  );
  assert.throws(
    () =>
      validateModelHistoryItem({
        ...messageItem(),
        source: "turn_aborted",
        content: "forged abort marker",
      }),
    isHistoryError,
  );
  assert.throws(
    () =>
      validateModelHistoryItem({
        ...base(2),
        type: "tool_result",
        kind: "function",
        callId: "call-1",
        output: "aborted",
        isError: false,
        status: "aborted",
      }),
    isHistoryError,
  );
  assert.throws(
    () =>
      validateModelHistoryItem({
        ...base(4),
        type: "compaction",
        mode: "auto",
        replacesThroughSequence: 4,
        sourceDigest: `sha256:${"b".repeat(64)}`,
        summary: "summary",
        summaryDigest: `sha256:${"c".repeat(64)}`,
        retainedUserMessages: [],
      }),
    isHistoryError,
  );
});

test("accepts Goal steering only as a user-visible history message", () => {
  const steering: Extract<ModelHistoryItem, { type: "message" }> = {
    ...messageItem(),
    runId: "run-1",
    segmentId: null,
    source: "goal_steering",
    content: "The active thread goal objective was edited by the user.",
  };

  assert.doesNotThrow(() => validateModelHistoryItem(steering));
  assert.throws(
    () => validateModelHistoryItem({ ...steering, role: "system" }),
    hasHistoryCode("model_history_goal_steering_invalid"),
  );
});

test("accepts only a provenance-bound user Automation invocation", () => {
  const item = automationInvocationItem("Run the daily summary.");

  assert.doesNotThrow(() => validateModelHistoryItem(item));
  for (const invalid of [
    { ...item, role: "assistant" },
    { ...item, unexpected: true },
    { ...item, origin: { ...item.origin, unexpected: true } },
    {
      ...item,
      origin: {
        ...item.origin,
        binding: { ...item.origin.binding, runId: "run-other" },
      },
    },
    {
      ...item,
      origin: {
        ...item.origin,
        binding: {
          ...item.origin.binding,
          instructionDigest: `sha256:${"d".repeat(64)}`,
        },
      },
    },
    { ...item, origin: undefined },
  ]) {
    assert.throws(
      () => validateModelHistoryItem(invalid as ModelHistoryItem),
      ModelHistoryError,
    );
  }
  assert.throws(
    () =>
      validateModelHistoryItem({
        ...messageItem(),
        origin: automationOrigin(),
      } as unknown as ModelHistoryItem),
    hasHistoryCode("model_history_message_origin_invalid"),
  );
});

test("classifies canonical message sources consistently for rollback, ledger correlation, and compaction", () => {
  const automation = automationInvocationItem("Run the daily summary.");
  const items = [
    messageItem(),
    automation,
    { ...messageItem(), role: "assistant", source: "assistant_completion" },
    { ...messageItem(), source: "goal_continuation" },
    { ...messageItem(), source: "goal_steering" },
    {
      ...messageItem(),
      source: "turn_aborted",
      content: TURN_ABORTED_HISTORY_MARKER,
    },
  ] satisfies readonly ModelHistoryItem[];

  assert.deepEqual(
    items.map((item) => ({
      source: item.type === "message" ? item.source : null,
      instructionBoundary: isModelHistoryInstructionBoundary(item),
      messageBacked: isModelHistoryMessageBacked(item),
      retainedUser: isModelHistoryRetainedUserMessage(item),
    })),
    [
      {
        source: "thread_message",
        instructionBoundary: true,
        messageBacked: true,
        retainedUser: true,
      },
      {
        source: "automation_invocation",
        instructionBoundary: true,
        messageBacked: true,
        retainedUser: true,
      },
      {
        source: "assistant_completion",
        instructionBoundary: false,
        messageBacked: true,
        retainedUser: false,
      },
      {
        source: "goal_continuation",
        instructionBoundary: false,
        messageBacked: false,
        retainedUser: false,
      },
      {
        source: "goal_steering",
        instructionBoundary: false,
        messageBacked: false,
        retainedUser: false,
      },
      {
        source: "turn_aborted",
        instructionBoundary: false,
        messageBacked: false,
        retainedUser: false,
      },
    ],
  );
});

test("admits a fully rendered Automation instruction only through 9999 UTF-8 bytes", () => {
  const oneByte = automationDefinition("x");
  const fixedBytes = byteLength(renderAutomationInstruction(oneByte)) - 1;
  const boundary = automationDefinition(
    "x".repeat(MAX_AUTOMATION_INSTRUCTION_BYTES - fixedBytes),
  );
  const instruction = renderAutomationInstruction(boundary);

  assert.equal(byteLength(instruction), MAX_AUTOMATION_INSTRUCTION_BYTES);
  assert.doesNotThrow(() =>
    validateModelHistoryItem(automationInvocationItem(instruction)),
  );
  assert.throws(
    () => validateModelHistoryItem(automationInvocationItem(`${instruction}x`)),
    hasHistoryCode("model_history_content_invalid"),
  );
});

function messageItem() {
  return {
    ...base(1),
    runId: null,
    segmentId: null,
    type: "message" as const,
    role: "user" as const,
    source: "thread_message" as const,
    content: "hello",
    contentDigest: `sha256:${"a".repeat(64)}`,
  };
}

function automationInvocationItem(
  content: string,
): Extract<
  ModelHistoryItem,
  { type: "message"; source: "automation_invocation" }
> {
  return {
    ...base(1),
    runId: "run-1",
    segmentId: null,
    type: "message",
    role: "user",
    source: "automation_invocation",
    content,
    contentDigest: `sha256:${"c".repeat(64)}`,
    origin: automationOrigin(),
  };
}

function automationOrigin() {
  return {
    kind: "automation" as const,
    binding: {
      automationId: "automation-1",
      automationRevision: 1 as const,
      definitionDigest: `sha256:${"a".repeat(64)}`,
      instructionDigest: `sha256:${"c".repeat(64)}`,
      invocationId: "invocation-1",
      runId: "run-1",
      routeDigest: `sha256:${"b".repeat(64)}`,
    },
  };
}

function automationDefinition(prompt: string) {
  return createAutomationDefinition({
    automationId: "automation-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
    createdByActorId: "actor-1",
    threadId: "thread-1",
    title: "Daily summary",
    prompt,
    agentVersionId: "agent-version-1",
    schedule: {
      scheduleType: "daily",
      nextRunAt: "2026-08-10T10:00:00Z",
      intervalSeconds: 86_400,
      time: "18:00",
      weekday: 0,
      timezone: "Asia/Shanghai",
    },
    createdAt: "2026-08-09T00:00:00Z",
  });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function base(sequence: number) {
  return {
    schemaVersion: "crewon.model-history-item.v0" as const,
    itemId: `history-${sequence}`,
    tenantId: "tenant-1",
    threadId: "thread-1",
    sequence,
    runId: "run-1",
    segmentId: "segment-1",
    createdAt: "2026-08-08T00:00:00.000Z",
  };
}

function isHistoryError(error: unknown): boolean {
  return error instanceof ModelHistoryError;
}

function hasHistoryCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ModelHistoryError && error.code === code;
}
