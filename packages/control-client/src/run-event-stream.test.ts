import assert from "node:assert/strict";
import test from "node:test";

import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";
import { streamRunEvents } from "./run-event-stream.ts";

test("parses fragmented CRLF SSE and preserves the durable sequence cursor", async () => {
  const requests: { input: string; headers: Headers }[] = [];
  const payload = [
    ": heartbeat\r\n\r\n",
    "id: 2\r\nevent: run.started\r\ndata: ",
    JSON.stringify(runStartedEvent()),
    "\r\n\r\n",
  ].join("");
  const bytes = new TextEncoder().encode(payload);
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    accessToken: "token-1",
    fetch: async (input, init = {}) => {
      requests.push({
        input: String(input),
        headers: new Headers(init.headers),
      });
      return new Response(fragmentedStream(bytes, [1, 7, 13, 29]), {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    },
  });

  const events = [];
  for await (const event of streamRunEvents(client, {
    runId: "run/1",
    afterSequence: 1,
    view: "audit",
  })) {
    events.push(event);
  }
  assert.deepEqual(events, [runStartedEvent()]);
  assert.equal(
    requests[0]?.input,
    "https://control.example/api/v1/runs/run%2F1/events?view=audit",
  );
  assert.equal(requests[0]?.headers.get("last-event-id"), "1");
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer token-1");
});

test("parses bounded Tool previews from the transcript event view", async () => {
  const requests: string[] = [];
  const requested = {
    eventId: "event-1",
    runId: "run-1",
    sequence: 1,
    occurredAt: "2026-08-09T00:00:01Z",
    type: "tool.requested" as const,
    data: {
      segmentId: "segment-1",
      callId: "call-1",
      kind: "function" as const,
      name: "read_file",
      inputPreview: '{"path":"README.md"}',
      inputTruncated: false,
    },
  };
  const completed = {
    eventId: "event-2",
    runId: "run-1",
    sequence: 2,
    occurredAt: "2026-08-09T00:00:02Z",
    type: "tool.completed" as const,
    data: {
      segmentId: "segment-1",
      callId: "call-1",
      kind: "function" as const,
      name: "read_file",
      isError: false,
      outputTruncated: false,
      artifactAvailable: false,
      outputPreview: "",
    },
  };
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async (input) => {
      requests.push(String(input));
      return new Response(
        [requested, completed]
          .map(
            (event) =>
              `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(""),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    },
  });

  const events = [];
  for await (const event of streamRunEvents(client, {
    runId: "run-1",
    view: "transcript",
  })) {
    events.push(event);
  }

  assert.deepEqual(events, [requested, completed]);
  assert.deepEqual(requests, [
    "https://control.example/api/v1/runs/run-1/events?view=transcript",
  ]);
});

test("accepts exact workspace change metadata only on the transcript view", async () => {
  const workspaceChanges = {
    schemaVersion: "crewon.workspace-change-summary.v0" as const,
    paths: ["README.md", "src/task.ts"],
    additions: 8,
    deletions: 2,
    statsComplete: true,
  };
  const event = {
    eventId: "event-changes",
    runId: "run-1",
    sequence: 2,
    occurredAt: "2026-08-09T00:00:02Z",
    type: "tool.completed" as const,
    data: {
      segmentId: "segment-1",
      callId: "call-1",
      kind: "function" as const,
      name: "workspace_run_command",
      isError: false,
      outputTruncated: true,
      artifactAvailable: false,
      workspaceChanges,
      outputPreview: "command output",
    },
  };
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async () =>
      new Response(
        `id: 2\nevent: tool.completed\ndata: ${JSON.stringify(event)}\n\n`,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      ),
  });

  const events = [];
  for await (const received of streamRunEvents(client, {
    runId: "run-1",
    view: "transcript",
  })) {
    events.push(received);
  }

  assert.deepEqual(events, [event]);
});

test("rejects non-canonical workspace change metadata", async () => {
  const invalidSummaries = [
    {
      schemaVersion: "crewon.workspace-change-summary.v0",
      paths: ["src/../secret"],
      additions: 1,
      deletions: 0,
      statsComplete: true,
    },
    {
      schemaVersion: "crewon.workspace-change-summary.v0",
      paths: ["src/task.ts"],
      additions: 0,
      deletions: 0,
      statsComplete: false,
    },
  ];

  for (const workspaceChanges of invalidSummaries) {
    const event = {
      eventId: "event-changes",
      runId: "run-1",
      sequence: 2,
      occurredAt: "2026-08-09T00:00:02Z",
      type: "tool.completed",
      data: {
        segmentId: "segment-1",
        callId: "call-1",
        kind: "function",
        name: "workspace_run_command",
        isError: false,
        outputTruncated: false,
        artifactAvailable: false,
        workspaceChanges,
      },
    };
    const client = new ControlApiClient({
      baseUrl: "https://control.example/",
      fetch: async () =>
        new Response(
          `id: 2\nevent: tool.completed\ndata: ${JSON.stringify(event)}\n\n`,
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
    });

    await assert.rejects(async () => {
      for await (const _event of streamRunEvents(client, {
        runId: "run-1",
      })) {
        assert.fail("invalid workspace metadata must not be yielded");
      }
    }, hasProtocolCode("control_client_event_invalid"));
  }
});

test("falls back to the client event view when an older server rejects transcript", async () => {
  const requests: string[] = [];
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async (input) => {
      requests.push(String(input));
      if (requests.length === 1) {
        return new Response('{"error":"run_event_view_invalid"}', {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      const event = runStartedEvent();
      return new Response(
        `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    },
  });

  const events = [];
  for await (const event of streamRunEvents(client, {
    runId: "run/1",
    view: "transcript",
  })) {
    events.push(event);
  }

  assert.deepEqual(events, [runStartedEvent()]);
  assert.deepEqual(requests, [
    "https://control.example/api/v1/runs/run%2F1/events?view=transcript",
    "https://control.example/api/v1/runs/run%2F1/events?view=client",
  ]);
});

test("keeps Tool preview keys exclusive to the transcript event view", async () => {
  const event = {
    eventId: "event-1",
    runId: "run-1",
    sequence: 1,
    occurredAt: "2026-08-09T00:00:01Z",
    type: "tool.requested" as const,
    data: {
      segmentId: "segment-1",
      callId: "call-1",
      kind: "function" as const,
      name: "read_file",
      inputPreview: "{}",
      inputTruncated: false,
    },
  };
  const payload = `id: 1\nevent: tool.requested\ndata: ${JSON.stringify(event)}\n\n`;
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async () =>
      new Response(payload, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  });

  await assert.rejects(async () => {
    for await (const _event of streamRunEvents(client, {
      runId: "run-1",
      view: "client",
    })) {
      assert.fail("client view must reject transcript Tool previews");
    }
  }, hasProtocolCode("control_client_event_invalid"));
});

test("rejects missing or oversized transcript Tool previews", async () => {
  const invalidData = [
    {
      segmentId: "segment-1",
      callId: "call-1",
      kind: "function",
      name: "read_file",
      inputPreview: "{}",
    },
    {
      segmentId: "segment-1",
      callId: "call-1",
      kind: "function",
      name: "read_file",
      inputPreview: "x".repeat(16 * 1024 + 1),
      inputTruncated: true,
    },
  ];

  for (const data of invalidData) {
    const event = {
      eventId: "event-1",
      runId: "run-1",
      sequence: 1,
      occurredAt: "2026-08-09T00:00:01Z",
      type: "tool.requested",
      data,
    };
    const client = new ControlApiClient({
      baseUrl: "https://control.example/",
      fetch: async () =>
        new Response(
          `id: 1\nevent: tool.requested\ndata: ${JSON.stringify(event)}\n\n`,
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
    });

    await assert.rejects(async () => {
      for await (const _event of streamRunEvents(client, {
        runId: "run-1",
        view: "transcript",
      })) {
        assert.fail("invalid transcript Tool preview must not be yielded");
      }
    }, hasProtocolCode("control_client_event_invalid"));
  }
});

test("rejects an SSE identity mismatch without yielding remote data", async () => {
  const event = { ...runStartedEvent(), runId: "run-1" };
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async () =>
      new Response(
        `id: 3\nevent: run.started\ndata: ${JSON.stringify(event)}\n\n`,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      ),
  });

  await assert.rejects(async () => {
    for await (const _event of streamRunEvents(client, { runId: "run-1" })) {
      assert.fail("mismatched event must not be yielded");
    }
  }, hasProtocolCode("control_client_event_identity_mismatch"));
});

test("rejects a cross-Run event before yielding remote data", async () => {
  const event = { ...runStartedEvent(), runId: "run-other" };
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async () =>
      new Response(
        `id: 2\nevent: run.started\ndata: ${JSON.stringify(event)}\n\n`,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      ),
  });

  await assert.rejects(async () => {
    for await (const _event of streamRunEvents(client, { runId: "run/1" })) {
      assert.fail("cross-Run event must not be yielded");
    }
  }, hasProtocolCode("control_client_event_invalid"));
});

test("rejects malformed discriminated event data before yielding", async () => {
  const event = { ...runStartedEvent(), data: { injected: true } };
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async () =>
      new Response(
        `id: 2\nevent: run.started\ndata: ${JSON.stringify(event)}\n\n`,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      ),
  });

  await assert.rejects(async () => {
    for await (const _event of streamRunEvents(client, { runId: "run/1" })) {
      assert.fail("malformed event must not be yielded");
    }
  }, hasProtocolCode("control_client_event_invalid"));
});

test("accepts provider continuation events covered by the generated union", async () => {
  const event = {
    eventId: "event-3",
    runId: "run-1",
    sequence: 3,
    occurredAt: "2026-08-09T00:00:03Z",
    type: "segment.provider_continuation" as const,
    data: {
      segmentId: "segment-1",
      sampleIndex: 2,
      throughHistorySequence: 7,
    },
  };
  const client = sseClient(event);
  const events = [];
  for await (const received of streamRunEvents(client, { runId: "run-1" })) {
    events.push(received);
  }
  assert.deepEqual(events, [event]);
});

test("accepts a Run Plan snapshot only through the negotiated extension", async () => {
  const event = runPlanUpdatedEvent();
  const requests: string[] = [];
  const client = sseClient(event, requests);
  const events = [];
  for await (const received of streamRunEvents(client, {
    runId: "run-1",
    extensions: ["run-plan-v1"],
  })) {
    events.push(received);
  }
  assert.deepEqual(events, [event]);
  assert.equal("callId" in events[0]!.data, false);
  assert.deepEqual(requests, [
    "https://control.example/api/v1/runs/run-1/events?view=client&extensions=run-plan-v1",
  ]);
});

test("rejects unnegotiated and cross-Run Plan snapshots", async () => {
  const event = runPlanUpdatedEvent();
  await assert.rejects(async () => {
    for await (const _received of streamRunEvents(sseClient(event), {
      runId: "run-1",
    })) {
      assert.fail("unnegotiated Run Plan event must not be yielded");
    }
  }, hasProtocolCode("control_client_event_invalid"));

  const crossed = {
    ...event,
    data: { plan: { ...event.data.plan, planId: "run-other" } },
  };
  await assert.rejects(async () => {
    for await (const _received of streamRunEvents(sseClient(crossed), {
      runId: "run-1",
      extensions: ["run-plan-v1"],
    })) {
      assert.fail("cross-Run Plan event must not be yielded");
    }
  }, hasProtocolCode("control_client_event_invalid"));
});

test("accepts the content-free durable Plan proposal event", async () => {
  const event = {
    eventId: "event-7",
    runId: "run-1",
    sequence: 7,
    occurredAt: "2026-08-09T00:00:07Z",
    type: "plan.proposed" as const,
    data: {
      planId: "plan-1",
      messageId: "message-1",
      messageSequence: 2,
    },
  };
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async () =>
      new Response(
        `id: 7\nevent: plan.proposed\ndata: ${JSON.stringify(event)}\n\n`,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      ),
  });

  const events = [];
  for await (const received of streamRunEvents(client, { runId: "run-1" })) {
    events.push(received);
  }
  assert.deepEqual(events, [event]);
  assert.equal("content" in events[0]!.data, false);
});

function runStartedEvent() {
  return {
    eventId: "event-2",
    runId: "run/1",
    sequence: 2,
    occurredAt: "2026-08-09T00:00:02Z",
    type: "run.started" as const,
    data: {},
  };
}

function runPlanUpdatedEvent() {
  return {
    eventId: "event-4",
    runId: "run-1",
    sequence: 4,
    occurredAt: "2026-08-09T00:00:04Z",
    type: "run.plan.updated" as const,
    data: {
      plan: {
        schemaVersion: "crewon.run-plan.v0" as const,
        planId: "run-1",
        revision: 1,
        explanation: null,
        items: [
          { itemId: "design", title: "Design", status: "inProgress" as const },
        ],
        createdAt: "2026-08-09T00:00:04Z",
        updatedAt: "2026-08-09T00:00:04Z",
      },
    },
  };
}

function sseClient(
  event:
    | ReturnType<typeof runPlanUpdatedEvent>
    | {
        eventId: string;
        runId: string;
        sequence: number;
        occurredAt: string;
        type: "segment.provider_continuation";
        data: {
          segmentId: string;
          sampleIndex: number;
          throughHistorySequence: number;
        };
      },
  requests: string[] = [],
): ControlApiClient {
  return new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async (input) => {
      requests.push(String(input));
      return new Response(
        `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    },
  });
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

function hasProtocolCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof ControlApiProtocolError && error.code === code;
}
