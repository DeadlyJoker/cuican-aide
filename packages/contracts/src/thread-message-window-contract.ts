import type { components } from "./generated/control-api.ts";
import { ContractValidationError } from "./contract-validation-error.ts";
import { parseThreadId } from "./control-api-contract.ts";

export type GetThreadMessageWindowResponse =
  components["schemas"]["GetThreadMessageWindowResponse"];
export const MAX_THREAD_MESSAGE_WINDOW_RESPONSE_BYTES = 5 * 1024 * 1024;
export type ThreadMessageWindowPosition = Readonly<{
  direction: "older" | "newer";
  messageSequence: number;
  threadRevision: number;
}>;
export type ThreadMessageWindowQuery = Readonly<{
  position: ThreadMessageWindowPosition | null;
  limit: number;
}>;
const VERSION = "crewon.message-window.v0";

function record(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}
function keys(
  input: unknown,
  expected: readonly string[],
): input is Record<string, unknown> {
  return (
    record(input) &&
    Object.keys(input).length === expected.length &&
    expected.every((key) => Object.hasOwn(input, key))
  );
}
function integer(input: unknown, minimum = 1): input is number {
  return Number.isSafeInteger(input) && Number(input) >= minimum;
}
function boundedString(input: unknown): input is string {
  return (
    typeof input === "string" && input.trim().length > 0 && input.length <= 512
  );
}
function timestamp(input: unknown): input is string {
  return (
    typeof input === "string" &&
    /^\d{4}-\d\d-\d\dT/u.test(input) &&
    Number.isFinite(Date.parse(input))
  );
}
function fail(code = "message_window_response_invalid"): never {
  throw new ContractValidationError(code);
}

export function formatThreadMessageWindowCursor(
  threadId: string,
  position: ThreadMessageWindowPosition,
): string {
  parseThreadId(threadId);
  if (
    !integer(position.threadRevision) ||
    !integer(position.messageSequence) ||
    !["older", "newer"].includes(position.direction)
  )
    fail("message_window_cursor_invalid");
  const json = JSON.stringify([
    VERSION,
    threadId,
    position.threadRevision,
    position.direction,
    position.messageSequence,
  ]);
  return btoa(
    Array.from(new TextEncoder().encode(json), (byte) =>
      String.fromCharCode(byte),
    ).join(""),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function parseCursor(
  input: unknown,
  threadId: string,
): ThreadMessageWindowPosition {
  if (
    typeof input !== "string" ||
    input.length > 2048 ||
    !/^[A-Za-z0-9_-]+$/u.test(input)
  )
    fail("message_window_cursor_invalid");
  try {
    const binary = atob(input.replaceAll("-", "+").replaceAll("_", "/"));
    const value: unknown = JSON.parse(
      new TextDecoder(undefined, { fatal: true }).decode(
        Uint8Array.from(binary, (character) => character.charCodeAt(0)),
      ),
    );
    if (
      !Array.isArray(value) ||
      value.length !== 5 ||
      value[0] !== VERSION ||
      value[1] !== threadId ||
      !integer(value[2]) ||
      !["older", "newer"].includes(value[3]) ||
      !integer(value[4])
    )
      fail("message_window_cursor_invalid");
    const position: ThreadMessageWindowPosition = {
      threadRevision: value[2],
      direction: value[3],
      messageSequence: value[4],
    };
    if (formatThreadMessageWindowCursor(threadId, position) !== input)
      fail("message_window_cursor_invalid");
    return position;
  } catch {
    return fail("message_window_cursor_invalid");
  }
}

export function parseThreadMessageWindowQuery(
  input: unknown,
  threadId: string,
): ThreadMessageWindowQuery {
  parseThreadId(threadId);
  if (
    !record(input) ||
    Object.keys(input).some((key) => key !== "cursor" && key !== "limit")
  )
    fail("message_window_query_invalid");
  const limit =
    input.limit === undefined
      ? 100
      : typeof input.limit === "string" && /^[1-9][0-9]*$/u.test(input.limit)
        ? Number(input.limit)
        : input.limit;
  if (!integer(limit) || limit > 100) fail("message_window_limit_invalid");
  return {
    limit,
    position:
      input.cursor === undefined || input.cursor === null
        ? null
        : parseCursor(input.cursor, threadId),
  };
}

export function parseThreadMessageWindowResponse(
  input: unknown,
  threadId: string,
  query: ThreadMessageWindowQuery,
): GetThreadMessageWindowResponse {
  if (
    !keys(input, [
      "schemaVersion",
      "threadId",
      "threadRevision",
      "eventSequence",
      "headMessageSequence",
      "data",
      "olderCursor",
      "newerCursor",
    ]) ||
    input.schemaVersion !== VERSION ||
    input.threadId !== threadId ||
    !integer(input.threadRevision) ||
    !integer(input.eventSequence, 0) ||
    input.eventSequence !== input.threadRevision ||
    !integer(input.headMessageSequence, 0) ||
    !Array.isArray(input.data) ||
    input.data.length > query.limit
  )
    fail();
  if (
    query.position !== null &&
    query.position.threadRevision !== input.threadRevision
  )
    fail();
  let previous = 0;
  for (const message of input.data) {
    if (
      !keys(message, [
        "messageId",
        "threadId",
        "sequence",
        "role",
        "content",
        "proposedPlan",
        "createdAt",
      ]) ||
      !boundedString(message.messageId) ||
      message.threadId !== threadId ||
      !integer(message.sequence) ||
      message.sequence <= previous ||
      message.sequence > input.headMessageSequence ||
      (message.role !== "user" &&
        message.role !== "assistant" &&
        message.role !== "system" &&
        message.role !== "tool") ||
      typeof message.content !== "string" ||
      !timestamp(message.createdAt)
    )
      fail();
    if (
      query.position !== null &&
      (query.position.direction === "older"
        ? message.sequence >= query.position.messageSequence
        : message.sequence <= query.position.messageSequence)
    )
      fail();
    const plan = message.proposedPlan;
    if (
      plan !== null &&
      (!keys(plan, [
        "schemaVersion",
        "planId",
        "threadId",
        "runId",
        "messageId",
        "content",
        "createdAt",
      ]) ||
        plan.schemaVersion !== "crewon.proposed-plan.v0" ||
        message.role !== "assistant" ||
        !boundedString(plan.planId) ||
        !boundedString(plan.runId) ||
        plan.threadId !== threadId ||
        plan.messageId !== message.messageId ||
        plan.content !== message.content ||
        message.content.trim().length === 0 ||
        new TextEncoder().encode(message.content).byteLength > 9999 ||
        !timestamp(plan.createdAt))
    )
      fail();
    previous = message.sequence;
  }
  for (const direction of ["older", "newer"] as const) {
    const cursor = input[`${direction}Cursor`];
    if (cursor === null) continue;
    const position = parseCursor(cursor, threadId);
    const edge = direction === "older" ? input.data[0] : input.data.at(-1);
    if (
      !edge ||
      position.direction !== direction ||
      position.threadRevision !== input.threadRevision ||
      position.messageSequence !== edge.sequence
    )
      fail();
  }
  return structuredClone(input) as GetThreadMessageWindowResponse;
}
