import { validateThreadState, type ThreadState } from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import { canonicalJson } from "./canonical-json.ts";
import type { IdempotencyDescriptor } from "./run-store-port.ts";
import type {
  SpaceScopedThreadStore,
  ThreadStore,
} from "./thread-store-port.ts";
import { WorkspaceListCommandCoordinator } from "./workspace-list-command-coordinator.ts";
import {
  DELIVERY_COMMIT_MARGIN_MS,
  mapStoreError,
  mutation,
  operationRecord,
  phaseForCommand,
  requireIdentity,
  unknownOutcome,
  validateActor,
  validateExecuteCommand,
  validateExistingCommand,
} from "./workspace-list-command-validation.ts";
import { WorkspaceListResultValidator } from "./workspace-list-result-validator.ts";
import { WorkspaceListReadCoordinator } from "./workspace-list-read-coordinator.ts";
import {
  validateWorkspaceDeliveryAttempt,
  WorkspaceListDispatchError,
  type WorkspaceDeliveryAttempt,
} from "./workspace-delivery-store-port.ts";
import {
  WORKSPACE_OPERATION_LIMITS,
  canonicalWorkspaceListAction,
  canonicalWorkspaceListDispatchCommand,
  canonicalWorkspaceOperationResult,
  validateFrozenWorkspaceListCommand,
  validateWorkspaceListResolution,
  validateWorkspaceOperationMutationResult,
  validateWorkspaceOperationPreparationResult,
  validateWorkspaceOperationRecord,
  validateWorkspaceDeliverySettlementResult,
  WorkspaceListCommandFactoryError,
  type FrozenWorkspaceListCommand,
  type WorkspaceListCommandFactoryPort,
  type WorkspaceListDispatcherPort,
  type WorkspaceListOperationPhase,
  type WorkspaceListResolution,
  type WorkspaceOperationMutationResult,
  type WorkspaceOperationPreparationResult,
  type WorkspaceOperationRecord,
  type WorkspaceOperationStore,
  type WorkspaceDeliverySettlementResult,
} from "./workspace-operation-store-port.ts";

export type ExecuteWorkspaceListCommand = Readonly<{
  kind: "workspaceList.execute";
  idempotencyKey: string;
  threadId: string;
  expectedRevision: number;
  maxEntries: number;
}>;

export type ReconcileWorkspaceListCommand = Readonly<{
  kind: "workspaceList.reconcile";
  idempotencyKey: string;
  threadId: string;
  executionId: string;
  expectedOperationRevision: number;
}>;

export type CancelWorkspaceListCommand = Readonly<{
  kind: "workspaceList.cancel";
  idempotencyKey: string;
  threadId: string;
  executionId: string;
  expectedOperationRevision: number;
}>;

type WorkspaceApplicationStore = ThreadStore &
  SpaceScopedThreadStore &
  WorkspaceOperationStore;

/** Receipt-first workspace list orchestration without concrete Device dependencies. */
export class WorkspaceListApplicationService {
  readonly #store: WorkspaceApplicationStore;
  readonly #digester: ContentDigester;
  readonly #commandCoordinator: WorkspaceListCommandCoordinator;
  readonly #dispatcher: WorkspaceListDispatcherPort;
  readonly #deliveryOwnerId: string;
  readonly #deliveryLeaseDurationMs: number;
  readonly #resultValidator: WorkspaceListResultValidator;
  readonly #reads: WorkspaceListReadCoordinator;

  constructor(dependencies: {
    store: WorkspaceApplicationStore;
    authorization: AuthorizationPort;
    digester: ContentDigester;
    commands: WorkspaceListCommandFactoryPort;
    dispatcher: WorkspaceListDispatcherPort;
    deliveryOwnerId: string;
    deliveryLeaseDurationMs: number;
  }) {
    this.#store = dependencies.store;
    this.#digester = dependencies.digester;
    this.#commandCoordinator = new WorkspaceListCommandCoordinator(
      dependencies.authorization,
      dependencies.digester,
      dependencies.commands,
    );
    this.#dispatcher = dependencies.dispatcher;
    requireIdentity(dependencies.deliveryOwnerId, "delivery_owner_invalid");
    if (
      !Number.isSafeInteger(dependencies.deliveryLeaseDurationMs) ||
      dependencies.deliveryLeaseDurationMs <
        WORKSPACE_OPERATION_LIMITS.maxTimeoutMs + DELIVERY_COMMIT_MARGIN_MS ||
      dependencies.deliveryLeaseDurationMs > 5 * 60_000
    ) {
      throw new ApplicationError(
        "validation",
        "delivery_lease_duration_invalid",
      );
    }
    this.#deliveryOwnerId = dependencies.deliveryOwnerId;
    this.#deliveryLeaseDurationMs = dependencies.deliveryLeaseDurationMs;
    this.#resultValidator = new WorkspaceListResultValidator(this.#digester);
    this.#reads = new WorkspaceListReadCoordinator(this.#store);
  }

  async executeWorkspaceList(
    actor: ActorContext,
    command: ExecuteWorkspaceListCommand,
    signal: AbortSignal,
  ): Promise<WorkspaceOperationMutationResult> {
    validateActor(actor);
    validateExecuteCommand(command);
    await this.#commandCoordinator.authorize(actor, null);
    const idempotency = this.#resultValidator.idempotency(
      actor,
      "execute",
      command,
    );
    const replay = await this.#reads.loadReceipt(actor, "execute", idempotency);
    if (replay !== null) {
      const validated = this.#resultValidator.validatedResult(
        actor,
        command,
        replay,
      );
      await this.#commandCoordinator.authorize(
        actor,
        validated.operation.threadId,
      );
      return validated;
    }

    const thread = await this.#reads.loadThread(actor, command.threadId);
    await this.#commandCoordinator.authorize(actor, thread.threadId);
    if (thread.revision !== command.expectedRevision) {
      throw new ApplicationError("conflict", "revision_conflict");
    }
    const frozen = await this.#commandCoordinator.createFrozenCommand(
      actor,
      command,
      signal,
    );
    const operation = operationRecord(actor, command, frozen);
    const prepared = await this.#reads.storeCall(() =>
      this.#store.prepareWorkspaceOperation({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        threadFence: {
          threadId: command.threadId,
          expectedRevision: command.expectedRevision,
        },
        idempotency,
        operation,
      }),
    );
    const validated = this.#resultValidator.validatedPreparation(
      actor,
      command,
      prepared,
      operation,
    );
    if (validated.disposition === "replayed") return mutation(validated);
    return this.#deliver(actor, command, validated, signal);
  }

  reconcileWorkspaceList(
    actor: ActorContext,
    command: ReconcileWorkspaceListCommand,
    signal: AbortSignal,
  ): Promise<WorkspaceOperationMutationResult> {
    return this.#operateExisting(actor, command, "reconcile", signal);
  }

  cancelWorkspaceList(
    actor: ActorContext,
    command: CancelWorkspaceListCommand,
    signal: AbortSignal,
  ): Promise<WorkspaceOperationMutationResult> {
    return this.#operateExisting(actor, command, "cancel", signal);
  }

  async #operateExisting(
    actor: ActorContext,
    command: ReconcileWorkspaceListCommand | CancelWorkspaceListCommand,
    phase: "reconcile" | "cancel",
    signal: AbortSignal,
  ): Promise<WorkspaceOperationMutationResult> {
    validateActor(actor);
    validateExistingCommand(command, phase);
    await this.#commandCoordinator.authorize(actor, null);
    const idempotency = this.#resultValidator.idempotency(
      actor,
      phase,
      command,
    );
    const replay = await this.#reads.loadReceipt(actor, phase, idempotency);
    if (replay !== null) {
      const validated = this.#resultValidator.validatedResult(
        actor,
        command,
        replay,
      );
      await this.#commandCoordinator.authorize(
        actor,
        validated.operation.threadId,
      );
      return validated;
    }

    const operation = await this.#reads.storeCall(() =>
      this.#store.loadWorkspaceOperation({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        threadId: command.threadId,
        executionId: command.executionId,
      }),
    );
    if (operation === null) {
      throw new ApplicationError("notFound", "workspace_operation_not_found");
    }
    const validatedOperation = validateWorkspaceOperationRecord(operation);
    this.#resultValidator.validateScope(actor, command, validatedOperation);
    await this.#commandCoordinator.authorize(
      actor,
      validatedOperation.threadId,
    );
    if (validatedOperation.revision !== command.expectedOperationRevision) {
      throw new ApplicationError(
        "conflict",
        "workspace_operation_revision_conflict",
      );
    }
    const prepared = await this.#reads.storeCall(() =>
      this.#store.prepareWorkspaceOperationAction({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        threadId: command.threadId,
        executionId: command.executionId,
        expectedOperationRevision: command.expectedOperationRevision,
        phase,
        idempotency,
      }),
    );
    const validated = this.#resultValidator.validatedPreparation(
      actor,
      command,
      prepared,
      validatedOperation,
    );
    if (
      validated.disposition === "replayed" ||
      validated.deliveryAttempt === null
    ) {
      return mutation(validated);
    }
    return this.#deliver(actor, command, validated, signal);
  }

  async #dispatch(
    phase: WorkspaceListOperationPhase,
    operation: WorkspaceOperationRecord,
    attempt: WorkspaceDeliveryAttempt,
    signal: AbortSignal,
  ) {
    if (attempt.status !== "leased" || attempt.lease === null) {
      throw new ApplicationError(
        "internal",
        "workspace_delivery_lease_invalid",
      );
    }
    try {
      return validateWorkspaceListResolution(
        await this.#dispatcher[phase](operation, attempt.lease, signal),
        operation.command,
      );
    } catch (error) {
      throw error instanceof WorkspaceListDispatchError
        ? error
        : new WorkspaceListDispatchError("possiblySent", {
            cause: error instanceof Error ? error : undefined,
          });
    }
  }

  async #deliver(
    actor: ActorContext,
    command:
      | ExecuteWorkspaceListCommand
      | ReconcileWorkspaceListCommand
      | CancelWorkspaceListCommand,
    prepared: WorkspaceOperationPreparationResult,
    signal: AbortSignal,
  ): Promise<WorkspaceOperationMutationResult> {
    const pending = prepared.deliveryAttempt;
    if (pending === null || pending.status !== "pending") {
      throw new ApplicationError(
        "internal",
        "workspace_delivery_attempt_invalid",
      );
    }
    const leased = validateWorkspaceDeliveryAttempt(
      await this.#reads.storeCall(() =>
        this.#store.claimWorkspaceOperationDelivery({
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          threadId: prepared.operation.threadId,
          executionId: prepared.operation.executionId,
          attemptNumber: pending.attemptNumber,
          operationRevision: prepared.operation.revision,
          phase: pending.phase,
          ownerId: this.#deliveryOwnerId,
          leaseDurationMs: this.#deliveryLeaseDurationMs,
        }),
      ),
    );
    if (
      leased.status !== "leased" ||
      leased.lease === null ||
      leased.lease.epoch !== 1 ||
      canonicalJson(leased) !==
        canonicalJson({
          ...pending,
          status: "leased",
          lease: leased.lease,
          settlement: null,
        })
    ) {
      throw new ApplicationError(
        "internal",
        "workspace_delivery_lease_invalid",
      );
    }
    if (
      leased.phase !== phaseForCommand(command) ||
      leased.actionDigest !== prepared.operation.command.actionDigest ||
      leased.commandDigest !== prepared.operation.command.commandDigest ||
      leased.lease.ownerId !== this.#deliveryOwnerId ||
      Date.parse(leased.lease.expiresAt) - Date.parse(leased.lease.leasedAt) <
        prepared.operation.command.limits.timeoutMs + DELIVERY_COMMIT_MARGIN_MS
    ) {
      throw new ApplicationError(
        "internal",
        "workspace_delivery_lease_invalid",
      );
    }
    let resolution: WorkspaceListResolution;
    try {
      resolution = await this.#dispatch(
        leased.phase,
        prepared.operation,
        leased,
        signal,
      );
    } catch (error) {
      if (
        error instanceof WorkspaceListDispatchError &&
        error.certainty === "notSent"
      ) {
        return this.#abandonDelivery(actor, prepared, leased);
      }
      return this.#settleDelivery(
        actor,
        command,
        prepared.operation,
        leased,
        unknownOutcome(prepared.operation),
      );
    }
    return this.#settleDelivery(
      actor,
      command,
      prepared.operation,
      leased,
      resolution,
    );
  }

  async #abandonDelivery(
    actor: ActorContext,
    prepared: WorkspaceOperationPreparationResult,
    leased: WorkspaceDeliveryAttempt,
  ): Promise<WorkspaceOperationMutationResult> {
    const operation = prepared.operation;
    if (leased.status !== "leased" || leased.lease === null) {
      throw new ApplicationError(
        "internal",
        "workspace_delivery_lease_invalid",
      );
    }
    const abandoned = validateWorkspaceDeliveryAttempt(
      await this.#reads.storeCall(() =>
        this.#store.abandonWorkspaceOperationDelivery({
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          threadId: operation.threadId,
          executionId: operation.executionId,
          operationRevision: operation.revision,
          deliveryLease: leased.lease!,
          reason: "notSent",
        }),
      ),
    );
    if (
      abandoned.status !== "settled" ||
      abandoned.settlement?.kind !== "abandoned" ||
      abandoned.settlement.resolutionStatus !== null ||
      abandoned.settlement.resultRevision !== operation.revision ||
      abandoned.settlement.resultDigest !==
        this.#digester.sha256(canonicalWorkspaceOperationResult(operation)) ||
      canonicalJson(abandoned) !==
        canonicalJson({
          ...leased,
          status: "settled",
          settlement: abandoned.settlement,
        })
    ) {
      throw new ApplicationError(
        "internal",
        "workspace_delivery_abandon_invalid",
      );
    }
    return mutation(prepared);
  }

  async #settleDelivery(
    actor: ActorContext,
    command:
      | ExecuteWorkspaceListCommand
      | ReconcileWorkspaceListCommand
      | CancelWorkspaceListCommand,
    previous: WorkspaceOperationRecord,
    leased: WorkspaceDeliveryAttempt,
    resolution: WorkspaceListResolution,
  ): Promise<WorkspaceOperationMutationResult> {
    if (leased.status !== "leased" || leased.lease === null) {
      throw new ApplicationError(
        "internal",
        "workspace_delivery_lease_invalid",
      );
    }
    const settled = validateWorkspaceDeliverySettlementResult(
      await this.#reads.storeCall(() =>
        this.#store.settleWorkspaceOperationDelivery({
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          threadId: previous.threadId,
          executionId: previous.executionId,
          expectedOperationRevision: previous.revision,
          deliveryLease: leased.lease!,
          resolution,
        }),
      ),
    );
    return this.#resultValidator.validatedSettlement(
      actor,
      command,
      previous,
      leased,
      settled,
      resolution,
    );
  }
}
