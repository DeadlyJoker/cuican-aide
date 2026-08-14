import type { FrozenWorkflowVersionBinding } from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import { canonicalJson } from "./canonical-json.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import { RunStoreError } from "./run-store-port.ts";
import type {
  WorkflowHumanGatePublicationStore,
  WorkflowRunCompositionStore,
} from "./workflow-run-composition-port.ts";

export type DecideWorkflowHumanGateCommand = Readonly<{
  kind: "workflowHumanGate.decide";
  idempotencyKey: string;
  runId: string;
  nodeId: string;
  claimId: string;
  claimEpoch: number;
  gateRequestId: string;
  decision: "approve" | "reject";
}>;

type Store = Readonly<{
  loadRun(input: { tenantId: string; runId: string }): Promise<GateRunAuthority | null>;
  listPublishedWorkflowHumanGates(
    input: Parameters<WorkflowHumanGatePublicationStore["listPublishedWorkflowHumanGates"]>[0],
  ): ReturnType<WorkflowHumanGatePublicationStore["listPublishedWorkflowHumanGates"]>;
  recordWorkflowHumanGateDecision(
    input: Parameters<WorkflowRunCompositionStore["recordWorkflowHumanGateDecision"]>[0],
  ): ReturnType<WorkflowRunCompositionStore["recordWorkflowHumanGateDecision"]>;
}>;

type GateRunAuthority = Readonly<{
  tenantId: string;
  spaceId: string;
  threadId: string;
  runId: string;
  purpose: string;
  status: string;
  workflowVersionBinding?: FrozenWorkflowVersionBinding;
}>;

export class WorkflowHumanGateApplicationService {
  readonly #store: Store;
  readonly #authorization: AuthorizationPort;
  readonly #digester: ContentDigester;

  constructor(dependencies: {
    store: Store;
    authorization: AuthorizationPort;
    digester: ContentDigester;
  }) {
    this.#store = dependencies.store;
    this.#authorization = dependencies.authorization;
    this.#digester = dependencies.digester;
  }

  async listPublished(actor: ActorContext, runId: string) {
    validateActor(actor);
    if (!bounded(runId))
      throw new ApplicationError("validation", "workflow_gate_run_id_invalid");
    const run = await this.#loadAuthorizedRun(actor, runId);
    try {
      return await this.#store.listPublishedWorkflowHumanGates({
        tenantId: actor.tenantId,
        runId: run.runId,
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async decide(actor: ActorContext, command: DecideWorkflowHumanGateCommand) {
    validateActor(actor);
    validateCommand(command);
    const run = await this.#loadAuthorizedRun(actor, command.runId);
    if (run.status !== "running")
      throw new ApplicationError("conflict", "workflow_gate_run_authority_invalid");
    const decisionReceiptId = receiptId(actor, command, this.#digester);
    try {
      const result = await this.#store.recordWorkflowHumanGateDecision({
        tenantId: actor.tenantId,
        runId: run.runId,
        binding: run.workflowVersionBinding,
        nodeId: command.nodeId,
        claimId: command.claimId,
        claimEpoch: command.claimEpoch,
        gateRequestId: command.gateRequestId,
        decisionReceiptId,
        outcome: command.decision === "approve"
          ? { status: "completed" }
          : { status: "failed", failureCode: "workflow_gate_rejected" },
      });
      return {
        disposition: result.disposition,
        runId: run.runId,
        nodeId: command.nodeId,
        gateRequestId: command.gateRequestId,
        decisionReceiptId,
        resumeWorkItemId: result.approvalResumeWorkItemId,
      } as const;
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async #loadAuthorizedRun(actor: ActorContext, runId: string) {
    let run: GateRunAuthority | null;
    try {
      run = await this.#store.loadRun({
        tenantId: actor.tenantId,
        runId,
      });
    } catch (error) {
      throw mapStoreError(error);
    }
    if (run === null || run.tenantId !== actor.tenantId ||
        run.spaceId !== actor.spaceId)
      throw new ApplicationError("notFound", "workflow_gate_run_not_found");
    const binding = run.workflowVersionBinding;
    if (run.purpose !== "workflow" || binding === undefined)
      throw new ApplicationError("conflict", "workflow_gate_run_authority_invalid");
    await this.#authorize(actor, run);
    return { ...run, workflowVersionBinding: binding };
  }

  async #authorize(actor: ActorContext, run: GateRunAuthority): Promise<void> {
    try {
      const decision = await this.#authorization.authorize({
        actor,
        action: "run:execute",
        resource: { kind: "run", tenantId: actor.tenantId,
          spaceId: actor.spaceId, threadId: run.threadId, runId: run.runId },
      });
      if (decision.outcome !== "allow")
        throw new ApplicationError("authorization", "workflow_gate_forbidden");
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError("authorization", "authorization_unavailable", {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }
}

function receiptId(
  actor: ActorContext,
  command: DecideWorkflowHumanGateCommand,
  digester: ContentDigester,
): string {
  const digest = digester.sha256(canonicalJson({ tenantId: actor.tenantId,
    spaceId: actor.spaceId, principalId: actor.principalId, actorId: actor.actorId,
    runId: command.runId, nodeId: command.nodeId,
    gateRequestId: command.gateRequestId, idempotencyKey: command.idempotencyKey }));
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest))
    throw new ApplicationError("internal", "workflow_gate_digest_invalid");
  return `workflow-gate-decision:${digest.slice("sha256:".length)}`;
}

function validateActor(actor: ActorContext): void {
  if (!plain(actor) || Object.keys(actor).sort().join(",") !==
      "actorId,principalId,spaceId,tenantId" ||
      !bounded(actor.principalId) || !bounded(actor.actorId) ||
      !bounded(actor.tenantId) || !bounded(actor.spaceId))
    throw new ApplicationError("validation", "actor_invalid");
}

function validateCommand(command: DecideWorkflowHumanGateCommand): void {
  if (!plain(command) || Object.keys(command).sort().join(",") !==
      "claimEpoch,claimId,decision,gateRequestId,idempotencyKey,kind,nodeId,runId" ||
      command.kind !== "workflowHumanGate.decide" ||
      !bounded(command.idempotencyKey) || !bounded(command.runId) ||
      !bounded(command.nodeId) || !bounded(command.claimId) ||
      !bounded(command.gateRequestId) || !Number.isSafeInteger(command.claimEpoch) ||
      command.claimEpoch < 1 || !["approve", "reject"].includes(command.decision))
    throw new ApplicationError("validation", "workflow_gate_command_invalid");
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function bounded(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    new TextEncoder().encode(value).length <= 256;
}

function mapStoreError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error;
  const code = error instanceof RunStoreError ? error.code
    : error instanceof Error ? error.message : "workflow_gate_store_failed";
  if (code.includes("idempotency_conflict") || code.includes("decision_mismatch") ||
      code.includes("authority_mismatch"))
    return new ApplicationError("conflict", code, { cause: error instanceof Error ? error : undefined });
  if (code.includes("invalid"))
    return new ApplicationError("validation", code, { cause: error instanceof Error ? error : undefined });
  return new ApplicationError("internal", code, { cause: error instanceof Error ? error : undefined });
}
