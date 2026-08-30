import type { ToolApprovalState } from "@crewon/domain";

import { RunStoreError, type CommitRunInput } from "./run-store-port.ts";
import type { ReplaceToolApprovalInput } from "./tool-approval-store-port.ts";

export function validateToolApprovalReplacement(
  current: ToolApprovalState,
  input: ReplaceToolApprovalInput,
): void {
  const replacement = input.replacement;
  if (
    current.status !== "required" ||
    current.actionDigest !== input.current.actionDigest ||
    current.tenantId !== replacement.tenantId ||
    current.spaceId !== replacement.spaceId ||
    current.runId !== replacement.runId ||
    current.workItemId !== replacement.workItemId ||
    current.actionDigest === replacement.actionDigest ||
    current.approvalId === replacement.approvalId
  ) {
    throw new RunStoreError("tool_approval_replacement_mismatch");
  }
}

export function validateToolApprovalReplacementCommit(
  current: ToolApprovalState,
  replacement: ToolApprovalState,
  commit: CommitRunInput,
): void {
  const [resumed, required] = commit.events;
  if (
    commit.tenantId !== current.tenantId ||
    commit.events.length !== 2 ||
    commit.workItems.length !== 0 ||
    resumed?.type !== "run.resumed" ||
    resumed.identity.runId !== current.runId ||
    resumed.data.reasonCode !== "tool_approval_superseded" ||
    required?.type !== "run.approval.required" ||
    required.identity.runId !== current.runId ||
    required.data.approvalId !== replacement.approvalId ||
    required.data.actionDigest !== replacement.actionDigest
  ) {
    throw new RunStoreError("tool_approval_run_commit_mismatch");
  }
}

export function validateToolApprovalReplacementReplay(
  current: ToolApprovalState,
  existing: ToolApprovalState,
  input: ReplaceToolApprovalInput,
): void {
  if (
    current.status !== "superseded" ||
    current.terminalReasonCode !== "action_replaced" ||
    current.actionDigest !== input.current.actionDigest ||
    existing.status !== "required" ||
    JSON.stringify(existing) !== JSON.stringify(input.replacement)
  ) {
    throw new RunStoreError("tool_approval_replacement_replay_mismatch");
  }
}
