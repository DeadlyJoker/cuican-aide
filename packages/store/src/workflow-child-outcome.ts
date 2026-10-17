import {
  workflowVerificationResultError,
  type RunState,
  type WorkflowValueSchema,
  type WorkflowNodeDefinition,
} from "@crewon/domain";
import {
  RunStoreError,
  isWorkflowChildPreparationFailureCode,
} from "@crewon/application";
import { workflowNodeValue } from "./workflow-node-value.ts";

/** Protocol corruption is a storage failure; a known response violating its schema is terminal. */
export function workflowChildOutcome(input: {
  child: RunState;
  canceledByParent: boolean;
  output: string | null;
  outputError?: unknown;
  schema: WorkflowValueSchema;
  node: Pick<WorkflowNodeDefinition, "kind" | "instruction">;
}) {
  if (!["completed", "failed", "canceled"].includes(input.child.status))
    throw new RunStoreError("workflow_child_not_terminal");
  const canceled = input.child.status === "canceled" && input.canceledByParent;
  let failureCode =
    input.child.status === "completed" || canceled
      ? null
      : input.child.status === "canceled"
        ? "workflow_child_canceled"
        : isWorkflowChildPreparationFailureCode(input.child.failure?.code)
          ? input.child.failure!.code
          : "workflow_child_failed";
  let value: ReturnType<typeof workflowNodeValue> | null = null;
  if (input.child.status === "completed") {
    try {
      if (input.outputError !== undefined) throw input.outputError;
      if (typeof input.output !== "string")
        throw new RunStoreError("workflow_child_output_authority_corrupt");
      value = workflowNodeValue(JSON.parse(input.output), input.schema);
      failureCode = workflowVerificationResultError(input.node, value.value);
      if (failureCode !== null) value = null;
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (error instanceof Error &&
          "code" in error &&
          [
            "workflow_value_schema_mismatch",
            "workflow_node_value_limit",
            "workflow_child_output_limit",
            "command_non_json_value",
          ].includes(String(error.code)))
      )
        failureCode = "workflow_child_output_invalid";
      else throw error;
    }
  }
  return {
    status: canceled
      ? ("canceled" as const)
      : failureCode === null
        ? ("completed" as const)
        : ("failed" as const),
    failureCode,
    value,
  };
}
