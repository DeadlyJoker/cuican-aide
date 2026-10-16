import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowSchemaValue } from "./workflow-schema-value.ts";
import {
  workflowVerificationInstructionV1,
  hasWorkflowVerificationV1,
  visibleWorkflowVerificationInstruction,
  workflowVerificationTextError,
  workflowVerificationResultError,
  WORKFLOW_VERIFICATION_CONTRACT_V1,
} from "./workflow-verification.ts";

test("frozen verification v1 keeps its published instruction bytes and visible author text", () => {
  const instruction = workflowVerificationInstructionV1("  Verify evidence  ");
  assert.equal(
    instruction,
    [
      "Verify evidence",
      "",
      WORKFLOW_VERIFICATION_CONTRACT_V1,
      "输出必须且只能包含一行独立 verdict；该行必须逐字等于 `VERDICT: PASS` 或 `VERDICT: FAIL`。",
      "verdict 使用大写英文和 ASCII 冒号，不得缩进、加前缀、加后缀或输出第二行 VERDICT。",
      "只有全部验收条件有可核验证据时才能 PASS；缺失、冲突或无法核验时必须 FAIL。",
    ].join("\n"),
  );
  assert.equal(
    visibleWorkflowVerificationInstruction(instruction),
    "Verify evidence",
  );
  assert.equal(hasWorkflowVerificationV1(instruction), true);
  assert.equal(hasWorkflowVerificationV1(instruction + " altered"), false);
});
test("v1 requires one exact standalone verdict in renderer text and the durable result envelope", () => {
  const instruction = workflowVerificationInstructionV1("Verify");
  const node = { kind: "verification" as const, instruction };
  for (const text of [
    "VERDICT: PASS",
    "Evidence checked\nVERDICT: PASS",
    "Evidence checked\r\nVERDICT: PASS\r\n",
  ]) {
    assert.equal(workflowVerificationTextError(instruction, text), null);
    assert.equal(workflowVerificationResultError(node, { result: text }), null);
  }
  for (const [text, error] of [
    ["VERDICT: FAIL", "control_workflow_verification_failed"],
    ["VERDICT: PASS\nVERDICT: FAIL", "control_workflow_verification_invalid"],
    ["verdict: pass", "control_workflow_verification_invalid"],
    [" VERDICT: PASS", "control_workflow_verification_invalid"],
    ["VERDICT: PASS extra", "control_workflow_verification_invalid"],
    ["Evidence looks fine", "control_workflow_verification_invalid"],
  ]) {
    assert.equal(workflowVerificationTextError(instruction, text!), error);
    assert.equal(
      workflowVerificationResultError(node, { result: text! }),
      error,
    );
  }
  const invalidValues: WorkflowSchemaValue[] = [
    null,
    "VERDICT: PASS",
    ["VERDICT: PASS"],
    { result: true },
    { topic: "VERDICT: PASS" },
  ];
  for (const value of invalidValues)
    assert.equal(
      workflowVerificationResultError(node, value),
      "control_workflow_verification_invalid",
    );
});
test("arbitrary structured verifiers keep their schemas and historical unmarked text keeps its original FAIL rule", () => {
  assert.equal(
    workflowVerificationResultError(
      { kind: "verification", instruction: "Verify JSON" },
      { topic: "verified" },
    ),
    null,
  );
  assert.equal(
    workflowVerificationResultError(
      {
        kind: "agent",
        instruction: workflowVerificationInstructionV1("Verify"),
      },
      { result: "VERDICT: FAIL" },
    ),
    null,
  );
  assert.equal(
    workflowVerificationTextError("Historical verifier", "No explicit verdict"),
    null,
  );
  assert.equal(
    workflowVerificationTextError(
      "Historical verifier",
      "VERDICT : FAIL because evidence is missing",
    ),
    "control_workflow_verification_failed",
  );
});
