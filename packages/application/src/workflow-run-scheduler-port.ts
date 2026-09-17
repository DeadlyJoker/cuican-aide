import type { RunState } from "@crewon/domain";
import type { AuthorizationDecision } from "./authorization-port.ts";
import type { WorkItem } from "./durable-queue-port.ts";
import type {
  WorkflowRunCompositionStore,
  WorkflowRunCancellationStore,
  WorkflowRunFinalizationStore,
} from "./workflow-run-composition-port.ts";

export type WorkflowSchedulerInput = Parameters<
  WorkflowRunFinalizationStore["finalizeWorkflowRun"]
>[0];

/** Current server policy, evaluated synchronously inside the admission transaction. */
export type WorkflowSchedulerAuthorization = (
  input: Readonly<{
    run: RunState;
    workItem: WorkItem;
  }>,
) => AuthorizationDecision;

export type WorkflowSchedulerPassResult =
  | Readonly<{ kind: "terminal"; run: RunState }>
  | Readonly<{ kind: "ready"; runId: string }>
  | Readonly<{
      kind: "waiting";
      runId: string;
      children: number;
      humanGates: number;
    }>;

/** Experimental internal Worker integration; never enabled by a model or client payload. */
export interface WorkflowRunSchedulerStore
  extends WorkflowRunCompositionStore,
    WorkflowRunCancellationStore,
    WorkflowRunFinalizationStore {
  prepareWorkflowRun(input: WorkflowSchedulerInput): Promise<RunState>;
  /** Confirm durable wake sources (or enqueue a successor) atomically with acknowledgement. */
  finishWorkflowSchedulerPass(
    input: WorkflowSchedulerInput,
  ): Promise<WorkflowSchedulerPassResult>;
}
