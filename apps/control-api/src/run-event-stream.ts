import type { ServerResponse } from "node:http";

import type { ActorContext, RunApplicationService } from "@crewon/application";
import type { RunEventExtension, RunEventViewMode } from "@crewon/contracts";
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
  extensions: readonly RunEventExtension[];
  heartbeatIntervalMs: number | null;
}): Promise<void> {
  if (input.view === "transcript") {
    await input.application.getRunTranscript(input.actor, input.runId);
  } else {
    await input.application.getRun(input.actor, input.runId);
  }
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
  const streaming = new AbortController();
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    streaming.abort();
    subscription.close();
    if (!response.writableEnded) {
      response.end();
    }
  };
  response.once("close", close);
  response.once("error", close);
  const heartbeat = startHeartbeat(response, input.heartbeatIntervalMs, close);

  try {
    let cursor = input.afterSequence;
    let terminal = false;
    while (!closed) {
      const query = {
        runId: input.runId,
        afterSequence: cursor,
        limit: EVENT_PAGE_SIZE,
      };
      const events =
        input.view === "transcript"
          ? await input.application.listRunTranscriptEvents(input.actor, query)
          : await input.application.listRunEvents(input.actor, query);
      for (const event of events) {
        if (event.sequence <= cursor) {
          continue;
        }
        if (
          !(await writeRunSseEvent({
            response,
            event,
            view: input.view,
            extensions: input.extensions,
            signal: streaming.signal,
          }))
        ) {
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
      if (input.view === "transcript") {
        await input.application.getRunTranscript(input.actor, input.runId);
      } else {
        await input.application.getRun(input.actor, input.runId);
      }
      if (
        !(await writeRunSseEvent({
          response,
          event,
          view: input.view,
          extensions: input.extensions,
          signal: streaming.signal,
        }))
      ) {
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
    response.off("error", close);
    close();
  }
}

export async function writeRunSseEvent(input: {
  response: ServerResponse;
  event: RunLifecycleEvent;
  view: RunEventViewMode;
  extensions: readonly RunEventExtension[];
  signal: AbortSignal;
}): Promise<boolean> {
  const { response, event, view, extensions, signal } = input;
  if (signal.aborted || response.destroyed || response.writableEnded) {
    return false;
  }
  const projected = projectRunEventForView(event, view, extensions);
  if (projected === null) {
    return true;
  }
  const accepted = response.write(
    `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(projected)}\n\n`,
  );
  if (accepted) return true;
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
  if (intervalMs === null) {
    return null;
  }
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

function isTerminalEvent(event: RunLifecycleEvent): boolean {
  return (
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.canceled"
  );
}
