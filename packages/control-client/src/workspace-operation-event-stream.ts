import {
  isWorkspaceOperationTerminal,
  parseWorkspaceOperationEventView,
  type WorkspaceOperationEventView,
} from "@crewon/contracts";

import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";

const MAX_FRAME_BYTES = 128 * 1024;
const MAX_BUFFER_BYTES = 256 * 1024;
const MAX_RECONNECT_DELAY_MS = 60_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const WORKSPACE_EVENT_NAME = "workspace.operation.replaced";

/** Streams one execution's independent revision journal and resumes on disconnect. */
export async function* streamWorkspaceOperationEvents(
  client: ControlApiClient,
  input: {
    threadId: string;
    executionId: string;
    afterSequence?: number;
    reconnectDelayMs?: number;
    signal?: AbortSignal;
  },
): AsyncIterable<WorkspaceOperationEventView> {
  let cursor = input.afterSequence ?? 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new ControlApiProtocolError(
      "control_client_workspace_event_cursor_invalid",
    );
  }
  const reconnectDelayMs = input.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  if (
    !Number.isSafeInteger(reconnectDelayMs) ||
    reconnectDelayMs < 0 ||
    reconnectDelayMs > MAX_RECONNECT_DELAY_MS
  ) {
    throw new ControlApiProtocolError(
      "control_client_workspace_event_reconnect_delay_invalid",
    );
  }

  let connected = false;
  for (;;) {
    if (isAborted(input.signal)) return;
    let response: Response;
    try {
      response = await client.openWorkspaceListOperationEventStream({
        threadId: input.threadId,
        executionId: input.executionId,
        afterSequence: cursor,
        signal: input.signal,
      });
    } catch (error) {
      if (isAborted(input.signal)) return;
      if (!connected || error instanceof ControlApiProtocolError) {
        throw connectionError(error);
      }
      await waitForReconnect(reconnectDelayMs, input.signal);
      continue;
    }
    if (response.status !== 200) {
      throw new ControlApiProtocolError(
        "control_client_workspace_event_stream_failed",
      );
    }
    if (
      !/^text\/event-stream(?:;|$)/iu.test(
        response.headers.get("content-type") ?? "",
      ) ||
      response.body === null
    ) {
      throw new ControlApiProtocolError(
        "control_client_workspace_event_stream_invalid",
      );
    }
    connected = true;

    try {
      for await (const event of readConnection(response, {
        threadId: input.threadId,
        executionId: input.executionId,
        afterSequence: cursor,
      })) {
        cursor = event.sequence;
        yield event;
        if (isWorkspaceOperationTerminal(event.data.operation)) return;
      }
    } catch (error) {
      if (error instanceof ControlApiProtocolError) throw error;
      if (isAborted(input.signal)) return;
    }

    if (isAborted(input.signal)) return;
    await waitForReconnect(reconnectDelayMs, input.signal);
  }
}

async function* readConnection(
  response: Response,
  expected: {
    threadId: string;
    executionId: string;
    afterSequence: number;
  },
): AsyncIterable<WorkspaceOperationEventView> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new ControlApiProtocolError(
      "control_client_workspace_event_stream_invalid",
    );
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let cursor = expected.afterSequence;
  let buffer = "";
  try {
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch {
        return;
      }
      if (next.done) {
        try {
          buffer += decoder.decode();
        } catch {
          throw invalidStream();
        }
        break;
      }
      try {
        buffer += decoder.decode(next.value, { stream: true });
      } catch {
        throw invalidStream();
      }
      if (byteLength(buffer) > MAX_BUFFER_BYTES) {
        throw new ControlApiProtocolError(
          "control_client_workspace_event_buffer_too_large",
        );
      }
      buffer = normalizeNewlines(buffer, false);
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseFrame(frame, {
          ...expected,
          afterSequence: cursor,
        });
        if (event !== null) {
          cursor = event.sequence;
          yield event;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer = normalizeNewlines(buffer, true);
    if (buffer.trim().length > 0) {
      const event = parseFrame(buffer, { ...expected, afterSequence: cursor });
      if (event !== null) yield event;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parseFrame(
  frame: string,
  expected: {
    threadId: string;
    executionId: string;
    afterSequence: number;
  },
): WorkspaceOperationEventView | null {
  if (byteLength(frame) > MAX_FRAME_BYTES) {
    throw new ControlApiProtocolError(
      "control_client_workspace_event_frame_too_large",
    );
  }
  if (frame.length === 0) return null;
  let id: string | null = null;
  let eventName: string | null = null;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const raw = separator < 0 ? "" : line.slice(separator + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "id") {
      if (id !== null) throw invalidFrame();
      id = value;
    } else if (field === "event") {
      if (eventName !== null) throw invalidFrame();
      eventName = value;
    } else if (field === "data") {
      data.push(value);
    } else {
      throw invalidFrame();
    }
  }
  if (id === null && eventName === null && data.length === 0) return null;
  if (
    id === null ||
    eventName !== WORKSPACE_EVENT_NAME ||
    data.length === 0 ||
    !/^[1-9][0-9]*$/u.test(id)
  ) {
    throw invalidFrame();
  }
  let value: unknown;
  try {
    value = JSON.parse(data.join("\n"));
  } catch {
    throw new ControlApiProtocolError(
      "control_client_workspace_event_json_invalid",
    );
  }
  let event: WorkspaceOperationEventView;
  try {
    event = parseWorkspaceOperationEventView(value, expected);
  } catch {
    throw new ControlApiProtocolError("control_client_workspace_event_invalid");
  }
  if (String(event.sequence) !== id || event.type !== eventName) {
    throw new ControlApiProtocolError(
      "control_client_workspace_event_identity_mismatch",
    );
  }
  return event;
}

function invalidFrame(): ControlApiProtocolError {
  return new ControlApiProtocolError(
    "control_client_workspace_event_frame_invalid",
  );
}

function invalidStream(): ControlApiProtocolError {
  return new ControlApiProtocolError(
    "control_client_workspace_event_stream_invalid",
  );
}

function connectionError(error: unknown): ControlApiProtocolError {
  return error instanceof ControlApiProtocolError
    ? error
    : new ControlApiProtocolError(
        "control_client_workspace_event_stream_failed",
      );
}

async function waitForReconnect(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (delayMs === 0) {
    await Promise.resolve();
    return;
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function normalizeNewlines(value: string, final: boolean): string {
  const trailingCarriageReturn = !final && value.endsWith("\r");
  const body = trailingCarriageReturn ? value.slice(0, -1) : value;
  return (
    body.replaceAll("\r\n", "\n").replaceAll("\r", "\n") +
    (trailingCarriageReturn ? "\r" : "")
  );
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
