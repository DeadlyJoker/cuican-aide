import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import test from "node:test";

import type { ThreadGoalEvent } from "@crewon/domain";

import { writeThreadGoalSseEvent } from "./thread-goal-event-stream.ts";

test("waits for drain without dropping a backpressured Goal event", async () => {
  const response = new BackpressuredResponse();
  const controller = new AbortController();
  let settled = false;
  const pending = writeThreadGoalSseEvent(
    response as unknown as ServerResponse,
    goalEvent(),
    controller.signal,
  ).then((result) => {
    settled = true;
    return result;
  });

  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(response.chunks.length, 1);
  assert.equal(response.chunks[0]?.includes("tenant-1"), false);
  assert.match(response.chunks[0] ?? "", /^id: 1\nevent: goal\.updated\n/);

  response.writableNeedDrain = false;
  response.emit("drain");
  assert.equal(await pending, true);
  assert.equal(response.listenerCount("drain"), 0);
  assert.equal(response.listenerCount("close"), 0);
  assert.equal(response.listenerCount("error"), 0);
});

test("stops a backpressured Goal write on close, error or abort", async () => {
  for (const outcome of ["close", "error", "abort"] as const) {
    const response = new BackpressuredResponse();
    const controller = new AbortController();
    const pending = writeThreadGoalSseEvent(
      response as unknown as ServerResponse,
      goalEvent(),
      controller.signal,
    );

    if (outcome === "abort") {
      controller.abort();
    } else {
      response.emit(
        outcome,
        outcome === "error" ? new Error("closed") : undefined,
      );
    }
    assert.equal(await pending, false);
    assert.equal(response.listenerCount("drain"), 0);
    assert.equal(response.listenerCount("close"), 0);
    assert.equal(response.listenerCount("error"), 0);
  }
});

class BackpressuredResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableNeedDrain = true;
  readonly chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return false;
  }
}

function goalEvent(): ThreadGoalEvent {
  return {
    schemaVersion: "crewon.thread-goal-event.v0",
    tenantId: "tenant-1",
    threadId: "thread-1",
    eventId: "goal-event-1",
    sequence: 1,
    occurredAt: "2026-08-09T00:00:01Z",
    type: "goal.updated",
    data: {
      goal: {
        schemaVersion: "crewon.thread-goal.v0",
        tenantId: "tenant-1",
        threadId: "thread-1",
        goalId: "goal-1",
        revision: 1,
        objective: "finish the migration",
        status: "active",
        tokenBudget: 100_000,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: "2026-08-09T00:00:01Z",
        updatedAt: "2026-08-09T00:00:01Z",
      },
    },
  };
}
