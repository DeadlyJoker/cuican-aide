import type { ModelSpendingStore } from "./model-spending-store-port.ts";
import type { ModelPricingStore } from "./model-pricing-store-port.ts";
import type { RunExecutionProgressStore } from "./run-execution-progress-store-port.ts";
import type { CompactionCheckpointStore } from "./compaction-checkpoint-store-port.ts";
import type { OfficeThreadStore } from "./office-thread-store-port.ts";
import type { ModelCallStore } from "./model-call-store-port.ts";
import type { RunReceiptStore, RunStore } from "./run-store-port.ts";
import type { ModelUsageStore } from "./model-usage-store-port.ts";
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
export type DomainStore = {
  readonly modelPricing?: ModelPricingStore;
  readonly modelSpending?: ModelSpendingStore;
  readonly compactionCheckpoints?: CompactionCheckpointStore;
  readonly executionProgress?: RunExecutionProgressStore;
} & RunStore &
  ArtifactRetentionGuard &
  ModelUsageStore &
  ModelCallStore &
  OfficeDefinitionStore &
  OfficeThreadStore &
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
import type { ArtifactRetentionGuard } from "./artifact-retention-port.ts";
