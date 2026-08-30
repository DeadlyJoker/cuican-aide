import assert from "node:assert/strict";
import { test } from "node:test";

import type { RunExecutionService, WorkItemClaim } from "@crewon/application";
import type {
  ToolApprovalState,
  ToolExecutionReceiptState,
} from "@crewon/domain";
import type { ToolRuntimePort } from "@crewon/tool-broker";

import { replaceChangedToolApproval } from "./tool-approval-replacement.ts";

test("uses a different prepared receipt as the replacement identity", async () => {
  const receipt = { actionDigest: "sha256:new", status: "prepared" };
  const replacement = { approvalId: "approval-new" };
  const seen: string[] = [];
  const execution = {
    async loadToolApprovalReplacementReceipt(
      _claim: WorkItemClaim,
      _current: ToolApprovalState,
      call: { callId: string },
    ) {
      seen.push(call.callId);
      return call.callId === "call-new"
        ? (receipt as ToolExecutionReceiptState)
        : null;
    },
    async replaceToolApproval(
      _claim: WorkItemClaim,
      _current: ToolApprovalState,
      selected: ToolExecutionReceiptState,
    ) {
      assert.equal(selected, receipt);
      return replacement as ToolApprovalState;
    },
  } as unknown as RunExecutionService;

  const result = await replaceChangedToolApproval({
    execution,
    claim: {} as WorkItemClaim,
    current: {} as ToolApprovalState,
    calls: [toolCall("call-same"), toolCall("call-new")],
    toolRuntime: toolRuntime(),
    expiresAfterMs: 1_000,
    retryAfterMs: 10,
  });

  assert.equal(result, replacement);
  assert.deepEqual(seen, ["call-new"]);
});

test("does not replace when every durable candidate is the same action", async () => {
  let replacements = 0;
  const execution = {
    async loadToolApprovalReplacementReceipt() {
      return null;
    },
    async replaceToolApproval() {
      replacements += 1;
      throw new Error("unexpected replacement");
    },
  } as unknown as RunExecutionService;

  assert.equal(
    await replaceChangedToolApproval({
      execution,
      claim: {} as WorkItemClaim,
      current: {} as ToolApprovalState,
      calls: [toolCall("call-same")],
      toolRuntime: toolRuntime(),
      expiresAfterMs: null,
      retryAfterMs: 10,
    }),
    null,
  );
  assert.equal(replacements, 0);
});

function toolCall(callId: string) {
  return {
    schemaVersion: "crewon.agent-event.v0" as const,
    runId: "run-1",
    segmentId: "segment-1",
    sequence: 1,
    type: "tool.requested" as const,
    data: {
      callId,
      kind: "function" as const,
      name: "writer",
      input: "{}",
    },
  };
}

function toolRuntime(): ToolRuntimePort {
  return {
    definitions: () => [],
    executionPolicy: () => ({
      effect: "mutation",
      recovery: "reconcilable",
      resourceBindingId: null,
      credentialBindingId: null,
      executionTarget: { kind: "control", bindingId: "writer" },
      capability: "fixture.write",
      approvalRequirement: "perAction",
      limits: {
        timeoutMs: 1_000,
        maxOutputBytes: 1_000,
        maxArtifactBytes: 1_000,
      },
    }),
    execute: async () => {
      throw new Error("Provider must not be invoked during replacement");
    },
    reconcile: async () => {
      throw new Error("Provider must not be invoked during replacement");
    },
    cancel: async () => ({
      status: "canceled",
      executionId: "execution-1",
      providerReceiptId: null,
    }),
  };
}
