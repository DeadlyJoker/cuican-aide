import type { ServerResponse } from "node:http";

import type { ActorContext, RunApplicationService } from "@crewon/application";
import type { RunEventViewMode } from "@crewon/contracts";
import type { RunLifecycleEvent } from "@crewon/domain";
import type { FastifyReply, FastifyRequest } from "fastify";

import { RunEventHub } from "./run-event-hub.ts";
import { projectRunEventForView } from "./run-projection.ts";

const EVENT_PAGE_SIZE = 1_000;

export async function streamRunEvents(input: {
  request: FastifyRequest;
  reply: FastifyReply;
  application: RunApplicationService;
  actor: ActorContext;
  eventHub: RunEventHub;
  runId: string;
  afterSequence: number;
  view: RunEventViewMode;
  heartbeatIntervalMs: number | null;
}): Promise<void> {
  await input.application.getRun(input.actor, input.runId);
  const subscription = input.eventHub.subscribe(input.runId);
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
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    subscription.close();
    if (!response.writableEnded) {
      response.end();
    }
  };
  response.once("close", close);
  const heartbeat = startHeartbeat(response, input.heartbeatIntervalMs, close);

  try {
    let cursor = input.afterSequence;
    let terminal = false;
    while (!closed) {
      const events = await input.application.listRunEvents(input.actor, {
        runId: input.runId,
        afterSequence: cursor,
        limit: EVENT_PAGE_SIZE,
      });
      for (const event of events) {
        if (event.sequence <= cursor) {
          continue;
        }
        if (!writeEvent(response, event, input.view)) {
          close();
          break;
        }
        cursor = event.sequence;
        terminal = isTerminalEvent(event);
      }
      if (closed || terminal || events.length < EVENT_PAGE_SIZE) {
        break;
      }
    }

    if (terminal) {
      close();
      return;
    }

    for await (const event of subscription) {
      if (closed) {
        break;
      }
      if (event.sequence <= cursor) {
        continue;
      }
      await input.application.getRun(input.actor, input.runId);
      if (!writeEvent(response, event, input.view)) {
        close();
        break;
      }
      cursor = event.sequence;
      if (isTerminalEvent(event)) {
        close();
        break;
      }
    }
  } catch {
    close();
  } finally {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
    }
    response.off("close", close);
    close();
  }
}

function writeEvent(
  response: ServerResponse,
  event: RunLifecycleEvent,
  view: RunEventViewMode,
): boolean {
  const projected = projectRunEventForView(event, view);
  if (projected === null) {
    return true;
  }
  return response.write(
    `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(projected)}\n\n`,
  );
}

function startHeartbeat(
  response: ServerResponse,
  intervalMs: number | null,
  close: () => void,
): NodeJS.Timeout | null {
  if (intervalMs === null) {
    return null;
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) {
    throw new Error("heartbeat_interval_invalid");
  }
  const timer = setInterval(() => {
    if (!response.write(": heartbeat\n\n")) {
      close();
    }
  }, intervalMs);
  timer.unref();
  return timer;
}

function isTerminalEvent(event: RunLifecycleEvent): boolean {
  return (
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.canceled"
  );
}
