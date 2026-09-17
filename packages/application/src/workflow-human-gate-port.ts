import type { JsonValue } from "@crewon/contracts";
import type { FrozenWorkflowVersionBinding } from "@crewon/domain";
import type {
  ActorContext,
  AuthorizationDecision,
} from "./authorization-port.ts";

export type WorkflowHumanGateAuthority = Readonly<{
  tenantId: string;
  spaceId: string;
  runId: string;
  nodeId: string;
  binding: FrozenWorkflowVersionBinding;
  claimId: string;
  gateRequestId: string;
  approvalPolicyId: string;
  inputDigest: string;
}>;
export type WorkflowHumanGateDecision = Readonly<{
  authority: WorkflowHumanGateAuthority;
  actor: ActorContext;
  outcome: "approved" | "rejected";
  decidedAt: string;
}>;
export type WorkflowHumanGateView = Readonly<{
  authority: WorkflowHumanGateAuthority;
  title: string;
  instruction: string;
  input: JsonValue;
  status: "waitingHuman" | "completed" | "failed" | "canceled";
  decision: WorkflowHumanGateDecision | null;
}>;
export type WorkflowHumanGateLocator = Readonly<{
  runId: string;
  nodeId: string;
  gateRequestId: string;
}>;
export type DecideWorkflowHumanGateCommand = WorkflowHumanGateLocator &
  Readonly<{
    kind: "workflowHumanGate.decide";
    inputDigest: string;
    decision: "approved" | "rejected";
  }>;
/** Authorization must use the frozen gate policy and current principal grants inside the Store transaction.
 * Implementations must fail closed when that policy cannot be resolved. No external I/O in this callback.
 */
export type WorkflowHumanGateAuthorization = (input: {
  actor: ActorContext;
  action: "read" | "decide";
  authority: WorkflowHumanGateAuthority;
}) => AuthorizationDecision;

/** One decision per gate request. Equal actor/outcome/input replays the exact durable decision after restart. */
export interface WorkflowHumanGateStore {
  loadWorkflowHumanGate(input: {
    actor: ActorContext;
    locator: WorkflowHumanGateLocator;
  }): Promise<WorkflowHumanGateView>;
  decideWorkflowHumanGate(input: {
    actor: ActorContext;
    command: DecideWorkflowHumanGateCommand;
  }): Promise<
    Readonly<{
      disposition: "committed" | "replayed";
      decision: WorkflowHumanGateDecision;
    }>
  >;
}
