import { parseWorkflowHumanGateReviewComment } from "@crewon/contracts";
import type { ActorContext } from "./authorization-port.ts";
import { ApplicationError } from "./application-error.ts";
import { callWorkflowHumanGateStore } from "./workflow-human-gate-errors.ts";
import type { WorkflowHumanGateLocator } from "./workflow-human-gate-port.ts";
import { validateWorkflowHumanGateRequest } from "./workflow-human-gate-service.ts";
import type {
  ReviewWorkflowHumanGateCommand,
  WorkflowHumanGateReviewStore,
} from "./workflow-human-gate-review-port.ts";

export function validateWorkflowHumanGateReviewComment(
  value: unknown,
): asserts value is string | null {
  try {
    parseWorkflowHumanGateReviewComment(value);
  } catch (cause) {
    throw new ApplicationError("validation", "workflow_gate_comment_invalid", {
      cause,
    });
  }
}

function captureRecord<T extends object>(value: T, keys: string): T {
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new ApplicationError("validation", "workflow_gate_request_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.keys(descriptors).sort().join() !== keys ||
    Object.values(descriptors).some((d) => !("value" in d) || !d.enumerable)
  )
    throw new ApplicationError("validation", "workflow_gate_request_invalid");
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, d]) => [key, d.value]),
  ) as T;
}

/** Capture plain data before any callback, database access or await. */
export function captureWorkflowHumanGateReviewRead(input: {
  actor: ActorContext;
  locator: WorkflowHumanGateLocator;
}) {
  const actor = captureRecord(
    input.actor,
    "actorId,principalId,spaceId,tenantId",
  );
  const locator = captureRecord(input.locator, "gateRequestId,nodeId,runId");
  validateWorkflowHumanGateRequest(actor, locator);
  return { actor, locator };
}
export function captureWorkflowHumanGateReviewRequest(input: {
  actor: ActorContext;
  command: ReviewWorkflowHumanGateCommand;
}) {
  const actor = captureRecord(
    input.actor,
    "actorId,principalId,spaceId,tenantId",
  );
  const command = captureRecord(
    input.command,
    "comment,decision,gateRequestId,inputDigest,kind,nodeId,runId",
  );
  validateWorkflowHumanGateRequest(actor, command);
  if (
    command.kind !== "workflowHumanGate.review" ||
    typeof command.inputDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(command.inputDigest) ||
    !["approved", "rejected"].includes(command.decision)
  )
    throw new ApplicationError("validation", "workflow_gate_command_invalid");
  validateWorkflowHumanGateReviewComment(command.comment);
  return { actor, command };
}

export class WorkflowHumanGateReviewApplicationService {
  readonly #store: WorkflowHumanGateReviewStore;
  constructor(store: WorkflowHumanGateReviewStore) {
    this.#store = store;
  }
  async getReview(actor: ActorContext, locator: WorkflowHumanGateLocator) {
    const input = captureWorkflowHumanGateReviewRead({ actor, locator });
    return callWorkflowHumanGateStore(() =>
      this.#store.loadWorkflowHumanGateReview(input),
    );
  }
  async reviewGate(
    actor: ActorContext,
    command: ReviewWorkflowHumanGateCommand,
  ) {
    const input = captureWorkflowHumanGateReviewRequest({ actor, command });
    return callWorkflowHumanGateStore(() =>
      this.#store.reviewWorkflowHumanGate(input),
    );
  }
}
