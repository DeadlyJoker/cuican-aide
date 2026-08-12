import type { WorkflowRunCompositionStore } from "@crewon/application";
import type { FrozenWorkflowVersionBinding } from "@crewon/domain";

/** Internal-only gate; production must not construct this without atomic Store support. */
export class ExperimentalWorkflowRunCompositionAdapter {
  readonly #store: WorkflowRunCompositionStore;

  constructor(store: WorkflowRunCompositionStore) {
    this.#store = store;
  }

  async admit(input: {
    tenantId: string;
    runId: string;
    lease: import("@crewon/application").WorkItemLeaseInput;
    binding: FrozenWorkflowVersionBinding;
    schedulerOperationId: string;
    leaseDurationMs: number;
  }): ReturnType<WorkflowRunCompositionStore["admitWorkflowNodes"]> {
    return this.#store.admitWorkflowNodes(input);
  }

  settleNode(
    input: Parameters<WorkflowRunCompositionStore["settleWorkflowNode"]>[0],
  ): ReturnType<WorkflowRunCompositionStore["settleWorkflowNode"]> {
    return this.#store.settleWorkflowNode(input);
  }

  publishHumanGate(
    input: Parameters<
      WorkflowRunCompositionStore["publishWorkflowHumanGate"]
    >[0],
  ): ReturnType<WorkflowRunCompositionStore["publishWorkflowHumanGate"]> {
    return this.#store.publishWorkflowHumanGate(input);
  }

  settleHumanGate(
    input: Parameters<
      WorkflowRunCompositionStore["settleWorkflowHumanGate"]
    >[0],
  ): ReturnType<WorkflowRunCompositionStore["settleWorkflowHumanGate"]> {
    return this.#store.settleWorkflowHumanGate(input);
  }

  scheduleReconciliation(
    input: Parameters<
      WorkflowRunCompositionStore["scheduleWorkflowReconciliation"]
    >[0],
  ): ReturnType<WorkflowRunCompositionStore["scheduleWorkflowReconciliation"]> {
    return this.#store.scheduleWorkflowReconciliation(input);
  }
}
