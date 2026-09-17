import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import test from "node:test";
import { ModelTransportError } from "@crewon/agent-kernel";
import type WebSocket from "ws";

import {
  WebSocketMessageQueue,
  WebSocketQueueBudget,
  WEBSOCKET_QUEUE_LIMITS,
} from "./websocket-message-queue.ts";

class SocketFixture extends EventEmitter {
  readyState = 1;
  pauses = 0;
  resumes = 0;
  terminations = 0;
  pause(): void {
    this.pauses += 1;
  }
  resume(): void {
    this.resumes += 1;
  }
  terminate(): void {
    this.terminations += 1;
    this.readyState = 3;
  }
  sendValue(value: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(value)), false);
  }
}

class SchedulerFixture {
  readonly callbacks = new Set<() => void>();
  schedule(callback: () => void): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }
  fire(): void {
    for (const callback of [...this.callbacks]) callback();
  }
}

function fixture(
  budget = new WebSocketQueueBudget({
    maxBytes: WEBSOCKET_QUEUE_LIMITS.processMaxBytes,
    maxMessages: WEBSOCKET_QUEUE_LIMITS.processMaxMessages,
  }),
) {
  const socket = new SocketFixture();
  const controller = new AbortController();
  const scheduler = new SchedulerFixture();
  const queue = new WebSocketMessageQueue({
    socket: socket as unknown as WebSocket,
    signal: controller.signal,
    scheduler,
    idleTimeoutMs: 1000,
    maxMessageBytes: 1024 * 1024,
    budget,
  });
  return { queue, socket, controller, scheduler, budget };
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof ModelTransportError && error.code === code;
}

test("pauses a burst, drains in order and resumes below the low watermark", async () => {
  const { queue, socket, scheduler, budget } = fixture();
  const text = "x".repeat(64 * 1024);
  for (let index = 0; index < 20; index += 1) socket.sendValue({ index, text });
  assert.equal(socket.pauses, 1);
  assert.equal(socket.resumes, 0);
  scheduler.fire();
  assert.equal(
    socket.terminations,
    0,
    "a paused consumer is not producer idle",
  );
  for (let index = 0; index < 20; index += 1) {
    assert.deepEqual(await queue.next(), { index, text });
  }
  assert.equal(socket.resumes, 1);
  assert.deepEqual(budget.usage, { bytes: 0, messages: 0 });
  queue.close();
});

test("caps small-frame counts as well as bytes even within one receive batch", async () => {
  const { queue, socket, budget } = fixture();
  for (let index = 0; index < 10000; index += 1) socket.sendValue(index);
  assert.equal(socket.terminations, 1);
  assert.equal(queue.pendingCount, 0);
  assert.deepEqual(budget.usage, { bytes: 0, messages: 0 });
  await assert.rejects(
    queue.next(),
    hasCode("responses_websocket_queue_limit_exceeded"),
  );
  queue.close();
});

test("fails closed when buffered bytes exceed the hard limit after pause", async () => {
  const { queue, socket, budget } = fixture();
  const text = "x".repeat(700_000);
  socket.sendValue(text);
  socket.sendValue(text);
  assert.equal(socket.pauses, 1);
  socket.sendValue(text);
  await assert.rejects(
    queue.next(),
    hasCode("responses_websocket_queue_limit_exceeded"),
  );
  assert.deepEqual(budget.usage, { bytes: 0, messages: 0 });
  queue.close();
});

test("enforces the shared budget across independent streams and releases only owned bytes", async () => {
  const budget = new WebSocketQueueBudget({ maxBytes: 20, maxMessages: 3 });
  const first = fixture(budget);
  const second = fixture(budget);
  first.socket.sendValue("abcdef");
  first.socket.sendValue("abcdef");
  second.socket.sendValue("abcdef");
  await assert.rejects(
    second.queue.next(),
    hasCode("responses_websocket_queue_limit_exceeded"),
  );
  assert.deepEqual(budget.usage, { bytes: 16, messages: 2 });
  assert.equal(await first.queue.next(), "abcdef");
  first.queue.close();
  second.queue.close();
  assert.deepEqual(budget.usage, { bytes: 0, messages: 0 });
});

test("releases buffered data, timers and subscriptions on abort and idempotent close", async () => {
  for (const outcome of [
    "abort",
    "close",
    "socket-close",
    "error",
    "invalid-json",
  ] as const) {
    const { queue, socket, controller, scheduler, budget } = fixture();
    if (outcome === "invalid-json")
      socket.emit("message", Buffer.from("{"), false);
    socket.sendValue("pending");
    if (outcome === "abort") controller.abort();
    if (outcome === "close") queue.close();
    if (outcome === "socket-close") socket.emit("close");
    if (outcome === "error") socket.emit("error", new Error("offline"));
    await assert.rejects(queue.next());
    assert.deepEqual(budget.usage, { bytes: 0, messages: 0 }, outcome);
    queue.close();
    queue.close();
    assert.equal(scheduler.callbacks.size, 0);
    assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
    for (const name of ["message", "error", "close"])
      assert.equal(socket.listenerCount(name), 0);
  }
});

test("expires only a pending read, and close settles an outstanding waiter", async () => {
  const first = fixture();
  const reading = first.queue.next();
  assert.equal(first.scheduler.callbacks.size, 1);
  first.scheduler.fire();
  await assert.rejects(reading, hasCode("responses_websocket_idle_timeout"));
  first.queue.close();
  const second = fixture();
  const waiting = second.queue.next();
  second.queue.close();
  await assert.rejects(waiting, hasCode("responses_websocket_queue_closed"));
  assert.equal(second.scheduler.callbacks.size, 0);
});

test("validates binary and oversized frames without allocating queue budget", async () => {
  for (const binary of [true, false]) {
    const { socket, queue, budget } = fixture();
    socket.emit("message", Buffer.alloc(binary ? 1 : 1024 * 1024 + 1), binary);
    await assert.rejects(
      queue.next(),
      hasCode(
        binary
          ? "responses_websocket_binary_unsupported"
          : "responses_websocket_message_too_large",
      ),
    );
    assert.deepEqual(budget.usage, { bytes: 0, messages: 0 });
    queue.close();
  }
});
