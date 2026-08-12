import type {
  WorkflowNodeAttemptAdmission,
  WorkflowRunCompositionStore,
} from "@crewon/application";
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
  }): Promise<readonly WorkflowNodeAttemptAdmission[]> {
    const result = await this.#store.admitWorkflowNodes(input);
    return result.admissions;
  }
}
