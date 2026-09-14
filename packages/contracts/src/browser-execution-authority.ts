import { ContractValidationError } from "./contract-validation-error.ts";
import type { components } from "./generated/control-api.ts";

export type BrowserExecutionAuthorityResponse =
  components["schemas"]["BrowserExecutionAuthorityResponse"];

/** Authenticated Run facts only. This response does not create a browser grant. */
export function parseBrowserExecutionAuthorityResponse(
  input: unknown,
  expectedRunId?: string,
): BrowserExecutionAuthorityResponse {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).sort().join() !==
    "cancelRequested,revision,runId,schemaVersion,status,threadId,workspaceBindingId"
  )
    invalid();
  if (value.schemaVersion !== "crewon.browser-execution-authority.v1")
    invalid();
  for (const id of [value.runId, value.threadId])
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id)
    )
      invalid();
  if (expectedRunId !== undefined && value.runId !== expectedRunId) invalid();
  if (
    value.workspaceBindingId !== null &&
    (typeof value.workspaceBindingId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value.workspaceBindingId))
  )
    invalid();
  if (
    typeof value.status !== "string" ||
    ![
      "queued",
      "running",
      "waitingApproval",
      "suspended",
      "reconciling",
      "completed",
      "failed",
      "canceled",
    ].includes(value.status) ||
    typeof value.cancelRequested !== "boolean" ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1
  )
    invalid();
  if (
    (value.status === "canceled" && value.cancelRequested !== true) ||
    (["completed", "failed"].includes(value.status) &&
      value.cancelRequested !== false)
  )
    invalid();
  return structuredClone(value) as BrowserExecutionAuthorityResponse;
}
function invalid(): never {
  throw new ContractValidationError("browser_execution_authority_invalid");
}
