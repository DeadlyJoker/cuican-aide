import type { ServerResponse } from "node:http";

import type {
  ActorContext,
  ThreadGoalApplicationService,
} from "@crewon/application";
import {
  validateThreadGoalEventPageBoundary,
  type ThreadGoalEvent,
} from "@crewon/domain";
import type { FastifyReply, FastifyRequest } from "fastify";

import { projectThreadGoalEvent } from "./thread-projection.ts";

const EVENT_PAGE_SIZE = 1_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export interface ThreadGoalEventPoller {
  waitForNextPoll(signal: AbortSignal): Promise<void>;
}

export class IntervalThreadGoalEventPoller implements ThreadGoalEventPoller {
  readonly #intervalMs: number;

  constructor(intervalMs = DEFAULT_POLL_INTERVAL_MS) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
      throw new Error("goal_event_poll_interval_invalid");
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

export async function streamThreadGoalEvents(input: {
  request: FastifyRequest;
  reply: FastifyReply;
  application: Pick<ThreadGoalApplicationService, "listGoalEvents">;
  actor: ActorContext;
  threadId: string;
  afterSequence: number;
  poller: ThreadGoalEventPoller;
  heartbeatIntervalMs: number | null;
}): Promise<void> {
  let cursor = input.afterSequence;
  let page = await loadPage(input, cursor);
  validatePage(input, page, cursor);

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
        if (!(await writeThreadGoalSseEvent(response, event, polling.signal))) {
          close();
          break;
        }
        cursor = event.sequence;
      }
      if (closed) break;

      if (page.length === EVENT_PAGE_SIZE) {
        page = await loadPage(input, cursor);
        validatePage(input, page, cursor);
        continue;
      }

      await input.poller.waitForNextPoll(polling.signal);
      if (closed) break;
      page = await loadPage(input, cursor);
      validatePage(input, page, cursor);
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
  input: Parameters<typeof streamThreadGoalEvents>[0],
  afterSequence: number,
): Promise<readonly ThreadGoalEvent[]> {
  return input.application.listGoalEvents(input.actor, {
    threadId: input.threadId,
    afterSequence,
    limit: EVENT_PAGE_SIZE,
  });
}

function validatePage(
  input: Parameters<typeof streamThreadGoalEvents>[0],
  events: readonly ThreadGoalEvent[],
  afterSequence: number,
): void {
  validateThreadGoalEventPageBoundary(events, {
    tenantId: input.actor.tenantId,
    threadId: input.threadId,
    afterSequence,
  });
}

export async function writeThreadGoalSseEvent(
  response: ServerResponse,
  event: ThreadGoalEvent,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted || response.destroyed || response.writableEnded) {
    return false;
  }
  const accepted = response.write(
    `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(projectThreadGoalEvent(event))}\n\n`,
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
