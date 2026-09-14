import { registerDemonstratedSkillRoutes } from "./demonstrated-skill-routes.ts";
import type { DemonstratedSkillService, SkillRecordingStore, SkillDraftGenerationService } from "@crewon/application";
import { projectAutomationWithReadiness } from "./automation-readiness-projection.ts";
import { requireSkillScheduleClient, supportsSkillSchedules } from "./automation-client-compatibility.ts";
import { registerThreadActiveRunRoute } from "./thread-active-run-route.ts";
import { registerBrowserExecutionAuthorityRoute } from "./browser-execution-authority-route.ts";
import { registerDeliveryRoutes } from "./delivery-routes.ts";
import type { DeliveryApplicationService } from "@crewon/application";
import { registerThreadCatalogRoute } from "./thread-catalog-route.ts";
import type { StorageAdmissionPort } from "@crewon/application";
import { installStorageAdmission } from "./storage-admission.ts";
import { registerThreadMessageWindowRoute } from "./thread-message-window-route.ts";
import { registerThreadTranscriptWindowRoute } from "./thread-transcript-window-route.ts";
import { withThreadListTitles } from "./thread-list-titles.ts";
import type {
  AgentVersionApplicationService,
  AgentVersionCatalogApplicationService,
  ArtifactApplicationService,
  AutomationApplicationService,
  ModelProviderSettingsApplicationService,
  ApplicationClock,
  ContentDigester,
  OfficeApplicationService,
  RunApplicationService,
  ThreadApplicationService,
  ThreadCompactionApplicationService,
  ThreadGoalApplicationService,
  ThreadRollbackApplicationService,
  ThreadTaskChangeQueryService,
  ToolApprovalApplicationService,
  TurnApplicationService,
  WorkspaceListApplicationService,
  WorkspaceOperationQueryService,
  WorkflowVersionApplicationService,
  WorkflowRunApplicationService,
  CommitThreadResult,
  CommitTurnStartResult,
} from "@crewon/application";
import {
  AgentVersionError,
  compileAgentVersion,
  createAgentVersionAsset,
  type AgentVersionSource,
} from "@crewon/agent-version";
import {
  ContractValidationError,
  formatAgentVersionCursor,
  formatAutomationCursor,
  formatMessageCursor,
  formatOfficeCursor,
  formatThreadCursor,
  formatThreadRunCursor,
  formatWorkflowVersionCursor,
  parseAgentVersionId,
  parseAgentVersionListQuery,
  parseArchiveThreadRequest,
  parseAppendThreadMessageRequest,
  parseApprovalId,
  parseArtifactId,
  parseAutomationId,
  parseAutomationListQuery,
  parseCancelRunRequest,
  parseCompactThreadRequest,
  parseClearThreadGoalRequest,
  parseCreateRunRequest,
  parseCreateOfficeRequest,
  parseStartWorkflowRunRequest,
  parseCreateAutomationRequest,
  parseCreateThreadRequest,
  parseDecideToolApprovalRequest,
  parseDeleteThreadRequest,
  parseForkThreadRequest,
  parseIdempotencyKey,
  parseLastEventSequence,
  parseMessageListQuery,
  parseOfficeListQuery,
  parseOfficeVersionId,
  parseStartOfficeRunRequest,
  parseProbeModelProviderRequest,
  parseRenameThreadRequest,
  parseRollbackThreadRequest,
  parsePublishAgentVersionRequest,
  parseRunId,
  parseRunEventExtensions,
  parseRunEventViewMode,
  parseRunAutomationNowRequest,
  parseSetThreadGoalRequest,
  parseStartTurnRequest,
  parseThreadId,
  parseThreadHistoryView,
  parseThreadListQuery,
  parseThreadRunListQuery,
  parseUnarchiveThreadRequest,
  parseCreateWorkspaceListRequest,
  parseWorkspaceExecutionId,
  parseWorkspaceOperationActionRequest,
  parseWorkspaceOperationLastEventSequence,
  parseWorkspaceOperationListQuery,
  parsePublishWorkflowVersionRequest,
  parseWorkflowVersionId,
  parseWorkflowVersionListQuery,
  type AgentVersionMutationResponse,
  type ActiveAgentVersionCatalogResponse,
  type AppendThreadMessageResponse,
  type AutomationMutationResponse,
  type GetAgentVersionResponse,
  type GetArtifactResponse,
  type GetAutomationResponse,
  type ExecutionIntentCapabilityResponse,
  type GetRunResponse,
  type GetRunPlanResponse,
  type GetThreadResponse,
  type ThreadTaskChangeLedgerResponse,
  type GetThreadGoalResponse,
  type GetToolApprovalResponse,
  type ListThreadRunsResponse,
  type ListThreadsResponse,
  type ListThreadMessagesResponse,
  type ListAgentVersionsResponse,
  type ListAutomationsResponse,
  type GetOfficeResponse,
  type AuthorizeOfficeRunResponse,
  type ListOfficesResponse,
  type OfficeMutationResponse,
  type GetModelProviderSettingsResponse,
  type ProbeModelProviderResponse,
  type RunMutationResponse,
  type RunAutomationNowResponse,
  type StartTurnResponse,
  type ThreadMutationResponse,
  type ToolApprovalMutationResponse,
  type GetWorkspaceOperationResponse,
  type ListWorkspaceOperationsResponse,
  type WorkspaceOperationMutationResponse,
  type WorkflowVersionMutationResponse,
  type GetWorkflowVersionResponse,
  type ListWorkflowVersionsResponse,
  type JsonValue,
  START_TURN_EXECUTION_INTENT_ACK_ACCEPT,
} from "@crewon/contracts";
import type { OfficeDefinition } from "@crewon/domain";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

import {
  errorResponse,
  notFoundResponse,
  readinessErrorResponse,
  WorkspaceControlUnavailableError,
} from "./control-api-errors.ts";
import type {
  ControlApiIdentityPort,
  ControlApiReadinessPort,
  RunRouteResolverPort,
} from "./control-api-ports.ts";
import { requestContext } from "./request-context.ts";
import { RunEventHub } from "./run-event-hub.ts";
import { streamRunEvents } from "./run-event-stream.ts";
import {
  IntervalThreadEventPoller,
  streamThreadEvents,
  type ThreadEventPoller,
} from "./thread-event-stream.ts";
import {
  IntervalThreadGoalEventPoller,
  streamThreadGoalEvents,
  type ThreadGoalEventPoller,
} from "./thread-goal-event-stream.ts";
import { projectAgentVersion } from "./agent-version-projection.ts";
import { projectArtifact } from "./artifact-projection.ts";
import {
  projectAutomation,
  projectAutomationInvocation,
  projectAutomationMutation,
} from "./automation-projection.ts";
import { projectRun, projectRunPlanSnapshot } from "./run-projection.ts";
import {
  projectMessage,
  projectThread,
  projectThreadSnapshot,
  projectThreadGoal,
  projectThreadGoalMutation,
} from "./thread-projection.ts";
import { projectToolApproval } from "./tool-approval-projection.ts";
import { ProviderProbeIdempotencyCoordinator } from "./provider-probe-idempotency.ts";
import type { ControlProviderProbeService } from "./provider-probe-worker-client.ts";
import {
  pausedAdmissionResponse,
  type ProcessLocalActivationGate,
} from "./paused-admission.ts";
import {
  projectModelProviderProbe,
  projectModelProviderSettings,
  type ProviderRuntimeRouteAvailability,
} from "./provider-settings-projection.ts";
import {
  projectWorkspaceOperationList,
  projectWorkspaceOperationMutation,
  projectWorkspaceOperationSnapshot,
} from "./workspace-operation-projection.ts";
import {
  IntervalWorkspaceOperationEventPoller,
  streamWorkspaceOperationEvents,
  type WorkspaceOperationEventPoller,
} from "./workspace-operation-event-stream.ts";
import {
  projectWorkflowVersion,
  projectWorkflowVersionSummary,
} from "./workflow-version-projection.ts";
import type {
  SandboxGitSummaryView,
  ThreadSandboxPort,
} from "./pim-sandbox-client.ts";

export type ControlApiDependencies = Readonly<{
  deliveries?: DeliveryApplicationService | null;
  skills?: DemonstratedSkillService | null;
  skillRecordings?: SkillRecordingStore | null;
  skillGenerations?: SkillDraftGenerationService | null;
