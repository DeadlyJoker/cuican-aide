import assert from "node:assert/strict";
import test from "node:test";

import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";
import { streamThreadGoalEvents } from "./thread-goal-event-stream.ts";

test("reconnects with the independent Goal cursor across clear and revision reset", async () => {
  const requests: { input: string; headers: Headers }[] = [];
  const connections = [
    sseResponse([goalUpdatedEvent(1, "goal-1", 2), goalClearedEvent(2)]),
    sseResponse([goalUpdatedEvent(3, "goal-2", 1)]),
  ];
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    accessToken: "goal-stream-token",
    fetch: async (input, init = {}) => {
      requests.push({
        input: String(input),
        headers: new Headers(init.headers),
      });
      const response = connections.shift();
      assert.notEqual(response, undefined);
      return response as Response;
    },
  });

  const events = [];
  for await (const event of streamThreadGoalEvents(client, {
    threadId: "thread/1",
    reconnectDelayMs: 0,
  })) {
    events.push(event);
    if (events.length === 3) {
      break;
    }
  }

  assert.deepEqual(events, [
    goalUpdatedEvent(1, "goal-1", 2),
    goalClearedEvent(2),
    goalUpdatedEvent(3, "goal-2", 1),
  ]);
  assert.deepEqual(
    requests.map(({ input, headers }) => ({
      input,
      lastEventId: headers.get("last-event-id"),
      authorization: headers.get("authorization"),
    })),
    [
      {
        input: "https://control.example/api/v1/threads/thread%2F1/goal/events",
        lastEventId: null,
        authorization: "Bearer goal-stream-token",
      },
      {
        input: "https://control.example/api/v1/threads/thread%2F1/goal/events",
        lastEventId: "2",
        authorization: "Bearer goal-stream-token",
      },
    ],
  );
});

test("parses fragmented CRLF Goal events and resumes from Last-Event-ID", async () => {
  const requests: Headers[] = [];
  const payload = frame(goalUpdatedEvent(8, "goal-1", 4)).replaceAll(
    "\n",
    "\r\n",
  );
  const bytes = new TextEncoder().encode(payload);
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async (_input, init = {}) => {
      requests.push(new Headers(init.headers));
      return new Response(fragmentedStream(bytes, [1, 9, 27, 71]), {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    },
  });

  for await (const event of streamThreadGoalEvents(client, {
    threadId: "thread/1",
    afterSequence: 7,
    reconnectDelayMs: 0,
  })) {
    assert.deepEqual(event, goalUpdatedEvent(8, "goal-1", 4));
    break;
  }
  assert.equal(requests[0]?.get("last-event-id"), "7");
});

test("fails closed for malformed and cross-shaped public Goal events", async (t) => {
  const validGoal = goalUpdatedEvent(1, "goal-1", 1);
  const cases: readonly { name: string; event: unknown }[] = [
    {
      name: "updated event carrying clear data",
      event: { ...validGoal, data: goalClearedEvent(1).data },
    },
    {
      name: "cleared event carrying Goal data",
      event: {
        ...goalClearedEvent(1),
        data: validGoal.data,
      },
    },
    {
      name: "private tenant field",
      event: { ...validGoal, tenantId: "tenant-secret" },
    },
    {
      name: "Run event identity",
      event: {
        eventId: "run-event-1",
        runId: "run-1",
        sequence: 1,
        occurredAt: "2026-08-09T00:00:01Z",
        type: "run.started",
        data: {},
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const client = goalStreamClient(rawFrame(item.event, 1));
      await assert.rejects(async () => {
        for await (const _event of streamThreadGoalEvents(client, {
          threadId: "thread/1",
          reconnectDelayMs: 0,
        })) {
          assert.fail("invalid event must not be yielded");
        }
      }, hasProtocolCode("control_client_goal_event_invalid"));
    });
  }
});

test("rejects cross-thread events and missing durable sequences", async () => {
  const crossThread = goalStreamClient(
    frame({
      ...goalUpdatedEvent(1, "goal-1", 1),
      threadId: "thread-2",
      data: {
        goal: {
          ...goalUpdatedEvent(1, "goal-1", 1).data.goal,
          threadId: "thread-2",
        },
      },
    }),
  );
  await assert.rejects(async () => {
    for await (const _event of streamThreadGoalEvents(crossThread, {
      threadId: "thread/1",
      reconnectDelayMs: 0,
    })) {
      assert.fail("cross-thread event must not be yielded");
    }
  }, hasProtocolCode("control_client_goal_event_thread_mismatch"));

  const skippedSequence = goalStreamClient(
    frame(goalUpdatedEvent(2, "goal-1", 1)),
  );
  await assert.rejects(async () => {
    for await (const _event of streamThreadGoalEvents(skippedSequence, {
      threadId: "thread/1",
      reconnectDelayMs: 0,
    })) {
      assert.fail("non-contiguous event must not be yielded");
    }
  }, hasProtocolCode("control_client_goal_event_sequence_invalid"));
});

test("enforces hard caps for individual frames and buffered input", async () => {
  const oversizedFrame = goalStreamClient(
    `id: 1\nevent: goal.updated\ndata: ${"x".repeat(128 * 1024)}\n\n`,
  );
  await assert.rejects(async () => {
    for await (const _event of streamThreadGoalEvents(oversizedFrame, {
      threadId: "thread/1",
      reconnectDelayMs: 0,
    })) {
      assert.fail("oversized frame must not be yielded");
    }
  }, hasProtocolCode("control_client_goal_event_frame_too_large"));

  const oversizedBuffer = goalStreamClient("x".repeat(256 * 1024 + 1));
  await assert.rejects(async () => {
    for await (const _event of streamThreadGoalEvents(oversizedBuffer, {
      threadId: "thread/1",
      reconnectDelayMs: 0,
    })) {
      assert.fail("oversized buffer must not be yielded");
    }
  }, hasProtocolCode("control_client_goal_event_buffer_too_large"));
});

function goalUpdatedEvent(sequence: number, goalId: string, revision: number) {
  return {
    schemaVersion: "crewon.thread-goal-event.v0" as const,
    threadId: "thread/1",
    eventId: `goal-event-${sequence}`,
    sequence,
    occurredAt: `2026-08-09T00:00:0${sequence}Z`,
    type: "goal.updated" as const,
    data: {
      goal: {
        threadId: "thread/1",
        goalId,
        revision,
        objective: "complete the migration",
        status: "active" as const,
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: "2026-08-09T00:00:00Z",
        updatedAt: `2026-08-09T00:00:0${sequence}Z`,
      },
    },
  };
}

function goalClearedEvent(sequence: number) {
  return {
    schemaVersion: "crewon.thread-goal-event.v0" as const,
    threadId: "thread/1",
    eventId: `goal-event-${sequence}`,
    sequence,
    occurredAt: `2026-08-09T00:00:0${sequence}Z`,
    type: "goal.cleared" as const,
    data: {
      previousGoalId: "goal-1",
      previousRevision: 2,
    },
  };
}

function sseResponse(events: readonly unknown[]): Response {
  return goalStreamResponse(events.map(frame).join(""));
}

function goalStreamClient(payload: string): ControlApiClient {
  return new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async () => goalStreamResponse(payload),
  });
}

function goalStreamResponse(payload: string): Response {
  return new Response(payload, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function frame(event: unknown): string {
  if (
    !isRecord(event) ||
    !Number.isSafeInteger(event.sequence) ||
    typeof event.type !== "string"
  ) {
    throw new Error("test Goal event is invalid");
  }
  return rawFrame(event, Number(event.sequence), event.type);
}

function rawFrame(
  event: unknown,
  sequence: number,
  type = isRecord(event) && typeof event.type === "string"
    ? event.type
    : "goal.updated",
): string {
  return `id: ${sequence}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function fragmentedStream(
  bytes: Uint8Array,
  boundaries: readonly number[],
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      let offset = 0;
      for (const boundary of boundaries) {
        controller.enqueue(bytes.slice(offset, boundary));
        offset = boundary;
      }
      controller.enqueue(bytes.slice(offset));
      controller.close();
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasProtocolCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof ControlApiProtocolError && error.code === code;
}
