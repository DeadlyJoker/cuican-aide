import type { WorkflowRunApplicationService } from "@crewon/application";

export const WORKFLOW_PRODUCTION_STORE_CAPABILITIES = [
  "startAdmission",
  "schedule",
  "admit",
  "settle",
  "humanGate",
  "reconcile",
  "cancel",
] as const;

export type WorkflowProductionStoreCapability =
  (typeof WORKFLOW_PRODUCTION_STORE_CAPABILITIES)[number];

export type WorkflowRunStartService = Pick<
  WorkflowRunApplicationService,
  "startWorkflowRun"
>;

/**
 * An explicit certification emitted by the future integrated Store/Worker
 * composition. The gate deliberately does not infer readiness from method
 * presence: partial PostgreSQL implementations may expose methods that fail
 * closed when invoked.
 */
export type WorkflowProductionCompositionCandidate = Readonly<{
  backend: "sqlite" | "postgres";
  storeCapabilities: readonly WorkflowProductionStoreCapability[];
  modelDispatchEvidence: "durable";
  agentRuntime: "WorkflowAgentRuntimeAdapter";
  createWorkflowRunStartService: () => WorkflowRunStartService;
}>;

export type WorkflowProductionCompositionInput =
  | Readonly<{ status: "disabled" }>
  | Readonly<{
      status: "candidate";
      candidate: WorkflowProductionCompositionCandidate;
    }>;

export function selectWorkflowRunStartFactory(
  input: WorkflowProductionCompositionInput,
): (() => WorkflowRunStartService) | null {
  if (input.status === "disabled") return null;
  const capabilities = input.candidate.storeCapabilities;
  if (
    capabilities.length !== WORKFLOW_PRODUCTION_STORE_CAPABILITIES.length ||
    new Set(capabilities).size !== capabilities.length ||
    !WORKFLOW_PRODUCTION_STORE_CAPABILITIES.every((capability) =>
      capabilities.includes(capability),
    ) ||
    input.candidate.modelDispatchEvidence !== "durable" ||
    input.candidate.agentRuntime !== "WorkflowAgentRuntimeAdapter"
  ) {
    return null;
  }
  return input.candidate.createWorkflowRunStartService;
}
