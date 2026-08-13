import type { ServerResponse } from "node:http";

import type {
  ActorContext,
  WorkspaceOperationEvent,
  WorkspaceOperationQueryService,
} from "@crewon/application";
import {
  isWorkspaceOperationTerminal,
  type WorkspaceOperationEventView,
} from "@crewon/contracts/runtime";
import type { FastifyReply, FastifyRequest } from "fastify";

import {
  projectWorkspaceOperationEvent,
  projectWorkspaceOperationSnapshot,
} from "./workspace-operation-projection.ts";

const EVENT_PAGE_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_SSE_FRAME_BYTES = 128 * 1024;

export interface WorkspaceOperationEventPoller {
  waitForNextPoll(signal: AbortSignal): Promise<void>;
}

export class IntervalWorkspaceOperationEventPoller
  implements WorkspaceOperationEventPoller
{
  readonly #intervalMs: number;

  constructor(intervalMs = DEFAULT_POLL_INTERVAL_MS) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
      throw new Error("workspace_event_poll_interval_invalid");
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

type WorkspaceEventApplication = Pick<
  WorkspaceOperationQueryService,
  "getSnapshot" | "listEvents"
>;

export async function streamWorkspaceOperationEvents(input: {
  request: FastifyRequest;
  reply: FastifyReply;
  application: WorkspaceEventApplication;
  actor: ActorContext;
  threadId: string;
  executionId: string;
  afterSequence: number;
  poller: WorkspaceOperationEventPoller;
  heartbeatIntervalMs: number | null;
}): Promise<void> {
  let cursor = input.afterSequence;
  let page = await loadPage(input, cursor);
  let terminalAtCursor =
    page.length === 0 ? await isTerminalAtCursor(input, cursor) : false;

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
        if (
          !(await writeWorkspaceOperationSseEvent(
            response,
            event,
            polling.signal,
          ))
        ) {
          close();
          break;
        }
        cursor = event.sequence;
        if (isWorkspaceOperationTerminal(event.data.operation)) {
          terminalAtCursor = true;
          break;
        }
      }
      if (closed || terminalAtCursor) {
        close();
        break;
      }
      if (page.length === EVENT_PAGE_SIZE) {
        page = await loadPage(input, cursor);
        continue;
      }
      await input.poller.waitForNextPoll(polling.signal);
      if (closed) break;
      page = await loadPage(input, cursor);
      terminalAtCursor =
        page.length === 0 ? await isTerminalAtCursor(input, cursor) : false;
    }
  } catch {
    close();
  } finally {
    if (heartbeat !== null) clearInterval(heartbeat);
    response.off("close", close);
    close();
  }
}

export async function writeWorkspaceOperationSseEvent(
  response: ServerResponse,
  event: WorkspaceOperationEventView,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted || response.destroyed || response.writableEnded) {
    return false;
  }
  const frame = `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  if (new TextEncoder().encode(frame).byteLength > MAX_SSE_FRAME_BYTES) {
    throw new Error("workspace_event_frame_too_large");
  }
  const accepted = response.write(frame);
  return accepted ? true : waitForDrain(response, signal);
}

function loadPage(
  input: Parameters<typeof streamWorkspaceOperationEvents>[0],
  afterSequence: number,
): Promise<readonly WorkspaceOperationEventView[]> {
  return input.application
    .listEvents(input.actor, {
      threadId: input.threadId,
      executionId: input.executionId,
      afterSequence,
      limit: EVENT_PAGE_SIZE,
    })
    .then((events) => projectPage(input, events, afterSequence));
}

function projectPage(
  input: Parameters<typeof streamWorkspaceOperationEvents>[0],
  events: readonly WorkspaceOperationEvent[],
  afterSequence: number,
): readonly WorkspaceOperationEventView[] {
  let cursor = afterSequence;
  return events.map((event) => {
    const projected = projectWorkspaceOperationEvent(event, {
      threadId: input.threadId,
      executionId: input.executionId,
      afterSequence: cursor,
    });
    cursor = projected.sequence;
    return projected;
  });
}

async function isTerminalAtCursor(
  input: Parameters<typeof streamWorkspaceOperationEvents>[0],
  cursor: number,
): Promise<boolean> {
  const snapshot = projectWorkspaceOperationSnapshot(
    await input.application.getSnapshot(input.actor, {
      threadId: input.threadId,
      executionId: input.executionId,
    }),
  );
  return (
    snapshot.eventSequence === cursor &&
    isWorkspaceOperationTerminal(snapshot.operation)
  );
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
