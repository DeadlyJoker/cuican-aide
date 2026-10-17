import type { components } from "./generated/control-api.ts";
import { ContractValidationError } from "./contract-validation-error.ts";

export const WORKFLOW_RECOVERY_CONTEXT_HEADER = "x-crewon-workflow-context";
export type WorkflowRecoveryContextResponse =
  components["schemas"]["WorkflowRecoveryContextResponse"];

/** A comparison token, never a credential or permission grant. */
export function parseWorkflowRecoveryContextId(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value))
    throw new ContractValidationError("workflow_recovery_context_invalid");
  return value;
}
export function parseWorkflowRecoveryContextResponse(
  value: unknown,
): WorkflowRecoveryContextResponse {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== 2
  )
    invalid();
  const version = Object.getOwnPropertyDescriptor(value, "version"),
    context = Object.getOwnPropertyDescriptor(value, "contextId");
  if (
    !version?.enumerable ||
    !Object.hasOwn(version, "value") ||
    version.value !== "v1" ||
    !context?.enumerable ||
    !Object.hasOwn(context, "value")
  )
    invalid();
  return Object.freeze({
    version: "v1",
    contextId:
      context.value === null
        ? null
        : parseWorkflowRecoveryContextId(context.value),
  });
}
function invalid(): never {
  throw new ContractValidationError("workflow_recovery_context_invalid");
}
