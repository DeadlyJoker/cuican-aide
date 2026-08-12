import type { JsonValue } from "@crewon/contracts";

import type { WorkflowRunInputAuthority } from "./durable-queue-port.ts";
import type { RunRoute } from "./run-commands.ts";
import type {
  CommitRunInput,
  CommitRunResult,
  IdempotencyDescriptor,
} from "./run-store-port.ts";
import type { WorkflowVersionAsset } from "./workflow-version-store-port.ts";
import type {
  ActiveAgentVersionRelease,
} from "./agent-version-release-store-port.ts";
import type { AgentVersionDeployment } from "./agent-version-deployment-store-port.ts";

export type WorkflowRunAdmissionAuthority = Readonly<{
  workflowVersion: WorkflowVersionAsset;
  route: RunRoute;
}>;

export type WorkflowRunRouteAuthority = Readonly<{
  workflowVersion: WorkflowVersionAsset;
  activeRelease: ActiveAgentVersionRelease;
  deployments: readonly AgentVersionDeployment[];
}>;

export type CommitWorkflowRunStartInput = Readonly<{
  tenantId: string;
  spaceId: string;
  threadId: string;
  workflowVersionId: string;
  workflowInput: JsonValue;
  idempotency: IdempotencyDescriptor;
  resolveRoute: (authority: WorkflowRunRouteAuthority) => RunRoute;
  prepare: (authority: WorkflowRunAdmissionAuthority) => Readonly<{
    commit: CommitRunInput;
    workflowInputValue: WorkflowRunInputAuthority;
  }>;
}>;

export type CommitWorkflowRunStartResult = Readonly<{
  authority: WorkflowRunAdmissionAuthority;
  run: CommitRunResult;
}>;

/** Atomic authority for admitting a Workflow Run and its immutable root value. */
export interface WorkflowRunAdmissionStore {
  commitWorkflowRunStart(
    input: CommitWorkflowRunStartInput,
  ): Promise<CommitWorkflowRunStartResult>;
}
