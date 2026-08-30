import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import test from "node:test";

import type { WorkspaceOperationEventView } from "@crewon/contracts";

import { writeWorkspaceOperationSseEvent } from "./workspace-operation-event-stream.ts";

test("writes one bounded redacted Workspace replacement and honors backpressure", async () => {
  const response = new BackpressuredResponse();
  const pending = writeWorkspaceOperationSseEvent(
    response as unknown as ServerResponse,
    event(),
    new AbortController().signal,
  );
  await Promise.resolve();
  assert.equal(response.chunks.length, 1);
  assert.match(
    response.chunks[0] ?? "",
    /^id: 1\nevent: workspace\.operation\.replaced\n/u,
  );
  assert.equal(response.chunks[0]?.includes("tenantId"), false);
  response.writableNeedDrain = false;
  response.emit("drain");
  assert.equal(await pending, true);
  assert.equal(response.listenerCount("drain"), 0);
  assert.equal(response.listenerCount("close"), 0);
  assert.equal(response.listenerCount("error"), 0);
});

test("fails closed before writing an oversized Workspace SSE frame", async () => {
  const response = new BackpressuredResponse();
  await assert.rejects(
    writeWorkspaceOperationSseEvent(
      response as unknown as ServerResponse,
      {
        ...event(),
        data: {
          operation: {
            ...event().data.operation,
            status: "completed",
            result: {
              status: "completed",
              entries: [{ name: "x".repeat(129 * 1024), kind: "file" }],
              truncated: false,
            },
          },
        },
      },
      new AbortController().signal,
    ),
    /workspace_event_frame_too_large/u,
  );
  assert.deepEqual(response.chunks, []);
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

function event(): WorkspaceOperationEventView {
  return {
    schemaVersion: "crewon.workspace-operation-event.v0",
    threadId: "thread-1",
    executionId: "exec-1",
    sequence: 1,
    type: "workspace.operation.replaced",
    data: {
      operation: {
        threadId: "thread-1",
        executionId: "exec-1",
        revision: 1,
        status: "pending",
        result: null,
      },
    },
  };
}
