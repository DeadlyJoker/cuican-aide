import type { ActorContext } from "./authorization-port.ts";
import { ApplicationError } from "./application-error.ts";
import { RunStoreError } from "./run-store-port.ts";
import type {
  DecideWorkflowHumanGateCommand,
  WorkflowHumanGateLocator,
  WorkflowHumanGateStore,
} from "./workflow-human-gate-port.ts";

/** Server-resolved actor identity only. The Store rechecks the frozen policy under its transaction. */
export class WorkflowHumanGateApplicationService {
  readonly #store: WorkflowHumanGateStore;
  constructor(store: WorkflowHumanGateStore) {
    this.#store = store;
  }
  async getGate(actor: ActorContext, locator: WorkflowHumanGateLocator) {
    validateWorkflowHumanGateRequest(actor, locator);
    return this.call(() =>
      this.#store.loadWorkflowHumanGate({ actor, locator }),
    );
  }
  async decideGate(
    actor: ActorContext,
    command: DecideWorkflowHumanGateCommand,
  ) {
    validateWorkflowHumanGateRequest(actor, command);
    if (
      command.kind !== "workflowHumanGate.decide" ||
      !/^sha256:[a-f0-9]{64}$/u.test(command.inputDigest) ||
      !["approved", "rejected"].includes(command.decision) ||
      Object.keys(command).sort().join() !==
        "decision,gateRequestId,inputDigest,kind,nodeId,runId"
    )
      throw new ApplicationError("validation", "workflow_gate_command_invalid");
    return this.call(() =>
      this.#store.decideWorkflowHumanGate({ actor, command }),
    );
  }
  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      if (error instanceof RunStoreError) {
        const kind = error.code.includes("authorization")
          ? "authorization"
          : error.code === "workflow_gate_not_found"
            ? "notFound"
            : error.code.endsWith("_conflict") ||
                error.code === "workflow_gate_not_decidable"
              ? "conflict"
              : "internal";
        throw new ApplicationError(kind, error.code, { cause: error });
      }
      throw new ApplicationError("internal", "workflow_gate_store_failed", {
        cause: error,
      });
    }
  }
}
export function validateWorkflowHumanGateRequest(
  actor: ActorContext,
  locator: WorkflowHumanGateLocator,
): void {
  if (
    !actor ||
    !locator ||
    typeof actor !== "object" ||
    typeof locator !== "object"
  )
    throw new ApplicationError("validation", "workflow_gate_request_invalid");
  if (
    Object.keys(actor).sort().join() !== "actorId,principalId,spaceId,tenantId"
  )
    throw new ApplicationError("validation", "workflow_gate_request_invalid");
  for (const value of [
    actor.tenantId,
    actor.spaceId,
    actor.actorId,
    actor.principalId,
    locator.runId,
    locator.nodeId,
    locator.gateRequestId,
  ])
    if (
      typeof value !== "string" ||
      !value.trim() ||
      new TextEncoder().encode(value).byteLength > 512
    )
      throw new ApplicationError("validation", "workflow_gate_request_invalid");
}
