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
  prepare: (authority: WorkflowRunAdmissionAuthority) => Readonly<{
    commit: CommitRunInput;
    workflowInputValue: WorkflowRunInputAuthority;
  }>;
}>;

export type CommitWorkflowRunStartResult = Readonly<{
  authority: WorkflowRunAdmissionAuthority;
  run: CommitRunResult;
}>;

/**
 * Atomic authority for admitting a Workflow Run.
 *
 * Implementations must inspect the durable idempotency receipt before any
 * mutable admission state. A matching receipt returns its exact original
 * authority and Run; a fingerprint mismatch conflicts. Otherwise, in one
 * transaction, implementations must validate the tenant/space Thread, load
 * the immutable tenant WorkflowVersion, resolve the server-owned execution
 * route, invoke `prepare` exactly once while the transaction remains open,
 * and atomically persist the returned immutable root input value with the
 * receipt, Run event, outbox message, and `run.execute` WorkItem. The Store
 * must verify the scheduler payload's exact `{valueId,valueDigest}` reference
 * against that value authority. Implementations must fail closed
 * rather than invoke `prepare` when any scope or authority check fails. The
 * callback parses and digest-verifies `definitionJson` and validates input
 * against its frozen `inputSchema`; an exception from it must roll back every
 * Run, receipt, outbox, and WorkItem write.
 */
export interface WorkflowRunAdmissionStore {
  commitWorkflowRunStart(
    input: CommitWorkflowRunStartInput,
  ): Promise<CommitWorkflowRunStartResult>;
}
