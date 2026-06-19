import type { AgentMessageDeltaNotification } from "@crewon-protocol/v2/AgentMessageDeltaNotification";
import type { AccountLoginCompletedNotification } from "@crewon-protocol/v2/AccountLoginCompletedNotification";
import type { AccountRateLimitsUpdatedNotification } from "@crewon-protocol/v2/AccountRateLimitsUpdatedNotification";
import type { AccountUpdatedNotification } from "@crewon-protocol/v2/AccountUpdatedNotification";
import type { AppListUpdatedNotification } from "@crewon-protocol/v2/AppListUpdatedNotification";
import type { AppsListResponse } from "@crewon-protocol/v2/AppsListResponse";
import type { AskForApproval } from "@crewon-protocol/v2/AskForApproval";
import type { CommandExecutionOutputDeltaNotification } from "@crewon-protocol/v2/CommandExecutionOutputDeltaNotification";
import type { CommandExecOutputDeltaNotification } from "@crewon-protocol/v2/CommandExecOutputDeltaNotification";
import type { CommandExecResponse } from "@crewon-protocol/v2/CommandExecResponse";
import type { ConfigReadResponse } from "@crewon-protocol/v2/ConfigReadResponse";
import type { ConfigRequirementsReadResponse } from "@crewon-protocol/v2/ConfigRequirementsReadResponse";
import type { ConfigWriteResponse } from "@crewon-protocol/v2/ConfigWriteResponse";
import type { ConfigWarningNotification } from "@crewon-protocol/v2/ConfigWarningNotification";
import type { ContextCompactedNotification } from "@crewon-protocol/v2/ContextCompactedNotification";
import type { ErrorNotification } from "@crewon-protocol/v2/ErrorNotification";
import type { ExternalAgentConfigDetectResponse } from "@crewon-protocol/v2/ExternalAgentConfigDetectResponse";
import type { ExternalAgentConfigImportCompletedNotification } from "@crewon-protocol/v2/ExternalAgentConfigImportCompletedNotification";
import type { ExternalAgentConfigImportResponse } from "@crewon-protocol/v2/ExternalAgentConfigImportResponse";
import type { ExternalAgentConfigMigrationItem } from "@crewon-protocol/v2/ExternalAgentConfigMigrationItem";
import type { FileChangePatchUpdatedNotification } from "@crewon-protocol/v2/FileChangePatchUpdatedNotification";
import type { FuzzyFileSearchResponse } from "@crewon-protocol/FuzzyFileSearchResponse";
import type { FsGetMetadataResponse } from "@crewon-protocol/v2/FsGetMetadataResponse";
import type { FsReadDirectoryResponse } from "@crewon-protocol/v2/FsReadDirectoryResponse";
import type { FsReadFileResponse } from "@crewon-protocol/v2/FsReadFileResponse";
import type { FsCreateDirectoryResponse } from "@crewon-protocol/v2/FsCreateDirectoryResponse";
import type { FsChangedNotification } from "@crewon-protocol/v2/FsChangedNotification";
import type { FsWatchResponse } from "@crewon-protocol/v2/FsWatchResponse";
import type { FsWriteFileResponse } from "@crewon-protocol/v2/FsWriteFileResponse";
import type { GitDiffToRemoteResponse } from "@crewon-protocol/GitDiffToRemoteResponse";
import type { GetAuthStatusResponse } from "@crewon-protocol/GetAuthStatusResponse";
import type { GetConversationSummaryResponse } from "@crewon-protocol/GetConversationSummaryResponse";
import type { GetAccountResponse } from "@crewon-protocol/v2/GetAccountResponse";
import type { GetAccountRateLimitsResponse } from "@crewon-protocol/v2/GetAccountRateLimitsResponse";
import type { GetAccountTokenUsageResponse } from "@crewon-protocol/v2/GetAccountTokenUsageResponse";
import type { ItemStartedNotification } from "@crewon-protocol/v2/ItemStartedNotification";
import type { ItemCompletedNotification } from "@crewon-protocol/v2/ItemCompletedNotification";
import type { LoginAccountResponse } from "@crewon-protocol/v2/LoginAccountResponse";
import type { LoginAccountParams } from "@crewon-protocol/v2/LoginAccountParams";
import type { ListMcpServerStatusResponse } from "@crewon-protocol/v2/ListMcpServerStatusResponse";
import type { LogoutAccountResponse } from "@crewon-protocol/v2/LogoutAccountResponse";
import type { HooksListResponse } from "@crewon-protocol/v2/HooksListResponse";
import type { McpServerOauthLoginCompletedNotification } from "@crewon-protocol/v2/McpServerOauthLoginCompletedNotification";
import type { McpServerConfigDeleteResponse } from "@crewon-protocol/v2/McpServerConfigDeleteResponse";
import type { McpServerConfigListResponse } from "@crewon-protocol/v2/McpServerConfigListResponse";
import type { McpServerConfigReadResponse } from "@crewon-protocol/v2/McpServerConfigReadResponse";
import type { McpServerConfigSaveResponse } from "@crewon-protocol/v2/McpServerConfigSaveResponse";
import type { McpServerRefreshResponse } from "@crewon-protocol/v2/McpServerRefreshResponse";
import type { McpResourceReadResponse } from "@crewon-protocol/v2/McpResourceReadResponse";
import type { McpServerToolCallResponse } from "@crewon-protocol/v2/McpServerToolCallResponse";
import type { McpServerStatusUpdatedNotification } from "@crewon-protocol/v2/McpServerStatusUpdatedNotification";
import type { McpServerOauthLoginResponse } from "@crewon-protocol/v2/McpServerOauthLoginResponse";
import type { AgentCreateResponse } from "@crewon-protocol/v2/AgentCreateResponse";
import type { AgentUpdateResponse } from "@crewon-protocol/v2/AgentUpdateResponse";
import type { ModelListResponse } from "@crewon-protocol/v2/ModelListResponse";
import type { ModelProviderCapabilitiesReadResponse } from "@crewon-protocol/v2/ModelProviderCapabilitiesReadResponse";
import type { PermissionProfileListResponse } from "@crewon-protocol/v2/PermissionProfileListResponse";
import type { PluginInstallResponse } from "@crewon-protocol/v2/PluginInstallResponse";
import type { PluginListResponse } from "@crewon-protocol/v2/PluginListResponse";
import type { PluginReadResponse } from "@crewon-protocol/v2/PluginReadResponse";
import type { PluginSkillReadResponse } from "@crewon-protocol/v2/PluginSkillReadResponse";
import type { PlanDeltaNotification } from "@crewon-protocol/v2/PlanDeltaNotification";
import type { RemoteControlStatusChangedNotification } from "@crewon-protocol/v2/RemoteControlStatusChangedNotification";
import type { ReviewStartResponse } from "@crewon-protocol/v2/ReviewStartResponse";
import type { SandboxPolicy } from "@crewon-protocol/v2/SandboxPolicy";
import type { ServerRequestResolvedNotification } from "@crewon-protocol/v2/ServerRequestResolvedNotification";
import type { SkillsChangedNotification } from "@crewon-protocol/v2/SkillsChangedNotification";
import type { SkillsCreateResponse } from "@crewon-protocol/v2/SkillsCreateResponse";
import type { SkillsListResponse } from "@crewon-protocol/v2/SkillsListResponse";
import type { SkillsConfigWriteResponse } from "@crewon-protocol/v2/SkillsConfigWriteResponse";
import type { SkillsExtraRootsSetResponse } from "@crewon-protocol/v2/SkillsExtraRootsSetResponse";
import type { JsonValue } from "@crewon-protocol/serde_json/JsonValue";
import type { Thread } from "@crewon-protocol/v2/Thread";
import type { ThreadArchivedNotification } from "@crewon-protocol/v2/ThreadArchivedNotification";
import type { ThreadDeletedNotification } from "@crewon-protocol/v2/ThreadDeletedNotification";
import type { ThreadForkResponse } from "@crewon-protocol/v2/ThreadForkResponse";
import type { ThreadGoalClearedNotification } from "@crewon-protocol/v2/ThreadGoalClearedNotification";
import type { ThreadGoalGetResponse } from "@crewon-protocol/v2/ThreadGoalGetResponse";
import type { ThreadGoalSetResponse } from "@crewon-protocol/v2/ThreadGoalSetResponse";
import type { ThreadGoalUpdatedNotification } from "@crewon-protocol/v2/ThreadGoalUpdatedNotification";
import type { ThreadListResponse } from "@crewon-protocol/v2/ThreadListResponse";
import type { ThreadNameUpdatedNotification } from "@crewon-protocol/v2/ThreadNameUpdatedNotification";
import type { ThreadResumeResponse } from "@crewon-protocol/v2/ThreadResumeResponse";
import type { ThreadSettingsUpdatedNotification } from "@crewon-protocol/v2/ThreadSettingsUpdatedNotification";
import type { ThreadStartResponse } from "@crewon-protocol/v2/ThreadStartResponse";
import type { ThreadStartedNotification } from "@crewon-protocol/v2/ThreadStartedNotification";
import type { ThreadStatusChangedNotification } from "@crewon-protocol/v2/ThreadStatusChangedNotification";
import type { ThreadTokenUsageUpdatedNotification } from "@crewon-protocol/v2/ThreadTokenUsageUpdatedNotification";
import type { ThreadUnarchiveResponse } from "@crewon-protocol/v2/ThreadUnarchiveResponse";
import type { ThreadUnarchivedNotification } from "@crewon-protocol/v2/ThreadUnarchivedNotification";
import type { Turn } from "@crewon-protocol/v2/Turn";
import type { TurnCompletedNotification } from "@crewon-protocol/v2/TurnCompletedNotification";
import type { TurnDiffUpdatedNotification } from "@crewon-protocol/v2/TurnDiffUpdatedNotification";
import type { TurnPlanUpdatedNotification } from "@crewon-protocol/v2/TurnPlanUpdatedNotification";
import type { TurnStartedNotification } from "@crewon-protocol/v2/TurnStartedNotification";
import type { TurnStartResponse } from "@crewon-protocol/v2/TurnStartResponse";
import type { UserInput } from "@crewon-protocol/v2/UserInput";
import type { WarningNotification } from "@crewon-protocol/v2/WarningNotification";
import type { WindowsSandboxReadinessResponse } from "@crewon-protocol/v2/WindowsSandboxReadinessResponse";
import type { WindowsSandboxSetupMode } from "@crewon-protocol/v2/WindowsSandboxSetupMode";
import type { WindowsSandboxSetupStartResponse } from "@crewon-protocol/v2/WindowsSandboxSetupStartResponse";
import type {
  AgentConfig,
  ArtifactItem,
  AutomationConfig,
  KnowledgeData,
  OfficeConfig,
  OfficeMember,
  OfficeMessage,
  OfficeWorkspace,
  ToolConfig,
  ToolConfigKind,
} from "../domain/domainTypes";

type JsonRpcRequest = {
  id: number | string;
  method: string;
  params?: unknown;
};

type JsonRpcResponse<T> = {
  id: number | string;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export class AppServerRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AppServerRpcError";
  }
}

export function isMissingThreadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("thread not found") ||
      error.message.includes("invalid thread id"))
  );
}

export function isUnsupportedRpcError(error: unknown): boolean {
  return error instanceof AppServerRpcError && error.code === -32601;
}

type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

type ThreadSearchResponse = {
  data: Array<{
    thread: Thread;
    snippet: string;
  }>;
  nextCursor: string | null;
  backwardsCursor: string | null;
};

export type BackgroundTerminal = {
  itemId: string;
  processId: string;
  command: string;
  cwd: string;
  osPid: number | null;
  cpuPercent: number | null;
  rssKb: number | null;
};

type BackgroundTerminalsListResponse = {
  data: BackgroundTerminal[];
  nextCursor: string | null;
};

type LoadedThreadsListResponse = {
  data: string[];
  nextCursor: string | null;
};

export type DomainConfigListResponse<TConfig> = {
  data: Array<{
    filePath: string;
    savedAt: string;
    config: TConfig;
  }>;
  nextCursor: string | null;
};

export type DomainConfigSaveResponse = {
  filePath: string;
};

export type AgentSaveResponse = DomainConfigSaveResponse & {
  agentId: string;
};

export type AgentReadResponse = {
  record: DomainConfigListResponse<AgentConfig>["data"][number] | null;
};

export type AgentRecruitableListResponse =
  DomainConfigListResponse<AgentConfig>;

export type DomainConfigDeleteResponse = {
  deleted: boolean;
};

export type OfficeReadResponse = {
  record: DomainConfigListResponse<OfficeConfig>["data"][number] | null;
};

export type OfficeCreateResponse = DomainConfigSaveResponse & {
  config: OfficeConfig;
};

export type OfficeMessageSendResponse = {
  filePath: string;
  config: OfficeConfig;
};

export type OfficeRunResponse = {
  filePath: string;
  config: OfficeConfig;
  threadId: string;
  runId: string;
  turn: Turn;
};

export type OfficeRunSyncResponse = {
  filePath: string;
  config: OfficeConfig;
};

export type OfficeRunCancelResponse = {
  filePath: string;
  config: OfficeConfig;
};

export type OfficeRunRetryResponse = OfficeRunResponse;

export type OfficeMemberAddResponse = {
  filePath: string;
  config: OfficeConfig;
};

export type OfficeApprovalDecideResponse = {
  filePath: string;
  config: OfficeConfig;
};

export type OfficeArtifactUpsertResponse = {
  filePath: string;
  config: OfficeConfig;
};

export type KnowledgeListResponse = {
  data: KnowledgeData;
};

export type KnowledgeMemoryWriteResponse = {
  filePath: string;
  data: KnowledgeData;
};

export type AutomationRunRecord = {
  runId: string;
  automationTitle: string;
  threadId: string | null;
  turnId: string | null;
  status: string;
  startedAt: number;
  completedAt: number | null;
  note: string | null;
  config: AutomationConfig;
};

export type AutomationRunResponse = {
  filePath: string;
  run: AutomationRunRecord;
};

export type AutomationRunUpdateResponse = AutomationRunResponse;

export type AutomationCreateResponse = {
  filePath: string;
  config: AutomationConfig;
};

export type AutomationReadResponse = {
  record: DomainConfigListResponse<AutomationConfig>["data"][number] | null;
};

export type AutomationUpdateResponse = {
  filePath: string;
  config: AutomationConfig;
};

export type AutomationRunsListResponse = {
  data: Array<{
    filePath: string;
    savedAt: number;
    run: AutomationRunRecord;
  }>;
  nextCursor: string | null;
};

export type ToolConfigListResponse = {
  data: Array<{
    filePath: string;
    savedAt: string;
    kind: ToolConfigKind;
    config: ToolConfig;
  }>;
  nextCursor: string | null;
};

export type ToolConfigReadResponse = {
  record: ToolConfigListResponse["data"][number] | null;
};

export type ToolConfigUpdateResponse = {
  filePath: string;
  config: ToolConfig;
};

type ThreadTurnsListResponse = {
  data: Turn[];
  nextCursor: string | null;
  backwardsCursor: string | null;
};

export type RemoteControlStatusResponse = {
  status: "disabled" | "connecting" | "connected" | "errored";
  serverName: string;
  installationId: string;
  environmentId: string | null;
};

export type RemoteControlPairingStartResponse = {
  pairingCode: string;
  manualPairingCode: string | null;
  environmentId: string;
  expiresAt: number;
};

export type RemoteControlPairingStatusResponse = {
  claimed: boolean;
};

export type RemoteControlClient = {
  clientId: string;
  displayName: string | null;
  deviceType: string | null;
  platform: string | null;
  osVersion: string | null;
  deviceModel: string | null;
  appVersion: string | null;
  lastSeenAt: number | null;
};

export type RemoteControlClientsListResponse = {
  data: RemoteControlClient[];
  nextCursor: string | null;
};

function sandboxPolicyFromMode(mode: string): SandboxPolicy | null {
  if (mode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  if (mode === "read-only") {
    return { type: "readOnly", networkAccess: false };
  }
  if (mode === "workspace-write") {
    return {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }
  return null;
}

function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export type AppServerRequest = {
  id: number | string;
  method: string;
  params?: unknown;
};

export type KnownAppServerNotification =
  | { method: "error"; params: ErrorNotification }
  | { method: "account/login/completed"; params: AccountLoginCompletedNotification }
  | { method: "account/rateLimits/updated"; params: AccountRateLimitsUpdatedNotification }
  | { method: "account/updated"; params: AccountUpdatedNotification }
  | { method: "app/list/updated"; params: AppListUpdatedNotification }
  | { method: "configWarning"; params: ConfigWarningNotification }
  | { method: "externalAgentConfig/import/completed"; params: ExternalAgentConfigImportCompletedNotification }
  | { method: "fs/changed"; params: FsChangedNotification }
  | { method: "command/exec/outputDelta"; params: CommandExecOutputDeltaNotification }
  | { method: "item/agentMessage/delta"; params: AgentMessageDeltaNotification }
  | { method: "item/commandExecution/outputDelta"; params: CommandExecutionOutputDeltaNotification }
  | { method: "item/completed"; params: ItemCompletedNotification }
  | { method: "item/fileChange/patchUpdated"; params: FileChangePatchUpdatedNotification }
  | { method: "item/plan/delta"; params: PlanDeltaNotification }
  | { method: "item/started"; params: ItemStartedNotification }
  | { method: "mcpServer/oauthLogin/completed"; params: McpServerOauthLoginCompletedNotification }
  | { method: "mcpServer/startupStatus/updated"; params: McpServerStatusUpdatedNotification }
  | { method: "remoteControl/status/changed"; params: RemoteControlStatusChangedNotification }
  | { method: "serverRequest/resolved"; params: ServerRequestResolvedNotification }
  | { method: "skills/changed"; params: SkillsChangedNotification }
  | { method: "thread/archived"; params: ThreadArchivedNotification }
  | { method: "thread/compacted"; params: ContextCompactedNotification }
  | { method: "thread/deleted"; params: ThreadDeletedNotification }
  | { method: "thread/goal/cleared"; params: ThreadGoalClearedNotification }
  | { method: "thread/goal/updated"; params: ThreadGoalUpdatedNotification }
  | { method: "thread/name/updated"; params: ThreadNameUpdatedNotification }
  | { method: "thread/settings/updated"; params: ThreadSettingsUpdatedNotification }
  | { method: "thread/started"; params: ThreadStartedNotification }
  | { method: "thread/status/changed"; params: ThreadStatusChangedNotification }
  | { method: "thread/tokenUsage/updated"; params: ThreadTokenUsageUpdatedNotification }
  | { method: "thread/unarchived"; params: ThreadUnarchivedNotification }
  | { method: "turn/completed"; params: TurnCompletedNotification }
  | { method: "turn/diff/updated"; params: TurnDiffUpdatedNotification }
  | { method: "turn/plan/updated"; params: TurnPlanUpdatedNotification }
  | { method: "turn/started"; params: TurnStartedNotification }
  | { method: "warning"; params: WarningNotification };

export type AppServerNotification = KnownAppServerNotification;

const DEFAULT_REQUEST_TIMEOUT_MS = 12000;
const LONG_REQUEST_TIMEOUT_MS = 60000;

export class AppServerClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<
    number | string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeoutId: number;
    }
  >();

  constructor(
    private readonly url: string,
    private readonly onNotification: (notification: AppServerNotification) => void,
    private readonly onClose?: () => void,
    private readonly onServerRequest?: (request: AppServerRequest) => void,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;

      socket.addEventListener("open", async () => {
        try {
          await this.initialize();
          resolve();
        } catch (error) {
          reject(error);
        }
      });

      socket.addEventListener("message", (event) => {
        this.handleMessage(event.data);
      });

      socket.addEventListener("error", () => {
        reject(new Error(`Unable to connect to ${this.url}`));
      });

      socket.addEventListener("close", () => {
        for (const [, pending] of this.pending) {
          window.clearTimeout(pending.timeoutId);
          pending.reject(new Error("App-server connection closed"));
        }
        this.pending.clear();
        this.onClose?.();
      });
    });
  }

  close(): void {
    this.socket?.close();
  }

  async listThreads(archived = false): Promise<Thread[]> {
    const response = await this.request<ThreadListResponse>("thread/list", {
      limit: 24,
      archived,
    });
    return response.data;
  }

  async searchThreads(searchTerm: string, archived = false): Promise<Thread[]> {
    const response = await this.request<ThreadSearchResponse>("thread/search", {
      cursor: null,
      limit: 24,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: null,
      archived,
      searchTerm,
    });
    return response.data.map((result) => result.thread);
  }

  async listLoadedThreadIds(): Promise<string[]> {
    const response = await this.request<LoadedThreadsListResponse>("thread/loaded/list", {
      cursor: null,
      limit: 50,
    });
    return response.data;
  }

  async getAccount(refreshToken = false): Promise<GetAccountResponse> {
    return this.request<GetAccountResponse>("account/read", { refreshToken });
  }

  async getAccountRateLimits(): Promise<GetAccountRateLimitsResponse> {
    return this.request<GetAccountRateLimitsResponse>("account/rateLimits/read");
  }

  async getAccountUsage(): Promise<GetAccountTokenUsageResponse> {
    return this.request<GetAccountTokenUsageResponse>("account/usage/read");
  }

  async getAuthStatus(): Promise<GetAuthStatusResponse> {
    return this.request<GetAuthStatusResponse>("getAuthStatus", {
      includeToken: false,
      refreshToken: false,
    });
  }

  async listModels(): Promise<ModelListResponse> {
    return this.request<ModelListResponse>("model/list", {
      cursor: null,
      limit: 24,
      includeHidden: false,
    });
  }

  async listPermissionProfiles(cwd?: string): Promise<PermissionProfileListResponse> {
    return this.request<PermissionProfileListResponse>("permissionProfile/list", {
      cursor: null,
      limit: 24,
      cwd: cwd || null,
    });
  }

  async getModelProviderCapabilities(): Promise<ModelProviderCapabilitiesReadResponse> {
    return this.request<ModelProviderCapabilitiesReadResponse>("modelProvider/capabilities/read", {});
  }

  async readConfig(cwd?: string): Promise<ConfigReadResponse> {
    return this.request<ConfigReadResponse>("config/read", {
      includeLayers: true,
      cwd: cwd || null,
    });
  }

  async readConfigRequirements(): Promise<ConfigRequirementsReadResponse> {
    return this.request<ConfigRequirementsReadResponse>("configRequirements/read");
  }

  async readWindowsSandboxReadiness(): Promise<WindowsSandboxReadinessResponse> {
    return this.request<WindowsSandboxReadinessResponse>("windowsSandbox/readiness");
  }

  async readRemoteControlStatus(): Promise<RemoteControlStatusResponse> {
    return this.request<RemoteControlStatusResponse>("remoteControl/status/read");
  }

  async enableRemoteControl(): Promise<RemoteControlStatusResponse> {
    return this.request<RemoteControlStatusResponse>("remoteControl/enable");
  }

  async disableRemoteControl(): Promise<RemoteControlStatusResponse> {
    return this.request<RemoteControlStatusResponse>("remoteControl/disable");
  }

  async startRemoteControlPairing(manualCode = false): Promise<RemoteControlPairingStartResponse> {
    return this.request<RemoteControlPairingStartResponse>("remoteControl/pairing/start", {
      manualCode,
    });
  }

  async getRemoteControlPairingStatus(
    pairingCode: string | null,
    manualPairingCode: string | null,
  ): Promise<RemoteControlPairingStatusResponse> {
    return this.request<RemoteControlPairingStatusResponse>("remoteControl/pairing/status", {
      pairingCode,
      manualPairingCode,
    });
  }

  async listRemoteControlClients(environmentId: string): Promise<RemoteControlClientsListResponse> {
    return this.request<RemoteControlClientsListResponse>("remoteControl/client/list", {
      environmentId,
      cursor: null,
      limit: 24,
      order: "desc",
    });
  }

  async revokeRemoteControlClient(environmentId: string, clientId: string): Promise<void> {
    await this.request("remoteControl/client/revoke", {
      environmentId,
      clientId,
    });
  }

  async startWindowsSandboxSetup(
    mode: WindowsSandboxSetupMode,
    cwd?: string,
  ): Promise<WindowsSandboxSetupStartResponse> {
    return this.request<WindowsSandboxSetupStartResponse>("windowsSandbox/setupStart", {
      mode,
      cwd: cwd || null,
    });
  }

  async writeConfigBatch(
    edits: Array<{ keyPath: string; value: JsonValue; mergeStrategy?: "replace" | "upsert" }>,
  ): Promise<ConfigWriteResponse> {
    return this.request<ConfigWriteResponse>("config/batchWrite", {
      edits: edits.map((edit) => ({
        keyPath: edit.keyPath,
        value: edit.value,
        mergeStrategy: edit.mergeStrategy ?? "replace",
      })),
      filePath: null,
      expectedVersion: null,
      reloadUserConfig: true,
    });
  }

  async loginAccount(params: LoginAccountParams): Promise<LoginAccountResponse> {
    return this.request<LoginAccountResponse>("account/login/start", params);
  }

  async logoutAccount(): Promise<LogoutAccountResponse> {
    return this.request<LogoutAccountResponse>("account/logout");
  }

  async startThread(cwd?: string, threadSource = "app_server"): Promise<Thread> {
    const response = await this.request<ThreadStartResponse>("thread/start", {
      cwd: cwd || undefined,
      threadSource,
    });
    return response.thread;
  }

  async readThread(threadId: string): Promise<Thread> {
    const response = await this.request<{ thread: Thread }>("thread/read", {
      threadId,
      includeTurns: true,
    });
    return response.thread;
  }

  async listThreadTurns(threadId: string): Promise<Turn[]> {
    const response = await this.request<ThreadTurnsListResponse>("thread/turns/list", {
      threadId,
      cursor: null,
      limit: 50,
      sortDirection: "asc",
      itemsView: "full",
    });
    return response.data;
  }

  async getConversationSummary(threadId: string): Promise<GetConversationSummaryResponse> {
    return this.request<GetConversationSummaryResponse>("getConversationSummary", {
      conversationId: threadId,
    });
  }

  async getThreadGoal(threadId: string): Promise<ThreadGoalGetResponse> {
    return this.request<ThreadGoalGetResponse>("thread/goal/get", { threadId });
  }

  async setThreadGoal(threadId: string, objective: string, tokenBudget: number | null): Promise<ThreadGoalSetResponse> {
    return this.request<ThreadGoalSetResponse>("thread/goal/set", {
      threadId,
      objective,
      status: "active",
      tokenBudget,
    });
  }

  async clearThreadGoal(threadId: string): Promise<void> {
    await this.request("thread/goal/clear", { threadId });
  }

  async setThreadMemoryMode(threadId: string, mode: "enabled" | "disabled"): Promise<void> {
    await this.request("thread/memoryMode/set", { threadId, mode });
  }

  async resetMemory(): Promise<void> {
    await this.request("memory/reset");
  }

  async updateThreadSettings(
    threadId: string,
    settings: {
      model?: string | null;
      approvalPolicy?: string | null;
      sandboxMode?: string | null;
    },
  ): Promise<void> {
    const sandboxPolicy = settings.sandboxMode
      ? sandboxPolicyFromMode(settings.sandboxMode)
      : null;
    await this.request("thread/settings/update", {
      threadId,
      model: settings.model || null,
      approvalPolicy: (settings.approvalPolicy || null) as AskForApproval | null,
      sandboxPolicy,
    });
  }

  async compactThread(threadId: string): Promise<void> {
    await this.request("thread/compact/start", { threadId });
  }

  async rollbackThread(threadId: string, numTurns = 1): Promise<Thread> {
    const response = await this.request<{ thread: Thread }>("thread/rollback", {
      threadId,
      numTurns,
    });
    return response.thread;
  }

  async resumeThread(threadId: string): Promise<Thread> {
    const response = await this.request<ThreadResumeResponse>("thread/resume", { threadId });
    return response.thread;
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.request("thread/archive", { threadId });
  }

  async unarchiveThread(threadId: string): Promise<Thread> {
    const response = await this.request<ThreadUnarchiveResponse>("thread/unarchive", { threadId });
    return response.thread;
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.request("thread/delete", { threadId });
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    await this.request("thread/name/set", { threadId, name });
  }

  async startTurn(
    threadId: string,
    text: string,
    mentions: Array<{ name: string; path: string }> = [],
  ): Promise<TurnStartResponse> {
    const input: UserInput[] = [
      { type: "text", text, text_elements: [] },
      ...mentions.map((mention) => ({
        type: "mention" as const,
        name: mention.name,
        path: mention.path,
      })),
    ];
    return this.request<TurnStartResponse>(
      "turn/start",
      { threadId, input },
      { timeoutMs: LONG_REQUEST_TIMEOUT_MS },
    );
  }

  async steerTurn(
    threadId: string,
    text: string,
    mentions: Array<{ name: string; path: string }> = [],
  ): Promise<{ turnId: string }> {
    const input: UserInput[] = [
      { type: "text", text, text_elements: [] },
      ...mentions.map((mention) => ({
        type: "mention" as const,
        name: mention.name,
        path: mention.path,
      })),
    ];
    return this.request<{ turnId: string }>(
      "turn/steer",
      { threadId, input },
      { timeoutMs: LONG_REQUEST_TIMEOUT_MS },
    );
  }

  async runThreadShellCommand(threadId: string, command: string): Promise<void> {
    await this.request("thread/shellCommand", { threadId, command });
  }

  async listBackgroundTerminals(threadId: string): Promise<BackgroundTerminalsListResponse> {
    return this.request<BackgroundTerminalsListResponse>("thread/backgroundTerminals/list", {
      threadId,
      cursor: null,
      limit: 20,
    });
  }

  async cleanBackgroundTerminals(threadId: string): Promise<void> {
    await this.request("thread/backgroundTerminals/clean", { threadId });
  }

  async terminateBackgroundTerminal(
    threadId: string,
    processId: BackgroundTerminal["processId"],
  ): Promise<boolean> {
    const response = await this.request<{ terminated: boolean }>(
      "thread/backgroundTerminals/terminate",
      { threadId, processId },
    );
    return response.terminated;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  async startReview(threadId: string): Promise<ReviewStartResponse> {
    return this.request<ReviewStartResponse>("review/start", {
      threadId,
      delivery: "inline",
      target: { type: "uncommittedChanges" },
    });
  }

  async runCommand(cwd: string, command: string, processId?: string): Promise<CommandExecResponse> {
    return this.request<CommandExecResponse>(
      "command/exec",
      {
        command: ["sh", "-lc", command],
        processId: processId ?? null,
        streamStdoutStderr: Boolean(processId),
        streamStdin: Boolean(processId),
        cwd,
        outputBytesCap: 12000,
        timeoutMs: 8000,
      },
      { timeoutMs: LONG_REQUEST_TIMEOUT_MS },
    );
  }

  async writeCommandInput(processId: string, text: string, closeStdin = false): Promise<void> {
    await this.request("command/exec/write", {
      processId,
      deltaBase64: text ? textToBase64(text) : null,
      closeStdin,
    });
  }

  async terminateCommand(processId: string): Promise<void> {
    await this.request("command/exec/terminate", { processId });
  }

  async readDirectory(path: string): Promise<FsReadDirectoryResponse> {
    return this.request<FsReadDirectoryResponse>("fs/readDirectory", { path });
  }

  async createDirectory(path: string, recursive = true): Promise<FsCreateDirectoryResponse> {
    return this.request<FsCreateDirectoryResponse>("fs/createDirectory", {
      path,
      recursive,
    });
  }

  async readFile(path: string): Promise<FsReadFileResponse> {
    return this.request<FsReadFileResponse>("fs/readFile", { path });
  }

  async writeTextFile(path: string, text: string): Promise<FsWriteFileResponse> {
    return this.request<FsWriteFileResponse>("fs/writeFile", {
      path,
      dataBase64: textToBase64(text),
    });
  }

  async listAgentConfigs(cwd: string): Promise<DomainConfigListResponse<AgentConfig>> {
    return this.request<DomainConfigListResponse<AgentConfig>>("agent/list", {
      cwd,
      cursor: null,
      limit: 24,
    });
  }

  async saveAgentConfig(
    cwd: string,
    config: AgentConfig,
  ): Promise<AgentSaveResponse> {
    return this.request<AgentSaveResponse>("agent/save", { cwd, config });
  }

  async createAgentConfig(
    cwd: string,
    config: unknown,
  ): Promise<AgentCreateResponse> {
    return this.request<AgentCreateResponse>("agent/create", { cwd, config });
  }

  async updateAgentConfig(
    cwd: string,
    filePath: string,
    config: unknown,
  ): Promise<AgentUpdateResponse> {
    return this.request<AgentUpdateResponse>("agent/update", {
      cwd,
      filePath,
      config,
    });
  }

  async readAgentConfig(
    cwd: string,
    params: {
      agentId?: string | null;
      threadId?: string | null;
      name?: string | null;
    },
  ): Promise<AgentReadResponse> {
    return this.request<AgentReadResponse>("agent/read", {
      cwd,
      agentId: params.agentId ?? null,
      threadId: params.threadId ?? null,
      name: params.name ?? null,
    });
  }

  async listRecruitableAgentConfigs(
    cwd: string,
    params: {
      cursor?: string | null;
      existingAgentIds?: string[] | null;
      existingNames?: string[] | null;
      limit?: number | null;
    },
  ): Promise<AgentRecruitableListResponse> {
    return this.request<AgentRecruitableListResponse>("agent/recruitable/list", {
      cwd,
      cursor: params.cursor ?? null,
      existingAgentIds: params.existingAgentIds ?? null,
      existingNames: params.existingNames ?? null,
      limit: params.limit ?? 24,
    });
  }

  async deleteAgentConfig(
    cwd: string,
    filePath: string,
  ): Promise<DomainConfigDeleteResponse> {
    return this.request<DomainConfigDeleteResponse>("agent/delete", {
      cwd,
      filePath,
    });
  }

  async listOfficeConfigs(cwd: string): Promise<DomainConfigListResponse<OfficeConfig>> {
    return this.request<DomainConfigListResponse<OfficeConfig>>("office/list", {
      cwd,
      cursor: null,
      limit: 24,
    });
  }

  async saveOfficeConfig(
    cwd: string,
    config: OfficeConfig,
  ): Promise<DomainConfigSaveResponse> {
    return this.request<DomainConfigSaveResponse>("office/save", { cwd, config });
  }

  async createOfficeConfig(
    cwd: string,
    params: {
      title: string;
      subtitle?: string | null;
      threadId?: string | null;
      goal?: string | null;
    },
  ): Promise<OfficeCreateResponse> {
    return this.request<OfficeCreateResponse>("office/create", {
      cwd,
      title: params.title,
      subtitle: params.subtitle ?? null,
      threadId: params.threadId ?? null,
      goal: params.goal ?? null,
    });
  }

  async readOfficeConfig(
    cwd: string,
    params: { threadId?: string | null; title?: string | null },
  ): Promise<OfficeReadResponse> {
    return this.request<OfficeReadResponse>("office/read", {
      cwd,
      threadId: params.threadId ?? null,
      title: params.title ?? null,
    });
  }

  async sendOfficeMessageConfig(
    cwd: string,
    config: OfficeConfig,
    message: OfficeMessage,
    text?: string | null,
    locale?: "zh" | "en" | null,
    workspace?: OfficeWorkspace | null,
  ): Promise<OfficeMessageSendResponse> {
    return this.request<OfficeMessageSendResponse>("office/message/send", {
      cwd,
      config,
      message,
      text: text ?? null,
      locale: locale ?? null,
      workspace: workspace ?? null,
    });
  }

  async runOfficeConfig(
    cwd: string,
    config: OfficeConfig,
    message: OfficeMessage,
    text: string,
    locale?: "zh" | "en" | null,
    threadId?: string | null,
    clientUserMessageId?: string | null,
  ): Promise<OfficeRunResponse> {
    return this.request<OfficeRunResponse>("office/run", {
      cwd,
      config,
      message,
      text,
      locale: locale ?? null,
      threadId: threadId ?? null,
      clientUserMessageId: clientUserMessageId ?? null,
    });
  }

  async syncOfficeRunConfig(
    cwd: string,
    config: OfficeConfig,
    turn: Turn,
    params?: {
      runId?: string | null;
      locale?: "zh" | "en" | null;
    },
  ): Promise<OfficeRunSyncResponse> {
    return this.request<OfficeRunSyncResponse>("office/run/sync", {
      cwd,
      config,
      runId: params?.runId ?? null,
      turn,
      locale: params?.locale ?? null,
    });
  }

  async cancelOfficeRunConfig(
    cwd: string,
    config: OfficeConfig,
    runId: string,
    params?: {
      threadId?: string | null;
      turnId?: string | null;
      locale?: "zh" | "en" | null;
    },
  ): Promise<OfficeRunCancelResponse> {
    return this.request<OfficeRunCancelResponse>("office/run/cancel", {
      cwd,
      config,
      runId,
      threadId: params?.threadId ?? null,
      turnId: params?.turnId ?? null,
      locale: params?.locale ?? null,
    });
  }

  async retryOfficeRunConfig(
    cwd: string,
    config: OfficeConfig,
    runId: string,
    params?: {
      message?: OfficeMessage | null;
      text?: string | null;
      locale?: "zh" | "en" | null;
      clientUserMessageId?: string | null;
    },
  ): Promise<OfficeRunRetryResponse> {
    return this.request<OfficeRunRetryResponse>("office/run/retry", {
      cwd,
      config,
      runId,
      message: params?.message ?? null,
      text: params?.text ?? null,
      locale: params?.locale ?? null,
      clientUserMessageId: params?.clientUserMessageId ?? null,
    });
  }

  async addOfficeMemberConfig(
    cwd: string,
    config: OfficeConfig,
    agentId: string,
    member: OfficeMember,
  ): Promise<OfficeMemberAddResponse> {
    return this.request<OfficeMemberAddResponse>("office/member/add", {
      cwd,
      config,
      agentId,
      member,
    });
  }

  async decideOfficeApprovalConfig(
    cwd: string,
    config: OfficeConfig,
    approvalId: string,
    decision: "approved" | "denied",
    message?: OfficeMessage | null,
  ): Promise<OfficeApprovalDecideResponse> {
    return this.request<OfficeApprovalDecideResponse>("office/approval/decide", {
      cwd,
      config,
      approvalId,
      decision,
      message: message ?? null,
    });
  }

  async upsertOfficeArtifactConfig(
    cwd: string,
    config: OfficeConfig,
    artifact: ArtifactItem,
    message?: OfficeMessage | null,
  ): Promise<OfficeArtifactUpsertResponse> {
    return this.request<OfficeArtifactUpsertResponse>("office/artifact/upsert", {
      cwd,
      config,
      artifact,
      message: message ?? null,
    });
  }

  async deleteOfficeConfig(
    cwd: string,
    filePath: string,
  ): Promise<DomainConfigDeleteResponse> {
    return this.request<DomainConfigDeleteResponse>("office/delete", {
      cwd,
      filePath,
    });
  }

  async listAutomationConfigs(cwd: string): Promise<DomainConfigListResponse<AutomationConfig>> {
    return this.request<DomainConfigListResponse<AutomationConfig>>("automation/list", {
      cwd,
      cursor: null,
      limit: 24,
    });
  }

  async saveAutomationConfig(
    cwd: string,
    config: AutomationConfig,
  ): Promise<DomainConfigSaveResponse> {
    return this.request<DomainConfigSaveResponse>("automation/save", { cwd, config });
  }

  async createAutomationConfig(
    cwd: string,
    params: {
      title: string;
      threadId?: string | null;
      targetOffice?: OfficeConfig | null;
      executionAgent?: AgentConfig | null;
      prompt?: string | null;
      enabled?: boolean | null;
      status?: string | null;
    },
  ): Promise<AutomationCreateResponse> {
    return this.request<AutomationCreateResponse>("automation/create", {
      cwd,
      title: params.title,
      threadId: params.threadId ?? null,
      targetOffice: params.targetOffice ?? null,
      executionAgent: params.executionAgent ?? null,
      prompt: params.prompt ?? null,
      enabled: params.enabled ?? null,
      status: params.status ?? null,
    });
  }

  async readAutomationConfig(
    cwd: string,
    params: {
      filePath?: string | null;
      threadId?: string | null;
      title?: string | null;
    },
  ): Promise<AutomationReadResponse> {
    return this.request<AutomationReadResponse>("automation/read", {
      cwd,
      filePath: params.filePath ?? null,
      threadId: params.threadId ?? null,
      title: params.title ?? null,
    });
  }

  async updateAutomationConfig(
    cwd: string,
    filePath: string,
    config: AutomationConfig,
  ): Promise<AutomationUpdateResponse> {
    return this.request<AutomationUpdateResponse>("automation/update", {
      cwd,
      filePath,
      config,
    });
  }

  async runAutomationConfig(
    cwd: string,
    config: AutomationConfig,
    note: string | null,
    turnId: string | null,
  ): Promise<AutomationRunResponse> {
    return this.request<AutomationRunResponse>("automation/run", {
      cwd,
      config,
      note,
      turnId,
    });
  }

  async updateAutomationRun(
    cwd: string,
    filePath: string,
    status: string,
    completedAt: number | null,
  ): Promise<AutomationRunUpdateResponse> {
    return this.request<AutomationRunUpdateResponse>("automation/run/update", {
      cwd,
      filePath,
      status,
      completedAt,
    });
  }

  async listAutomationRuns(
    cwd: string,
    threadId?: string | null,
  ): Promise<AutomationRunsListResponse> {
    return this.request<AutomationRunsListResponse>("automation/runs/list", {
      cwd,
      threadId: threadId ?? null,
      cursor: null,
      limit: 24,
    });
  }

  async deleteAutomationConfig(
    cwd: string,
    filePath: string,
  ): Promise<DomainConfigDeleteResponse> {
    return this.request<DomainConfigDeleteResponse>("automation/delete", {
      cwd,
      filePath,
    });
  }

  async listKnowledge(cwd: string): Promise<KnowledgeListResponse> {
    return this.request<KnowledgeListResponse>("knowledge/list", {
      cwd,
      limit: 24,
    });
  }

  async writeKnowledgeMemory(params: {
    cwd: string;
    title?: string | null;
    threadId?: string | null;
    note?: string | null;
  }): Promise<KnowledgeMemoryWriteResponse> {
    return this.request<KnowledgeMemoryWriteResponse>("knowledge/memory/write", {
      cwd: params.cwd,
      title: params.title ?? null,
      threadId: params.threadId ?? null,
      note: params.note ?? null,
    });
  }

  async listToolConfigs(
    cwd: string,
    kind?: ToolConfigKind,
  ): Promise<ToolConfigListResponse> {
    return this.request<ToolConfigListResponse>("tool/list", {
      cwd,
      kind: kind ?? null,
      cursor: null,
      limit: 24,
    });
  }

  async saveToolConfig(
    cwd: string,
    config: ToolConfig,
  ): Promise<DomainConfigSaveResponse> {
    return this.request<DomainConfigSaveResponse>("tool/save", { cwd, config });
  }

  async readToolConfig(
    cwd: string,
    filePath: string,
  ): Promise<ToolConfigReadResponse> {
    return this.request<ToolConfigReadResponse>("tool/read", {
      cwd,
      filePath,
    });
  }

  async updateToolConfig(
    cwd: string,
    filePath: string,
    config: ToolConfig,
  ): Promise<ToolConfigUpdateResponse> {
    return this.request<ToolConfigUpdateResponse>("tool/update", {
      cwd,
      filePath,
      config,
    });
  }

  async deleteToolConfig(
    cwd: string,
    filePath: string,
  ): Promise<DomainConfigDeleteResponse> {
    return this.request<DomainConfigDeleteResponse>("tool/delete", {
      cwd,
      filePath,
    });
  }

  async copyPath(sourcePath: string, destinationPath: string, recursive = false): Promise<void> {
    await this.request("fs/copy", {
      sourcePath,
      destinationPath,
      recursive,
    });
  }

  async removePath(path: string, recursive = false, force = true): Promise<void> {
    await this.request("fs/remove", {
      path,
      recursive,
      force,
    });
  }

  async watchPath(watchId: string, path: string): Promise<FsWatchResponse> {
    return this.request<FsWatchResponse>("fs/watch", { watchId, path });
  }

  async unwatchPath(watchId: string): Promise<void> {
    await this.request("fs/unwatch", { watchId });
  }

  async getMetadata(path: string): Promise<FsGetMetadataResponse> {
    return this.request<FsGetMetadataResponse>("fs/getMetadata", { path });
  }

  async getGitDiffToRemote(cwd: string): Promise<GitDiffToRemoteResponse> {
    return this.request<GitDiffToRemoteResponse>("gitDiffToRemote", { cwd });
  }

  async fuzzyFileSearch(query: string, roots: string[], cancellationToken: string | null = null): Promise<FuzzyFileSearchResponse> {
    return this.request<FuzzyFileSearchResponse>("fuzzyFileSearch", {
      query,
      roots,
      cancellationToken,
    });
  }

  async listApps(threadId?: string): Promise<AppsListResponse> {
    return this.request<AppsListResponse>("app/list", {
      cursor: null,
      limit: 24,
      threadId: threadId || null,
      forceRefetch: false,
    });
  }

  async listMcpServerStatus(threadId?: string, detail: "full" | "toolsAndAuthOnly" = "toolsAndAuthOnly"): Promise<ListMcpServerStatusResponse> {
    return this.request<ListMcpServerStatusResponse>("mcpServerStatus/list", {
      cursor: null,
      limit: 24,
      detail,
      threadId: threadId || null,
    });
  }

  async listMcpServerConfigs(params: {
    cwd?: string | null;
    cursor?: string | null;
    limit?: number | null;
  } = {}): Promise<McpServerConfigListResponse> {
    return this.request<McpServerConfigListResponse>("mcpServerConfig/list", {
      cwd: params.cwd ?? null,
      cursor: params.cursor ?? null,
      limit: params.limit ?? null,
    });
  }

  async readMcpServerConfig(name: string, cwd?: string | null): Promise<McpServerConfigReadResponse> {
    return this.request<McpServerConfigReadResponse>("mcpServerConfig/read", {
      cwd: cwd ?? null,
      name,
    });
  }

  async saveMcpServerConfig(params: {
    name: string;
    config: JsonValue;
    expectedVersion?: string | null;
    reload?: boolean;
  }): Promise<McpServerConfigSaveResponse> {
    return this.request<McpServerConfigSaveResponse>("mcpServerConfig/save", {
      name: params.name,
      config: params.config,
      expectedVersion: params.expectedVersion ?? null,
      reload: params.reload ?? false,
    });
  }

  async deleteMcpServerConfig(params: {
    name: string;
    expectedVersion?: string | null;
    reload?: boolean;
  }): Promise<McpServerConfigDeleteResponse> {
    return this.request<McpServerConfigDeleteResponse>("mcpServerConfig/delete", {
      name: params.name,
      expectedVersion: params.expectedVersion ?? null,
      reload: params.reload ?? false,
    });
  }

  async reloadMcpServers(): Promise<McpServerRefreshResponse> {
    return this.request<McpServerRefreshResponse>("config/mcpServer/reload", {});
  }

  async readMcpResource(server: string, uri: string, threadId?: string): Promise<McpResourceReadResponse> {
    return this.request<McpResourceReadResponse>("mcpServer/resource/read", {
      threadId: threadId || null,
      server,
      uri,
    });
  }

  async callMcpTool(
    threadId: string,
    server: string,
    tool: string,
    args: JsonValue | undefined,
  ): Promise<McpServerToolCallResponse> {
    return this.request<McpServerToolCallResponse>("mcpServer/tool/call", {
      threadId,
      server,
      tool,
      arguments: args,
    });
  }

  async startMcpOauthLogin(name: string): Promise<McpServerOauthLoginResponse> {
    return this.request<McpServerOauthLoginResponse>("mcpServer/oauth/login", {
      name,
      scopes: null,
      timeoutSecs: null,
    });
  }

  async listPlugins(cwd?: string): Promise<PluginListResponse> {
    return this.request<PluginListResponse>("plugin/list", {
      cwds: cwd ? [cwd] : null,
      marketplaceKinds: null,
    });
  }

  async readPlugin(
    pluginName: string,
    marketplacePath?: string | null,
    remoteMarketplaceName?: string | null,
  ): Promise<PluginReadResponse> {
    return this.request<PluginReadResponse>("plugin/read", {
      pluginName,
      marketplacePath: marketplacePath ?? null,
      remoteMarketplaceName: remoteMarketplaceName ?? null,
    });
  }

  async installPlugin(
    pluginName: string,
    marketplacePath?: string | null,
    remoteMarketplaceName?: string | null,
  ): Promise<PluginInstallResponse> {
    return this.request<PluginInstallResponse>("plugin/install", {
      pluginName,
      marketplacePath: marketplacePath ?? null,
      remoteMarketplaceName: remoteMarketplaceName ?? null,
    });
  }

  async readPluginSkill(
    remoteMarketplaceName: string,
    remotePluginId: string,
    skillName: string,
  ): Promise<PluginSkillReadResponse> {
    return this.request<PluginSkillReadResponse>("plugin/skill/read", {
      remoteMarketplaceName,
      remotePluginId,
      skillName,
    });
  }

  async uninstallPlugin(pluginId: string): Promise<void> {
    await this.request("plugin/uninstall", { pluginId });
  }

  async listSkills(cwd?: string): Promise<SkillsListResponse> {
    return this.request<SkillsListResponse>("skills/list", {
      cwds: cwd ? [cwd] : [],
      forceReload: false,
    });
  }

  async createSkill(params: {
    cwd: string;
    name: string;
    description: string;
    body: string;
  }): Promise<SkillsCreateResponse> {
    return this.request<SkillsCreateResponse>("skills/create", params);
  }

  async writeSkillConfig(params: { path?: string | null; name?: string | null; enabled: boolean }): Promise<SkillsConfigWriteResponse> {
    return this.request<SkillsConfigWriteResponse>("skills/config/write", {
      path: params.path ?? null,
      name: params.name ?? null,
      enabled: params.enabled,
    });
  }

  async setSkillExtraRoots(extraRoots: string[]): Promise<SkillsExtraRootsSetResponse> {
    return this.request<SkillsExtraRootsSetResponse>("skills/extraRoots/set", {
      extraRoots,
    });
  }

  async listHooks(cwd?: string): Promise<HooksListResponse> {
    return this.request<HooksListResponse>("hooks/list", {
      cwds: cwd ? [cwd] : [],
    });
  }

  async detectExternalAgentConfig(cwd?: string): Promise<ExternalAgentConfigDetectResponse> {
    return this.request<ExternalAgentConfigDetectResponse>("externalAgentConfig/detect", {
      includeHome: false,
      cwds: cwd ? [cwd] : null,
    });
  }

  async importExternalAgentConfig(item: ExternalAgentConfigMigrationItem): Promise<ExternalAgentConfigImportResponse> {
    return this.request<ExternalAgentConfigImportResponse>("externalAgentConfig/import", {
      migrationItems: [item],
    });
  }

  async forkThread(threadId: string): Promise<ThreadForkResponse> {
    return this.request<ThreadForkResponse>("thread/fork", {
      threadId,
      ephemeral: true,
      threadSource: "app_server",
    });
  }

  respondServerRequest(id: number | string, result: unknown): void {
    this.respond(id, result);
  }

  rejectServerRequest(id: number | string, message: string, code = -32000): void {
    this.socket?.send(JSON.stringify({ id, error: { code, message } }));
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "crewon_ui",
        title: "Crewon UI",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized");
  }

  private notify(method: string, params?: unknown): void {
    this.socket?.send(JSON.stringify({ method, params }));
  }

  private request<T>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("App-server is not connected"));
    }

    const id = this.nextId++;
    const payload: JsonRpcRequest = { id, method, params };
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    return new Promise<T>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`App-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          window.clearTimeout(timeoutId);
          resolve(value as T);
        },
        reject: (error) => {
          window.clearTimeout(timeoutId);
          reject(error);
        },
        timeoutId,
      });
      try {
        this.socket?.send(JSON.stringify(payload));
      } catch (error) {
        const pending = this.pending.get(id);
        if (pending) {
          window.clearTimeout(pending.timeoutId);
          this.pending.delete(id);
        }
        reject(error instanceof Error ? error : new Error("Unable to send app-server request"));
      }
    });
  }

  private handleMessage(rawData: unknown): void {
    let message: JsonRpcResponse<unknown> | JsonRpcNotification | JsonRpcRequest;

    try {
      message = JSON.parse(String(rawData)) as JsonRpcResponse<unknown> | JsonRpcNotification;
    } catch {
      return;
    }

    if ("id" in message) {
      const pending = this.pending.get(message.id);
      if (!pending && isJsonRpcRequest(message)) {
        this.handleServerRequest(message);
        return;
      }

      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      window.clearTimeout(pending.timeoutId);

      if (message.error) {
        pending.reject(
          new AppServerRpcError(
            message.error.message,
            message.error.code,
            message.error.data,
          ),
        );
        return;
      }

      pending.resolve(message.result);
      return;
    }

    if (isKnownNotification(message)) {
      this.onNotification(message);
    }
  }

  private handleServerRequest(request: JsonRpcRequest): void {
    this.onServerRequest?.(request);

    switch (request.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval":
      case "item/tool/requestUserInput":
      case "item/tool/call":
      case "applyPatchApproval":
      case "execCommandApproval":
      case "mcpServer/elicitation/request": {
        return;
      }
      case "account/chatgptAuthTokens/refresh":
      case "attestation/generate":
        return;
      default: {
        this.socket?.send(
          JSON.stringify({
            id: request.id,
            error: {
              code: -32601,
              message: `Unsupported server request: ${request.method}`,
            },
          }),
        );
      }
    }
  }

  private respond(id: number | string, result: unknown): void {
    this.socket?.send(JSON.stringify({ id, result }));
  }
}

function isKnownNotification(message: JsonRpcNotification): message is KnownAppServerNotification {
  return (
    message.method === "error" ||
    message.method === "account/login/completed" ||
    message.method === "account/rateLimits/updated" ||
    message.method === "account/updated" ||
    message.method === "app/list/updated" ||
    message.method === "command/exec/outputDelta" ||
    message.method === "configWarning" ||
    message.method === "externalAgentConfig/import/completed" ||
    message.method === "fs/changed" ||
    message.method === "item/agentMessage/delta" ||
    message.method === "item/commandExecution/outputDelta" ||
    message.method === "item/completed" ||
    message.method === "item/fileChange/patchUpdated" ||
    message.method === "item/plan/delta" ||
    message.method === "item/started" ||
    message.method === "mcpServer/oauthLogin/completed" ||
    message.method === "mcpServer/startupStatus/updated" ||
    message.method === "remoteControl/status/changed" ||
    message.method === "serverRequest/resolved" ||
    message.method === "skills/changed" ||
    message.method === "thread/archived" ||
    message.method === "thread/compacted" ||
    message.method === "thread/deleted" ||
    message.method === "thread/goal/cleared" ||
    message.method === "thread/goal/updated" ||
    message.method === "thread/name/updated" ||
    message.method === "thread/settings/updated" ||
    message.method === "thread/started" ||
    message.method === "thread/status/changed" ||
    message.method === "thread/tokenUsage/updated" ||
    message.method === "thread/unarchived" ||
    message.method === "turn/completed" ||
    message.method === "turn/diff/updated" ||
    message.method === "turn/plan/updated" ||
    message.method === "turn/started" ||
    message.method === "warning"
  );
}

function isJsonRpcRequest(message: JsonRpcResponse<unknown> | JsonRpcNotification | JsonRpcRequest): message is JsonRpcRequest {
  return "id" in message && "method" in message && typeof message.method === "string";
}
