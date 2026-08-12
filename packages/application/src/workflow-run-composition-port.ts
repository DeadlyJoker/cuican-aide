import type {
  FrozenWorkflowVersionBinding,
  RunAttemptState,
  RunStepState,
} from "@crewon/domain";

import type { WorkItemLeaseInput } from "./durable-queue-port.ts";
import type { WorkflowExecutionState } from "./workflow-execution-store-port.ts";
import type { WorkflowNodeClaim } from "./workflow-execution-service.ts";

export type WorkflowNodeAttemptAdmission = Readonly<{
  claim: WorkflowNodeClaim;
  step: RunStepState;
  attempt: RunAttemptState | null;
}>;

/**
 * Atomic composition boundary required before Workflow execution is routable.
 *
 * Implementations must validate the WorkItem lease and the Run's frozen
 * WorkflowVersion binding in the same transaction that claims DAG nodes and
 * creates their RunStep/RunAttempt authority. No current Store implements this
 * port yet, so Runtime Worker production routing must remain disabled.
 */
export interface WorkflowRunCompositionStore {
  admitWorkflowNodes(input: {
    tenantId: string;
    runId: string;
    lease: WorkItemLeaseInput;
    binding: FrozenWorkflowVersionBinding;
    schedulerOperationId: string;
    leaseDurationMs: number;
  }): Promise<
    Readonly<{
      /** `replayed` is historical authority and MUST NOT dispatch side effects again. */
      disposition: "committed" | "replayed";
      execution: WorkflowExecutionState;
      admissions: readonly WorkflowNodeAttemptAdmission[];
    }>
  >;
}
