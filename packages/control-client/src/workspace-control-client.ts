import {
  WORKSPACE_CONTROL_LIMITS,
  parseCreateWorkspaceListRequest,
  parseGetWorkspaceOperationResponse,
  parseListWorkspaceOperationsResponse,
  parseWorkspaceExecutionId,
  parseWorkspaceOperationActionRequest,
  parseWorkspaceOperationListQuery,
  parseWorkspaceOperationMutationResponse,
  type CreateWorkspaceListRequest,
  type GetWorkspaceOperationResponse,
  type ListWorkspaceOperationsResponse,
  type WorkspaceOperationActionRequest,
  type WorkspaceOperationMutationResponse,
} from "@crewon/contracts";

const MAX_WORKSPACE_OPERATION_RESPONSE_BYTES = 128 * 1024;

export type WorkspaceControlRequestOptions = Readonly<{
  signal?: AbortSignal;
  headers?: HeadersInit;
}>;

export type WorkspaceControlJsonOptions = WorkspaceControlRequestOptions &
  Readonly<{
    idempotencyKey?: string;
    requireCsrf?: boolean;
    requireIdempotency?: boolean;
    expectedStatuses: readonly number[];
    maximumResponseBytes?: number;
  }>;

export type WorkspaceControlTransport = Readonly<{
  json(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    options: WorkspaceControlJsonOptions,
  ): Promise<unknown>;
  eventHeaders(): Headers;
  fetch(url: URL, init: RequestInit): Promise<Response>;
  baseUrl: URL;
  protocolError(code: string): Error;
}>;

export class WorkspaceControlClient {
  readonly #transport: WorkspaceControlTransport;

  constructor(transport: WorkspaceControlTransport) {
    this.#transport = transport;
  }

  async create(
    threadId: string,
    body: CreateWorkspaceListRequest,
    idempotencyKey: string,
    options: WorkspaceControlRequestOptions = {},
  ): Promise<WorkspaceOperationMutationResponse> {
    const request = parseCreateWorkspaceListRequest(body);
    const response = await this.#transport.json(
      "POST",
      workspaceListPath(threadId),
      request,
      mutationOptions(options, idempotencyKey, [200, 201]),
    );
    return parseWorkspaceOperationMutationResponse(response, { threadId });
  }

  async list(
    threadId: string,
    query: { afterExecutionId?: string | null; limit?: number } = {},
    options: WorkspaceControlRequestOptions = {},
  ): Promise<ListWorkspaceOperationsResponse> {
    const parsedQuery = parseWorkspaceOperationListQuery(query);
    const parameters = new URLSearchParams();
    if (parsedQuery.afterExecutionId !== null) {
      parameters.set("afterExecutionId", parsedQuery.afterExecutionId);
    }
    parameters.set("limit", String(parsedQuery.limit));
    const response = await this.#transport.json(
      "GET",
      `${workspaceListPath(threadId)}?${parameters}`,
      null,
      {
        ...options,
        expectedStatuses: [200],
        maximumResponseBytes: WORKSPACE_CONTROL_LIMITS.maxListResponseBytes,
      },
    );
    return parseListWorkspaceOperationsResponse(response, {
      threadId,
      query: parsedQuery,
    });
  }

  async get(
    threadId: string,
    executionId: string,
    options: WorkspaceControlRequestOptions = {},
  ): Promise<GetWorkspaceOperationResponse> {
    const expectedExecutionId = parseWorkspaceExecutionId(executionId);
    const response = await this.#transport.json(
      "GET",
      workspaceOperationPath(threadId, expectedExecutionId),
      null,
      {
        ...options,
        expectedStatuses: [200],
        maximumResponseBytes: MAX_WORKSPACE_OPERATION_RESPONSE_BYTES,
      },
    );
    return parseGetWorkspaceOperationResponse(response, {
      threadId,
      executionId: expectedExecutionId,
    });
  }

  reconcile(
    threadId: string,
    executionId: string,
    body: WorkspaceOperationActionRequest,
    idempotencyKey: string,
    options: WorkspaceControlRequestOptions = {},
  ): Promise<WorkspaceOperationMutationResponse> {
    return this.#action(
      "reconcile",
      threadId,
      executionId,
      body,
      idempotencyKey,
      options,
    );
  }

  cancel(
    threadId: string,
    executionId: string,
    body: WorkspaceOperationActionRequest,
    idempotencyKey: string,
    options: WorkspaceControlRequestOptions = {},
  ): Promise<WorkspaceOperationMutationResponse> {
    return this.#action(
      "cancel",
      threadId,
      executionId,
      body,
      idempotencyKey,
      options,
    );
  }

  openEventStream(input: {
    threadId: string;
    executionId: string;
    afterSequence: number;
    signal?: AbortSignal;
  }): Promise<Response> {
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) {
      throw this.#transport.protocolError(
        "control_client_workspace_event_cursor_invalid",
      );
    }
    const executionId = parseWorkspaceExecutionId(input.executionId);
    const headers = this.#transport.eventHeaders();
    if (input.afterSequence > 0)
      headers.set("last-event-id", String(input.afterSequence));
    return this.#transport.fetch(
      new URL(
        `${workspaceOperationPath(input.threadId, executionId)}/events`,
        this.#transport.baseUrl,
      ),
      { method: "GET", headers, credentials: "include", signal: input.signal },
    );
  }

  async #action(
    action: "reconcile" | "cancel",
    threadId: string,
    executionId: string,
    body: WorkspaceOperationActionRequest,
    idempotencyKey: string,
    options: WorkspaceControlRequestOptions,
  ): Promise<WorkspaceOperationMutationResponse> {
    const expectedExecutionId = parseWorkspaceExecutionId(executionId);
    const response = await this.#transport.json(
      "POST",
      `${workspaceOperationPath(threadId, expectedExecutionId)}:${action}`,
      parseWorkspaceOperationActionRequest(body),
      mutationOptions(options, idempotencyKey, [200]),
    );
    return parseWorkspaceOperationMutationResponse(response, {
      threadId,
      executionId: expectedExecutionId,
    });
  }
}

function mutationOptions(
  options: WorkspaceControlRequestOptions,
  idempotencyKey: string,
  expectedStatuses: readonly number[],
): WorkspaceControlJsonOptions {
  return {
    ...options,
    idempotencyKey,
    requireCsrf: true,
    requireIdempotency: true,
    expectedStatuses,
    maximumResponseBytes: MAX_WORKSPACE_OPERATION_RESPONSE_BYTES,
  };
}

function workspaceListPath(threadId: string): string {
  return `/api/v1/threads/${resourceId(threadId)}/workspace-list`;
}

function workspaceOperationPath(threadId: string, executionId: string): string {
  return `${workspaceListPath(threadId)}/${resourceId(executionId)}`;
}

function resourceId(value: string): string {
  if (value.trim().length === 0 || value.length > 128) {
    throw new TypeError("control_api_resource_id_invalid");
  }
  return encodeURIComponent(value);
}
