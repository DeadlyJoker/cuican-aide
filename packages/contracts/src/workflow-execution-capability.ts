import type { components } from "./generated/control-api.ts";
import { ContractValidationError } from "./contract-validation-error.ts";

/** Composed API support, not Worker liveness or permission to execute a request. */
export type WorkflowExecutionCapability =
  components["schemas"]["WorkflowExecutionCapability"];
export function parseWorkflowExecutionCapability(
  value: unknown,
): WorkflowExecutionCapability {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 4 ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !["version", "admission", "snapshots", "humanGates"].includes(key),
    )
  )
    invalid();
  const row: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
      invalid();
    row[String(key)] = descriptor.value;
  }
  if (
    row.version !== "v1" ||
    [row.admission, row.snapshots, row.humanGates].some(
      (item) => typeof item !== "boolean",
    )
  )
    invalid();
  return Object.freeze(row) as WorkflowExecutionCapability;
}
function invalid(): never {
  throw new ContractValidationError("workflow_execution_capability_invalid");
}
