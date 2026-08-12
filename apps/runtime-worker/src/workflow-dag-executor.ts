import {
  WorkflowExecutionService,
  type WorkflowNodeAttemptAdmission,
  type WorkflowExecutionState,
  type WorkflowNodeClaim,
} from "@crewon/application";
import type {
  CompiledWorkflowVersion,
  FrozenWorkflowVersionBinding,
} from "@crewon/domain";

export type WorkflowNodeOutcome =
  | Readonly<{ status: "completed"; resultDigest: string }>
  | Readonly<{ status: "failed"; failureCode: string }>
  | Readonly<{ status: "canceled" }>
  | Readonly<{ status: "unknown" }>;

export interface WorkflowAgentNodePort {
  execute(input: {
    tenantId: string;
    runId: string;
    nodeId: string;
    agentVersionId: string;
    inputDigest: string;
    claimId: string;
    claimEpoch: number;
    stepId: string;
    attemptId: string;
  }): Promise<WorkflowNodeOutcome>;
}

export interface WorkflowHumanGatePort {
  publish(input: {
    tenantId: string;
    runId: string;
    nodeId: string;
    approvalPolicyId: string;
    gateRequestId: string;
    inputDigest: string;
  }): Promise<void>;
}

export type WorkflowNodeDispatchAdmission = WorkflowNodeAttemptAdmission &
  Readonly<{ agentVersionId: string | null }>;

/** Signals the WorkItem adapter to retain/retry the original claim via reconciliation. */
export class WorkflowNodeRecoveryRequiredError extends Error {
  readonly claim: WorkflowNodeClaim;
  readonly cause: unknown;

  constructor(claim: WorkflowNodeClaim, cause: unknown) {
    super("workflow_node_recovery_required");
    this.name = "WorkflowNodeRecoveryRequiredError";
    this.claim = claim;
    this.cause = cause;
  }
}

/** Executes one durable scheduler pass; waiting gates release the Worker immediately. */
export class WorkflowDagExecutor {
  readonly #execution: WorkflowExecutionService;
  readonly #agent: WorkflowAgentNodePort;
  readonly #gate: WorkflowHumanGatePort;

  constructor(dependencies: {
    execution: WorkflowExecutionService;
    agent: WorkflowAgentNodePort;
    gate: WorkflowHumanGatePort;
  }) {
    this.#execution = dependencies.execution;
    this.#agent = dependencies.agent;
    this.#gate = dependencies.gate;
  }

  async executeAdmissions(input: {
    tenantId: string;
    runId: string;
    binding: FrozenWorkflowVersionBinding;
    workflow: CompiledWorkflowVersion;
    admissions: readonly WorkflowNodeDispatchAdmission[];
  }): Promise<WorkflowExecutionState> {
    await Promise.all(
      input.admissions.map((admission) => this.#execute(input, admission)),
    );
    return this.#execution.load(input);
  }

  async settleHumanGate(input: {
    tenantId: string;
    runId: string;
    binding: FrozenWorkflowVersionBinding;
    workflow: CompiledWorkflowVersion;
    nodeId: string;
    claimId: string;
    operationId: string;
    approved: boolean;
    resultDigest: string;
  }): Promise<WorkflowExecutionState> {
    return this.#execution.settleNode({
      ...input,
      outcome: input.approved
        ? { status: "completed", resultDigest: input.resultDigest }
        : { status: "failed", failureCode: "workflow_human_gate_rejected" },
    });
  }

  async #execute(
    input: {
      tenantId: string;
      runId: string;
      binding: FrozenWorkflowVersionBinding;
      workflow: CompiledWorkflowVersion;
    },
    admission: WorkflowNodeDispatchAdmission,
  ): Promise<void> {
    const { claim } = admission;
    if (claim.node.kind === "humanGate") {
      try {
        await this.#gate.publish({
          tenantId: input.tenantId,
          runId: input.runId,
          nodeId: claim.node.nodeId,
          approvalPolicyId: claim.node.approvalPolicyId,
          gateRequestId: claim.gateRequestId!,
          inputDigest: claim.inputDigest,
        });
      } catch (error) {
        try {
          await this.#execution.settleNode({
            tenantId: input.tenantId,
            runId: input.runId,
            binding: input.binding,
            workflow: input.workflow,
            nodeId: claim.node.nodeId,
            claimId: claim.claimId,
            operationId: `node:${claim.claimId}:publish-unknown`,
            outcome: { status: "unknown" },
          });
        } catch (settlementError) {
          throw new WorkflowNodeRecoveryRequiredError(claim, settlementError);
        }
        return;
      }
      return;
    }
    let outcome: WorkflowNodeOutcome;
    try {
      if (admission.attempt === null) {
        throw new Error("workflow_node_attempt_admission_missing");
      }
      outcome = await this.#agent.execute({
        tenantId: input.tenantId,
        runId: input.runId,
        nodeId: claim.node.nodeId,
        agentVersionId: admission.agentVersionId!,
        inputDigest: claim.inputDigest,
        claimId: claim.claimId,
        claimEpoch: claim.claimEpoch,
        stepId: admission.step.stepId,
        attemptId: admission.attempt.attemptId,
      });
    } catch {
      outcome = { status: "unknown" };
    }
    try {
      await this.#execution.settleNode({
        tenantId: input.tenantId,
        runId: input.runId,
        binding: input.binding,
        workflow: input.workflow,
        nodeId: claim.node.nodeId,
        claimId: claim.claimId,
        operationId: `node:${claim.claimId}:settle`,
        outcome,
      });
    } catch (error) {
      throw new WorkflowNodeRecoveryRequiredError(claim, error);
    }
  }
}
