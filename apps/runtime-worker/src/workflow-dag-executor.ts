import {
  WorkflowExecutionService,
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

  async tick(input: {
    tenantId: string;
    runId: string;
    binding: FrozenWorkflowVersionBinding;
    workflow: CompiledWorkflowVersion;
    leaseDurationMs: number;
    operationId: string;
  }): Promise<WorkflowExecutionState> {
    await this.#execution.initialize(input);
    const claims = await this.#execution.claimReady(input);
    await Promise.all(claims.map((claim) => this.#execute(input, claim)));
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
    claim: WorkflowNodeClaim,
  ): Promise<void> {
    if (claim.node.kind === "humanGate") {
      await this.#gate.publish({
        tenantId: input.tenantId,
        runId: input.runId,
        nodeId: claim.node.nodeId,
        approvalPolicyId: claim.node.approvalPolicyId,
        gateRequestId: claim.gateRequestId!,
        inputDigest: claim.inputDigest,
      });
      return;
    }
    let outcome: WorkflowNodeOutcome;
    try {
      outcome = await this.#agent.execute({
        tenantId: input.tenantId,
        runId: input.runId,
        nodeId: claim.node.nodeId,
        agentVersionId:
          claim.node.kind === "agent"
            ? claim.node.agentVersionId
            : claim.node.verifierAgentVersionId,
        inputDigest: claim.inputDigest,
        claimId: claim.claimId,
        claimEpoch: claim.claimEpoch,
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
