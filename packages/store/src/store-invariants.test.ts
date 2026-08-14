import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { RunStoreError } from "@crewon/application";

import { validateMessages, validateWorkItems } from "./store-invariants.ts";

const digest = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const binding = {
  automationId: "automation-1",
  automationRevision: 1,
  definitionDigest: `sha256:${"a".repeat(64)}`,
  instructionDigest: digest("instruction"),
  invocationId: "invocation-1",
  runId: "run-1",
  routeDigest: `sha256:${"b".repeat(64)}`,
  trigger: { kind: "manual" },
} as const;

test("accepts only the canonical automation invocation Work Item payload", () => {
  const workItem = {
    workItemId: "work-1",
    tenantId: "tenant-1",
    runId: "run-1",
    kind: "run.execute",
    payload: {
      schemaVersion: "crewon.automation-invocation-work-item.v1",
      trigger: "automationInvocation",
      throughSequence: 1,
      binding,
    },
    createdAt: "2026-08-09T00:00:00Z",
  } as const;
  assert.doesNotThrow(() =>
    validateWorkItems(
      [workItem],
      "run-1",
      "tenant-1",
      1,
      () => false,
      "automationInvocation",
    ),
  );
  assert.throws(
    () =>
      validateWorkItems(
        [
          {
            ...workItem,
            payload: {
              throughSequence: 1,
              automationInvocationId: "invocation-1",
            },
          },
        ],
        "run-1",
        "tenant-1",
        1,
        () => false,
        "automationInvocation",
      ),
    storeError("work_item_payload_invalid"),
  );
});

test("new Message writes require explicit null or strict canonical origin", () => {
  const event = {
    schemaVersion: "crewon.thread-event.v0",
    identity: { threadId: "thread-1" },
    eventId: "event-1",
    sequence: 1,
    occurredAt: "2026-08-09T00:00:00Z",
    type: "thread.message.appended",
    data: {
      messageId: "message-1",
      messageSequence: 1,
      role: "user",
      contentDigest: binding.instructionDigest,
    },
  } as const;
  const message = {
    messageId: "message-1",
    tenantId: "tenant-1",
    threadId: "thread-1",
    sequence: 1,
    role: "user",
    content: "instruction",
    contentDigest: binding.instructionDigest,
    createdAt: event.occurredAt,
    proposedPlan: null,
    origin: { kind: "automation", binding },
  } as const;
  assert.doesNotThrow(() =>
    validateMessages([message], [event], "thread-1", "tenant-1", () => false),
  );
  const { origin: _origin, ...legacyShapedWrite } = message;
  assert.throws(
    () =>
      validateMessages(
        [legacyShapedWrite],
        [event],
        "thread-1",
        "tenant-1",
        () => false,
      ),
    storeError("message_origin_missing"),
  );
  assert.throws(
    () =>
      validateMessages(
        [
          {
            ...message,
            origin: {
              kind: "automation",
              binding: { ...binding, unexpected: true },
            },
          } as never,
        ],
        [event],
        "thread-1",
        "tenant-1",
        () => false,
      ),
    storeError("message_origin_invalid"),
  );
  const boundaryContent = "a".repeat(9_999);
  const boundaryDigest = digest(boundaryContent);
  assert.doesNotThrow(() =>
    validateMessages(
      [
        {
          ...message,
          content: boundaryContent,
          contentDigest: boundaryDigest,
          origin: {
            kind: "automation",
            binding: { ...binding, instructionDigest: boundaryDigest },
          },
        },
      ],
      [
        {
          ...event,
          data: { ...event.data, contentDigest: boundaryDigest },
        },
      ],
      "thread-1",
      "tenant-1",
      () => false,
    ),
  );
  const oversizedContent = "a".repeat(10_000);
  const oversizedDigest = digest(oversizedContent);
  assert.throws(
    () =>
      validateMessages(
        [
          {
            ...message,
            content: oversizedContent,
            contentDigest: oversizedDigest,
            origin: {
              kind: "automation",
              binding: { ...binding, instructionDigest: oversizedDigest },
            },
          },
        ],
        [
          {
            ...event,
            data: { ...event.data, contentDigest: oversizedDigest },
          },
        ],
        "thread-1",
        "tenant-1",
        () => false,
      ),
    storeError("message_automation_content_too_large"),
  );
});

function storeError(code: string) {
  return (error: unknown) =>
    error instanceof RunStoreError && error.code === code;
}
