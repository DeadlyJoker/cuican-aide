import type { WorkflowNodeDefinition } from "./workflow-version.ts";
import type { WorkflowSchemaValue } from "./workflow-schema-value.ts";

/** Existing published text contract; changing these bytes would change frozen definitions. */
export const WORKFLOW_VERIFICATION_CONTRACT_V1 =
  "[Control Workflow · verification-contract:v1]" as const;
const instructionV1 = [
  WORKFLOW_VERIFICATION_CONTRACT_V1,
  "输出必须且只能包含一行独立 verdict；该行必须逐字等于 `VERDICT: PASS` 或 `VERDICT: FAIL`。",
  "verdict 使用大写英文和 ASCII 冒号，不得缩进、加前缀、加后缀或输出第二行 VERDICT。",
  "只有全部验收条件有可核验证据时才能 PASS；缺失、冲突或无法核验时必须 FAIL。",
].join("\n");
export function workflowVerificationInstructionV1(instruction: string): string {
  return `${instruction.trim()}\n\n${instructionV1}`;
}
export function hasWorkflowVerificationV1(instruction: string): boolean {
  return instruction.endsWith(`\n\n${instructionV1}`);
}
export function visibleWorkflowVerificationInstruction(
  instruction: string,
): string {
  return hasWorkflowVerificationV1(instruction)
    ? instruction.slice(0, -`\n\n${instructionV1}`.length)
    : instruction;
}

/** Same user-visible text semantics for old renderer records and durable node settlement. */
export function workflowVerificationTextError(
  instruction: string,
  output: string,
): string | null {
  if (!hasWorkflowVerificationV1(instruction))
    return /^VERDICT\s*:\s*FAIL\b/imu.test(output)
      ? "control_workflow_verification_failed"
      : null;
  const candidates = output
    .split(/\n/u)
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line) => /^VERDICT\b/iu.test(line.trim()));
  if (candidates.length !== 1) return "control_workflow_verification_invalid";
  if (candidates[0] === "VERDICT: PASS") return null;
  return candidates[0] === "VERDICT: FAIL"
    ? "control_workflow_verification_failed"
    : "control_workflow_verification_invalid";
}

/** Only the explicitly frozen v1 contract opts into textual verification; arbitrary JSON schemas are unchanged. */
export function workflowVerificationResultError(
  node: Pick<WorkflowNodeDefinition, "kind" | "instruction">,
  value: WorkflowSchemaValue,
): string | null {
  if (
    node.kind !== "verification" ||
    !hasWorkflowVerificationV1(node.instruction)
  )
    return null;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("result" in value) ||
    typeof value.result !== "string"
  )
    return "control_workflow_verification_invalid";
  return workflowVerificationTextError(node.instruction, value.result);
}
