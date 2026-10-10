import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import test from "node:test";

import type { ActorContext, RunApplicationService } from "@crewon/application";
import type { RunLifecycleEvent } from "@crewon/domain";
import type { FastifyReply, FastifyRequest } from "fastify";

import { RunEventHub } from "./run-event-hub.ts";
import { streamRunEvents, writeRunSseEvent } from "./run-event-stream.ts";

test("waits for Run SSE drain without dropping or repeating the accepted event", async () => {
  const response = new RecordingResponse(true);
  let settled = false;
  const pending = writeRunSseEvent({
    response: response as unknown as ServerResponse,
    event: outputEvent(1),
    view: "transcript",
    extensions: [],
    signal: new AbortController().signal,
  }).then((result) => {
    settled = true;
    return result;
  });
  await response.firstWrite;
  assert.equal(settled, false);
  assert.equal(response.chunks.length, 1);
  assert.match(response.chunks[0]!, /^id: 1\nevent: model\.output\.delta\n/);
  response.drain();
  assert.equal(await pending, true);
  assert.equal(response.chunks.length, 1);
  assertNoWriteListeners(response);
});

for (const ending of ["close", "error", "abort"] as const) {
  test(`settles a backpressured Run write on ${ending} and removes its listeners`, async () => {
    const response = new RecordingResponse(true);
    const controller = new AbortController();
    const pending = writeRunSseEvent({
      response: response as unknown as ServerResponse,
      event: outputEvent(1),
      view: "transcript",
      extensions: [],
      signal: controller.signal,
    });
    await response.firstWrite;
    if (ending === "abort") controller.abort();
    else response.emit(ending);
    assert.equal(await pending, false);
    assertNoWriteListeners(response);
    response.drain();
    assert.equal(response.chunks.length, 1);
  });
}

test("a backpressured replay preserves ordered output and the terminal event", async () => {
  const response = new RecordingResponse(true);
  const events = [outputEvent(1), outputEvent(2), terminalEvent(3)];
  const f = fixture(response, events);
  const pending = streamRunEvents(f.input);
  await response.firstWrite;
  assert.equal(response.writableEnded, false);
  assert.deepEqual(response.sequences(), [1]);
  response.drain();
  await pending;
  assert.deepEqual(response.sequences(), [1, 2, 3]);
  assert.match(response.chunks[2]!, /event: run\.completed/);
  assert.equal(response.writableEnded, true);
  assertNoWriteListeners(response);
  f.hub.close();
});

test("a live Run retains its subscription and terminal output while waiting for drain", async () => {
  const response = new RecordingResponse(true);
  const f = fixture(response, []);
  const pending = streamRunEvents(f.input);
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.hub.publish([outputEvent(1)]);
  await response.firstWrite;
  f.hub.publish([terminalEvent(2)]);
  assert.equal(response.writableEnded, false);
  response.drain();
  await pending;
  assert.deepEqual(response.sequences(), [1, 2]);
  assert.equal(f.authorizations(), 3);
  assertNoWriteListeners(response);
  f.hub.close();
});

test("closing a stalled Run allows a durable cursor resume without replaying earlier output", async () => {
  const events = [outputEvent(1), outputEvent(2), terminalEvent(3)];
  const first = new RecordingResponse(true);
  const f = fixture(first, events);
  const pending = streamRunEvents(f.input);
  await first.firstWrite;
  first.emit("close");
  await pending;
  assert.deepEqual(first.sequences(), [1]);
  assertNoWriteListeners(first);

  const resumed = new RecordingResponse(false);
  await streamRunEvents({
    ...f.input,
    reply: reply(resumed),
    afterSequence: 1,
  });
  assert.deepEqual(resumed.sequences(), [2, 3]);
  assert.equal(resumed.writableEnded, true);
  assertNoWriteListeners(resumed);
  f.hub.close();
});

function fixture(
  response: RecordingResponse,
  events: readonly RunLifecycleEvent[],
) {
  let authorizations = 0;
  const authorize = async () => {
    authorizations++;
    return {};
  };
  const page = async (_actor: ActorContext, query: { afterSequence: number }) =>
    events.filter((event) => event.sequence > query.afterSequence);
  const application = {
    getRunTranscript: authorize,
    getRun: authorize,
    listRunTranscriptEvents: page,
    listRunEvents: page,
  } as unknown as RunApplicationService;
  const hub = new RunEventHub();
  return {
    hub,
    authorizations: () => authorizations,
    input: {
      request: { id: "request-1" } as FastifyRequest,
      reply: reply(response),
      application,
      actor: {
        principalId: "principal",
        actorId: "actor",
        tenantId: "tenant",
        spaceId: "space",
      },
      eventHub: hub,
      runId: "run-1",
      afterSequence: 0,
      view: "transcript" as const,
      extensions: [],
      heartbeatIntervalMs: null,
    },
  };
}

function reply(response: RecordingResponse): FastifyReply {
  return { raw: response, hijack: () => {} } as unknown as FastifyReply;
}

function envelope(sequence: number) {
  return {
    schemaVersion: "crewon.run-event.v0" as const,
    identity: { runId: "run-1" },
    eventId: `event-${sequence}`,
    sequence,
    occurredAt: "2026-10-10T00:00:00Z",
  };
}

function outputEvent(sequence: number): RunLifecycleEvent {
  return {
    ...envelope(sequence),
    type: "model.output.delta",
    data: {
      segmentId: "segment-1",
      segmentSequence: sequence,
      delta: `输出${sequence}😀`,
    },
  };
}

function terminalEvent(sequence: number): RunLifecycleEvent {
  return {
    ...envelope(sequence),
    type: "run.completed",
    data: { outputRef: null },
  };
}

function assertNoWriteListeners(response: RecordingResponse) {
  assert.equal(response.listenerCount("drain"), 0);
  assert.equal(response.listenerCount("close"), 0);
  assert.equal(response.listenerCount("error"), 0);
}

class RecordingResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableNeedDrain = false;
  readonly chunks: string[] = [];
  readonly firstWrite: Promise<void>;
  readonly #blockFirst: boolean;
  readonly #written: () => void;

  constructor(blockFirst: boolean) {
    super();
    this.#blockFirst = blockFirst;
    let written!: () => void;
    this.firstWrite = new Promise((resolve) => {
      written = resolve;
    });
    this.#written = written;
  }

  writeHead() {}
  flushHeaders() {}
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    this.#written();
    this.writableNeedDrain = this.#blockFirst && this.chunks.length === 1;
    return !this.writableNeedDrain;
  }
  end() {
    this.writableEnded = true;
  }
  drain() {
    this.writableNeedDrain = false;
    this.emit("drain");
  }
  sequences(): number[] {
    return this.chunks.map((chunk) => Number(chunk.match(/^id: (\d+)/u)?.[1]));
  }
}
