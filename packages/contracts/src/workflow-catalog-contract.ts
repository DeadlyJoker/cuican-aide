import type { components } from "./generated/control-api.ts";
import { ContractValidationError } from "./contract-validation-error.ts";
import {
  formatWorkflowVersionCursor,
  parseWorkflowVersionCatalogQuery,
} from "./control-api-contract.ts";
import { captureWorkflowControlJson } from "./workflow-control-json.ts";
export const MAX_WORKFLOW_CATALOG_RESPONSE_BYTES = 1024 * 1024;
export type WorkflowVersionCatalogResponse =
  components["schemas"]["ListWorkflowVersionsResponse"];
function fail(): never {
  throw new ContractValidationError("workflow_catalog_response_invalid");
}
function fields(value: unknown, expected: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== expected.sort().join()
  )
    fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number) {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    new TextEncoder().encode(value).byteLength > maximum ||
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      new TextEncoder().encode(value),
    ) !== value
  )
    fail();
  return value;
}
export function parseWorkflowVersionCatalogResponse(
  value: unknown,
  query: ReturnType<typeof parseWorkflowVersionCatalogQuery>,
): WorkflowVersionCatalogResponse {
  const { limit } = query;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) fail();
  const row = fields(
    captureWorkflowControlJson(value, MAX_WORKFLOW_CATALOG_RESPONSE_BYTES),
    ["data", "nextCursor"],
  );
  if (!Array.isArray(row.data) || row.data.length > limit) fail();
  let previous = query.after;
  const versions = new Set<string>();
  for (const entry of row.data) {
    const item = fields(entry, [
      "workflowId",
      "workflowVersionId",
      "contentDigest",
      "name",
      "description",
      "createdAt",
    ]);
    const workflowId = text(item.workflowId, 512),
      workflowVersionId = text(item.workflowVersionId, 512);
    if (
      ![workflowId, workflowVersionId].every((id) =>
        /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id),
      )
    )
      fail();
    if (
      previous &&
      (workflowId < previous.workflowId ||
        (workflowId === previous.workflowId &&
          workflowVersionId <= previous.workflowVersionId))
    )
      fail();
    if (versions.has(workflowVersionId)) fail();
    versions.add(workflowVersionId);
    previous = { workflowId, workflowVersionId };
    if (!text(item.name, 256).trim()) fail();
    text(item.description, 4096);
    if (
      typeof item.contentDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(item.contentDigest) ||
      typeof item.createdAt !== "string" ||
      !Number.isFinite(Date.parse(item.createdAt)) ||
      new Date(item.createdAt).toISOString() !== item.createdAt
    )
      fail();
  }
  if (
    row.nextCursor !== null &&
    (!previous ||
      row.data.length !== limit ||
      row.nextCursor !==
        formatWorkflowVersionCursor(
          previous.workflowId,
          previous.workflowVersionId,
        ))
  )
    fail();
  return row as WorkflowVersionCatalogResponse;
}
