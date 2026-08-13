import type {
  ActiveAgentVersionCatalogResponse,
  AgentVersionMutationResponse,
  ArchiveThreadRequest,
  AppendThreadMessageRequest,
  AppendThreadMessageResponse,
  CancelRunRequest,
  ClearThreadGoalRequest,
  CompactThreadRequest,
  CreateRunRequest,
  StartWorkflowRunRequest,
  DecideWorkflowHumanGateRequest,
  WorkflowHumanGateDecisionResponse,
  CreateThreadRequest,
  DecideToolApprovalRequest,
  DeleteThreadRequest,
  ErrorCategory,
  ErrorEnvelope,
  ForkThreadRequest,
  GetAgentVersionResponse,
  GetArtifactResponse,
  GetModelProviderSettingsResponse,
  GetRunResponse,
  GetThreadResponse,
  GetThreadGoalResponse,
  GetToolApprovalResponse,
  ListAgentVersionsResponse,
  ListThreadRunsResponse,
  ListThreadsResponse,
  ListThreadMessagesResponse,
  PublishAgentVersionRequest,
  PublishWorkflowVersionRequest,
  ProbeModelProviderResponse,
  WorkflowVersionMutationResponse,
  GetWorkflowVersionResponse,
  ListWorkflowVersionsResponse,
  RenameThreadRequest,
  RollbackThreadRequest,
  RunMutationResponse,
  StartTurnRequest,
  StartTurnResponse,
  RunEventViewMode,
  SetThreadGoalRequest,
  ThreadMutationResponse,
  ThreadHistoryViewMode,
  ThreadGoalMutationResponse,
  ToolApprovalMutationResponse,
  UnarchiveThreadRequest,
  CreateWorkspaceListRequest,
  GetWorkspaceOperationResponse,
  ListWorkspaceOperationsResponse,
  WorkspaceOperationActionRequest,
  WorkspaceOperationMutationResponse,
} from "@crewon/contracts";
import { WorkspaceControlClient } from "./workspace-control-client.ts";
import { readBoundedWorkspaceJson } from "./workspace-response-reader.ts";

export type ControlApiClientConfig = Readonly<{
  baseUrl: string;
  accessToken?: string | null;
  csrfToken?: string | null;
  origin?: string | null;
  fetch?: typeof globalThis.fetch;
}>;

export type ControlApiRequestOptions = Readonly<{
  signal?: AbortSignal;
}>;

export type ArtifactDownload = Readonly<{
  mediaType: string;
  contentDigest: string;
  content: Uint8Array;
}>;

const MAX_ARTIFACT_DOWNLOAD_BYTES = 1024 * 1024;

export class ControlApiClient {
  readonly #baseUrl: URL;
  readonly #accessToken: string | null;
  readonly #csrfToken: string | null;
  readonly #origin: string | null;
  readonly #fetch: typeof globalThis.fetch;

  constructor(config: ControlApiClientConfig) {
    this.#baseUrl = parseBaseUrl(config.baseUrl);
    this.#accessToken = optionalSecret(
      config.accessToken,
      "control_client_access_token_invalid",
    );
    this.#csrfToken = optionalSecret(
      config.csrfToken,
      "control_client_csrf_token_invalid",
    );
    this.#origin = optionalOrigin(config.origin);
    this.#fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  getModelProviderSettings(
    options: ControlApiRequestOptions = {},
  ): Promise<GetModelProviderSettingsResponse> {
    return this.#json("GET", "/api/v1/model-provider-settings", null, {
      ...options,
      expectedStatuses: [200],
    });
  }

  probeModelProvider(
    idempotencyKey: string,
    options: ControlApiRequestOptions = {},
  ): Promise<ProbeModelProviderResponse> {
    return this.#json(
      "POST",
      "/api/v1/model-provider-settings/probe",
      {},
      {
        ...options,
        idempotencyKey,
        expectedStatuses: [200],
      },
    );
  }

  createThread(
    body: CreateThreadRequest,
    idempotencyKey: string,
    options: ControlApiRequestOptions = {},
  ): Promise<ThreadMutationResponse> {
    return this.#json("POST", "/api/v1/threads", body, {
      ...options,
      idempotencyKey,
      expectedStatuses: [200, 201],
    });
  }

  listThreads(
    query: { cursor?: string | null; limit?: number } = {},
    options: ControlApiRequestOptions = {},
  ): Promise<ListThreadsResponse> {
    return this.#json("GET", withQuery("/api/v1/threads", query), null, {
      ...options,
      expectedStatuses: [200],
    });
  }

  getThread(
    threadId: string,
    options: ControlApiRequestOptions = {},
  ): Promise<GetThreadResponse> {
    return this.#json("GET", `/api/v1/threads/${resourceId(threadId)}`, null, {
      ...options,
      expectedStatuses: [200],
    });
  }

  archiveThread(
    threadId: string,
    body: ArchiveThreadRequest,
    idempotencyKey: string,
    options: ControlApiRequestOptions = {},
  ): Promise<ThreadMutationResponse> {
    return this.#json(
      "POST",
      `/api/v1/threads/${resourceId(threadId)}:archive`,
      body,
      {
        ...options,
        idempotencyKey,
        requireCsrf: true,
        requireIdempotency: true,
        expectedStatuses: [200],
      },
    );
  }

  rollbackThread(
    threadId: string,
    body: RollbackThreadRequest,
    idempotencyKey: string,
    options: ControlApiRequestOptions = {},
  ): Promise<ThreadMutationResponse> {
    return this.#json(
      "POST",
      `/api/v1/threads/${resourceId(threadId)}:rollback`,
      body,
      {
        ...options,
        idempotencyKey,
        requireCsrf: true,
        requireIdempotency: true,
        expectedStatuses: [200, 201],
      },
    );
  }

  unarchiveThread(
    threadId: string,
    body: UnarchiveThreadRequest,
    idempotencyKey: string,
    options: ControlApiRequestOptions = {},
  ): Promise<ThreadMutationResponse> {
    return this.#json(
      "POST",
      `/api/v1/threads/${resourceId(threadId)}:unarchive`,
      body,
      {
        ...options,
        idempotencyKey,
        requireCsrf: true,
        requireIdempotency: true,
        expectedStatuses: [200],
      },
    );
  }

  renameThread(
    threadId: string,
    body: RenameThreadRequest,
    idempotencyKey: string,
    options: ControlApiRequestOptions = {},
  ): Promise<ThreadMutationResponse> {
    return this.#json(
      "POST",
      `/api/v1/threads/${resourceId(threadId)}:rename`,
      body,
      {
        ...options,
        idempotencyKey,
        requireCsrf: true,
        requireIdempotency: true,
        expectedStatuses: [200],
      },
    );
  }

  deleteThread(
    threadId: string,
    body: DeleteThreadRequest,
    idempotencyKey: string,
    options: ControlApiRequestOptions = {},
  ): Promise<ThreadMutationResponse> {
    return this.#json(
      "POST",
      `/api/v1/threads/${resourceId(threadId)}:delete`,
      body,
      {
        ...options,
        idempotencyKey,
        requireCsrf: true,
        requireIdempotency: true,
        expectedStatuses: [200],
      },
    );
  }

  getThreadGoal(
    threadId: string,
    options: ControlApiRequestOptions = {},
  ): Promise<GetThreadGoalResponse> {
    return this.#json(
      "GET",
      `/api/v1/threads/${resourceId(threadId)}/goal`,
      null,
      { ...options, expectedStatuses: [200] },
    );
  }

  setThreadGoal(
    threadId: string,
    body: SetThreadGoalRequest,
    idempotencyKey: string,
    options: ControlApiRequestOptions = {},
  ): Promise<ThreadGoalMutationResponse> {
    return this.#json(
      "PUT",
      `/api/v1/threads/${resourceId(threadId)}/goal`,
      body,
      {
        ...options,
        idempotencyKey,
        requireCsrf: true,
        requireIdempotency: true,
        expectedStatuses: [200, 201],
      },
    );
  }

  clearThreadGoal(
    threadId: string,
    body: ClearThreadGoalRequest,
    idempotencyKey: string,
    options: ControlApiRequestOptions = {},
  ): Promise<ThreadGoalMutationResponse> {
    return this.#json(
      "DELETE",
      `/api/v1/threads/${resourceId(threadId)}/goal`,
      body,
      {
        ...options,
        idempotencyKey,
        requireCsrf: true,
        requireIdempotency: true,
        expectedStatuses: [200],
      },
    );
  }

  appendThreadMessage(
    threadId: string,
    body: AppendThreadMessageRequest,
    idempotencyKey: string,
    options: ControlApiRequestOptions = {},
  ): Promise<AppendThreadMessageResponse> {
    return this.#json(
      "POST",
      `/api/v1/threads/${resourceId(threadId)}/messages`,
      body,
      { ...options, idempotencyKey, expectedStatuses: [200, 201] },
    );
  }

  createWorkspaceListOperation(
    threadId: string,
    body: CreateWorkspaceListRequest,
    idempotencyKey: string,
    options: ControlApiRequestOptions = {},
  ): Promise<WorkspaceOperationMutationResponse> {
    return this.#workspaceClient().create(
      threadId,
      body,
      idempotencyKey,
      options,
    );
  }

  listWorkspaceListOperations(
    threadId: string,
    query: { afterExecutionId?: string | null; limit?: number } = {},
    options: ControlApiRequestOptions = {},
  ): Promise<ListWorkspaceOperationsResponse> {
    return this.#workspaceClient().list(threadId, query, options);
  }

  getWorkspaceListOperation(
    threadId: string,
    executionId: string,
    options: ControlApiRequestOptions = {},
  ): Promise<GetWorkspaceOperationResponse> {
    return this.#workspaceClient().get(threadId, executionId, options);
  }

  reconcileWorkspaceListOperation(
    threadId: string,
    executionId: string,
    body: WorkspaceOperationActionRequest,
    idempotencyKey: string,
    options: ControlApiRequestOptions = {},
  ): Promise<WorkspaceOperationMutationResponse> {
    return this.#workspaceClient().reconcile(
      threadId,
      executionId,
      body,
      idempotencyKey,
      options,
    );
  }

  cancelWorkspaceListOperation(
    threadId: string,
    executionId: string,
    body: WorkspaceOperationActionRequest,
    idempotencyKey: string,
    options: ControlApiRequestOptions = {},
  ): Promise<WorkspaceOperationMutationResponse> {
    return this.#workspaceClient().cancel(
      threadId,
      executionId,
      body,
      idempotencyKey,
      options,
    );
  }

  listThreadMessages(
    threadId: string,
    query: {
      cursor?: string | null;
      limit?: number;
      view?: ThreadHistoryViewMode;
    } = {},
    options: ControlApiRequestOptions = {},
  ): Promise<ListThreadMessagesResponse> {
    return this.#json(
      "GET",
      withQuery(`/api/v1/threads/${resourceId(threadId)}/messages`, query),
      null,
      { ...options, expectedStatuses: [200] },
    );
  }

  forkThread(
    threadId: string,
    body: ForkThreadRequest,
    idempotencyKey: string,
    options: ControlApiRequestOptions = {},
  ): Promise<ThreadMutationResponse> {
    return this.#json(
      "POST",
      `/api/v1/threads/${resourceId(threadId)}/forks`,
      body,
      { ...options, idempotencyKey, expectedStatuses: [200, 201] },
    );
  }

  listThreadRuns(
    threadId: string,
    query: { cursor?: string | null; limit?: number } = {},
    options: ControlApiRequestOptions = {},
  ): Promise<ListThreadRunsResponse> {
    return this.#json(
      "GET",
      withQuery(`/api/v1/threads/${resourceId(threadId)}/runs`, query),
      null,
      { ...options, expectedStatuses: [200] },
    );
  }

  startTurn(
    threadId: string,
    body: StartTurnRequest,
    idempotencyKey: string,
    options: ControlApiRequestOptions = {},
  ): Promise<StartTurnResponse> {
    return this.#json(
      "POST",
      `/api/v1/threads/${resourceId(threadId)}/turns`,
      body,
      { ...options, idempotencyKey, expectedStatuses: [200, 201] },
    );
  }

  compactThread(
    threadId: string,
    body: CompactThreadRequest,
    idempotencyKey: string,
    options: ControlApiRequestOptions = {},
  ): Promise<RunMutationResponse> {
    return this.#json(
      "POST",
      `/api/v1/threads/${resourceId(threadId)}:compact`,
      body,
      { ...options, idempotencyKey, expectedStatuses: [200, 201] },
    );
  }

  createRun(
    body: CreateRunRequest,
    idempotencyKey: string,
    options: ControlApiRequestOptions = {},
  ): Promise<RunMutationResponse> {
    return this.#json("POST", "/api/v1/runs", body, {
      ...options,
      idempotencyKey,
      expectedStatuses: [200, 201],
    });
  }

  startWorkflowRun(
    body: StartWorkflowRunRequest,
    idempotencyKey: string,
    options: ControlApiRequestOptions = {},
  ): Promise<RunMutationResponse> {
    return this.#json("POST", "/api/v1/workflow-runs", body, {
      ...options,
      idempotencyKey,
      expectedStatuses: [200, 201],
    });
  }

  decideWorkflowHumanGate(
    body: DecideWorkflowHumanGateRequest,
    idempotencyKey: string,
    options: ControlApiRequestOptions = {},
  ): Promise<WorkflowHumanGateDecisionResponse> {
    return this.#json("POST", "/api/v1/workflow-gates:decide", body, {
      ...options,
      idempotencyKey,
      expectedStatuses: [200],
    });
  }

  getRun(
    runId: string,
    options: ControlApiRequestOptions = {},
  ): Promise<GetRunResponse> {
    return this.#json("GET", `/api/v1/runs/${resourceId(runId)}`, null, {
      ...options,
      expectedStatuses: [200],
    });
  }

  cancelRun(
    runId: string,
    body: CancelRunRequest,
    idempotencyKey: string,
    options: ControlApiRequestOptions = {},
  ): Promise<RunMutationResponse> {
    return this.#json(
      "POST",
      `/api/v1/runs/${resourceId(runId)}:cancel`,
      body,
      { ...options, idempotencyKey, expectedStatuses: [200] },
    );
  }

  publishAgentVersion(
    body: PublishAgentVersionRequest,
    options: ControlApiRequestOptions = {},
  ): Promise<AgentVersionMutationResponse> {
    return this.#json("POST", "/api/v1/agent-versions", body, {
      ...options,
      expectedStatuses: [200, 201],
    });
  }

  publishWorkflowVersion(
    body: PublishWorkflowVersionRequest,
    options: ControlApiRequestOptions = {},
  ): Promise<WorkflowVersionMutationResponse> {
    return this.#json("POST", "/api/v1/workflow-versions", body, {
      ...options,
      expectedStatuses: [200, 201],
    });
  }

  getWorkflowVersion(
    workflowVersionId: string,
    options: ControlApiRequestOptions = {},
  ): Promise<GetWorkflowVersionResponse> {
    return this.#json(
      "GET",
      `/api/v1/workflow-versions/${resourceId(workflowVersionId)}`,
      null,
      { ...options, expectedStatuses: [200] },
    );
  }

  listWorkflowVersions(
    workflowId: string,
    query: { cursor?: string | null; limit?: number } = {},
    options: ControlApiRequestOptions = {},
  ): Promise<ListWorkflowVersionsResponse> {
    return this.#json(
      "GET",
      withQuery("/api/v1/workflow-versions", { workflowId, ...query }),
      null,
      { ...options, expectedStatuses: [200] },
    );
  }

  getAgentVersion(
    agentVersionId: string,
    options: ControlApiRequestOptions = {},
  ): Promise<GetAgentVersionResponse> {
    return this.#json(
      "GET",
      `/api/v1/agent-versions/${resourceId(agentVersionId)}`,
      null,
      { ...options, expectedStatuses: [200] },
    );
  }

  listAgentVersions(
    query: { cursor?: string | null; limit?: number } = {},
    options: ControlApiRequestOptions = {},
  ): Promise<ListAgentVersionsResponse> {
    return this.#json("GET", withQuery("/api/v1/agent-versions", query), null, {
      ...options,
      expectedStatuses: [200],
    });
  }

  getActiveAgentVersionCatalog(
    options: ControlApiRequestOptions = {},
  ): Promise<ActiveAgentVersionCatalogResponse> {
    return this.#json("GET", "/api/v1/agent-versions/active", null, {
      ...options,
      expectedStatuses: [200],
    });
  }

  getArtifact(
    artifactId: string,
    options: ControlApiRequestOptions = {},
  ): Promise<GetArtifactResponse> {
    return this.#json(
      "GET",
      `/api/v1/artifacts/${resourceId(artifactId)}`,
      null,
      { ...options, expectedStatuses: [200] },
    );
  }

  async downloadArtifact(
    artifactId: string,
    options: ControlApiRequestOptions = {},
  ): Promise<ArtifactDownload> {
    const response = await this.#fetch(
      new URL(
        `/api/v1/artifacts/${resourceId(artifactId)}/content`,
        this.#baseUrl,
      ),
      {
        method: "GET",
        headers: this.#authenticatedHeaders("application/octet-stream"),
        credentials: "include",
        signal: options.signal,
      },
    );
    if (response.status !== 200) {
      throw await controlApiError(response);
    }
    const mediaType = response.headers.get("content-type") ?? "";
    const contentDigest = parseArtifactEtag(response.headers.get("etag"));
    if (
      mediaType.length === 0 ||
      mediaType.length > 128 ||
      /[\r\n]/u.test(mediaType) ||
      response.headers.get("content-disposition") !==
        "attachment; filename=artifact"
    ) {
      throw new ControlApiProtocolError(
        "control_client_artifact_response_invalid",
      );
    }
    const content = await readBoundedArtifact(response);
    const digestInput = new ArrayBuffer(content.byteLength);
    new Uint8Array(digestInput).set(content);
    const digest = `sha256:${toHex(
      await globalThis.crypto.subtle.digest("SHA-256", digestInput),
    )}`;
    if (digest !== contentDigest) {
      throw new ControlApiProtocolError(
        "control_client_artifact_digest_mismatch",
      );
    }
    return { mediaType, contentDigest, content };
  }

  getToolApproval(
    approvalId: string,
    options: ControlApiRequestOptions = {},
  ): Promise<GetToolApprovalResponse> {
    return this.#json(
      "GET",
      `/api/v1/tool-approvals/${resourceId(approvalId)}`,
      null,
      { ...options, expectedStatuses: [200] },
    );
  }

  decideToolApproval(
    approvalId: string,
    body: DecideToolApprovalRequest,
    idempotencyKey: string,
    options: ControlApiRequestOptions = {},
  ): Promise<ToolApprovalMutationResponse> {
    return this.#json(
      "POST",
      `/api/v1/tool-approvals/${resourceId(approvalId)}:decide`,
      body,
      { ...options, idempotencyKey, expectedStatuses: [200] },
    );
  }

  openRunEventStream(input: {
    runId: string;
    afterSequence: number;
    view: RunEventViewMode;
    signal?: AbortSignal;
  }): Promise<Response> {
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) {
      throw new ControlApiProtocolError("control_client_event_cursor_invalid");
    }
    if (input.view !== "client" && input.view !== "audit") {
      throw new ControlApiProtocolError("control_client_event_view_invalid");
    }
    const headers = this.#authenticatedHeaders("text/event-stream");
    if (input.afterSequence > 0) {
      headers.set("last-event-id", String(input.afterSequence));
    }
    return this.#fetch(
      new URL(
        `/api/v1/runs/${resourceId(input.runId)}/events?view=${input.view}`,
        this.#baseUrl,
      ),
      {
        method: "GET",
        headers,
        credentials: "include",
        signal: input.signal,
      },
    );
  }

  openThreadGoalEventStream(input: {
    threadId: string;
    afterSequence: number;
    signal?: AbortSignal;
  }): Promise<Response> {
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) {
      throw new ControlApiProtocolError("control_client_event_cursor_invalid");
    }
    const headers = this.#authenticatedHeaders("text/event-stream");
    if (input.afterSequence > 0) {
      headers.set("last-event-id", String(input.afterSequence));
    }
    return this.#fetch(
      new URL(
        `/api/v1/threads/${resourceId(input.threadId)}/goal/events`,
        this.#baseUrl,
      ),
      {
        method: "GET",
        headers,
        credentials: "include",
        signal: input.signal,
      },
    );
  }

  openThreadEventStream(input: {
    threadId: string;
    afterSequence: number;
    view?: ThreadHistoryViewMode;
    signal?: AbortSignal;
  }): Promise<Response> {
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) {
      throw new ControlApiProtocolError("control_client_event_cursor_invalid");
    }
    const headers = this.#authenticatedHeaders("text/event-stream");
    if (input.afterSequence > 0) {
      headers.set("last-event-id", String(input.afterSequence));
    }
    const url = new URL(
      `/api/v1/threads/${resourceId(input.threadId)}/events`,
      this.#baseUrl,
    );
    if (input.view !== undefined) {
      if (input.view !== "standard" && input.view !== "audit") {
        throw new ControlApiProtocolError(
          "control_client_thread_history_view_invalid",
        );
      }
      url.searchParams.set("view", input.view);
    }
    return this.#fetch(url, {
      method: "GET",
      headers,
      credentials: "include",
      signal: input.signal,
    });
  }

  openWorkspaceListOperationEventStream(input: {
    threadId: string;
    executionId: string;
    afterSequence: number;
    signal?: AbortSignal;
  }): Promise<Response> {
    return this.#workspaceClient().openEventStream(input);
  }

  #workspaceClient(): WorkspaceControlClient {
    return new WorkspaceControlClient({
      baseUrl: this.#baseUrl,
      json: (method, path, body, options) =>
        this.#json(method, path, body, options),
      eventHeaders: () => this.#authenticatedHeaders("text/event-stream"),
      fetch: (url, init) => this.#fetch(url, init),
      protocolError: (code) => new ControlApiProtocolError(code),
    });
  }

  async #json<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body: unknown,
    options: ControlApiRequestOptions & {
      idempotencyKey?: string;
      requireCsrf?: boolean;
      requireIdempotency?: boolean;
      expectedStatuses: readonly number[];
      maximumResponseBytes?: number;
    },
  ): Promise<T> {
    const headers = this.#authenticatedHeaders("application/json");
    if (method !== "GET") {
      headers.set("content-type", "application/json");
      if (options.requireCsrf === true && this.#csrfToken === null) {
        throw new ControlApiProtocolError("control_client_csrf_token_required");
      }
      if (this.#csrfToken !== null) {
        headers.set("x-csrf-token", this.#csrfToken);
      }
    }
    if (
      options.requireIdempotency === true &&
      options.idempotencyKey === undefined
    ) {
      throw new ControlApiProtocolError(
        "control_client_idempotency_key_required",
      );
    }
    if (options.idempotencyKey !== undefined) {
      headers.set("idempotency-key", idempotencyKey(options.idempotencyKey));
    }
    const response = await this.#fetch(new URL(path, this.#baseUrl), {
      method,
      headers,
      credentials: "include",
      signal: options.signal,
      ...(body === null ? {} : { body: JSON.stringify(body) }),
    });
    if (!options.expectedStatuses.includes(response.status)) {
      throw await controlApiError(response, options.maximumResponseBytes);
    }
    return (await responseJson(response, options.maximumResponseBytes)) as T;
  }

  #authenticatedHeaders(accept: string): Headers {
    const headers = new Headers({ accept });
    if (this.#accessToken !== null) {
      headers.set("authorization", `Bearer ${this.#accessToken}`);
    }
    if (this.#origin !== null) {
      headers.set("origin", this.#origin);
    }
    return headers;
  }
}

export class ControlApiClientError extends Error {
  readonly status: number;
  readonly category: ErrorCategory;
  readonly code: string;
  readonly requestId: string;

  constructor(input: {
    status: number;
    category: ErrorCategory;
    code: string;
    requestId: string;
  }) {
    super(input.code);
    this.name = "ControlApiClientError";
    this.status = input.status;
    this.category = input.category;
    this.code = input.code;
    this.requestId = input.requestId;
  }
}

export class ControlApiProtocolError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ControlApiProtocolError";
    this.code = code;
  }
}

const ERROR_CATEGORIES = new Set<ErrorCategory>([
  "authentication",
  "authorization",
  "notFound",
  "conflict",
  "validation",
  "rateLimit",
  "providerUnavailable",
  "deviceUnavailable",
  "unknownOutcome",
  "internal",
]);

async function controlApiError(
  response: Response,
  maximumResponseBytes?: number,
): Promise<Error> {
  try {
    const value = (await responseJson(
      response,
      maximumResponseBytes,
    )) as ErrorEnvelope;
    if (
      isPlainObject(value) &&
      isPlainObject(value.error) &&
      typeof value.error.category === "string" &&
      ERROR_CATEGORIES.has(value.error.category as ErrorCategory) &&
      typeof value.error.code === "string" &&
      typeof value.error.requestId === "string"
    ) {
      return new ControlApiClientError({
        status: response.status,
        category: value.error.category as ErrorCategory,
        code: value.error.code,
        requestId: value.error.requestId,
      });
    }
  } catch {
    // Replace malformed remote error bodies with a content-free protocol code.
  }
  return new ControlApiProtocolError("control_api_error_envelope_invalid");
}

async function responseJson(
  response: Response,
  maximumResponseBytes?: number,
): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:;|$)/iu.test(contentType)) {
    throw new ControlApiProtocolError("control_api_content_type_invalid");
  }
  const value =
    maximumResponseBytes === undefined
      ? await unboundedResponseJson(response)
      : await readBoundedWorkspaceJson(
          response,
          maximumResponseBytes,
          (code) => new ControlApiProtocolError(code),
        );
  if (!isPlainObject(value)) {
    throw new ControlApiProtocolError("control_api_response_invalid");
  }
  return value;
}

async function unboundedResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ControlApiProtocolError("control_api_json_invalid");
  }
}

function parseArtifactEtag(value: string | null): string {
  const match = value?.match(/^"(sha256:[a-f0-9]{64})"$/u);
  if (match?.[1] === undefined) {
    throw new ControlApiProtocolError(
      "control_client_artifact_response_invalid",
    );
  }
  return match[1];
}

async function readBoundedArtifact(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^[1-9][0-9]*$/u.test(contentLength) ||
      !Number.isSafeInteger(Number(contentLength)) ||
      Number(contentLength) > MAX_ARTIFACT_DOWNLOAD_BYTES)
  ) {
    throw new ControlApiProtocolError(
      "control_client_artifact_content_too_large",
    );
  }
  if (response.body === null) {
    throw new ControlApiProtocolError(
      "control_client_artifact_response_invalid",
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      total += chunk.value.byteLength;
      if (total > MAX_ARTIFACT_DOWNLOAD_BYTES) {
        throw new ControlApiProtocolError(
          "control_client_artifact_content_too_large",
        );
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  if (
    total < 1 ||
    (contentLength !== null && total !== Number(contentLength))
  ) {
    throw new ControlApiProtocolError(
      "control_client_artifact_response_invalid",
    );
  }
  const content = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

function toHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ControlApiProtocolError("control_client_base_url_invalid");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ControlApiProtocolError("control_client_base_url_invalid");
  }
  if (!url.pathname.endsWith("/")) {
    url.pathname += "/";
  }
  return url;
}

function resourceId(value: string): string {
  if (value.trim().length === 0 || value.length > 512) {
    throw new ControlApiProtocolError("control_client_resource_id_invalid");
  }
  return encodeURIComponent(value);
}

function idempotencyKey(value: string): string {
  if (value.trim().length === 0 || value.length > 256) {
    throw new ControlApiProtocolError("control_client_idempotency_key_invalid");
  }
  return value;
}

function optionalSecret(
  value: string | null | undefined,
  code: string,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (value.length === 0 || value.length > 8192) {
    throw new ControlApiProtocolError(code);
  }
  return value;
}

function optionalOrigin(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ControlApiProtocolError("control_client_origin_invalid");
  }
  if (
    url.origin !== value ||
    (url.protocol !== "http:" && url.protocol !== "https:")
  ) {
    throw new ControlApiProtocolError("control_client_origin_invalid");
  }
  return value;
}

function withQuery(
  path: string,
  query: {
    cursor?: string | null;
    limit?: number;
    view?: ThreadHistoryViewMode;
    workflowId?: string;
  },
): string {
  const parameters = new URLSearchParams();
  if (query.workflowId !== undefined) {
    parameters.set("workflowId", resourceId(query.workflowId));
  }
  if (query.cursor !== undefined && query.cursor !== null) {
    parameters.set("cursor", query.cursor);
  }
  if (query.limit !== undefined) {
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 100
    ) {
      throw new ControlApiProtocolError("control_client_page_limit_invalid");
    }
    parameters.set("limit", String(query.limit));
  }
  if (query.view !== undefined) {
    if (query.view !== "standard" && query.view !== "audit") {
      throw new ControlApiProtocolError(
        "control_client_thread_history_view_invalid",
      );
    }
    parameters.set("view", query.view);
  }
  const encoded = parameters.toString();
  return encoded.length === 0 ? path : `${path}?${encoded}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
