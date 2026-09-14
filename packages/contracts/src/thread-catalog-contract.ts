import type { components } from "./generated/control-api.ts";
import { ContractValidationError } from "./contract-validation-error.ts";
import {
  formatThreadCursor,
  parseThreadId,
  parseThreadListQuery,
} from "./control-api-contract.ts";

export type ThreadCatalogResponse =
  components["schemas"]["ThreadCatalogResponse"];
export type ThreadCatalogRequest = Readonly<{
  cursor?: string | null;
  limit?: number;
  status?: "active" | "archived";
  search?: string;
  excludeForks?: boolean;
}>;
export type ThreadCatalogFilter = Readonly<{
  status: "active" | "archived";
  search: string;
  excludeForks: boolean;
}>;
export type ThreadCatalogPosition = Readonly<{
  direction: "older" | "newer";
  updatedAt: string;
  threadId: string;
}>;
export type ThreadCatalogQuery = ThreadCatalogFilter &
  Readonly<{
    position: ThreadCatalogPosition | null;
    limit: number;
  }>;
export const MAX_THREAD_CATALOG_RESPONSE_BYTES = 1024 * 1024;
const VERSION = "crewon.thread-catalog.v0";

function fail(code = "thread_catalog_query_invalid"): never {
  throw new ContractValidationError(code);
}
function record(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}
function encode(value: unknown): string {
  return btoa(
    Array.from(new TextEncoder().encode(JSON.stringify(value)), (byte) =>
      String.fromCharCode(byte),
    ).join(""),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
function parseFilter(input: Record<string, unknown>): ThreadCatalogFilter {
  const status = input.status === undefined ? "active" : input.status;
  const search = input.search === undefined ? "" : input.search;
  const excludeForks =
    input.excludeForks === undefined ? false : input.excludeForks;
  if (
    (status !== "active" && status !== "archived") ||
    typeof search !== "string" ||
    search.length > 256 ||
    /[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(search) ||
    ![true, false, "true", "false"].includes(excludeForks as boolean | string)
  )
    fail();
  return {
    status,
    search: search.trim(),
    excludeForks: excludeForks === true || excludeForks === "true",
  };
}

export function formatThreadCatalogCursor(
  filter: ThreadCatalogFilter,
  position: ThreadCatalogPosition,
): string {
  if (
    !record(filter) ||
    JSON.stringify(parseFilter(filter)) !==
      JSON.stringify({
        status: filter.status,
        search: filter.search,
        excludeForks: filter.excludeForks,
      }) ||
    !["older", "newer"].includes(position.direction)
  )
    fail("thread_catalog_cursor_invalid");
  const anchor = formatThreadCursor(position);
  return encode([
    VERSION,
    filter.status,
    filter.search,
    filter.excludeForks,
    position.direction,
    anchor,
  ]);
}

function parseCursor(
  value: unknown,
  filter: ThreadCatalogFilter,
): ThreadCatalogPosition {
  try {
    if (
      typeof value !== "string" ||
      value.length > 4096 ||
      !/^[A-Za-z0-9_-]+$/u.test(value)
    )
      fail();
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const decoded: unknown = JSON.parse(
      new TextDecoder(undefined, { fatal: true }).decode(
        Uint8Array.from(binary, (c) => c.charCodeAt(0)),
      ),
    );
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 6 ||
      decoded[0] !== VERSION ||
      decoded[1] !== filter.status ||
      decoded[2] !== filter.search ||
      decoded[3] !== filter.excludeForks ||
      (decoded[4] !== "older" && decoded[4] !== "newer")
    )
      fail();
    const anchor = parseThreadListQuery({ cursor: decoded[5] }).before;
    if (anchor === null) fail();
    const position = {
      direction: decoded[4],
      updatedAt: anchor.updatedAt,
      threadId: anchor.resourceId,
    };
    if (formatThreadCatalogCursor(filter, position) !== value) fail();
    return position;
  } catch {
    return fail("thread_catalog_cursor_invalid");
  }
}

export function parseThreadCatalogQuery(input: unknown): ThreadCatalogQuery {
  if (
    !record(input) ||
    Object.keys(input).some(
      (key) =>
        !["cursor", "limit", "status", "search", "excludeForks"].includes(key),
    )
  )
    fail();
  const filter = parseFilter(input);
  const rawLimit = input.limit === undefined ? 50 : input.limit;
  const { limit } = parseThreadListQuery({
    limit: typeof rawLimit === "number" ? String(rawLimit) : rawLimit,
  });
  return {
    ...filter,
    limit,
    position: input.cursor == null ? null : parseCursor(input.cursor, filter),
  };
}

/** Literal display-title search with locale-independent Unicode lowercase; never a SQL pattern. */
export function matchesThreadCatalogSearch(
  thread: { title: string | null; displayTitle?: string },
  search: string,
): boolean {
  return (thread.title ?? thread.displayTitle ?? "")
    .toLowerCase()
    .includes(search.toLowerCase());
}

export function threadCatalogPath(query: ThreadCatalogRequest): string {
  const parsed = parseThreadCatalogQuery(query);
  const parameters = new URLSearchParams({
    limit: String(parsed.limit),
    status: parsed.status,
    search: parsed.search,
    excludeForks: String(parsed.excludeForks),
  });
  if (query.cursor != null) parameters.set("cursor", query.cursor);
  return `/api/v1/thread-catalog?${parameters}`;
}

function integer(value: unknown, min: number): boolean {
  return Number.isSafeInteger(value) && Number(value) >= min;
}
function timestamp(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function compare(
  left: { updatedAt: string; threadId: string },
  right: { updatedAt: string; threadId: string },
): number {
  // The store owns ID collation and historical timestamp precision. SQLite keeps UTC text;
  // PostgreSQL compares timestamptz. Do not reject either native order for mixed legacy precision.
  const time = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
  const text =
    left.updatedAt === right.updatedAt
      ? 0
      : left.updatedAt < right.updatedAt
        ? -1
        : 1;
  return Math.sign(time) === text ? time : 0;
}

/** Filtered pages can be empty and still have a continuation; cursors refer to scanned candidates. */
export function parseThreadCatalogResponse(
  input: unknown,
  query: ThreadCatalogQuery,
): ThreadCatalogResponse {
  try {
    if (
      !record(input) ||
      Object.keys(input).length !== 5 ||
      input.schemaVersion !== VERSION ||
      !integer(input.scannedCount, 0) ||
      Number(input.scannedCount) > query.limit ||
      !Array.isArray(input.data) ||
      input.data.length > Number(input.scannedCount) ||
      !Object.hasOwn(input, "olderCursor") ||
      !Object.hasOwn(input, "newerCursor")
    )
      fail();
    const ids = new Set<string>();
    let previous: components["schemas"]["ThreadView"] | undefined;
    const fields = [
      "threadId",
      "title",
      "status",
      "revision",
      "lastMessageSequence",
      "forkedFromThreadId",
      "forkedThroughHistorySequence",
      "createdAt",
      "updatedAt",
      "archivedAt",
      "deletedAt",
    ];
    for (const value of input.data) {
      if (
        !record(value) ||
        !fields.every((key) => Object.hasOwn(value, key)) ||
        Object.keys(value).some(
          (key) => !fields.includes(key) && key !== "displayTitle",
        ) ||
        value.status !== query.status ||
        !integer(value.revision, 1) ||
        !integer(value.lastMessageSequence, 0) ||
        (value.title !== null &&
          (typeof value.title !== "string" || value.title.length > 256)) ||
        (value.displayTitle !== undefined &&
          (typeof value.displayTitle !== "string" ||
            value.displayTitle.length > 256)) ||
        !timestamp(value.createdAt) ||
        !timestamp(value.updatedAt) ||
        value.deletedAt !== null ||
        (query.status === "active"
          ? value.archivedAt !== null
          : !timestamp(value.archivedAt)) ||
        (value.forkedFromThreadId === null
          ? value.forkedThroughHistorySequence !== null
          : !integer(value.forkedThroughHistorySequence, 0)) ||
        (query.excludeForks && value.forkedFromThreadId !== null)
      )
        fail();
      parseThreadId(value.threadId);
      if (value.forkedFromThreadId !== null)
        parseThreadId(value.forkedFromThreadId);
      const thread = value as components["schemas"]["ThreadView"];
      if (
        ids.has(thread.threadId) ||
        !matchesThreadCatalogSearch(thread, query.search) ||
        (previous !== undefined && compare(previous, thread) < 0) ||
        (query.position !== null &&
          ((thread.threadId === query.position.threadId &&
            thread.updatedAt === query.position.updatedAt) ||
            (query.position.direction === "older"
              ? compare(thread, query.position) > 0
              : compare(thread, query.position) < 0)))
      )
        fail();
      ids.add(thread.threadId);
      previous = thread;
    }
    for (const direction of ["older", "newer"] as const) {
      const raw = input[`${direction}Cursor`];
      if (raw === null) continue;
      const edge = parseCursor(raw, query);
      if (
        edge.direction !== direction ||
        (input.scannedCount === 0 &&
          (query.position === null || query.position.direction === direction))
      )
        fail();
      if (
        query.position !== null &&
        direction === query.position.direction &&
        ((edge.threadId === query.position.threadId &&
          edge.updatedAt === query.position.updatedAt) ||
          (direction === "older"
            ? compare(edge, query.position) > 0
            : compare(edge, query.position) < 0))
      )
        fail();
      for (const thread of input.data as components["schemas"]["ThreadView"][])
        if (
          direction === "older"
            ? compare(edge, thread) > 0
            : compare(edge, thread) < 0
        )
          fail();
    }
    return structuredClone(input) as ThreadCatalogResponse;
  } catch {
    return fail("thread_catalog_response_invalid");
  }
}
