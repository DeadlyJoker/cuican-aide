import type { ActorContext } from "./authorization-port.ts";
import { ApplicationError } from "./application-error.ts";
import { callWorkflowHumanGateStore } from "./workflow-human-gate-errors.ts";
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
    return callWorkflowHumanGateStore(() =>
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
    return callWorkflowHumanGateStore(() =>
      this.#store.decideWorkflowHumanGate({ actor, command }),
    );
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
