import type { ServerResponse } from "node:http";

import type {
  ActorContext,
  ThreadApplicationService,
} from "@crewon/application";
import type { ThreadLifecycleEvent } from "@crewon/domain";
import type { FastifyReply, FastifyRequest } from "fastify";

import { projectThreadEvent } from "./thread-projection.ts";

const EVENT_PAGE_SIZE = 1_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export interface ThreadEventPoller {
  waitForNextPoll(signal: AbortSignal): Promise<void>;
}

export class IntervalThreadEventPoller implements ThreadEventPoller {
  readonly #intervalMs: number;

  constructor(intervalMs = DEFAULT_POLL_INTERVAL_MS) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
      throw new Error("thread_event_poll_interval_invalid");
    }
    this.#intervalMs = intervalMs;
  }

  waitForNextPoll(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, this.#intervalMs);
      timer.unref();
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
    });
  }
}

export async function streamThreadEvents(input: {
  request: FastifyRequest;
  reply: FastifyReply;
  application: Pick<ThreadApplicationService, "listThreadEvents">;
  actor: ActorContext;
  threadId: string;
  afterSequence: number;
  view?: "standard" | "audit";
  poller: ThreadEventPoller;
  heartbeatIntervalMs: number | null;
}): Promise<void> {
  let cursor = input.afterSequence;
  let page = await loadPage(input, cursor);
  validatePage(input.threadId, page, cursor);

  input.reply.hijack();
  const response = input.reply.raw;
  response.writeHead(200, {
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
    "x-request-id": input.request.id,
  });
  response.flushHeaders();

  let closed = false;
  const polling = new AbortController();
  const close = () => {
    if (closed) return;
    closed = true;
    polling.abort();
    if (!response.writableEnded) response.end();
  };
  response.once("close", close);
  const heartbeat = startHeartbeat(response, input.heartbeatIntervalMs, close);

  try {
    while (!closed) {
      for (const event of page) {
        if (!(await writeThreadSseEvent(response, event, polling.signal))) {
          close();
          break;
        }
        cursor = event.sequence;
      }
      if (closed) break;
      if (page.length === EVENT_PAGE_SIZE) {
        page = await loadPage(input, cursor);
        validatePage(input.threadId, page, cursor);
        continue;
      }
      await input.poller.waitForNextPoll(polling.signal);
      if (closed) break;
      page = await loadPage(input, cursor);
      validatePage(input.threadId, page, cursor);
    }
  } catch {
    close();
  } finally {
    if (heartbeat !== null) clearInterval(heartbeat);
    response.off("close", close);
    close();
  }
}

function loadPage(
  input: Parameters<typeof streamThreadEvents>[0],
  afterSequence: number,
): Promise<readonly ThreadLifecycleEvent[]> {
  return input.application.listThreadEvents(input.actor, {
    threadId: input.threadId,
    afterSequence,
    limit: EVENT_PAGE_SIZE,
    view: input.view ?? "standard",
  });
}

function validatePage(
  threadId: string,
  events: readonly ThreadLifecycleEvent[],
  afterSequence: number,
): void {
  if (
    events.length === 1 &&
    events[0]?.type === "thread.deleted" &&
    events[0].sequence > afterSequence
  ) {
    return;
  }
  let expectedSequence = afterSequence + 1;
  for (const event of events) {
    if (
      event.identity.threadId !== threadId ||
      event.sequence !== expectedSequence
    ) {
      throw new Error("thread_event_page_invalid");
    }
    expectedSequence += 1;
  }
}

export async function writeThreadSseEvent(
  response: ServerResponse,
  event: ThreadLifecycleEvent,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted || response.destroyed || response.writableEnded) {
    return false;
  }
  const accepted = response.write(
    `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(projectThreadEvent(event))}\n\n`,
  );
  if (accepted) return true;
  return waitForDrain(response, signal);
}

function waitForDrain(
  response: ServerResponse,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted || response.destroyed || response.writableEnded) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (drained: boolean) => {
      if (settled) return;
      settled = true;
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
      signal.removeEventListener("abort", onAbort);
      resolve(drained);
    };
    const onDrain = () =>
      finish(!response.destroyed && !response.writableEnded);
    const onClose = () => finish(false);
    const onError = () => finish(false);
    const onAbort = () => finish(false);
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted || response.destroyed || response.writableEnded) {
      finish(false);
    }
  });
}

function startHeartbeat(
  response: ServerResponse,
  intervalMs: number | null,
  close: () => void,
): NodeJS.Timeout | null {
  if (intervalMs === null) return null;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) {
    throw new Error("heartbeat_interval_invalid");
  }
  const timer = setInterval(() => {
    if (
      response.destroyed ||
      response.writableEnded ||
      response.writableNeedDrain
    ) {
      return;
    }
    try {
      response.write(": heartbeat\n\n");
    } catch {
      close();
    }
  }, intervalMs);
  timer.unref();
  return timer;
}
