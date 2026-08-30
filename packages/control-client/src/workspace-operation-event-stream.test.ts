import assert from "node:assert/strict";
import test from "node:test";

import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";
import { streamWorkspaceOperationEvents } from "./workspace-operation-event-stream.ts";

test("hands an atomic GET cursor to the execution-scoped Workspace stream", async () => {
  const requests: { input: string; headers: Headers }[] = [];
  const responses = [
    jsonResponse(snapshot(operation(1, "pending"))),
    sseResponse(frame(event(operation(2, "completed")))),
  ];
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    accessToken: "workspace-token",
    fetch: async (input, init = {}) => {
      requests.push({
        input: String(input),
        headers: new Headers(init.headers),
      });
      const response = responses.shift();
      assert.notEqual(response, undefined);
      return response as Response;
    },
  });

  const current = await client.getWorkspaceListOperation(
    "thread/1",
    "workspace:exec-1",
  );
  const received = [];
  for await (const item of streamWorkspaceOperationEvents(client, {
    threadId: "thread/1",
    executionId: "workspace:exec-1",
    afterSequence: current.eventSequence,
    reconnectDelayMs: 0,
  })) {
    received.push(item);
  }

  assert.deepEqual(received, [event(operation(2, "completed"))]);
  assert.deepEqual(
    requests.map(({ input, headers }) => ({
      input,
      lastEventId: headers.get("last-event-id"),
      authorization: headers.get("authorization"),
    })),
    [
      {
        input:
          "https://control.example/api/v1/threads/thread%2F1/workspace-list/workspace%3Aexec-1",
        lastEventId: null,
        authorization: "Bearer workspace-token",
      },
      {
        input:
          "https://control.example/api/v1/threads/thread%2F1/workspace-list/workspace%3Aexec-1/events",
        lastEventId: "1",
        authorization: "Bearer workspace-token",
      },
    ],
  );
});

test("reconnects from only the last Workspace revision and stops after terminal", async () => {
  const lastEventIds: (string | null)[] = [];
  const responses = [
    sseResponse(frame(event(operation(1, "pending")))),
    sseResponse(frame(event(operation(2, "completed")))),
  ];
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async (_input, init = {}) => {
      lastEventIds.push(new Headers(init.headers).get("last-event-id"));
      const response = responses.shift();
      assert.notEqual(response, undefined);
      return response as Response;
    },
  });

  const received = [];
  for await (const item of streamWorkspaceOperationEvents(client, {
    threadId: "thread/1",
    executionId: "workspace:exec-1",
    reconnectDelayMs: 0,
  })) {
    received.push(item);
  }

  assert.deepEqual(received, [
    event(operation(1, "pending")),
    event(operation(2, "completed")),
  ]);
  assert.deepEqual(lastEventIds, [null, "1"]);
  assert.equal(responses.length, 0);
});

test("keeps Workspace, Run, and Goal Last-Event-ID namespaces separate", async () => {
  const requests: { input: string; lastEventId: string | null }[] = [];
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async (input, init = {}) => {
      requests.push({
        input: String(input),
        lastEventId: new Headers(init.headers).get("last-event-id"),
      });
      return sseResponse("");
    },
  });

  await client.openRunEventStream({
    runId: "run-1",
    afterSequence: 9,
    view: "client",
  });
  await client.openThreadGoalEventStream({
    threadId: "thread/1",
    afterSequence: 14,
  });
  await client.openWorkspaceListOperationEventStream({
    threadId: "thread/1",
    executionId: "workspace:exec-1",
    afterSequence: 2,
  });

  assert.deepEqual(requests, [
    {
      input: "https://control.example/api/v1/runs/run-1/events?view=client",
      lastEventId: "9",
    },
    {
      input: "https://control.example/api/v1/threads/thread%2F1/goal/events",
      lastEventId: "14",
    },
    {
      input:
        "https://control.example/api/v1/threads/thread%2F1/workspace-list/workspace%3Aexec-1/events",
      lastEventId: "2",
    },
  ]);
});

test("fails closed for malformed identity, scope, and sequence gaps", async (t) => {
  const valid = event(operation(1, "pending"));
  const cases: readonly { name: string; frame: string }[] = [
    {
      name: "wrong SSE event name",
      frame: frame(valid).replace(
        "event: workspace.operation.replaced",
        "event: run.started",
      ),
    },
    {
      name: "wrong SSE id",
      frame: frame(valid).replace("id: 1", "id: 2"),
    },
    {
      name: "cross thread",
      frame: frame({ ...valid, threadId: "thread-2" }),
    },
    {
      name: "cross execution",
      frame: frame({ ...valid, executionId: "workspace:exec-2" }),
    },
    {
      name: "sequence gap",
      frame: frame(event(operation(2, "pending"))),
    },
    {
      name: "sequence and revision mismatch",
      frame: frame({
        ...valid,
        data: { operation: operation(2, "pending") },
      }),
    },
    {
      name: "private field",
      frame: frame({ ...valid, tenantId: "tenant-secret" }),
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const client = streamClient(item.frame);
      await assert.rejects(async () => {
        for await (const _item of streamWorkspaceOperationEvents(client, {
          threadId: "thread/1",
          executionId: "workspace:exec-1",
          reconnectDelayMs: 0,
        })) {
          assert.fail("invalid event must not be yielded");
        }
      }, isProtocolError);
    });
  }
});

test("enforces UTF-8 frame and buffer hard caps", async () => {
  const oversizedFrame = streamClient(
    `id: 1\nevent: workspace.operation.replaced\ndata: ${"x".repeat(128 * 1024)}\n\n`,
  );
  await assert.rejects(async () => {
    for await (const _item of streamWorkspaceOperationEvents(oversizedFrame, {
      threadId: "thread/1",
      executionId: "workspace:exec-1",
      reconnectDelayMs: 0,
    })) {
      assert.fail("oversized frame must not be yielded");
    }
  }, hasProtocolCode("control_client_workspace_event_frame_too_large"));

  const oversizedBuffer = streamClient("x".repeat(256 * 1024 + 1));
  await assert.rejects(async () => {
    for await (const _item of streamWorkspaceOperationEvents(oversizedBuffer, {
      threadId: "thread/1",
      executionId: "workspace:exec-1",
      reconnectDelayMs: 0,
    })) {
      assert.fail("oversized buffer must not be yielded");
    }
  }, hasProtocolCode("control_client_workspace_event_buffer_too_large"));
});

function operation(revision: number, status: "pending" | "completed") {
  if (status === "pending") {
    return {
      threadId: "thread/1",
      executionId: "workspace:exec-1",
      revision,
      status,
      result: null,
    } as const;
  }
  return {
    threadId: "thread/1",
    executionId: "workspace:exec-1",
    revision,
    status,
    result: {
      status: "completed" as const,
      entries: [
        { name: "README.md", kind: "file" as const },
        { name: "中文", kind: "directory" as const },
      ],
      truncated: false,
    },
  } as const;
}

function event(value: ReturnType<typeof operation>) {
  return {
    schemaVersion: "crewon.workspace-operation-event.v0" as const,
    threadId: value.threadId,
    executionId: value.executionId,
    sequence: value.revision,
    type: "workspace.operation.replaced" as const,
    data: { operation: value },
  };
}

function snapshot(value: ReturnType<typeof operation>) {
  return { operation: value, eventSequence: value.revision };
}

function frame(value: unknown): string {
  const object = value as { sequence: number };
  return `id: ${object.sequence}\nevent: workspace.operation.replaced\ndata: ${JSON.stringify(value)}\n\n`;
}

function streamClient(payload: string): ControlApiClient {
  return new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async () => sseResponse(payload),
  });
}

function sseResponse(payload: string): Response {
  return new Response(payload, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function isProtocolError(error: unknown): boolean {
  return error instanceof ControlApiProtocolError;
}

function hasProtocolCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof ControlApiProtocolError && error.code === code;
}
