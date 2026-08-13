import type { JsonValue } from "@crewon/contracts/runtime";
import type {
  OfficeDefinition,
  OfficeDelegation,
  RunState,
  ThreadState,
} from "@crewon/domain";

import type { WorkflowRunInputAuthority } from "./durable-queue-port.ts";
import type { RunRoute } from "./run-commands.ts";
import type {
  CommitRunInput,
  CommitRunResult,
  IdempotencyDescriptor,
} from "./run-store-port.ts";
import type { WorkflowVersionAsset } from "./workflow-version-store-port.ts";

export type StartOfficeDelegationCommand = Readonly<{
  kind: "officeDelegation.start";
  idempotencyKey: string;
  officeVersionId: string;
  workflowVersionId: string;
  threadId: string;
  input: JsonValue;
}>;

export type OfficeDelegationListCursor = Readonly<{
  createdAt: string;
  delegationId: string;
}>;

export type ListOfficeDelegationsQuery = Readonly<{
  officeVersionId: string;
  before: OfficeDelegationListCursor | null;
  limit: number;
}>;

export type OfficeDelegationAdmissionAuthority = Readonly<{
  office: OfficeDefinition;
  workflowVersion: WorkflowVersionAsset;
  thread: ThreadState;
  route: RunRoute;
}>;

export type OfficeDelegationPreparation = Readonly<{
  delegation: OfficeDelegation;
  runCommit: CommitRunInput;
  workflowInputValue: WorkflowRunInputAuthority;
}>;

export type CommitOfficeDelegationStartInput = Readonly<{
  tenantId: string;
  spaceId: string;
  officeVersionId: string;
  workflowVersionId: string;
  threadId: string;
  workflowInput: JsonValue;
  idempotency: IdempotencyDescriptor;
  /** Runs only after the Store's durable receipt probe misses. */
  resolveCandidateRoute: () => Promise<RunRoute>;
  /**
   * Runs inside the fresh admission transaction after the Store loads exact
   * Office, WorkflowVersion, and active Thread authorities and revalidates the
   * candidate route against current release/deployment state.
   */
  prepare: (
    authority: OfficeDelegationAdmissionAuthority,
  ) => OfficeDelegationPreparation;
}>;

export type OfficeDelegationStartResult = Readonly<{
  disposition: "committed" | "replayed";
  delegation: OfficeDelegation;
  run: CommitRunResult;
}>;

export type OfficeDelegationListItem = Readonly<{
  delegation: OfficeDelegation;
  run: RunState;
}>;

export type ListOfficeDelegationsResult = Readonly<{
  items: readonly OfficeDelegationListItem[];
  next: OfficeDelegationListCursor | null;
}>;

export class OfficeDelegationStoreError extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "OfficeDelegationStoreError";
    this.code = code;
  }
}

/**
 * Receipt-first atomic authority for explicit Office Workflow delegation.
 *
 * A matching receipt returns the original Delegation and Run without calling
 * either callback. A fingerprint mismatch conflicts. Fresh admission must, in
 * one transaction, load the exact tenant/space OfficeVersion, immutable and
 * digest-valid WorkflowVersion, and active Thread; revalidate the candidate
 * route; call `prepare` once; then atomically persist its input value, canonical
 * Workflow Run, scheduler WorkItem, outbox, OfficeDelegation, and receipt.
 * Preparation failures roll back every write.
 */
export interface OfficeDelegationStore {
  commitOfficeDelegationStart(
    input: CommitOfficeDelegationStartInput,
  ): Promise<OfficeDelegationStartResult>;
  listOfficeDelegations(input: {
    tenantId: string;
    spaceId: string;
    officeVersionId: string;
    before: OfficeDelegationListCursor | null;
    limit: number;
  }): Promise<ListOfficeDelegationsResult>;
}
