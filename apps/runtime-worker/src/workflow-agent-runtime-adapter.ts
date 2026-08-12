import type { WorkflowSchemaValue } from "@crewon/domain";
import type {
  AgentVersionRuntime,
  AgentVersionRuntimeResolverPort,
} from "./agent-version-runtime.ts";
import type {
  WorkflowAgentNodePort,
  WorkflowNodeOutcome,
} from "./workflow-runtime-dispatcher.ts";

export interface WorkflowAdmittedAgentExecutionEngine {
  execute(input: {
    runtime: AgentVersionRuntime;
    authority: {
      tenantId: string;
      runId: string;
      nodeId: string;
      agentVersionId: string;
      claimId: string;
      claimEpoch: number;
      stepId: string;
      attemptId: string;
      workItemClaim: Parameters<
        WorkflowAgentNodePort["execute"]
      >[0]["workItemClaim"];
    };
    inputValue: Parameters<WorkflowAgentNodePort["execute"]>[0]["inputValue"];
  }): Promise<
    | Readonly<{ status: "completed"; value: WorkflowSchemaValue }>
    | Exclude<
        WorkflowNodeOutcome,
        Readonly<{ status: "completed"; value: WorkflowSchemaValue }>
      >
  >;
}

/** Resolves the frozen node AgentVersion and delegates only to an admitted execution engine. */
export class WorkflowAgentRuntimeAdapter implements WorkflowAgentNodePort {
  readonly #runtimes: AgentVersionRuntimeResolverPort;
  readonly #engine: WorkflowAdmittedAgentExecutionEngine;

  constructor(dependencies: {
    runtimes: AgentVersionRuntimeResolverPort;
    engine: WorkflowAdmittedAgentExecutionEngine;
  }) {
    this.#runtimes = dependencies.runtimes;
    this.#engine = dependencies.engine;
  }

  async execute(
    input: Parameters<WorkflowAgentNodePort["execute"]>[0],
  ): Promise<WorkflowNodeOutcome> {
    const runtime = await this.#runtimes.resolve({
      tenantId: input.tenantId,
      agentVersionId: input.agentVersionId,
    });
    if (
      runtime === null ||
      runtime.version.agentVersionId !== input.agentVersionId
    ) {
      throw new Error("workflow_node_agent_runtime_unavailable");
    }
    return this.#engine.execute({
      runtime,
      authority: {
        tenantId: input.tenantId,
        runId: input.runId,
        nodeId: input.nodeId,
        agentVersionId: input.agentVersionId,
        claimId: input.claimId,
        claimEpoch: input.claimEpoch,
        stepId: input.stepId,
        attemptId: input.attemptId,
        workItemClaim: input.workItemClaim,
      },
      inputValue: input.inputValue,
    });
  }
}
