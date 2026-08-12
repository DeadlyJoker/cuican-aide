import type { JsonValue } from "@crewon/contracts";

import type { WorkflowRunInputAuthority } from "./durable-queue-port.ts";
import type { RunRoute } from "./run-commands.ts";
import type {
  CommitRunInput,
  CommitRunResult,
  IdempotencyDescriptor,
} from "./run-store-port.ts";
import type { WorkflowVersionAsset } from "./workflow-version-store-port.ts";

export type WorkflowRunAdmissionAuthority = Readonly<{
  workflowVersion: WorkflowVersionAsset;
  route: RunRoute;
}>;

export type CommitWorkflowRunStartInput = Readonly<{
  tenantId: string;
  spaceId: string;
  threadId: string;
  workflowVersionId: string;
  workflowInput: JsonValue;
  idempotency: IdempotencyDescriptor;
  /**
   * Resolves a server-owned candidate outside the SQLite write transaction.
   * Implementations must check a durable replay receipt before invoking it.
   */
  resolveCandidateRoute: () => Promise<RunRoute>;
  prepare: (authority: WorkflowRunAdmissionAuthority) => Readonly<{
    commit: CommitRunInput;
    workflowInputValue: WorkflowRunInputAuthority;
  }>;
}>;

export type CommitWorkflowRunStartResult = Readonly<{
  authority: WorkflowRunAdmissionAuthority;
  run: CommitRunResult;
}>;

/** Atomic authority for admitting a Workflow Run and its immutable root value. */
export interface WorkflowRunAdmissionStore {
  commitWorkflowRunStart(
    input: CommitWorkflowRunStartInput,
  ): Promise<CommitWorkflowRunStartResult>;
}
