import type { JsonValue } from "@crewon/contracts/runtime";

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
   * Resolves the server-owned route candidate outside a write transaction.
   * Implementations must receipt-probe first and must not invoke this callback
   * or `prepare` for a replay. After a miss, they await this callback before
   * opening a fresh write transaction, recheck the receipt, then revalidate
   * the candidate against current release and deployment authorities.
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

/**
 * Atomic authority for admitting a Workflow Run.
 *
 * Implementations must inspect the durable idempotency receipt before any
 * mutable admission state. A matching receipt returns its exact original
 * authority and Run; a fingerprint mismatch conflicts. Otherwise, in one
 * transaction, implementations must validate the tenant/space Thread, load
 * the immutable tenant WorkflowVersion, and revalidate the server-owned route
 * candidate plus every AgentVersion referenced by the Workflow against the
 * tenant's currently active release with an exact immutable
 * deployment content digest, authority, and workspace binding. This release
 * and deployment check must use the same transaction snapshot as admission.
 * The candidate callback runs only after an initial receipt miss and outside
 * the write transaction; a concurrent winner is checked again after the write
 * transaction begins. Implementations then invoke `prepare` exactly once only
 * for the fresh winner while the transaction remains open,
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
