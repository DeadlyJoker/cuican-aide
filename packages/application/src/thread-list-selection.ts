import { ApplicationError } from "./application-error.ts";
import type { ThreadListQuery } from "./thread-store-port.ts";

export type ThreadListSelection = Pick<
  ThreadListQuery,
  "before" | "after" | "filter" | "limit"
>;

/** Optional browse behavior; existing before/limit and scope validation remain authoritative. */
export function validateThreadListSelection(query: ThreadListSelection): void {
  const after = query.after;
  if (
    after !== undefined &&
    after !== null &&
    (query.before !== null ||
      typeof after !== "object" ||
      Array.isArray(after) ||
      Object.keys(after).some(
        (key) => !["updatedAt", "threadId"].includes(key),
      ) ||
      typeof after.updatedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(
        after.updatedAt,
      ) ||
      !Number.isFinite(Date.parse(after.updatedAt)) ||
      typeof after.threadId !== "string" ||
      after.threadId.trim().length === 0 ||
      after.threadId.length > 512)
  )
    throw new ApplicationError("validation", "thread_cursor_invalid");
  const filter = query.filter;
  if (filter === undefined) return;
  if (
    filter === null ||
    typeof filter !== "object" ||
    Array.isArray(filter) ||
    Object.keys(filter).some(
      (key) => !["status", "excludeForks"].includes(key),
    ) ||
    (filter.status !== "active" && filter.status !== "archived") ||
    typeof filter.excludeForks !== "boolean"
  )
    throw new ApplicationError("validation", "thread_filter_invalid");
}
