import type { ActorContext } from "./authorization-port.ts";
import type { IdempotencyDescriptor } from "./run-store-port.ts";
import {
  type AbandonWorkspaceDeliveryInput,
  type ClaimWorkspaceDeliveryInput,
  type WorkspaceDeliveryAttempt,
  type WorkspaceDeliveryAttemptQuery,
  type WorkspaceDeliveryLease,
  type WorkspaceDeliveryPhase,
} from "./workspace-delivery-store-port.ts";

export const WORKSPACE_OPERATION_LIMITS = Object.freeze({
  maxEntries: 200,
  maxNameBytes: 255,
  maxOutputBytes: 64 * 1024,
  maxScannedEntries: 10_000,
  maxScannedNameBytes: 1024 * 1024,
  maxTimeoutMs: 30_000,
});

export const WORKSPACE_OPERATION_EVENT_PAGE_MAX_LIMIT = 100;
export const WORKSPACE_OPERATION_LIST_PAGE_MAX_LIMIT = 100;

export type WorkspaceListOperationPhase = WorkspaceDeliveryPhase;

export type WorkspaceListLimits = Readonly<{
  depth: 0;
  maxEntries: number;
  maxNameBytes: number;
  maxOutputBytes: number;
  maxScannedEntries: number;
  maxScannedNameBytes: number;
  timeoutMs: number;
}>;

export type FrozenWorkspaceListCommand = Readonly<{
  executionId: string;
  workspaceBindingId: string;
  incarnationId: string;
  runtimeBindingId: string;
  policySnapshotId: string;
  actionDigest: string;
  commandDigest: string;
  limits: WorkspaceListLimits;
}>;

export type WorkspaceListResolution =
  | Readonly<{
      status: "completed";
      executionId: string;
      actionDigest: string;
      commandDigest: string;
      providerReceiptId: string;
      entries: readonly Readonly<{
        name: string;
        kind: "file" | "directory";
      }>[];
      truncated: boolean;
    }>
  | Readonly<{
      status: "failed";
      executionId: string;
      actionDigest: string;
      commandDigest: string;
      providerReceiptId: string;
      code: string;
      retryable: boolean;
    }>
  | Readonly<{
      status: "canceled" | "unknownOutcome";
      executionId: string;
      actionDigest: string;
      commandDigest: string;
      providerReceiptId: string | null;
    }>;

export type WorkspaceOperationRecord = Readonly<{
  schemaVersion: "crewon.workspace-operation.v0";
  tenantId: string;
  spaceId: string;
  threadId: string;
  expectedThreadRevision: number;
  principalId: string;
  actorId: string;
  idempotencyKey: string;
  executionId: string;
  revision: number;
  status: "prepared" | WorkspaceListResolution["status"];
  command: FrozenWorkspaceListCommand;
  resolution: WorkspaceListResolution | null;
}>;

export type WorkspaceOperationMutationResult = Readonly<{
  disposition: "committed" | "replayed";
  operation: WorkspaceOperationRecord;
}>;

export type WorkspaceOperationLocator = Readonly<{
  tenantId: string;
  spaceId: string;
  threadId: string;
  executionId: string;
}>;

export type WorkspaceOperationSnapshot = Readonly<{
  operation: WorkspaceOperationRecord;
  eventSequence: number;
}>;

export type WorkspaceOperationEvent = Readonly<{
  sequence: number;
  operation: WorkspaceOperationRecord;
}>;

export type WorkspaceOperationEventQuery = WorkspaceOperationLocator &
  Readonly<{
    afterSequence: number;
    limit: number;
  }>;

export type WorkspaceOperationListQuery = Readonly<{
  tenantId: string;
  spaceId: string;
  threadId: string;
  afterExecutionId: string | null;
  limit: number;
}>;

export type WorkspaceOperationListPage = Readonly<{
  operations: readonly WorkspaceOperationRecord[];
  nextAfterExecutionId: string | null;
}>;

export type WorkspaceOperationPreparationResult =
  WorkspaceOperationMutationResult &
    Readonly<{ deliveryAttempt: WorkspaceDeliveryAttempt | null }>;

export type WorkspaceDeliverySettlementResult = Readonly<{
  outcome: "committed" | "replayed" | "lostRace";
  operation: WorkspaceOperationRecord;
  deliveryAttempt: WorkspaceDeliveryAttempt;
}>;

export type WorkspaceOperationReceiptQuery = Readonly<{
  tenantId: string;
  spaceId: string;
  phase: WorkspaceListOperationPhase;
  idempotency: IdempotencyDescriptor;
}>;

export type PrepareWorkspaceOperationInput = Readonly<{
  tenantId: string;
  spaceId: string;
  threadFence: Readonly<{
    threadId: string;
    expectedRevision: number;
  }>;
  idempotency: IdempotencyDescriptor;
  operation: WorkspaceOperationRecord;
}>;

export type CommitWorkspaceOperationResolutionInput = Readonly<{
  tenantId: string;
  spaceId: string;
  threadId: string;
  executionId: string;
  expectedOperationRevision: number;
  deliveryLease: WorkspaceDeliveryLease;
  resolution: WorkspaceListResolution;
}>;

export type PrepareWorkspaceOperationActionInput = Readonly<{
  tenantId: string;
  spaceId: string;
  threadId: string;
  executionId: string;
  expectedOperationRevision: number;
  phase: "reconcile" | "cancel";
  idempotency: IdempotencyDescriptor;
}>;

/** Durable workspace operation and per-action receipt authority. */
export interface WorkspaceOperationStore {
  loadWorkspaceOperationReceipt(
    query: WorkspaceOperationReceiptQuery,
  ): Promise<WorkspaceOperationMutationResult | null>;
  prepareWorkspaceOperation(
    input: PrepareWorkspaceOperationInput,
  ): Promise<WorkspaceOperationPreparationResult>;
  loadWorkspaceOperation(
    input: WorkspaceOperationLocator,
  ): Promise<WorkspaceOperationRecord | null>;
  loadWorkspaceOperationSnapshot(
    locator: WorkspaceOperationLocator,
  ): Promise<WorkspaceOperationSnapshot | null>;
  listWorkspaceOperationEvents(
    query: WorkspaceOperationEventQuery,
  ): Promise<readonly WorkspaceOperationEvent[]>;
  listWorkspaceOperations(
    query: WorkspaceOperationListQuery,
  ): Promise<WorkspaceOperationListPage>;
  prepareWorkspaceOperationAction(
    input: PrepareWorkspaceOperationActionInput,
  ): Promise<WorkspaceOperationPreparationResult>;
  claimWorkspaceOperationDelivery(
    input: ClaimWorkspaceDeliveryInput,
  ): Promise<WorkspaceDeliveryAttempt>;
  listWorkspaceOperationDeliveryAttempts(
    query: WorkspaceDeliveryAttemptQuery,
  ): Promise<readonly WorkspaceDeliveryAttempt[]>;
  abandonWorkspaceOperationDelivery(
    input: AbandonWorkspaceDeliveryInput,
  ): Promise<WorkspaceDeliveryAttempt>;
  settleWorkspaceOperationDelivery(
    input: CommitWorkspaceOperationResolutionInput,
  ): Promise<WorkspaceDeliverySettlementResult>;
}

/** Creates the frozen provider-neutral command after receipt miss and policy authorization. */
export class WorkspaceListCommandFactoryError extends Error {
  readonly kind: "unavailable" | "invalidAuthority";

  constructor(
    kind: "unavailable" | "invalidAuthority",
    options?: ErrorOptions,
  ) {
    super(`workspace_command_factory_${kind}`, options);
    this.name = "WorkspaceListCommandFactoryError";
    this.kind = kind;
  }
}

export interface WorkspaceListCommandFactoryPort {
  create(
    input: {
      actor: ActorContext;
      threadId: string;
      expectedThreadRevision: number;
      idempotencyKey: string;
      maxEntries: number;
    },
    signal: AbortSignal,
  ): Promise<FrozenWorkspaceListCommand>;
}

/** Dispatches only an already-frozen command; implementations may adapt N1 later. */
export interface WorkspaceListDispatcherPort {
  execute(
    operation: WorkspaceOperationRecord,
    lease: WorkspaceDeliveryLease,
    signal: AbortSignal,
  ): Promise<WorkspaceListResolution>;
  reconcile(
    operation: WorkspaceOperationRecord,
    lease: WorkspaceDeliveryLease,
    signal: AbortSignal,
  ): Promise<WorkspaceListResolution>;
  cancel(
    operation: WorkspaceOperationRecord,
    lease: WorkspaceDeliveryLease,
    signal: AbortSignal,
  ): Promise<WorkspaceListResolution>;
}

export * from "./workspace-operation-validation.ts";
