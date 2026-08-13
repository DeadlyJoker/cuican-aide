import type { components, operations, paths } from "./generated/control-api.ts";

import { ContractValidationError } from "./contract-validation-error.ts";

export type ControlApiPaths = paths;
export type ControlApiOperations = operations;
export type AccountSnapshot = components["schemas"]["AccountSnapshot"];
export type GetAccountSnapshotResponse =
  components["schemas"]["GetAccountSnapshotResponse"];
export type LocalSettings = components["schemas"]["LocalSettings"];
export type LocalSettingsResponse =
  components["schemas"]["LocalSettingsResponse"];
export type PutLocalSettingsRequest =
  components["schemas"]["PutLocalSettingsRequest"];
export type ModelProviderBindingView =
  components["schemas"]["ModelProviderBindingView"];
export type ModelProviderSettingsSnapshot =
  components["schemas"]["ModelProviderSettingsSnapshot"];
export type GetModelProviderSettingsResponse =
  components["schemas"]["GetModelProviderSettingsResponse"];
export type ProbeModelProviderRequest =
  components["schemas"]["ProbeModelProviderRequest"];
export type ProbeModelProviderResponse =
  components["schemas"]["ProbeModelProviderResponse"];
export type CreateAutomationRequest =
  components["schemas"]["CreateAutomationRequest"];
export type RunAutomationNowRequest =
  components["schemas"]["RunAutomationNowRequest"];
export type AutomationView = components["schemas"]["AutomationView"];
export type AutomationMutationResponse =
  components["schemas"]["AutomationMutationResponse"];
export type GetAutomationResponse =
  components["schemas"]["GetAutomationResponse"];
export type ListAutomationsResponse =
  components["schemas"]["ListAutomationsResponse"];
export type CreateKnowledgeRequest =
  components["schemas"]["CreateKnowledgeRequest"];
export type KnowledgeView = components["schemas"]["KnowledgeView"];
export type KnowledgeMutationResponse =
  components["schemas"]["KnowledgeMutationResponse"];
export type GetKnowledgeResponse =
  components["schemas"]["GetKnowledgeResponse"];
export type ListKnowledgeResponse =
  components["schemas"]["ListKnowledgeResponse"];
export type AutomationInvocationView =
  components["schemas"]["AutomationInvocationView"];
export type RunAutomationNowResponse =
  components["schemas"]["RunAutomationNowResponse"];
export type CreateThreadRequest = components["schemas"]["CreateThreadRequest"];
export type AppendThreadMessageRequest =
  components["schemas"]["AppendThreadMessageRequest"];
export type ForkThreadRequest = components["schemas"]["ForkThreadRequest"];
export type RollbackThreadRequest =
  components["schemas"]["RollbackThreadRequest"];
export type ArchiveThreadRequest =
  components["schemas"]["ArchiveThreadRequest"];
export type UnarchiveThreadRequest =
  components["schemas"]["UnarchiveThreadRequest"];
export type RenameThreadRequest = components["schemas"]["RenameThreadRequest"];
export type DeleteThreadRequest = components["schemas"]["DeleteThreadRequest"];
export type ThreadView = components["schemas"]["ThreadView"];
export type ThreadEventView = components["schemas"]["ThreadEventView"];
export type MessageView = components["schemas"]["MessageView"];
export type ProposedPlanView = components["schemas"]["ProposedPlanView"];
export type ThreadMutationResponse =
  components["schemas"]["ThreadMutationResponse"];
export type AppendThreadMessageResponse =
  components["schemas"]["AppendThreadMessageResponse"];
export type GetThreadResponse = components["schemas"]["GetThreadResponse"];
export type ThreadGoalView = components["schemas"]["ThreadGoalView"];
export type GetThreadGoalResponse =
  components["schemas"]["GetThreadGoalResponse"];
export type SetThreadGoalRequest =
  components["schemas"]["SetThreadGoalRequest"];
export type ClearThreadGoalRequest =
  components["schemas"]["ClearThreadGoalRequest"];
export type ThreadGoalMutationResponse =
  components["schemas"]["ThreadGoalMutationResponse"];
export type ThreadGoalEventView = components["schemas"]["ThreadGoalEventView"];
export type ListThreadsResponse = components["schemas"]["ListThreadsResponse"];
export type ListThreadMessagesResponse =
  components["schemas"]["ListThreadMessagesResponse"];
export type CreateRunRequest = components["schemas"]["CreateRunRequest"];
export type StartWorkflowRunRequest =
  components["schemas"]["StartWorkflowRunRequest"];
export type DecideWorkflowHumanGateRequest =
  components["schemas"]["DecideWorkflowHumanGateRequest"];
export type WorkflowHumanGateDecisionResponse =
  components["schemas"]["WorkflowHumanGateDecisionResponse"];
export type StartTurnRequest = components["schemas"]["StartTurnRequest"];
export type CompactThreadRequest =
  components["schemas"]["CompactThreadRequest"];
export type StartTurnResponse = components["schemas"]["StartTurnResponse"];
export type CancelRunRequest = components["schemas"]["CancelRunRequest"];
export type RunView = components["schemas"]["RunView"];
export type RunMutationResponse = components["schemas"]["RunMutationResponse"];
export type GetRunResponse = components["schemas"]["GetRunResponse"];
export type ListThreadRunsResponse =
  components["schemas"]["ListThreadRunsResponse"];
export type RunEventView = components["schemas"]["RunEventView"];
export type DecideToolApprovalRequest =
  components["schemas"]["DecideToolApprovalRequest"];
export type ToolApprovalView = components["schemas"]["ToolApprovalView"];
export type GetToolApprovalResponse =
  components["schemas"]["GetToolApprovalResponse"];
export type ToolApprovalMutationResponse =
  components["schemas"]["ToolApprovalMutationResponse"];
export type PublishAgentVersionRequest =
  components["schemas"]["PublishAgentVersionRequest"];
export type AgentVersionView = components["schemas"]["AgentVersionView"];
export type AgentVersionMutationResponse =
  components["schemas"]["AgentVersionMutationResponse"];
export type GetAgentVersionResponse =
  components["schemas"]["GetAgentVersionResponse"];
export type ListAgentVersionsResponse =
  components["schemas"]["ListAgentVersionsResponse"];
export type PublishWorkflowVersionRequest =
  components["schemas"]["PublishWorkflowVersionRequest"];
export type WorkflowVersionView = components["schemas"]["WorkflowVersionView"];
export type WorkflowVersionSummaryView =
  components["schemas"]["WorkflowVersionSummaryView"];
export type WorkflowVersionMutationResponse =
  components["schemas"]["WorkflowVersionMutationResponse"];
export type GetWorkflowVersionResponse =
  components["schemas"]["GetWorkflowVersionResponse"];
export type ListWorkflowVersionsResponse =
  components["schemas"]["ListWorkflowVersionsResponse"];
export type ActiveAgentVersionCatalogResponse =
  components["schemas"]["ActiveAgentVersionCatalogResponse"];
export type CapabilitySummaryView =
  components["schemas"]["CapabilitySummaryView"];
export type ListActiveCapabilitiesResponse =
  components["schemas"]["ListActiveCapabilitiesResponse"];
export type ArtifactView = components["schemas"]["ArtifactView"];
export type GetArtifactResponse = components["schemas"]["GetArtifactResponse"];
export type ControlApiWorkspaceOperations = Pick<
  operations,
  | "createWorkspaceList"
  | "listWorkspaceOperations"
  | "getWorkspaceOperation"
  | "reconcileWorkspaceOperation"
  | "cancelWorkspaceOperation"
  | "streamWorkspaceOperationEvents"
>;
export type ErrorCategory = components["schemas"]["ErrorCategory"];
export type ErrorEnvelope = components["schemas"]["ErrorEnvelope"];
export type RunEventViewMode = "client" | "audit";
export type ThreadHistoryViewMode = "standard" | "audit";

const MAX_RESOURCE_ID_LENGTH = 128;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const MAX_THREAD_TITLE_LENGTH = 256;
const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_WORKFLOW_INPUT_BYTES = 32 * 1024;
const MAX_WORKFLOW_INPUT_DEPTH = 8;
const MAX_WORKFLOW_INPUT_NODES = 1024;
const MAX_WORKFLOW_INPUT_COLLECTION_SIZE = 256;
const MAX_WORKFLOW_INPUT_STRING_BYTES = 8192;
const MAX_THREAD_GOAL_OBJECTIVE_CHARS = 4_000;
const MAX_ROLLBACK_TURNS = 0xffff_ffff;
const MAX_MESSAGE_PAGE_SIZE = 100;
const MESSAGE_CURSOR_PREFIX = "crewon.message.cursor.v1:";
const AGENT_VERSION_CURSOR_PREFIX = "crewon.agent-version.cursor.v1:";
const CAPABILITY_CURSOR_PREFIX = "crewon.capability.cursor.v1:";
const WORKFLOW_VERSION_CURSOR_PREFIX = "crewon.workflow-version.cursor.v1:";
const THREAD_CURSOR_PREFIX = "crewon.thread.cursor.v1:";
const THREAD_RUN_CURSOR_PREFIX = "crewon.thread-run.cursor.v1:";
const AUTOMATION_CURSOR_PREFIX = "crewon.automation.cursor.v1:";
const KNOWLEDGE_CURSOR_PREFIX = "crewon.knowledge.cursor.v1:";

export function parseCreateKnowledgeRequest(
  input: unknown,
): CreateKnowledgeRequest {
  if (!hasExactKeys(input, ["content", "kind", "sourceId", "title"]))
    throw new ContractValidationError("create_knowledge_fields_invalid");
  if (input.kind !== "memory" && input.kind !== "source")
    throw new ContractValidationError("knowledge_kind_invalid");
  const sourceId = requireBoundedString(
    input.sourceId,
    128,
    "knowledge_source_id_invalid",
  );
  const title = canonicalUtf8(input.title, 256, "knowledge_title_invalid");
  const content = canonicalUtf8(
    input.content,
    32 * 1024,
    "knowledge_content_invalid",
  );
  return { kind: input.kind, sourceId, title, content };
}
export function parseKnowledgeId(input: unknown): string {
  return requireBoundedString(
    input,
    MAX_RESOURCE_ID_LENGTH,
    "knowledge_id_invalid",
  );
}
export function parseKnowledgeListQuery(input: unknown): ResourceListQuery {
  return parseResourceListQuery(
    input,
    KNOWLEDGE_CURSOR_PREFIX,
    "knowledge_cursor_invalid",
  );
}
export function formatKnowledgeCursor(input: {
  createdAt: string;
  knowledgeId: string;
}): string {
  return formatResourceCursor(
    {
      updatedAt: input.createdAt,
      resourceId: parseKnowledgeId(input.knowledgeId),
    },
    KNOWLEDGE_CURSOR_PREFIX,
    "knowledge_cursor_invalid",
  );
}

function canonicalUtf8(input: unknown, maximum: number, code: string): string {
  const value = requireBoundedString(input, maximum, code);
  if (
    value.normalize("NFC") !== value ||
    new TextEncoder().encode(value).byteLength > maximum
  )
    throw new ContractValidationError(code);
  return value;
}

export type MessageListQuery = Readonly<{
  afterSequence: number;
  limit: number;
  view: ThreadHistoryViewMode;
}>;

export type AgentVersionListQuery = Readonly<{
  afterAgentVersionId: string | null;
  limit: number;
}>;

export type CapabilityListQuery = Readonly<{
  releaseId: string | null;
  afterKey: string | null;
  limit: number;
}>;

export type WorkflowVersionListQuery = Readonly<{
  workflowId: string;
  afterWorkflowVersionId: string | null;
  limit: number;
}>;

export type ResourceListCursor = Readonly<{
  updatedAt: string;
  resourceId: string;
}>;

export type ResourceListQuery = Readonly<{
  before: ResourceListCursor | null;
  limit: number;
}>;

export function parseCreateThreadRequest(input: unknown): CreateThreadRequest {
  if (!hasExactKeys(input, ["title"])) {
    throw new ContractValidationError("create_thread_fields_invalid");
  }
  if (input.title === null) {
    return { title: null };
  }
  return {
    title: requireBoundedString(
      input.title,
      MAX_THREAD_TITLE_LENGTH,
      "thread_title_invalid",
    ),
  };
}

export function parseProbeModelProviderRequest(
  input: unknown,
): ProbeModelProviderRequest {
  if (!hasExactKeys(input, [])) {
    throw new ContractValidationError("model_provider_probe_fields_invalid");
  }
  return {};
}

export function parsePutLocalSettingsRequest(
  input: unknown,
): PutLocalSettingsRequest {
  if (!hasExactKeys(input, ["expectedRevision", "locale", "theme"])) {
    throw new ContractValidationError("local_settings_request_invalid");
  }
  if (
    (input.locale !== "en" && input.locale !== "zh") ||
    (input.theme !== "dark" && input.theme !== "light") ||
    !Number.isSafeInteger(input.expectedRevision) ||
    Number(input.expectedRevision) < 0
  ) {
    throw new ContractValidationError("local_settings_request_invalid");
  }
  return {
    expectedRevision: Number(input.expectedRevision),
    locale: input.locale,
    theme: input.theme,
  };
}

export function parseCreateAutomationRequest(
  input: unknown,
): CreateAutomationRequest {
  if (
    !hasExactKeys(input, [
      "agentVersionId",
      "expectedThreadRevision",
      "prompt",
      "threadId",
      "title",
    ])
  ) {
    throw new ContractValidationError("create_automation_fields_invalid");
  }
  if (
    !Number.isSafeInteger(input.expectedThreadRevision) ||
    Number(input.expectedThreadRevision) < 1
  ) {
    throw new ContractValidationError("expected_revision_invalid");
  }
  const prompt = requireBoundedString(
    input.prompt,
    9_999,
    "automation_prompt_invalid",
  );
  if (new TextEncoder().encode(prompt).byteLength > 9_999) {
    throw new ContractValidationError("automation_prompt_too_large");
  }
  return {
    threadId: parseThreadId(input.threadId),
    expectedThreadRevision: Number(input.expectedThreadRevision),
    title: requireBoundedString(
      input.title,
      MAX_THREAD_TITLE_LENGTH,
      "automation_title_invalid",
    ),
    prompt,
    agentVersionId:
      input.agentVersionId === null
        ? null
        : parseAgentVersionId(input.agentVersionId),
  };
}

export function parseRunAutomationNowRequest(
  input: unknown,
): RunAutomationNowRequest {
  if (
    !hasExactKeys(input, [
      "expectedAutomationRevision",
      "expectedThreadRevision",
    ])
  ) {
    throw new ContractValidationError("run_automation_fields_invalid");
  }
  if (
    input.expectedAutomationRevision !== 1 ||
    !Number.isSafeInteger(input.expectedThreadRevision) ||
    Number(input.expectedThreadRevision) < 1
  ) {
    throw new ContractValidationError("automation_revision_invalid");
  }
  return {
    expectedAutomationRevision: 1,
    expectedThreadRevision: Number(input.expectedThreadRevision),
  };
}

export function parseAutomationId(input: unknown): string {
  return requireBoundedString(
    input,
    MAX_RESOURCE_ID_LENGTH,
    "automation_id_invalid",
  );
}

export function parseAutomationListQuery(input: unknown): ResourceListQuery {
  return parseResourceListQuery(
    input,
    AUTOMATION_CURSOR_PREFIX,
    "automation_cursor_invalid",
  );
}

export function formatAutomationCursor(input: {
  updatedAt: string;
  automationId: string;
}): string {
  return formatResourceCursor(
    {
      updatedAt: input.updatedAt,
      resourceId: parseAutomationId(input.automationId),
    },
    AUTOMATION_CURSOR_PREFIX,
    "automation_cursor_invalid",
  );
}

export function parseAppendThreadMessageRequest(
  input: unknown,
): AppendThreadMessageRequest {
  if (!hasExactKeys(input, ["content", "expectedRevision"])) {
    throw new ContractValidationError("append_message_fields_invalid");
  }
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    Number(input.expectedRevision) < 1
  ) {
    throw new ContractValidationError("expected_revision_invalid");
  }
  const content = requireBoundedString(
    input.content,
    MAX_MESSAGE_BYTES,
    "message_content_invalid",
  );
  if (new TextEncoder().encode(content).byteLength > MAX_MESSAGE_BYTES) {
    throw new ContractValidationError("message_content_too_large");
  }
  return { expectedRevision: Number(input.expectedRevision), content };
}

export function parseSetThreadGoalRequest(
  input: unknown,
): SetThreadGoalRequest {
  if (
    !hasExactKeys(input, [
      "expectedRevision",
      "objective",
      "status",
      "tokenBudget",
    ])
  ) {
    throw new ContractValidationError("set_thread_goal_fields_invalid");
  }
  const expectedRevision = parseNullableExpectedRevision(
    input.expectedRevision,
  );
  const objective =
    input.objective === null
      ? null
      : requireThreadGoalObjective(input.objective);
  const status = parseNullableThreadGoalStatus(input.status);
  const tokenBudget = parseThreadGoalTokenBudgetUpdate(input.tokenBudget);
  return { expectedRevision, objective, status, tokenBudget };
}

export function parseClearThreadGoalRequest(
  input: unknown,
): ClearThreadGoalRequest {
  if (!hasExactKeys(input, ["expectedRevision"])) {
    throw new ContractValidationError("clear_thread_goal_fields_invalid");
  }
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    Number(input.expectedRevision) < 1
  ) {
    throw new ContractValidationError("expected_revision_invalid");
  }
  return { expectedRevision: Number(input.expectedRevision) };
}

export function parseForkThreadRequest(input: unknown): ForkThreadRequest {
  if (!hasExactKeys(input, ["expectedRevision", "throughHistorySequence"])) {
    throw new ContractValidationError("fork_thread_fields_invalid");
  }
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    Number(input.expectedRevision) < 1 ||
    (input.throughHistorySequence !== null &&
      (!Number.isSafeInteger(input.throughHistorySequence) ||
        Number(input.throughHistorySequence) < 0))
  ) {
    throw new ContractValidationError("fork_thread_boundary_invalid");
  }
  return {
    expectedRevision: Number(input.expectedRevision),
    throughHistorySequence:
      input.throughHistorySequence === null
        ? null
        : Number(input.throughHistorySequence),
  };
}

export function parseRollbackThreadRequest(
  input: unknown,
): RollbackThreadRequest {
  if (!hasExactKeys(input, ["expectedRevision", "numTurns"])) {
    throw new ContractValidationError("rollback_thread_fields_invalid");
  }
  const expectedRevision = requireExpectedRevision(input.expectedRevision);
  if (
    !Number.isSafeInteger(input.numTurns) ||
    Number(input.numTurns) < 1 ||
    Number(input.numTurns) > MAX_ROLLBACK_TURNS
  ) {
    throw new ContractValidationError("rollback_num_turns_invalid");
  }
  return { expectedRevision, numTurns: Number(input.numTurns) };
}

export function parseArchiveThreadRequest(
  input: unknown,
): ArchiveThreadRequest {
  if (!hasExactKeys(input, ["expectedRevision"])) {
    throw new ContractValidationError("archive_thread_fields_invalid");
  }
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    Number(input.expectedRevision) < 1
  ) {
    throw new ContractValidationError("expected_revision_invalid");
  }
  return { expectedRevision: Number(input.expectedRevision) };
}

export function parseUnarchiveThreadRequest(
  input: unknown,
): UnarchiveThreadRequest {
  return parseExpectedThreadRevisionRequest(
    input,
    "unarchive_thread_fields_invalid",
  );
}

export function parseRenameThreadRequest(input: unknown): RenameThreadRequest {
  if (!hasExactKeys(input, ["expectedRevision", "title"])) {
    throw new ContractValidationError("rename_thread_fields_invalid");
  }
  const expectedRevision = requireExpectedRevision(input.expectedRevision);
  const title =
    input.title === null
      ? null
      : requireBoundedString(
          input.title,
          MAX_THREAD_TITLE_LENGTH,
          "thread_title_invalid",
        );
  return { expectedRevision, title };
}

export function parseDeleteThreadRequest(input: unknown): DeleteThreadRequest {
  return parseExpectedThreadRevisionRequest(
    input,
    "delete_thread_fields_invalid",
  );
}

export function parseThreadHistoryView(input: unknown): ThreadHistoryViewMode {
  if (input === undefined || input === "standard") return "standard";
  if (input === "audit") return "audit";
  throw new ContractValidationError("thread_history_view_invalid");
}

function parseExpectedThreadRevisionRequest(
  input: unknown,
  fieldsCode: string,
): { expectedRevision: number } {
  if (!hasExactKeys(input, ["expectedRevision"])) {
    throw new ContractValidationError(fieldsCode);
  }
  return { expectedRevision: requireExpectedRevision(input.expectedRevision) };
}

function requireExpectedRevision(input: unknown): number {
  if (!Number.isSafeInteger(input) || Number(input) < 1) {
    throw new ContractValidationError("expected_revision_invalid");
  }
  return Number(input);
}

export function parseThreadId(input: unknown): string {
  return requireBoundedString(
    input,
    MAX_RESOURCE_ID_LENGTH,
    "thread_id_invalid",
  );
}

export function parseThreadListQuery(input: unknown): ResourceListQuery {
  return parseResourceListQuery(
    input,
    THREAD_CURSOR_PREFIX,
    "thread_cursor_invalid",
  );
}

export function formatThreadCursor(input: {
  updatedAt: string;
  threadId: string;
}): string {
  return formatResourceCursor(
    { updatedAt: input.updatedAt, resourceId: parseThreadId(input.threadId) },
    THREAD_CURSOR_PREFIX,
    "thread_cursor_invalid",
  );
}

export function parseMessageListQuery(input: unknown): MessageListQuery {
  if (!isPlainObject(input)) {
    throw new ContractValidationError("message_list_query_invalid");
  }
  const keys = Object.keys(input);
  if (
    keys.some((key) => key !== "cursor" && key !== "limit" && key !== "view")
  ) {
    throw new ContractValidationError("message_list_query_invalid");
  }
  return {
    afterSequence: parseMessageCursor(input.cursor),
    limit: parseUnsignedQueryInteger(
      input.limit,
      100,
      MAX_MESSAGE_PAGE_SIZE,
      "page_limit_invalid",
      1,
    ),
    view: parseThreadHistoryView(input.view),
  };
}

export function formatMessageCursor(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new ContractValidationError("message_cursor_invalid");
  }
  return base64UrlEncode(`${MESSAGE_CURSOR_PREFIX}${sequence}`);
}

export function parseCreateRunRequest(input: unknown): CreateRunRequest {
  if (
    !isPlainObject(input) ||
    !hasOnlyKeys(input, ["agentVersionId", "threadId"]) ||
    !Object.hasOwn(input, "threadId")
  ) {
    throw new ContractValidationError("create_run_fields_invalid");
  }
  const threadId = requireBoundedString(
    input.threadId,
    MAX_RESOURCE_ID_LENGTH,
    "thread_id_invalid",
  );
  if (!Object.hasOwn(input, "agentVersionId")) {
    return { threadId };
  }
  return {
    threadId,
    agentVersionId:
      input.agentVersionId === null
        ? null
        : parseAgentVersionId(input.agentVersionId),
  };
}

export function parseStartWorkflowRunRequest(
  input: unknown,
): StartWorkflowRunRequest {
  if (!hasExactKeys(input, ["input", "threadId", "workflowVersionId"])) {
    throw new ContractValidationError("workflow_run_fields_invalid");
  }
  const workflowInput = parseWorkflowInput(input.input);
  if (
    new TextEncoder().encode(JSON.stringify(workflowInput)).byteLength >
    MAX_WORKFLOW_INPUT_BYTES
  ) {
    throw new ContractValidationError("workflow_input_too_large");
  }
  return {
    workflowVersionId: parseWorkflowVersionId(input.workflowVersionId),
    threadId: parseThreadId(input.threadId),
    input: workflowInput,
  };
}

export function parseDecideWorkflowHumanGateRequest(
  input: unknown,
): DecideWorkflowHumanGateRequest {
  if (
    !hasExactKeys(input, [
      "claimEpoch",
      "claimId",
      "decision",
      "gateRequestId",
      "nodeId",
      "runId",
    ])
  )
    throw new ContractValidationError("workflow_gate_fields_invalid");
  if (!Number.isSafeInteger(input.claimEpoch) || Number(input.claimEpoch) < 1)
    throw new ContractValidationError("workflow_gate_claim_epoch_invalid");
  if (input.decision !== "approve" && input.decision !== "reject")
    throw new ContractValidationError("workflow_gate_decision_invalid");
  return {
    runId: parseRunId(input.runId),
    nodeId: requireBoundedUtf8String(
      input.nodeId,
      256,
      "workflow_gate_node_id_invalid",
    ),
    claimId: requireBoundedUtf8String(
      input.claimId,
      256,
      "workflow_gate_claim_id_invalid",
    ),
    claimEpoch: Number(input.claimEpoch),
    gateRequestId: requireBoundedUtf8String(
      input.gateRequestId,
      256,
      "workflow_gate_request_id_invalid",
    ),
    decision: input.decision,
  };
}

function parseWorkflowInput(input: unknown): StartWorkflowRunRequest["input"] {
  let nodes = 0;
  const visit = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_WORKFLOW_INPUT_NODES || depth > MAX_WORKFLOW_INPUT_DEPTH) {
      throw new ContractValidationError("workflow_input_too_large");
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      if (
        new TextEncoder().encode(value).byteLength >
        MAX_WORKFLOW_INPUT_STRING_BYTES
      ) {
        throw new ContractValidationError("workflow_input_too_large");
      }
      return value;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_WORKFLOW_INPUT_COLLECTION_SIZE) {
        throw new ContractValidationError("workflow_input_too_large");
      }
      return value.map((item) => visit(item, depth + 1));
    }
    if (isPlainObject(value)) {
      const entries = Object.entries(value);
      if (entries.length > MAX_WORKFLOW_INPUT_COLLECTION_SIZE) {
        throw new ContractValidationError("workflow_input_too_large");
      }
      return Object.fromEntries(
        entries.map(([key, item]) => {
          if (key.length === 0 || [...key].length > MAX_RESOURCE_ID_LENGTH) {
            throw new ContractValidationError("workflow_input_invalid");
          }
          return [key, visit(item, depth + 1)];
        }),
      );
    }
    throw new ContractValidationError("workflow_input_invalid");
  };
  return visit(input, 0) as StartWorkflowRunRequest["input"];
}

export function parseStartTurnRequest(input: unknown): StartTurnRequest {
  if (
    !hasExactKeys(input, [
      "agentVersionId",
      "content",
      "executionIntent",
      "expectedRevision",
    ])
  ) {
    throw new ContractValidationError("start_turn_fields_invalid");
  }
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    Number(input.expectedRevision) < 1
  ) {
    throw new ContractValidationError("expected_revision_invalid");
  }
  const content = requireBoundedString(
    input.content,
    MAX_MESSAGE_BYTES,
    "message_content_invalid",
  );
  if (new TextEncoder().encode(content).byteLength > MAX_MESSAGE_BYTES) {
    throw new ContractValidationError("message_content_too_large");
  }
  if (
    input.executionIntent !== "none" &&
    input.executionIntent !== "goal" &&
    input.executionIntent !== "plan"
  ) {
    throw new ContractValidationError("execution_intent_invalid");
  }
  return {
    expectedRevision: Number(input.expectedRevision),
    content,
    agentVersionId:
      input.agentVersionId === null
        ? null
        : parseAgentVersionId(input.agentVersionId),
    executionIntent: input.executionIntent,
  };
}

export function parseCompactThreadRequest(
  input: unknown,
): CompactThreadRequest {
  if (!hasExactKeys(input, ["agentVersionId", "expectedRevision"])) {
    throw new ContractValidationError("compact_thread_fields_invalid");
  }
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    Number(input.expectedRevision) < 1
  ) {
    throw new ContractValidationError("expected_revision_invalid");
  }
  return {
    expectedRevision: Number(input.expectedRevision),
    agentVersionId:
      input.agentVersionId === null
        ? null
        : parseAgentVersionId(input.agentVersionId),
  };
}

export function parsePublishAgentVersionRequest(
  input: unknown,
): PublishAgentVersionRequest {
  if (
    !hasExactKeys(input, [
      "agentVersionId",
      "execution",
      "instructions",
      "model",
      "policySnapshotId",
      "resources",
      "runtimeGeneration",
      "schemaVersion",
      "tools",
    ])
  ) {
    throw new ContractValidationError("agent_version_fields_invalid");
  }
  return structuredClone(input) as PublishAgentVersionRequest;
}

export function parseAgentVersionId(input: unknown): string {
  return requireBoundedString(input, 512, "agent_version_id_invalid");
}

export function parseAgentVersionListQuery(
  input: unknown,
): AgentVersionListQuery {
  if (!isPlainObject(input)) {
    throw new ContractValidationError("agent_version_list_query_invalid");
  }
  const keys = Object.keys(input);
  if (keys.some((key) => key !== "cursor" && key !== "limit")) {
    throw new ContractValidationError("agent_version_list_query_invalid");
  }
  return {
    afterAgentVersionId: parseAgentVersionCursor(input.cursor),
    limit: parseUnsignedQueryInteger(
      input.limit,
      100,
      100,
      "page_limit_invalid",
      1,
    ),
  };
}

export function formatAgentVersionCursor(agentVersionId: string): string {
  const id = parseAgentVersionId(agentVersionId);
  return base64UrlEncode(`${AGENT_VERSION_CURSOR_PREFIX}${id}`);
}

export function parseCapabilityListQuery(input: unknown): CapabilityListQuery {
  if (!isPlainObject(input)) {
    throw new ContractValidationError("capability_list_query_invalid");
  }
  const keys = Object.keys(input);
  if (keys.some((key) => key !== "cursor" && key !== "limit")) {
    throw new ContractValidationError("capability_list_query_invalid");
  }
  const cursor = parseCapabilityCursor(input.cursor);
  return {
    releaseId: cursor?.releaseId ?? null,
    afterKey: cursor?.afterKey ?? null,
    limit: parseUnsignedQueryInteger(
      input.limit,
      100,
      100,
      "page_limit_invalid",
      1,
    ),
  };
}

export function formatCapabilityCursor(input: {
  releaseId: string;
  afterKey: string;
}): string {
  const releaseId = requireCapabilityReleaseId(input.releaseId);
  const afterKey = requireBoundedString(
    input.afterKey,
    2048,
    "capability_cursor_invalid",
  );
  return base64UrlEncode(
    `${CAPABILITY_CURSOR_PREFIX}${JSON.stringify([releaseId, afterKey])}`,
  );
}

export function parsePublishWorkflowVersionRequest(
  input: unknown,
): PublishWorkflowVersionRequest {
  if (
    !hasExactKeys(input, [
      "description",
      "entryNodeIds",
      "inputSchema",
      "name",
      "nodes",
      "outputNodeIds",
      "outputSchema",
      "schemaVersion",
      "workflowId",
      "workflowVersionId",
    ])
  ) {
    throw new ContractValidationError("workflow_version_fields_invalid");
  }
  return structuredClone(input) as PublishWorkflowVersionRequest;
}

export function parseWorkflowVersionId(input: unknown): string {
  return requireBoundedString(input, 512, "workflow_version_id_invalid");
}

export function parseWorkflowVersionListQuery(
  input: unknown,
): WorkflowVersionListQuery {
  if (!isPlainObject(input)) {
    throw new ContractValidationError("workflow_version_list_query_invalid");
  }
  const keys = Object.keys(input);
  if (
    keys.some(
      (key) => key !== "workflowId" && key !== "cursor" && key !== "limit",
    )
  ) {
    throw new ContractValidationError("workflow_version_list_query_invalid");
  }
  const workflowId = requireBoundedString(
    input.workflowId,
    512,
    "workflow_id_invalid",
  );
  const cursor = parseWorkflowVersionCursor(input.cursor);
  if (cursor !== null && cursor.workflowId !== workflowId) {
    throw new ContractValidationError("workflow_version_cursor_invalid");
  }
  return {
    workflowId,
    afterWorkflowVersionId: cursor?.workflowVersionId ?? null,
    limit: parseUnsignedQueryInteger(
      input.limit,
      100,
      100,
      "page_limit_invalid",
      1,
    ),
  };
}

export function formatWorkflowVersionCursor(
  workflowId: string,
  workflowVersionId: string,
): string {
  const boundedWorkflowId = requireBoundedString(
    workflowId,
    512,
    "workflow_id_invalid",
  );
  const boundedVersionId = parseWorkflowVersionId(workflowVersionId);
  return base64UrlEncode(
    `${WORKFLOW_VERSION_CURSOR_PREFIX}${JSON.stringify([boundedWorkflowId, boundedVersionId])}`,
  );
}

export function parseCancelRunRequest(input: unknown): CancelRunRequest {
  if (!hasExactKeys(input, ["expectedRevision"])) {
    throw new ContractValidationError("cancel_run_fields_invalid");
  }
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    Number(input.expectedRevision) < 1
  ) {
    throw new ContractValidationError("expected_revision_invalid");
  }
  return { expectedRevision: Number(input.expectedRevision) };
}

export function parseRunId(input: unknown): string {
  return requireBoundedString(input, MAX_RESOURCE_ID_LENGTH, "run_id_invalid");
}

export function parseThreadRunListQuery(input: unknown): ResourceListQuery {
  return parseResourceListQuery(
    input,
    THREAD_RUN_CURSOR_PREFIX,
    "run_cursor_invalid",
  );
}

export function formatThreadRunCursor(input: {
  updatedAt: string;
  runId: string;
}): string {
  return formatResourceCursor(
    { updatedAt: input.updatedAt, resourceId: parseRunId(input.runId) },
    THREAD_RUN_CURSOR_PREFIX,
    "run_cursor_invalid",
  );
}

export function parseApprovalId(input: unknown): string {
  return requireBoundedString(
    input,
    MAX_RESOURCE_ID_LENGTH,
    "approval_id_invalid",
  );
}

export function parseArtifactId(input: unknown): string {
  const artifactId = requireBoundedString(input, 512, "artifact_id_invalid");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(artifactId)) {
    throw new ContractValidationError("artifact_id_invalid");
  }
  return artifactId;
}

export function parseDecideToolApprovalRequest(
  input: unknown,
): DecideToolApprovalRequest {
  if (!hasExactKeys(input, ["comment", "decision", "expectedRevision"])) {
    throw new ContractValidationError("approval_decision_fields_invalid");
  }
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    Number(input.expectedRevision) < 1
  ) {
    throw new ContractValidationError("expected_revision_invalid");
  }
  if (input.decision !== "approved" && input.decision !== "rejected") {
    throw new ContractValidationError("approval_decision_invalid");
  }
  if (
    input.comment !== null &&
    (typeof input.comment !== "string" ||
      input.comment.trim().length === 0 ||
      new TextEncoder().encode(input.comment).byteLength > 2_048)
  ) {
    throw new ContractValidationError("approval_comment_invalid");
  }
  return {
    expectedRevision: Number(input.expectedRevision),
    decision: input.decision,
    comment: input.comment,
  };
}

export function parseIdempotencyKey(input: unknown): string {
  return requireBoundedString(
    input,
    MAX_IDEMPOTENCY_KEY_LENGTH,
    "idempotency_key_invalid",
  );
}

export function parseLastEventSequence(input: unknown): number {
  if (input === undefined) {
    return 0;
  }
  if (typeof input !== "string" || !/^(0|[1-9][0-9]*)$/.test(input)) {
    throw new ContractValidationError("last_event_id_invalid");
  }
  const sequence = Number(input);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new ContractValidationError("last_event_id_invalid");
  }
  return sequence;
}

export function parseRunEventViewMode(input: unknown): RunEventViewMode {
  if (input === undefined || input === "client") {
    return "client";
  }
  if (input === "audit") {
    return "audit";
  }
  throw new ContractValidationError("run_event_view_invalid");
}

function parseUnsignedQueryInteger(
  input: unknown,
  defaultValue: number,
  maximum: number,
  code: string,
  minimum = 0,
): number {
  if (input === undefined) {
    return defaultValue;
  }
  if (typeof input !== "string" || !/^(0|[1-9][0-9]*)$/.test(input)) {
    throw new ContractValidationError(code);
  }
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ContractValidationError(code);
  }
  return value;
}

function parseMessageCursor(input: unknown): number {
  if (input === undefined) {
    return 0;
  }
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(input)
  ) {
    throw new ContractValidationError("message_cursor_invalid");
  }
  let decoded: string;
  try {
    decoded = base64UrlDecode(input);
  } catch {
    throw new ContractValidationError("message_cursor_invalid");
  }
  if (!decoded.startsWith(MESSAGE_CURSOR_PREFIX)) {
    throw new ContractValidationError("message_cursor_invalid");
  }
  const encodedSequence = decoded.slice(MESSAGE_CURSOR_PREFIX.length);
  if (!/^[1-9][0-9]*$/.test(encodedSequence)) {
    throw new ContractValidationError("message_cursor_invalid");
  }
  const sequence = Number(encodedSequence);
  if (
    !Number.isSafeInteger(sequence) ||
    formatMessageCursor(sequence) !== input
  ) {
    throw new ContractValidationError("message_cursor_invalid");
  }
  return sequence;
}

function parseAgentVersionCursor(input: unknown): string | null {
  if (input === undefined) {
    return null;
  }
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 768 ||
    !/^[A-Za-z0-9_-]+$/u.test(input)
  ) {
    throw new ContractValidationError("agent_version_cursor_invalid");
  }
  let decoded: string;
  try {
    decoded = base64UrlDecode(input);
  } catch {
    throw new ContractValidationError("agent_version_cursor_invalid");
  }
  if (!decoded.startsWith(AGENT_VERSION_CURSOR_PREFIX)) {
    throw new ContractValidationError("agent_version_cursor_invalid");
  }
  let agentVersionId: string;
  try {
    agentVersionId = parseAgentVersionId(
      decoded.slice(AGENT_VERSION_CURSOR_PREFIX.length),
    );
  } catch {
    throw new ContractValidationError("agent_version_cursor_invalid");
  }
  if (formatAgentVersionCursor(agentVersionId) !== input) {
    throw new ContractValidationError("agent_version_cursor_invalid");
  }
  return agentVersionId;
}

function parseWorkflowVersionCursor(input: unknown): Readonly<{
  workflowId: string;
  workflowVersionId: string;
}> | null {
  if (input === undefined) return null;
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 2048 ||
    !/^[A-Za-z0-9_-]+$/u.test(input)
  ) {
    throw new ContractValidationError("workflow_version_cursor_invalid");
  }
  try {
    const decoded = base64UrlDecode(input);
    if (!decoded.startsWith(WORKFLOW_VERSION_CURSOR_PREFIX)) throw new Error();
    const parsed: unknown = JSON.parse(
      decoded.slice(WORKFLOW_VERSION_CURSOR_PREFIX.length),
    );
    if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error();
    const [workflowId, workflowVersionId] = parsed;
    if (
      formatWorkflowVersionCursor(
        requireBoundedString(workflowId, 512, "workflow_id_invalid"),
        parseWorkflowVersionId(workflowVersionId),
      ) !== input
    ) {
      throw new Error();
    }
    return { workflowId, workflowVersionId };
  } catch {
    throw new ContractValidationError("workflow_version_cursor_invalid");
  }
}

function parseCapabilityCursor(input: unknown): Readonly<{
  releaseId: string;
  afterKey: string;
}> | null {
  if (input === undefined) return null;
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 4096 ||
    !/^[A-Za-z0-9_-]+$/u.test(input)
  ) {
    throw new ContractValidationError("capability_cursor_invalid");
  }
  try {
    const decoded = base64UrlDecode(input);
    if (!decoded.startsWith(CAPABILITY_CURSOR_PREFIX)) throw new Error();
    const parsed: unknown = JSON.parse(
      decoded.slice(CAPABILITY_CURSOR_PREFIX.length),
    );
    if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error();
    const releaseId = requireCapabilityReleaseId(parsed[0]);
    const afterKey = requireBoundedString(
      parsed[1],
      2048,
      "capability_cursor_invalid",
    );
    if (formatCapabilityCursor({ releaseId, afterKey }) !== input) {
      throw new Error();
    }
    return { releaseId, afterKey };
  } catch {
    throw new ContractValidationError("capability_cursor_invalid");
  }
}

function requireCapabilityReleaseId(input: unknown): string {
  if (typeof input !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input)) {
    throw new ContractValidationError("capability_cursor_invalid");
  }
  return input;
}

function parseResourceListQuery(
  input: unknown,
  prefix: string,
  cursorCode: string,
): ResourceListQuery {
  if (!isPlainObject(input)) {
    throw new ContractValidationError("resource_list_query_invalid");
  }
  const keys = Object.keys(input);
  if (keys.some((key) => key !== "cursor" && key !== "limit")) {
    throw new ContractValidationError("resource_list_query_invalid");
  }
  return {
    before: parseResourceCursor(input.cursor, prefix, cursorCode),
    limit: parseUnsignedQueryInteger(
      input.limit,
      100,
      100,
      "page_limit_invalid",
      1,
    ),
  };
}

function formatResourceCursor(
  input: ResourceListCursor,
  prefix: string,
  code: string,
): string {
  if (!isRfc3339Utc(input.updatedAt)) {
    throw new ContractValidationError(code);
  }
  const resourceId = requireBoundedString(input.resourceId, 128, code);
  return base64UrlEncode(
    `${prefix}${JSON.stringify([input.updatedAt, resourceId])}`,
  );
}

function parseResourceCursor(
  input: unknown,
  prefix: string,
  code: string,
): ResourceListCursor | null {
  if (input === undefined) {
    return null;
  }
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 512 ||
    !/^[A-Za-z0-9_-]+$/u.test(input)
  ) {
    throw new ContractValidationError(code);
  }
  try {
    const decoded = base64UrlDecode(input);
    if (!decoded.startsWith(prefix)) {
      throw new Error(code);
    }
    const value: unknown = JSON.parse(decoded.slice(prefix.length));
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      !isRfc3339Utc(value[0]) ||
      typeof value[1] !== "string"
    ) {
      throw new Error(code);
    }
    const cursor = { updatedAt: value[0], resourceId: value[1] };
    if (formatResourceCursor(cursor, prefix, code) !== input) {
      throw new Error(code);
    }
    return cursor;
  } catch {
    throw new ContractValidationError(code);
  }
}

function isRfc3339Utc(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlDecode(value: string): string {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder(undefined, { fatal: true }).decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

function requireBoundedString(
  input: unknown,
  maxLength: number,
  code: string,
): string {
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    input.length > maxLength
  ) {
    throw new ContractValidationError(code);
  }
  return input;
}

function requireBoundedUtf8String(
  input: unknown,
  maxBytes: number,
  code: string,
): string {
  const value = requireBoundedString(input, maxBytes, code);
  if (new TextEncoder().encode(value).byteLength > maxBytes)
    throw new ContractValidationError(code);
  return value;
}

function parseNullableExpectedRevision(input: unknown): number | null {
  if (input === null) return null;
  if (!Number.isSafeInteger(input) || Number(input) < 1) {
    throw new ContractValidationError("expected_revision_invalid");
  }
  return Number(input);
}

function parseNullableThreadGoalStatus(
  input: unknown,
): SetThreadGoalRequest["status"] {
  switch (input) {
    case null:
    case "active":
    case "paused":
    case "blocked":
    case "usageLimited":
    case "budgetLimited":
    case "complete":
      return input;
    default:
      throw new ContractValidationError("goal_status_invalid");
  }
}

function parseThreadGoalTokenBudgetUpdate(
  input: unknown,
): SetThreadGoalRequest["tokenBudget"] {
  if (!isPlainObject(input)) {
    throw new ContractValidationError("goal_token_budget_invalid");
  }
  if (input.kind === "keep" && hasExactKeys(input, ["kind"])) {
    return { kind: "keep" };
  }
  if (input.kind === "set" && hasExactKeys(input, ["kind", "value"])) {
    if (
      input.value !== null &&
      (!Number.isSafeInteger(input.value) || Number(input.value) < 1)
    ) {
      throw new ContractValidationError("goal_token_budget_invalid");
    }
    return {
      kind: "set",
      value: input.value === null ? null : Number(input.value),
    };
  }
  throw new ContractValidationError("goal_token_budget_invalid");
}

function requireThreadGoalObjective(input: unknown): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new ContractValidationError("goal_objective_invalid");
  }
  let characters = 0;
  for (const character of input) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      (character.length === 1 && codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      throw new ContractValidationError("goal_objective_invalid");
    }
    characters += 1;
    if (characters > MAX_THREAD_GOAL_OBJECTIVE_CHARS) {
      throw new ContractValidationError("goal_objective_invalid");
    }
  }
  return input;
}

function hasExactKeys(
  input: unknown,
  expectedKeys: readonly string[],
): input is Record<string, unknown> {
  if (!isPlainObject(input)) {
    return false;
  }
  const actualKeys = Object.keys(input).sort();
  const expected = [...expectedKeys].sort();
  return (
    actualKeys.length === expected.length &&
    actualKeys.every((value, index) => value === expected[index])
  );
}

function hasOnlyKeys(
  input: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
): boolean {
  return Object.keys(input).every((key) => allowedKeys.includes(key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
