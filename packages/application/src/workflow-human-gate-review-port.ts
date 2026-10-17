import type { ActorContext } from "./authorization-port.ts";
import type {
  WorkflowHumanGateDecision,
  WorkflowHumanGateLocator,
  WorkflowHumanGateView,
} from "./workflow-human-gate-port.ts";

/** Exact review text is metadata; it never replaces the gate's frozen input or output. */
export type WorkflowHumanGateReview = Readonly<{
  decision: WorkflowHumanGateDecision;
  comment: string | null;
}>;
export type WorkflowHumanGateReviewView = Omit<
  WorkflowHumanGateView,
  "decision"
> &
  Readonly<{ review: WorkflowHumanGateReview | null }>;
export type ReviewWorkflowHumanGateCommand = WorkflowHumanGateLocator &
  Readonly<{
    kind: "workflowHumanGate.review";
    inputDigest: string;
    decision: "approved" | "rejected";
    comment: string | null;
  }>;
export interface WorkflowHumanGateReviewStore {
  loadWorkflowHumanGateReview(input: {
    actor: ActorContext;
    locator: WorkflowHumanGateLocator;
  }): Promise<WorkflowHumanGateReviewView>;
  reviewWorkflowHumanGate(input: {
    actor: ActorContext;
    command: ReviewWorkflowHumanGateCommand;
  }): Promise<
    Readonly<{
      disposition: "committed" | "replayed";
      review: WorkflowHumanGateReview;
    }>
  >;
}
