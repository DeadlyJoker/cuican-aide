import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import test, { type TestContext } from "node:test";

import type { RunEventView } from "@crewon/contracts";

import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";
import { streamRunEvents } from "./run-event-stream.ts";

const runId = "run-live-output";

test(
  "real HTTP delivers 500 deltas including spaces and newlines before the terminal or EOF",
  { timeout: 10_000 },
  async (context) => {
    const source = outputEvents();
    let serverResponse: ServerResponse | null = null;
    let sent = 0;
    let closed!: () => void;
    const connectionClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const deliverNext = () => {
      assert.ok(serverResponse);
      const event = source[sent++];
      assert.ok(event);
      serverResponse.write(frame(event));
    };
    const baseUrl = await openServer(context, (_request, response) => {
      serverResponse = response;
      response.once("close", closed);
      deliverNext();
      // Each following frame waits for the client to consume its predecessor.
      // The terminal deliberately leaves HTTP open until the consumer returns.
    });
    const client = new ControlApiClient({ baseUrl });
    const observed: RunEventView[] = [];
    const streamingMilestones: number[] = [];
    for await (const event of streamRunEvents(client, {
      runId,
      view: "transcript",
    })) {
      observed.push(event);
      assert.equal(event.sequence, observed.length);
      assert.equal(sent, observed.length);
      assert.equal(
        (serverResponse as ServerResponse | null)?.writableEnded,
        false,
      );
      if ([4, 5, 6, 253, 503].includes(event.sequence)) {
        streamingMilestones.push(event.sequence);
        assert.ok(event.sequence < source.at(-1)!.sequence);
      }
      if (event.type === "run.completed") break;
      deliverNext();
    }
    assert.deepEqual(observed, source);
    assert.deepEqual(streamingMilestones, [4, 5, 6, 253, 503]);
    assert.equal(
      observed.filter((event) => event.type === "model.output.delta").length,
      500,
    );
    await connectionClosed;
  },
);

test(
  "real HTTP resumes from the last accepted delta without rejecting the next whitespace frame",
  { timeout: 10_000 },
  async (context) => {
    const source = outputEvents();
    const requestedCursors: (string | null)[] = [];
    const baseUrl = await openServer(context, (request, response) => {
      const cursor = request.headers["last-event-id"];
      requestedCursors.push(typeof cursor === "string" ? cursor : null);
      const next = source.filter(
        (event) => event.sequence > Number(cursor ?? 0),
      );
      const delivered = cursor === undefined ? next.slice(0, 4) : next;
      response.end(delivered.map(frame).join(""));
    });
    const client = new ControlApiClient({ baseUrl });
    const observed: RunEventView[] = [];
    let cursor = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      for await (const event of streamRunEvents(client, {
        runId,
        view: "transcript",
        afterSequence: cursor,
      })) {
        assert.equal(event.sequence, cursor + 1);
        cursor = event.sequence;
        observed.push(event);
      }
    }
    assert.deepEqual(requestedCursors, [null, "4"]);
    assert.deepEqual(observed, source);
    assert.equal(observed[4]?.type, "model.output.delta");
    assert.deepEqual(observed[4]?.data, { segmentId: "segment-1", delta: " " });
    assert.equal(observed.at(-1)?.type, "run.completed");
    assert.equal(cursor, source.at(-1)!.sequence);
  },
);

for (const delta of [
  "",
  null,
  42,
  {},
  [],
  " ".repeat(16 * 1024 + 1),
  "\u2003".repeat(5462),
]) {
  test(`output delta rejects an invalid type or exceeded byte limit (${typeof delta}, length=${typeof delta === "string" ? delta.length : "n/a"})`, async () => {
    const event = {
      ...outputEvents()[3],
      data: { segmentId: "segment-1", delta },
    };
    await assert.rejects(async () => {
      for await (const _event of streamRunEvents(bodyClient(event), { runId }))
        assert.fail("invalid delta must not escape");
    }, hasCode("control_client_event_invalid"));
  });
}

for (const delta of [" ".repeat(16 * 1024), "\u2003".repeat(5461) + " "]) {
  test(`output delta preserves whitespace at the 16KiB UTF-8 boundary (${delta.length} characters)`, async () => {
    const event = {
      ...outputEvents()[3],
      data: { segmentId: "segment-1", delta },
    };
    const received: RunEventView[] = [];
    for await (const value of streamRunEvents(bodyClient(event), { runId }))
      received.push(value);
    assert.deepEqual(received, [event]);
  });
}

for (const [name, change, code] of [
  [
    "blank segment identity",
    { data: { segmentId: " ", delta: " " } },
    "control_client_event_invalid",
  ],
  [
    "foreign Run identity",
    { runId: "foreign-run" },
    "control_client_event_invalid",
  ],
  [
    "unexpected data field",
    { data: { segmentId: "segment-1", delta: " ", injected: true } },
    "control_client_event_invalid",
  ],
] as const) {
  test(`whitespace output does not relax ${name}`, async () => {
    const event = { ...outputEvents()[3], ...change };
    await assert.rejects(async () => {
      for await (const _event of streamRunEvents(bodyClient(event), { runId }))
        assert.fail("invalid identity or envelope must not escape");
    }, hasCode(code));
  });
}

function outputEvents(): RunEventView[] {
  const deltas = Array.from({ length: 500 }, (_, index) =>
    index === 0
      ? "This is line"
      : [" ", "\n", "\t\r\n", `part-${index}🙂`][(index - 1) % 4]!,
  );
  return [
    event(1, "run.created", { threadId: "thread-1" }),
    event(2, "run.started", {}),
    event(3, "segment.started", { segmentId: "segment-1", attempt: 1 }),
    ...deltas.map((delta, index) =>
      event(index + 4, "model.output.delta", { segmentId: "segment-1", delta }),
    ),
    event(504, "run.completed", { outputRef: null }),
  ];
}

function event(
  sequence: number,
  type: RunEventView["type"],
  data: RunEventView["data"],
): RunEventView {
  return {
    eventId: `event-${sequence}`,
    runId,
    sequence,
    occurredAt: "2026-10-10T00:00:00Z",
    type,
    data,
  } as RunEventView;
}

function frame(value: unknown): string {
  const event = value as Pick<RunEventView, "sequence" | "type">;
  return `id: ${event.sequence}\r\nevent: ${event.type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
}

function bodyClient(value: unknown): ControlApiClient {
  return new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async () =>
      new Response(frame(value), {
        headers: { "content-type": "text/event-stream" },
      }),
  });
}

async function openServer(
  context: TestContext,
  write: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer((request, response) => {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    });
    response.flushHeaders();
    write(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}/`;
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof ControlApiProtocolError && error.code === code;
}
