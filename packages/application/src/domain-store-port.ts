import type { RunReceiptStore, RunStore } from "./run-store-port.ts";
import type { RunExecutionStore } from "./run-execution-store-port.ts";
import type { ModelHistoryStore } from "./model-history-store-port.ts";
import type {
  SpaceScopedThreadStore,
  ThreadStore,
} from "./thread-store-port.ts";
import type { ThreadRollbackStore } from "./thread-rollback-store-port.ts";
import type { ToolExecutionStore } from "./tool-execution-store-port.ts";
import type { ToolApprovalStore } from "./tool-approval-store-port.ts";
import type { AgentVersionStore } from "./agent-version-store-port.ts";
import type { AgentVersionDeploymentStore } from "./agent-version-deployment-store-port.ts";
import type { AgentVersionReleaseStore } from "./agent-version-release-store-port.ts";
import type { TurnStartStore } from "./turn-start-store-port.ts";
import type {
  ThreadGoalEventStore,
  ThreadGoalMutationStore,
  ThreadGoalSnapshotStore,
  ThreadGoalStore,
} from "./thread-goal-store-port.ts";
import type { GoalToolStore } from "./goal-tool-store-port.ts";
import type { WorkspaceOperationStore } from "./workspace-operation-store-port.ts";
import type { OfficeDefinitionStore } from "./office-store-port.ts";

/** Combined authority implemented by local and Team composition roots. */
export type DomainStore = RunStore &
  OfficeDefinitionStore &
  RunReceiptStore &
  ThreadStore &
  SpaceScopedThreadStore &
  ThreadRollbackStore &
  ModelHistoryStore &
  RunExecutionStore &
  ToolApprovalStore &
  ToolExecutionStore &
  AgentVersionStore &
  AgentVersionDeploymentStore &
  AgentVersionReleaseStore &
  ThreadGoalStore &
  ThreadGoalSnapshotStore &
  ThreadGoalEventStore &
  ThreadGoalMutationStore &
  GoalToolStore &
  WorkspaceOperationStore &
  TurnStartStore;
