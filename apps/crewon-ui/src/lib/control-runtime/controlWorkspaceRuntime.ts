import type {
  GetThreadResponse,
  WorkspaceOperationEventView,
  WorkspaceOperationMutationResponse,
  WorkspaceOperationView,
} from "@crewon/contracts";
import {
  isWorkspaceOperationTerminal,
  parseGetWorkspaceOperationResponse,
  parseListWorkspaceOperationsResponse,
  parseWorkspaceOperationEventView,
  parseWorkspaceOperationMutationResponse,
} from "@crewon/contracts";
import {
  ControlApiClient,
  ControlApiClientError,
  streamWorkspaceOperationEvents,
} from "@crewon/control-client";

import {
  MAX_LIST_PAGES, PAGE_SIZE, buildWorkspaceState, emptyState, isConflict, isGenerationCurrent, isStreamableOperation, isUnknownNetwork, validateThreadSnapshot, requireWorkspaceClient,
} from "./controlWorkspaceRuntimeSupport";
import type { ControlWorkspaceState, ControlWorkspaceStatus, OperationStream, Selection, WorkspaceOperationEventStream } from "./controlWorkspaceRuntimeSupport";
export type { ControlWorkspaceState, ControlWorkspaceStatus, WorkspaceOperationEventStream } from "./controlWorkspaceRuntimeSupport";

export class ControlWorkspaceRuntime {
  #client: ControlApiClient | null;
  readonly #eventStream: WorkspaceOperationEventStream;
  readonly #idempotencyKey: (operation: string) => string;
  readonly #listeners = new Set<() => void>();
  #state: ControlWorkspaceState;
  #selection: Selection | null = null;
  #generation = 0;
  #streamGeneration = 0;
  #closed = false;

  constructor(config: {
    client: ControlApiClient | null;
    eventStream?: WorkspaceOperationEventStream;
    idempotencyKey?: (operation: string) => string;
  }) {
    this.#client = config.client;
    this.#eventStream = config.eventStream ?? streamWorkspaceOperationEvents;
    this.#idempotencyKey =
      config.idempotencyKey ??
      ((operation) => `${operation}:${globalThis.crypto.randomUUID()}`);
    this.#state = emptyState(
      config.client === null ? "unavailable" : "available",
    );
}
  getSnapshot(): ControlWorkspaceState {
    return this.#state;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setAuthority(client: ControlApiClient | null): void {
    this.#client = client;
    this.#generation += 1;
    this.#abortSelection();
    this.#publish(emptyState(client === null ? "unavailable" : "available"));
  }

  close(): void {
    this.#closed = true;
    this.#generation += 1;
    this.#abortSelection();
    this.#listeners.clear();
  }

  async selectThread(threadId: string | null): Promise<void> {
    this.#generation += 1;
    this.#abortSelection();
    if (threadId === null) {
      this.#publish(
        emptyState(this.#client === null ? "unavailable" : "available"),
      );
      return;
    }
    const client = requireWorkspaceClient(this.#client, this.#closed);
    const controller = new AbortController();
    const generation = this.#generation;
    this.#publish({
      status: "loading",
      threadId,
      threadRevision: null,
      threadStatus: null,
      operations: [],
      eventSequences: {},
    });

    try {
      const thread = validateThreadSnapshot(
        await client.getThread(threadId, { signal: controller.signal }),
        threadId,
      );
      const selection: Selection = {
        generation,
        threadId,
        threadRevision: thread.thread.revision,
        threadStatus: thread.thread.status,
        controller,
        operations: new Map(),
        eventSequences: new Map(),
        streams: new Map(),
      };
      if (!isGenerationCurrent(this.#closed, this.#generation, generation, controller)) return;
      this.#selection = selection;
      await this.#recoverList(selection, client);
      if (!this.#isCurrent(selection)) return;
      this.#publishSelection(selection, "live");
      for (const operation of selection.operations.values()) {
        this.#startStream(
          selection,
          operation,
          selection.eventSequences.get(operation.executionId) ??
            operation.revision,
        );
      }
    } catch (error) {
      if (isGenerationCurrent(this.#closed, this.#generation, generation, controller)) {
        if (this.#selection?.generation === generation) {
          this.#selection = null;
        }
        controller.abort();
        this.#publish({
          status: "error",
          threadId,
          threadRevision: null,
          threadStatus: null,
          operations: [],
          eventSequences: {},
        });
      }
      throw error;
    }
  }

  async create(
    threadId: string,
    maxEntries: number,
  ): Promise<WorkspaceOperationView> {
    const selection = this.#requireSelection(threadId);
    if (selection.threadStatus !== "active") {
      throw new Error("control_workspace_thread_inactive");
    }
    const command = {
      expectedThreadRevision: selection.threadRevision,
      maxEntries,
    } as const;
    const response = await this.#mutate(
      selection,
      "workspace.create",
      null,
      (client, key) =>
        client.createWorkspaceListOperation(threadId, command, key, {
          signal: selection.controller.signal,
        }),
    );
    return response.operation;
  }

  async get(
    threadId: string,
    executionId: string,
  ): Promise<WorkspaceOperationView> {
    const selection = this.#requireSelection(threadId);
    const client = requireWorkspaceClient(this.#client, this.#closed);
    this.#publishSelection(selection, "loading");
    try {
      const response = parseGetWorkspaceOperationResponse(
        await client.getWorkspaceListOperation(threadId, executionId, {
          signal: selection.controller.signal,
        }),
        { threadId, executionId },
      );
      if (this.#isCurrent(selection)) {
        this.#adopt(selection, response.operation, response.eventSequence);
        this.#publishSelection(selection, "live");
        this.#startStream(
          selection,
          response.operation,
          response.eventSequence,
        );
      }
      return response.operation;
    } catch (error) {
      if (this.#isCurrent(selection))
        this.#publishSelection(selection, "error");
      throw error;
    }
  }

  reconcile(
    threadId: string,
    executionId: string,
  ): Promise<WorkspaceOperationView> {
    return this.#act(threadId, executionId, "reconcile");
  }

  cancel(
    threadId: string,
    executionId: string,
  ): Promise<WorkspaceOperationView> {
    return this.#act(threadId, executionId, "cancel");
  }

  async #act(
    threadId: string,
    executionId: string,
    action: "reconcile" | "cancel",
  ): Promise<WorkspaceOperationView> {
    const selection = this.#requireSelection(threadId);
    const operation = selection.operations.get(executionId);
    if (operation === undefined) {
      throw new Error("control_workspace_operation_not_loaded");
    }
    const command = { expectedOperationRevision: operation.revision } as const;
    const response = await this.#mutate(
      selection,
      `workspace.${action}`,
      executionId,
      (client, key) =>
        action === "reconcile"
          ? client.reconcileWorkspaceListOperation(
              threadId,
              executionId,
              command,
              key,
              { signal: selection.controller.signal },
            )
          : client.cancelWorkspaceListOperation(
              threadId,
              executionId,
              command,
              key,
              { signal: selection.controller.signal },
            ),
    );
    return response.operation;
  }

  async #mutate(
    selection: Selection,
    operationName: string,
    expectedExecutionId: string | null,
    request: (
      client: ControlApiClient,
      key: string,
    ) => Promise<WorkspaceOperationMutationResponse>,
  ): Promise<WorkspaceOperationMutationResponse> {
    const client = requireWorkspaceClient(this.#client, this.#closed);
    const key = this.#idempotencyKey(operationName);
    this.#publishSelection(selection, "mutating");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = parseWorkspaceOperationMutationResponse(
          await request(client, key),
          {
            threadId: selection.threadId,
            ...(expectedExecutionId === null
              ? {}
              : { executionId: expectedExecutionId }),
          },
        );
        if (this.#isCurrent(selection)) {
          this.#adopt(selection, response.operation, response.eventSequence);
          this.#publishSelection(selection, "live");
          this.#startStream(
            selection,
            response.operation,
            response.eventSequence,
          );
        }
        return response;
      } catch (error) {
        if (
          isUnknownNetwork(error) &&
          attempt === 0 &&
          this.#isCurrent(selection)
        ) {
          continue;
        }
        if (isConflict(error) && this.#isCurrent(selection)) {
          try {
            await this.#rehydrateConflict(selection, expectedExecutionId);
          } catch (rehydrateError) {
            if (this.#isCurrent(selection)) {
              this.#publishSelection(selection, "error");
            }
            throw rehydrateError;
          }
          throw error;
        }
        if (this.#isCurrent(selection))
          this.#publishSelection(selection, "error");
        throw error;
      }
    }
    throw new Error("control_workspace_mutation_retry_invariant");
  }

  async #rehydrateConflict(
    selection: Selection,
    executionId: string | null,
  ): Promise<void> {
    const client = requireWorkspaceClient(this.#client, this.#closed);
    const thread = validateThreadSnapshot(
      await client.getThread(selection.threadId, {
        signal: selection.controller.signal,
      }),
      selection.threadId,
    );
    if (!this.#isCurrent(selection)) return;
    selection.threadRevision = thread.thread.revision;
    selection.threadStatus = thread.thread.status;
    if (executionId !== null) {
      const snapshot = parseGetWorkspaceOperationResponse(
        await client.getWorkspaceListOperation(
          selection.threadId,
          executionId,
          {
            signal: selection.controller.signal,
          },
        ),
        { threadId: selection.threadId, executionId },
      );
      if (this.#isCurrent(selection)) {
        this.#adopt(selection, snapshot.operation, snapshot.eventSequence);
      }
    }
    if (this.#isCurrent(selection))
      this.#publishSelection(selection, "conflict");
  }

  async #recoverList(
    selection: Selection,
    client: ControlApiClient,
  ): Promise<void> {
    let afterExecutionId: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const query = { afterExecutionId, limit: PAGE_SIZE };
      const response = parseListWorkspaceOperationsResponse(
        await client.listWorkspaceListOperations(selection.threadId, query, {
          signal: selection.controller.signal,
        }),
        { threadId: selection.threadId, query },
      );
      if (!this.#isCurrent(selection)) return;
      for (const operation of response.data) {
        this.#adopt(selection, operation, operation.revision);
      }
      if (response.nextAfterExecutionId === null) return;
      afterExecutionId = response.nextAfterExecutionId;
    }
    throw new Error("control_workspace_list_page_limit_exceeded");
  }

  #startStream(
    selection: Selection,
    operation: WorkspaceOperationView,
    afterSequence: number,
  ): void {
    if (!this.#isCurrent(selection)) {
      return;
    }
    const existing = selection.streams.get(operation.executionId);
    existing?.controller.abort();
    if (!isStreamableOperation(operation)) {
      if (selection.streams.get(operation.executionId) === existing) {
        selection.streams.delete(operation.executionId);
      }
      return;
    }
    const stream: OperationStream = {
      generation: (this.#streamGeneration += 1),
      controller: new AbortController(),
    };
    selection.streams.set(operation.executionId, stream);
    const abortStream = () => stream.controller.abort();
    selection.controller.signal.addEventListener("abort", abortStream, {
      once: true,
    });
    void this.#consumeStream(
      selection,
      operation.executionId,
      afterSequence,
      stream,
    ).finally(() => {
      selection.controller.signal.removeEventListener("abort", abortStream);
      if (selection.streams.get(operation.executionId) === stream) {
        selection.streams.delete(operation.executionId);
      }
    });
  }

  async #consumeStream(
    selection: Selection,
    executionId: string,
    afterSequence: number,
    stream: OperationStream,
  ): Promise<void> {
    try {
      let cursor = afterSequence;
      for await (const raw of this.#eventStream(requireWorkspaceClient(this.#client, this.#closed), {
        threadId: selection.threadId,
        executionId,
        afterSequence,
        signal: stream.controller.signal,
      })) {
        if (!this.#isStreamCurrent(selection, executionId, stream)) return;
        const event = parseWorkspaceOperationEventView(raw, {
          threadId: selection.threadId,
          executionId,
          afterSequence: cursor,
        });
        cursor = event.sequence;
        this.#adopt(selection, event.data.operation, event.sequence);
        this.#publishSelection(selection, "live");
        if (isWorkspaceOperationTerminal(event.data.operation)) return;
      }
    } catch {
      if (this.#isStreamCurrent(selection, executionId, stream)) {
        this.#publishSelection(selection, "error");
      }
    }
  }

  #adopt(
    selection: Selection,
    operation: WorkspaceOperationView,
    eventSequence: number,
  ): void {
    selection.operations.set(operation.executionId, structuredClone(operation));
    selection.eventSequences.set(operation.executionId, eventSequence);
  }

  #publishSelection(
    selection: Selection,
    status: ControlWorkspaceStatus,
  ): void {
    if (!this.#isCurrent(selection)) return;
    this.#publish(buildWorkspaceState(selection, status));
  }

  #publish(state: ControlWorkspaceState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }

  #requireSelection(threadId: string): Selection {
    const selection = this.#selection;
    if (
      selection === null ||
      selection.threadId !== threadId ||
      !this.#isCurrent(selection)
    ) {
      throw new Error("control_workspace_thread_not_selected");
    }
    return selection;
  }
  #isCurrent(selection: Selection): boolean {
    return (
      this.#selection === selection &&
      isGenerationCurrent(
        this.#closed,
        this.#generation,
        selection.generation,
        selection.controller,
      )
    );
  }

  #isStreamCurrent(
    selection: Selection,
    executionId: string,
    stream: OperationStream,
  ): boolean {
    return (
      this.#isCurrent(selection) &&
      selection.streams.get(executionId)?.generation === stream.generation &&
      !stream.controller.signal.aborted
    );
  }

  #abortSelection(): void {
    const selection = this.#selection;
    this.#selection = null;
    if (selection === null) return;
    selection.controller.abort();
    for (const stream of selection.streams.values()) stream.controller.abort();
    selection.streams.clear();
  }
}
