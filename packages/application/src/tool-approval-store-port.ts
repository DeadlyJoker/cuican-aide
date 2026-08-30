import type { ToolApprovalDecision, ToolApprovalState } from "@crewon/domain";

import type { WorkItemLeaseInput } from "./durable-queue-port.ts";
import type { CommitRunInput, CommitRunResult } from "./run-store-port.ts";

export type ToolApprovalLocator = Readonly<{
  tenantId: string;
  approvalId: string;
}>;

export type ToolApprovalScopedLocator = ToolApprovalLocator &
  Readonly<{
    spaceId: string;
  }>;

export type ToolApprovalActionLocator = Readonly<{
  tenantId: string;
  runId: string;
  actionDigest: string;
}>;

export type ToolApprovalRunLocator = Readonly<{
  tenantId: string;
  runId: string;
}>;

export type RequireToolApprovalInput = Readonly<{
  lease: WorkItemLeaseInput;
  approval: ToolApprovalState;
  commit: CommitRunInput;
  retryAfterMs: number;
}>;

export type DecideToolApprovalInput = ToolApprovalLocator &
  Readonly<{
    expectedRevision: number;
    decision: ToolApprovalDecision;
    commit: CommitRunInput;
  }>;

export type ExpireToolApprovalInput = ToolApprovalLocator &
  Readonly<{
    lease: WorkItemLeaseInput;
    expectedRevision: number;
    occurredAt: string;
    commit: CommitRunInput;
  }>;

export type SupersedeToolApprovalInput = ExpireToolApprovalInput;

export type ReplaceToolApprovalInput = Readonly<{
  lease: WorkItemLeaseInput;
  current: ToolApprovalLocator &
    Readonly<{
      expectedRevision: number;
      actionDigest: string;
    }>;
  replacement: ToolApprovalState;
  occurredAt: string;
  commit: CommitRunInput;
  retryAfterMs: number;
}>;

export type ToolApprovalCommitResult = Readonly<{
  approval: ToolApprovalState;
  run: CommitRunResult;
}>;

/** Persists approval state, Run state and Work Item scheduling atomically. */
export interface ToolApprovalStore {
  loadToolApproval(
    locator: ToolApprovalLocator,
  ): Promise<ToolApprovalState | null>;
  /** User-facing read fence that excludes approvals from another space. */
  loadToolApprovalInSpace(
    locator: ToolApprovalScopedLocator,
  ): Promise<ToolApprovalState | null>;
  loadToolApprovalByAction(
    locator: ToolApprovalActionLocator,
  ): Promise<ToolApprovalState | null>;
  loadLatestToolApprovalForRun(
    locator: ToolApprovalRunLocator,
  ): Promise<ToolApprovalState | null>;
  requireToolApproval(
    input: RequireToolApprovalInput,
  ): Promise<ToolApprovalCommitResult>;
  decideToolApproval(
    input: DecideToolApprovalInput,
  ): Promise<ToolApprovalCommitResult>;
  expireToolApproval(
    input: ExpireToolApprovalInput,
  ): Promise<ToolApprovalCommitResult>;
  supersedeToolApproval(
    input: SupersedeToolApprovalInput,
  ): Promise<ToolApprovalCommitResult>;
  replaceToolApproval(
    input: ReplaceToolApprovalInput,
  ): Promise<ToolApprovalCommitResult>;
}
