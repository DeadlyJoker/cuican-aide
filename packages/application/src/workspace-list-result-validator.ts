import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import { ApplicationError } from "./application-error.ts";
import { canonicalJson } from "./canonical-json.ts";
import type { IdempotencyDescriptor } from "./run-store-port.ts";
import {
  validateWorkspaceDeliveryAttempt,
  type WorkspaceDeliveryAttempt,
} from "./workspace-delivery-store-port.ts";
import {
  canonicalWorkspaceListAction,
  canonicalWorkspaceListDispatchCommand,
  canonicalWorkspaceOperationResult,
  validateWorkspaceOperationMutationResult,
  validateWorkspaceOperationPreparationResult,
  validateWorkspaceOperationRecord,
  type WorkspaceListOperationPhase,
  type WorkspaceListResolution,
  type WorkspaceOperationMutationResult,
  type WorkspaceOperationPreparationResult,
  type WorkspaceOperationRecord,
  type WorkspaceDeliverySettlementResult,
} from "./workspace-operation-store-port.ts";
import { phaseForCommand } from "./workspace-list-command-validation.ts";
import type {
  CancelWorkspaceListCommand,
  ExecuteWorkspaceListCommand,
  ReconcileWorkspaceListCommand,
} from "./workspace-list-application-service.ts";
type WorkspaceCommand =
  | ExecuteWorkspaceListCommand
  | ReconcileWorkspaceListCommand
  | CancelWorkspaceListCommand;
export class WorkspaceListResultValidator {
  readonly #digester: ContentDigester;

  constructor(digester: ContentDigester) {
    this.#digester = digester;
  }
  idempotency(
    actor: ActorContext,
    phase: WorkspaceListOperationPhase,
    command:
      | ExecuteWorkspaceListCommand
      | ReconcileWorkspaceListCommand
      | CancelWorkspaceListCommand,
  ): IdempotencyDescriptor {
    return {
      scope: `workspace-list.${phase}:${actor.spaceId}`,
      key: command.idempotencyKey,
      requestFingerprint: this.#digester.sha256(
        canonicalJson({
          schemaVersion: "crewon.workspace-operation-request.v0",
          phase,
          actor,
          command,
        }),
      ),
    };
  }

  validatedResult(
    actor: ActorContext,
    command:
      | ExecuteWorkspaceListCommand
      | ReconcileWorkspaceListCommand
      | CancelWorkspaceListCommand,
    input: WorkspaceOperationMutationResult,
  ): WorkspaceOperationMutationResult {
    const result = validateWorkspaceOperationMutationResult(input);
    this.validateScope(actor, command, result.operation);
    const operation = result.operation;
    const actionDigest = this.#digester.sha256(
      canonicalWorkspaceListAction({
        idempotencyKey: operation.idempotencyKey,
        command: operation.command,
      }),
    );
    const commandDigest = this.#digester.sha256(
      canonicalWorkspaceListDispatchCommand({
        tenantId: operation.tenantId,
        spaceId: operation.spaceId,
        threadId: operation.threadId,
        expectedThreadRevision: operation.expectedThreadRevision,
        principalId: operation.principalId,
        actorId: operation.actorId,
        idempotencyKey: operation.idempotencyKey,
        command: { ...operation.command, actionDigest },
      }),
    );
    if (
      operation.command.actionDigest !== actionDigest ||
      operation.command.commandDigest !== commandDigest
    ) {
      throw new ApplicationError(
        "internal",
        "workspace_operation_result_invalid",
      );
    }
    return result;
  }

  validatedPreparation(
    actor: ActorContext,
    command:
      | ExecuteWorkspaceListCommand
      | ReconcileWorkspaceListCommand
      | CancelWorkspaceListCommand,
    input: WorkspaceOperationPreparationResult,
    expectedOperation: WorkspaceOperationRecord,
  ): WorkspaceOperationPreparationResult {
    const result = validateWorkspaceOperationPreparationResult(input);
    this.validateScope(actor, command, result.operation);
    if (
      result.disposition === "committed" &&
      canonicalJson(result.operation) !== canonicalJson(expectedOperation)
    ) {
      throw new ApplicationError(
        "internal",
        "workspace_operation_result_invalid",
      );
    }
    if (
      result.deliveryAttempt !== null &&
      (result.deliveryAttempt.phase !== phaseForCommand(command) ||
        result.deliveryAttempt.actionDigest !==
          result.operation.command.actionDigest ||
        result.deliveryAttempt.commandDigest !==
          result.operation.command.commandDigest)
    ) {
      throw new ApplicationError(
        "internal",
        "workspace_delivery_attempt_invalid",
      );
    }
    return result;
  }

  validatedSettlement(
    actor: ActorContext,
    command:
      | ExecuteWorkspaceListCommand
      | ReconcileWorkspaceListCommand
      | CancelWorkspaceListCommand,
    previous: WorkspaceOperationRecord,
    leased: WorkspaceDeliveryAttempt,
    input: WorkspaceDeliverySettlementResult,
    expectedResolution: WorkspaceListResolution,
  ): WorkspaceOperationMutationResult {
    const result = this.validatedResult(actor, command, {
      disposition: input.outcome === "committed" ? "committed" : "replayed",
      operation: input.operation,
    });
    const attempt = validateWorkspaceDeliveryAttempt(input.deliveryAttempt);
    if (
      leased.lease === null ||
      attempt.attemptNumber !== leased.attemptNumber ||
      attempt.operationRevision !== previous.revision ||
      attempt.status !== "settled" ||
      attempt.settlement === null ||
      canonicalJson(attempt.lease) !== canonicalJson(leased.lease) ||
      attempt.settlement.resultRevision !== result.operation.revision ||
      attempt.settlement.resultDigest !==
        this.#digester.sha256(
          canonicalWorkspaceOperationResult(result.operation),
        )
    ) {
      throw new ApplicationError(
        "internal",
        "workspace_delivery_settlement_result_invalid",
      );
    }
    const expectedOperation = validateWorkspaceOperationRecord({
      ...previous,
      revision: previous.revision + 1,
      status: expectedResolution.status,
      resolution: expectedResolution,
    });
    if (input.outcome === "committed" || input.outcome === "replayed") {
      if (
        attempt.settlement.kind !== "resolution" ||
        attempt.settlement.resolutionStatus !== expectedResolution.status ||
        canonicalJson(result.operation) !== canonicalJson(expectedOperation)
      ) {
        throw new ApplicationError(
          "internal",
          "workspace_operation_result_invalid",
        );
      }
      return result;
    }
    const winner = validateWorkspaceOperationRecord({
      ...previous,
      revision: previous.revision + 1,
      status: result.operation.status,
      resolution: result.operation.resolution,
    });
    if (
      attempt.settlement.kind !== "superseded" ||
      attempt.settlement.resolutionStatus !== null ||
      result.operation.status === "prepared" ||
      result.operation.resolution === null ||
      canonicalJson(result.operation) !== canonicalJson(winner)
    ) {
      throw new ApplicationError(
        "internal",
        "workspace_delivery_lost_race_invalid",
      );
    }
    return result;
  }

  validateScope(
    actor: ActorContext,
    command:
      | ExecuteWorkspaceListCommand
      | ReconcileWorkspaceListCommand
      | CancelWorkspaceListCommand,
    operation: WorkspaceOperationRecord,
  ): void {
    if (
      operation.tenantId !== actor.tenantId ||
      operation.spaceId !== actor.spaceId ||
      operation.threadId !== command.threadId ||
      operation.principalId !== actor.principalId ||
      operation.actorId !== actor.actorId ||
      ("executionId" in command &&
        operation.executionId !== command.executionId) ||
      (command.kind === "workspaceList.execute" &&
        operation.expectedThreadRevision !== command.expectedRevision)
    ) {
      throw new ApplicationError(
        "internal",
        "workspace_operation_result_invalid",
      );
    }
  }
}
