import type { components } from "./generated/control-api.ts";
import { ContractValidationError } from "./contract-validation-error.ts";
import { captureWorkflowControlJson } from "./workflow-control-json.ts";
import { base64UrlEncode, base64UrlDecode } from "./utf8-base64url.ts";
import { parseRunView } from "./run-view.ts";
export type WorkflowRunListRequest = Readonly<{
  workflowVersionId: string;
  threadId?: string | null;
  cursor?: string | null;
  limit?: number;
}>;
export type WorkflowRunListQuery = Readonly<{
  workflowVersionId: string;
  threadId: string | null;
  before: Readonly<{ createdAt: string; runId: string }> | null;
  limit: number;
}>;
export type WorkflowRunListResponse =
  components["schemas"]["ListWorkflowRunsResponse"];
export const MAX_WORKFLOW_RUN_LIST_BYTES = 1024 * 1024;
const prefix = "crewon.workflow-runs.cursor.v1:";
function fail(): never {
  throw new ContractValidationError("workflow_run_list_invalid");
}
function record(value: unknown, allowed: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length > allowed.length) fail();
  const entries = keys.map((key) => {
    if (typeof key !== "string" || !allowed.includes(key)) fail();
    const d = Object.getOwnPropertyDescriptor(value, key)!;
    if (!d.enumerable || !("value" in d)) fail();
    return [key, d.value] as const;
  });
  return Object.fromEntries(entries);
}
function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    value.length > 512 ||
    new TextEncoder().encode(value).byteLength > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      new TextEncoder().encode(value),
    ) !== value
  )
    fail();
  return value;
}
function stamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    fail();
  const normalized = new Date(value).toISOString();
  if (normalized.slice(0, 19) !== value.slice(0, 19)) fail();
  return normalized;
}
export function captureWorkflowRunListQuery(
  value: unknown,
): WorkflowRunListQuery {
  const row = record(value, [
    "workflowVersionId",
    "threadId",
    "before",
    "limit",
  ]);
  if (
    Object.keys(row).length !== 4 ||
    !Number.isSafeInteger(row.limit) ||
    Number(row.limit) < 1 ||
    Number(row.limit) > 20
  )
    fail();
  const workflowVersionId = id(row.workflowVersionId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(workflowVersionId)) fail();
  let before: WorkflowRunListQuery["before"] = null;
  if (row.before !== null) {
    const anchor = record(row.before, ["createdAt", "runId"]);
    if (Object.keys(anchor).length !== 2) fail();
    before = { createdAt: stamp(anchor.createdAt), runId: id(anchor.runId) };
  }
  return {
    workflowVersionId,
    threadId: row.threadId === null ? null : id(row.threadId),
    before,
    limit: Number(row.limit),
  };
}
export function formatWorkflowRunListCursor(
  query: Pick<WorkflowRunListQuery, "workflowVersionId" | "threadId">,
  anchor: NonNullable<WorkflowRunListQuery["before"]>,
) {
  const bounded = captureWorkflowRunListQuery({
    ...query,
    before: anchor,
    limit: 1,
  });
  return base64UrlEncode(
    prefix +
      JSON.stringify([
        bounded.workflowVersionId,
        bounded.threadId,
        bounded.before!.createdAt,
        bounded.before!.runId,
      ]),
  );
}
export function parseWorkflowRunListQuery(
  value: unknown,
): WorkflowRunListQuery {
  const row = record(value, [
    "workflowVersionId",
    "threadId",
    "cursor",
    "limit",
  ]);
  const numeric =
    typeof row.limit === "string" &&
    row.limit.length <= 2 &&
    /^[1-9][0-9]*$/u.test(row.limit)
      ? Number(row.limit)
      : row.limit;
  let query = captureWorkflowRunListQuery({
    workflowVersionId: row.workflowVersionId,
    threadId: row.threadId ?? null,
    before: null,
    limit: numeric === undefined ? 20 : numeric,
  });
  if (row.cursor !== undefined && row.cursor !== null) {
    if (
      typeof row.cursor !== "string" ||
      row.cursor.length > 4096 ||
      !row.cursor ||
      !/^[A-Za-z0-9_-]+$/u.test(row.cursor)
    )
      fail();
    try {
      const decoded = base64UrlDecode(row.cursor);
      if (!decoded.startsWith(prefix)) fail();
      const tuple: unknown = JSON.parse(decoded.slice(prefix.length));
      if (
        !Array.isArray(tuple) ||
        tuple.length !== 4 ||
        tuple[0] !== query.workflowVersionId ||
        tuple[1] !== query.threadId
      )
        fail();
      query = captureWorkflowRunListQuery({
        ...query,
        before: { createdAt: tuple[2], runId: tuple[3] },
      });
      if (formatWorkflowRunListCursor(query, query.before!) !== row.cursor)
        fail();
    } catch {
      fail();
    }
  }
  return query;
}
function compareIds(a: string, b: string) {
  const x = new TextEncoder().encode(a),
    y = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  }
  return x.length - y.length;
}
export function parseWorkflowRunListResponse(
  value: unknown,
  input: WorkflowRunListQuery,
): WorkflowRunListResponse {
  const query = captureWorkflowRunListQuery(input),
    row = record(
      captureWorkflowControlJson(value, MAX_WORKFLOW_RUN_LIST_BYTES),
      ["data", "nextCursor"],
    );
  if (
    Object.keys(row).length !== 2 ||
    !Array.isArray(row.data) ||
    row.data.length > query.limit
  )
    fail();
  const data: WorkflowRunListResponse["data"] = [],
    seen = new Set<string>();
  let previous = query.before;
  for (const candidate of row.data) {
    const run = parseRunView(candidate, query.threadId ?? undefined);
    if (
      run.purpose !== "workflow" ||
      run.workflowVersionBinding?.workflowVersionId !==
        query.workflowVersionId ||
      seen.has(run.runId)
    )
      fail();
    const time = stamp(run.createdAt);
    id(run.runId);
    if (
      previous &&
      (time > previous.createdAt ||
        (time === previous.createdAt &&
          compareIds(run.runId, previous.runId) >= 0))
    )
      fail();
    data.push(run);
    seen.add(run.runId);
    previous = { createdAt: time, runId: run.runId };
  }
  if (
    row.nextCursor !== null &&
    (!previous ||
      data.length !== query.limit ||
      row.nextCursor !== formatWorkflowRunListCursor(query, previous))
  )
    fail();
  return { data, nextCursor: row.nextCursor as string | null };
}
