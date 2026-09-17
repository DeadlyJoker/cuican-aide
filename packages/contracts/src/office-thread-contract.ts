import type { components } from "./generated/control-api.ts";
import { ContractValidationError } from "./contract-validation-error.ts";
import { parseThreadId } from "./control-api-contract.ts";
import { parseOfficeVersionId } from "./office-control-contract.ts";
import {
  parseThreadCatalogQuery,
  parseThreadCatalogResponse,
} from "./thread-catalog-contract.ts";

export type OfficeThreadResponse =
  components["schemas"]["OfficeThreadResponse"];
export type OfficeThreadMutationResponse =
  components["schemas"]["OfficeThreadMutationResponse"];
export type BindOfficeThreadRequest =
  components["schemas"]["BindOfficeThreadRequest"];
export const MAX_OFFICE_THREAD_RESPONSE_BYTES = 32 * 1024;

export function parseCreateOfficeThreadRequest(
  value: unknown,
): Record<string, never> {
  exact(value, []);
  return {};
}

export function parseBindOfficeThreadRequest(
  value: unknown,
): BindOfficeThreadRequest {
  exact(value, ["threadId", "expectedRevision"]);
  parseThreadId(value.threadId);
  if (
    !Number.isSafeInteger(value.expectedRevision) ||
    Number(value.expectedRevision) < 1
  )
    fail();
  return {
    threadId: value.threadId as string,
    expectedRevision: value.expectedRevision as number,
  };
}

export function parseOfficeThreadResponse(
  value: unknown,
  officeVersionId: string,
): OfficeThreadResponse {
  exact(value, ["officeId", "officeVersionId", "thread"]);
  return snapshot(value, officeVersionId);
}

export function parseOfficeThreadMutationResponse(
  value: unknown,
  expected: { officeVersionId: string; operation: "create" | "bind" },
): OfficeThreadMutationResponse {
  exact(value, ["officeId", "officeVersionId", "thread", "disposition"]);
  const parsed = snapshot(value, expected.officeVersionId);
  if (
    parsed.thread === null ||
    (value.disposition !== "existing" &&
      value.disposition !==
        (expected.operation === "create" ? "created" : "bound"))
  )
    fail();
  return {
    ...parsed,
    thread: parsed.thread,
    disposition:
      value.disposition as OfficeThreadMutationResponse["disposition"],
  };
}

function snapshot(
  value: Record<string, unknown>,
  officeVersionId: string,
): OfficeThreadResponse {
  parseOfficeVersionId(value.officeId);
  if (value.officeVersionId !== officeVersionId) fail();
  if (value.thread === null)
    return {
      officeId: value.officeId as string,
      officeVersionId,
      thread: null,
    };
  if (!record(value.thread)) fail();
  const query = parseThreadCatalogQuery({
    status: value.thread.status,
    limit: 1,
    excludeForks: true,
  });
  const page = parseThreadCatalogResponse(
    {
      schemaVersion: "crewon.thread-catalog.v0",
      data: [value.thread],
      scannedCount: 1,
      olderCursor: null,
      newerCursor: null,
    },
    query,
  );
  return {
    officeId: value.officeId as string,
    officeVersionId,
    thread: page.data[0]!,
  };
}

function exact(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !record(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail();
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fail(): never {
  throw new ContractValidationError("office_thread_contract_invalid");
}
