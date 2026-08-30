import type { components } from "./generated/control-api.ts";

import { ContractValidationError } from "./contract-validation-error.ts";
import { parseThreadId } from "./control-api-contract.ts";

export type CreateWorkspaceListRequest =
  components["schemas"]["CreateWorkspaceListRequest"];
export type WorkspaceOperationActionRequest =
  components["schemas"]["WorkspaceOperationActionRequest"];
export type WorkspaceListEntryView =
  components["schemas"]["WorkspaceListEntryView"];
export type WorkspaceCompletedResultView =
  components["schemas"]["WorkspaceCompletedResultView"];
export type WorkspaceFailedResultView =
  components["schemas"]["WorkspaceFailedResultView"];
export type WorkspaceOperationView =
  components["schemas"]["WorkspaceOperationView"];
export type WorkspaceOperationMutationResponse =
  components["schemas"]["WorkspaceOperationMutationResponse"];
export type GetWorkspaceOperationResponse =
  components["schemas"]["GetWorkspaceOperationResponse"];
export type ListWorkspaceOperationsResponse =
  components["schemas"]["ListWorkspaceOperationsResponse"];
export type WorkspaceOperationEventView =
  components["schemas"]["WorkspaceOperationEventView"];

export const WORKSPACE_CONTROL_LIMITS = Object.freeze({
  maxEntries: 200,
  maxNameBytes: 255,
  maxResultBytes: 64 * 1024,
  maxListPageSize: 100,
  maxListResponseBytes: 2 * 1024 * 1024,
});

export type WorkspaceOperationListQuery = Readonly<{
  afterExecutionId: string | null;
  limit: number;
}>;

export type WorkspaceOperationExpectation = Readonly<{
  threadId: string;
  executionId?: string;
}>;

export function parseCreateWorkspaceListRequest(
  input: unknown,
): CreateWorkspaceListRequest {
  const value = requireObject(input, "workspace_create_request_invalid");
  requireExactKeys(value, ["expectedThreadRevision", "maxEntries"]);
  return {
    expectedThreadRevision: requirePositiveInteger(
      value.expectedThreadRevision,
      "workspace_thread_revision_invalid",
    ),
    maxEntries: requireIntegerInRange(
      value.maxEntries,
      1,
      WORKSPACE_CONTROL_LIMITS.maxEntries,
      "workspace_max_entries_invalid",
    ),
  };
}

export function parseWorkspaceOperationActionRequest(
  input: unknown,
): WorkspaceOperationActionRequest {
  const value = requireObject(input, "workspace_action_request_invalid");
  requireExactKeys(value, ["expectedOperationRevision"]);
  return {
    expectedOperationRevision: requirePositiveInteger(
      value.expectedOperationRevision,
      "workspace_operation_revision_invalid",
    ),
  };
}

export function parseWorkspaceExecutionId(input: unknown): string {
  if (
    typeof input !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input)
  ) {
    throw new ContractValidationError("workspace_execution_id_invalid");
  }
  return input;
}

export function parseWorkspaceOperationListQuery(
  input: unknown,
): WorkspaceOperationListQuery {
  const value = requireObject(input, "workspace_list_query_invalid");
  requireAllowedKeys(value, ["afterExecutionId", "limit"]);
  return {
    afterExecutionId:
      value.afterExecutionId === undefined || value.afterExecutionId === null
        ? null
        : parseWorkspaceExecutionId(value.afterExecutionId),
    limit: parseQueryInteger(
      value.limit,
      WORKSPACE_CONTROL_LIMITS.maxListPageSize,
      WORKSPACE_CONTROL_LIMITS.maxListPageSize,
      "workspace_list_limit_invalid",
    ),
  };
}

export function parseWorkspaceOperationView(
  input: unknown,
  expected?: WorkspaceOperationExpectation,
): WorkspaceOperationView {
  const value = requireObject(input, "workspace_operation_invalid");
  requireExactKeys(value, [
    "executionId",
    "result",
    "revision",
    "status",
    "threadId",
  ]);
  const threadId = parseThreadId(value.threadId);
  const executionId = parseWorkspaceExecutionId(value.executionId);
  const revision = requirePositiveInteger(
    value.revision,
    "workspace_operation_revision_invalid",
  );
  if (
    expected !== undefined &&
    (threadId !== parseThreadId(expected.threadId) ||
      (expected.executionId !== undefined &&
        executionId !== parseWorkspaceExecutionId(expected.executionId)))
  ) {
    throw new ContractValidationError("workspace_operation_identity_mismatch");
  }

  switch (value.status) {
    case "pending":
    case "canceled":
    case "unknownOutcome":
      if (value.result !== null) {
        throw new ContractValidationError("workspace_operation_result_invalid");
      }
      return {
        threadId,
        executionId,
        revision,
        status: value.status,
        result: null,
      };
    case "completed":
      return {
        threadId,
        executionId,
        revision,
        status: "completed",
        result: parseCompletedResult(value.result),
      };
    case "failed":
      return {
        threadId,
        executionId,
        revision,
        status: "failed",
        result: parseFailedResult(value.result),
      };
    default:
      throw new ContractValidationError("workspace_operation_status_invalid");
  }
}

export function parseWorkspaceOperationMutationResponse(
  input: unknown,
  expected: WorkspaceOperationExpectation,
): WorkspaceOperationMutationResponse {
  const value = requireObject(input, "workspace_mutation_response_invalid");
  requireExactKeys(value, ["disposition", "eventSequence", "operation"]);
  if (value.disposition !== "committed" && value.disposition !== "replayed") {
    throw new ContractValidationError("workspace_disposition_invalid");
  }
  const operation = parseWorkspaceOperationView(value.operation, expected);
  const eventSequence = requirePositiveInteger(
    value.eventSequence,
    "workspace_event_sequence_invalid",
  );
  if (eventSequence !== operation.revision) {
    throw new ContractValidationError("workspace_event_sequence_mismatch");
  }
  return { disposition: value.disposition, eventSequence, operation };
}

export function parseGetWorkspaceOperationResponse(
  input: unknown,
  expected: Required<WorkspaceOperationExpectation>,
): GetWorkspaceOperationResponse {
  const value = requireObject(input, "workspace_snapshot_response_invalid");
  requireExactKeys(value, ["eventSequence", "operation"]);
  const operation = parseWorkspaceOperationView(value.operation, expected);
  const eventSequence = requirePositiveInteger(
    value.eventSequence,
    "workspace_event_sequence_invalid",
  );
  if (eventSequence !== operation.revision) {
    throw new ContractValidationError("workspace_event_sequence_mismatch");
  }
  return { operation, eventSequence };
}

export function parseListWorkspaceOperationsResponse(
  input: unknown,
  expected: Readonly<{
    threadId: string;
    query: WorkspaceOperationListQuery;
  }>,
): ListWorkspaceOperationsResponse {
  const query = parseWorkspaceOperationListQuery(expected.query);
  requireBoundedJson(
    input,
    WORKSPACE_CONTROL_LIMITS.maxListResponseBytes,
    "workspace_list_response_too_large",
  );
  const value = requireObject(input, "workspace_list_response_invalid");
  requireExactKeys(value, ["data", "nextAfterExecutionId"]);
  if (!Array.isArray(value.data) || value.data.length > query.limit) {
    throw new ContractValidationError("workspace_list_response_invalid");
  }
  const data = value.data.map((operation) =>
    parseWorkspaceOperationView(operation, { threadId: expected.threadId }),
  );
  let previous = query.afterExecutionId;
  for (const operation of data) {
    if (
      previous !== null &&
      compareUtf8(previous, operation.executionId) >= 0
    ) {
      throw new ContractValidationError("workspace_list_order_invalid");
    }
    previous = operation.executionId;
  }
  const nextAfterExecutionId =
    value.nextAfterExecutionId === null
      ? null
      : parseWorkspaceExecutionId(value.nextAfterExecutionId);
  if (
    nextAfterExecutionId !== null &&
    (data.length === 0 || nextAfterExecutionId !== data.at(-1)?.executionId)
  ) {
    throw new ContractValidationError("workspace_list_cursor_invalid");
  }
  return { data, nextAfterExecutionId };
}

export function parseWorkspaceOperationEventView(
  input: unknown,
  expected: Readonly<{
    threadId: string;
    executionId: string;
    afterSequence?: number;
  }>,
): WorkspaceOperationEventView {
  const value = requireObject(input, "workspace_event_invalid");
  requireExactKeys(value, [
    "data",
    "executionId",
    "schemaVersion",
    "sequence",
    "threadId",
    "type",
  ]);
  if (
    value.schemaVersion !== "crewon.workspace-operation-event.v0" ||
    value.type !== "workspace.operation.replaced"
  ) {
    throw new ContractValidationError("workspace_event_invalid");
  }
  const threadId = parseThreadId(value.threadId);
  const executionId = parseWorkspaceExecutionId(value.executionId);
  if (
    threadId !== parseThreadId(expected.threadId) ||
    executionId !== parseWorkspaceExecutionId(expected.executionId)
  ) {
    throw new ContractValidationError("workspace_event_identity_mismatch");
  }
  const sequence = requirePositiveInteger(
    value.sequence,
    "workspace_event_sequence_invalid",
  );
  if (
    expected.afterSequence !== undefined &&
    sequence !==
      requireNonnegativeInteger(
        expected.afterSequence,
        "workspace_event_cursor_invalid",
      ) +
        1
  ) {
    throw new ContractValidationError("workspace_event_sequence_gap");
  }
  const data = requireObject(value.data, "workspace_event_data_invalid");
  requireExactKeys(data, ["operation"]);
  const operation = parseWorkspaceOperationView(data.operation, {
    threadId,
    executionId,
  });
  if (sequence !== operation.revision) {
    throw new ContractValidationError("workspace_event_sequence_mismatch");
  }
  return {
    schemaVersion: "crewon.workspace-operation-event.v0",
    threadId,
    executionId,
    sequence,
    type: "workspace.operation.replaced",
    data: { operation },
  };
}

export function parseWorkspaceOperationLastEventSequence(
  input: unknown,
): number {
  if (input === undefined) return 0;
  if (typeof input !== "string" || !/^(0|[1-9][0-9]*)$/u.test(input)) {
    throw new ContractValidationError("workspace_last_event_id_invalid");
  }
  const value = Number(input);
  return requireNonnegativeInteger(value, "workspace_last_event_id_invalid");
}

export function isWorkspaceOperationTerminal(
  operation: WorkspaceOperationView,
): boolean {
  return operation.status !== "pending";
}

function parseCompletedResult(input: unknown): WorkspaceCompletedResultView {
  requireBoundedJson(
    input,
    WORKSPACE_CONTROL_LIMITS.maxResultBytes,
    "workspace_result_too_large",
  );
  const value = requireObject(input, "workspace_result_invalid");
  requireExactKeys(value, ["entries", "status", "truncated"]);
  if (
    value.status !== "completed" ||
    typeof value.truncated !== "boolean" ||
    !Array.isArray(value.entries) ||
    value.entries.length > WORKSPACE_CONTROL_LIMITS.maxEntries
  ) {
    throw new ContractValidationError("workspace_result_invalid");
  }
  const entries = value.entries.map(parseWorkspaceListEntry);
  for (let index = 1; index < entries.length; index += 1) {
    if (compareUtf8(entries[index - 1]!.name, entries[index]!.name) >= 0) {
      throw new ContractValidationError("workspace_entries_order_invalid");
    }
  }
  return { status: "completed", entries, truncated: value.truncated };
}

function parseFailedResult(input: unknown): WorkspaceFailedResultView {
  const value = requireObject(input, "workspace_result_invalid");
  requireExactKeys(value, ["code", "retryable", "status"]);
  if (
    value.status !== "failed" ||
    typeof value.code !== "string" ||
    !/^[a-z0-9_.:-]{1,128}$/u.test(value.code) ||
    typeof value.retryable !== "boolean"
  ) {
    throw new ContractValidationError("workspace_result_invalid");
  }
  return { status: "failed", code: value.code, retryable: value.retryable };
}

function parseWorkspaceListEntry(input: unknown): WorkspaceListEntryView {
  const value = requireObject(input, "workspace_entry_invalid");
  requireExactKeys(value, ["kind", "name"]);
  if (
    typeof value.name !== "string" ||
    (value.kind !== "file" && value.kind !== "directory")
  ) {
    throw new ContractValidationError("workspace_entry_invalid");
  }
  const encoded = new TextEncoder().encode(value.name);
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
  if (
    encoded.byteLength < 1 ||
    encoded.byteLength > WORKSPACE_CONTROL_LIMITS.maxNameBytes ||
    decoded !== value.name ||
    value.name === "." ||
    value.name === ".." ||
    /[\\/\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value.name)
  ) {
    throw new ContractValidationError("workspace_entry_name_invalid");
  }
  return { name: value.name, kind: value.kind };
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index]! - rightBytes[index]!;
    }
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

function parseQueryInteger(
  input: unknown,
  defaultValue: number,
  maximum: number,
  code: string,
): number {
  if (input === undefined) return defaultValue;
  if (
    typeof input !== "number" &&
    (typeof input !== "string" || !/^[1-9][0-9]*$/u.test(input))
  ) {
    throw new ContractValidationError(code);
  }
  return requireIntegerInRange(Number(input), 1, maximum, code);
}

function requirePositiveInteger(input: unknown, code: string): number {
  return requireIntegerInRange(input, 1, Number.MAX_SAFE_INTEGER, code);
}

function requireNonnegativeInteger(input: unknown, code: string): number {
  return requireIntegerInRange(input, 0, Number.MAX_SAFE_INTEGER, code);
}

function requireIntegerInRange(
  input: unknown,
  minimum: number,
  maximum: number,
  code: string,
): number {
  if (
    !Number.isSafeInteger(input) ||
    Number(input) < minimum ||
    Number(input) > maximum
  ) {
    throw new ContractValidationError(code);
  }
  return Number(input);
}

function requireBoundedJson(input: unknown, maximum: number, code: string) {
  let encoded: Uint8Array;
  try {
    encoded = new TextEncoder().encode(JSON.stringify(input));
  } catch {
    throw new ContractValidationError(code);
  }
  if (encoded.byteLength > maximum) {
    throw new ContractValidationError(code);
  }
}

function requireObject(input: unknown, code: string): Record<string, unknown> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  ) {
    throw new ContractValidationError(code);
  }
  return input as Record<string, unknown>;
}

function requireExactKeys(
  input: Record<string, unknown>,
  expected: readonly string[],
) {
  const actual = Object.keys(input).sort();
  const keys = [...expected].sort();
  if (
    actual.length !== keys.length ||
    actual.some((key, index) => key !== keys[index])
  ) {
    throw new ContractValidationError("workspace_fields_invalid");
  }
}

function requireAllowedKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
) {
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new ContractValidationError("workspace_fields_invalid");
  }
}
