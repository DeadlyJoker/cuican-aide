import { canonicalJson, RunStoreError } from "@crewon/application";
import {
  validateWorkflowSchemaValue,
  type WorkflowValueSchema,
  type WorkflowSchemaValue,
} from "@crewon/domain";
import { workflowAdmissionDigest } from "./workflow-run-admission-validation.ts";

export const MAX_WORKFLOW_NODE_VALUE_BYTES = 32768;

export function workflowNodeValue(
  input: unknown,
  schema: WorkflowValueSchema,
): { value: WorkflowSchemaValue; json: string; digest: string } {
  let nodes = 0;
  function visit(value: unknown, depth: number): void {
    if (++nodes > 4096 || depth > 16) invalid();
    if (typeof value === "string") {
      if (value.length > MAX_WORKFLOW_NODE_VALUE_BYTES) invalid();
      return;
    }
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "number"
    )
      return;
    if (!value || typeof value !== "object") invalid();
    if (Array.isArray(value)) {
      if (value.length > 256) invalid();
      for (const child of value) visit(child, depth + 1);
    } else {
      const keys = Object.keys(value);
      if (keys.length > 256) invalid();
      for (const key of keys) {
        if (key.length > 512) invalid();
        visit((value as Record<string, unknown>)[key], depth + 1);
      }
    }
  }
  visit(input, 0);
  const json = canonicalJson(input);
  if (Buffer.byteLength(json) > MAX_WORKFLOW_NODE_VALUE_BYTES) invalid();
  return {
    value: validateWorkflowSchemaValue(input, schema),
    json,
    digest: workflowAdmissionDigest.sha256(json),
  };
}

function invalid(): never {
  throw new RunStoreError("workflow_node_value_limit");
}
