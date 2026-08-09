import type { Thread } from "@crewon-protocol/v2/Thread";
import type { Turn } from "@crewon-protocol/v2/Turn";
import type { TurnStartResponse } from "@crewon-protocol/v2/TurnStartResponse";
import type {
  ActiveAgentVersionCatalogResponse,
  AgentVersionView,
  ClearThreadGoalRequest,
  GetThreadGoalResponse,
  MessageView,
  RunEventView,
  RunView,
  SetThreadGoalRequest,
  ThreadEventView,
  ThreadView,
} from "@crewon/contracts";
import {
  ControlApiClient,
  ControlApiClientError,
  ControlApiProtocolError,
  streamRunEvents,
  streamThreadEvents,
} from "@crewon/control-client";

import type { ThreadRuntimeSettings } from "../thread/threadRuntimeSettings";
import type { PendingComposerMention } from "../shared/composerMentions";
import type { ComposerImageInput } from "../shared/composerImages";
import {
  ThreadGoalControlState,
  type ControlThreadGoalMutationSignal,
  type ControlThreadGoalSnapshot,
  type ThreadGoalEventStream,
} from "./threadGoalControlState";

const MAX_LIST_PAGES = 10;
const PAGE_SIZE = 100;

type RunEventStream = (
  client: ControlApiClient,
  input: {
    runId: string;
    afterSequence?: number;
    view?: "client" | "audit";
    signal?: AbortSignal;
  },
) => AsyncIterable<RunEventView>;

type ThreadEventStream = (
  client: ControlApiClient,
  input: {
    threadId: string;
    afterSequence?: number;
    view?: "standard" | "audit";
    signal?: AbortSignal;
  },
) => AsyncIterable<ThreadEventView>;

export type ControlThreadRuntimeCallbacks = Readonly<{
  onThread: (thread: Thread) => void;
  onThreadDeleted?: (threadId: string) => void;
  onTextDelta: (threadId: string, delta: string) => void;
  onRunSettled: (threadId: string, runId: string) => void;
  onStreamError: (threadId: string, runId: string, error: unknown) => void;
  onThreadRolledBack?: (threadId: string) => void;
  onThreadStreamError?: (threadId: string, error: unknown) => void;
  onThreadGoal?: (snapshot: ControlThreadGoalSnapshot) => void;
  onGoalStreamError?: (threadId: string, error: unknown) => void;
  onGoalMutation?: (signal: ControlThreadGoalMutationSignal) => void;
}>;

export type ControlThreadRuntimeConfig = Readonly<{
  client: ControlApiClient;
  eventStream?: RunEventStream;
  threadEventStream?: ThreadEventStream;
  goalEventStream?: ThreadGoalEventStream;
  idempotencyKey?: (operation: string) => string;
  reconnectDelay?: (attempt: number, signal: AbortSignal) => Promise<void>;
}>;

/**
 * Adapts the generated Control REST/SSE contract to the existing CrewON thread
 * presentation model. Product authority remains in Control API and Runtime
 * Worker; this adapter only computes a bounded UI projection.
 */
export class ControlThreadRuntime {
  readonly #client: ControlApiClient;
  readonly #eventStream: RunEventStream;
  readonly #threadEventStream: ThreadEventStream;
  readonly #goals: ThreadGoalControlState;
  readonly #callbacks: ControlThreadRuntimeCallbacks;
  readonly #idempotencyKey: (operation: string) => string;
  readonly #reconnectDelay: (
    attempt: number,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly #runStreams = new Map<
    string,
    Readonly<{ threadId: string; controller: AbortController }>
  >();
  readonly #threadStreams = new Map<string, AbortController>();
  #closed = false;

  constructor(
    config: ControlThreadRuntimeConfig,
    callbacks: ControlThreadRuntimeCallbacks,
  ) {
    this.#client = config.client;
    this.#eventStream = config.eventStream ?? streamRunEvents;
    this.#threadEventStream = config.threadEventStream ?? streamThreadEvents;
    this.#callbacks = callbacks;
    this.#idempotencyKey =
      config.idempotencyKey ??
      ((operation) => `${operation}:${globalThis.crypto.randomUUID()}`);
    this.#reconnectDelay = config.reconnectDelay ?? defaultReconnectDelay;
    this.#goals = new ThreadGoalControlState({
      client: this.#client,
      eventStream: config.goalEventStream,
      idempotencyKey: this.#idempotencyKey,
      callbacks: {
        onSnapshot: callbacks.onThreadGoal,
        onStreamError: callbacks.onGoalStreamError,
        onMutation: (signal) => {
          if (signal.adoptRun !== null && !isTerminalRun(signal.adoptRun)) {
            this.#ensureEventStream(
              signal.threadId,
              signal.adoptRun.runId,
              signal.adoptRun.collaborationMode,
            );
          }
          callbacks.onGoalMutation?.(signal);
        },
      },
    });
  }

  async connect(): Promise<void> {
    await Promise.all([
      this.#client.getActiveAgentVersionCatalog(),
      this.#client.listThreads({ limit: 1 }),
    ]);
  }

  close(): void {
    this.#closed = true;
    this.#goals.close();
    for (const stream of this.#runStreams.values()) {
      stream.controller.abort();
    }
    this.#runStreams.clear();
    for (const controller of this.#threadStreams.values()) {
      controller.abort();
    }
    this.#threadStreams.clear();
  }

  async listThreads(showArchived: boolean): Promise<Thread[]> {
    const views: ThreadView[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const response = await this.#client.listThreads({
        ...(cursor === null ? {} : { cursor }),
        limit: PAGE_SIZE,
      });
      views.push(...response.data);
      cursor = response.nextCursor;
      if (cursor === null) {
        return views
          .filter((thread) =>
            showArchived
              ? thread.status === "archived"
              : thread.status === "active",
          )
          .map(controlThreadSummary);
      }
    }
    throw new Error("control_thread_list_page_limit_exceeded");
  }

  async searchThreads(
    searchTerm: string,
    showArchived: boolean,
  ): Promise<Thread[]> {
    const query = searchTerm.trim().toLocaleLowerCase();
    return (await this.listThreads(showArchived)).filter((thread) =>
      `${thread.name ?? ""} ${thread.preview}`
        .toLocaleLowerCase()
        .includes(query),
    );
  }

  async listLoadedThreadIds(): Promise<string[]> {
    return [];
  }

  async startThread(): Promise<Thread> {
    const response = await this.#client.createThread(
      { title: null },
      this.#idempotencyKey("thread.create"),
    );
    return controlThreadSummary(response.thread);
  }

  async resumeThread(threadId: string): Promise<Thread> {
    return this.readThread(threadId);
  }

  async archiveThread(threadId: string): Promise<void> {
    const current = await this.#client.getThread(threadId);
    if (
      current.thread.threadId !== threadId ||
      current.thread.status !== "active"
    ) {
      throw new Error("control_thread_archive_state_invalid");
    }
    const command = { expectedRevision: current.thread.revision } as const;
    const response = await this.#commitThreadMutation(
      threadId,
      "thread.archive",
      (idempotencyKey) =>
        this.#client.archiveThread(threadId, command, idempotencyKey),
    );
    if (
      response.thread.threadId !== threadId ||
      response.thread.status !== "archived" ||
      response.thread.revision !== current.thread.revision + 1 ||
      response.thread.archivedAt === null
    ) {
      throw new Error("control_thread_archive_response_invalid");
    }
    this.#callbacks.onThread(controlThreadSummary(response.thread));
  }

  async unarchiveThread(threadId: string): Promise<void> {
    const current = await this.#client.getThread(threadId);
    if (
      current.thread.threadId !== threadId ||
      current.thread.status !== "archived"
    ) {
      throw new Error("control_thread_unarchive_state_invalid");
    }
    const command = { expectedRevision: current.thread.revision } as const;
    const response = await this.#commitThreadMutation(
      threadId,
      "thread.unarchive",
      (idempotencyKey) =>
        this.#client.unarchiveThread(threadId, command, idempotencyKey),
    );
    if (
      response.thread.threadId !== threadId ||
      response.thread.status !== "active" ||
      response.thread.revision !== current.thread.revision + 1 ||
      response.thread.archivedAt !== null ||
      response.thread.deletedAt !== null
    ) {
      throw new Error("control_thread_unarchive_response_invalid");
    }
    this.#callbacks.onThread(controlThreadSummary(response.thread));
  }

  async deleteThread(threadId: string): Promise<void> {
    const current = await this.#client.getThread(threadId);
    if (
      current.thread.threadId !== threadId ||
      (current.thread.status !== "active" &&
        current.thread.status !== "archived")
    ) {
      throw new Error("control_thread_delete_state_invalid");
    }
    const command = { expectedRevision: current.thread.revision } as const;
    const response = await this.#commitThreadMutation(
      threadId,
      "thread.delete",
      (idempotencyKey) =>
        this.#client.deleteThread(threadId, command, idempotencyKey),
    );
    if (
      response.thread.threadId !== threadId ||
      response.thread.status !== "deleted" ||
      response.thread.revision !== current.thread.revision + 1 ||
      response.thread.title !== null ||
      response.thread.archivedAt !== null ||
      response.thread.deletedAt === null ||
      response.thread.deletedAt !== response.thread.updatedAt
    ) {
      throw new Error("control_thread_delete_response_invalid");
    }
    this.#callbacks.onThreadDeleted?.(threadId);
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    const current = await this.#client.getThread(threadId);
    if (
      current.thread.threadId !== threadId ||
      (current.thread.status !== "active" &&
        current.thread.status !== "archived")
    ) {
      throw new Error("control_thread_rename_state_invalid");
    }
    const command = {
      expectedRevision: current.thread.revision,
      title: name,
    } as const;
    const response = await this.#commitThreadMutation(
      threadId,
      "thread.rename",
      (idempotencyKey) =>
        this.#client.renameThread(threadId, command, idempotencyKey),
    );
    if (
      response.thread.threadId !== threadId ||
      response.thread.status !== current.thread.status ||
      response.thread.revision !== current.thread.revision + 1 ||
      response.thread.title !== name ||
      response.thread.deletedAt !== null
    ) {
      throw new Error("control_thread_rename_response_invalid");
    }
    this.#callbacks.onThread(controlThreadSummary(response.thread));
  }

  async rollbackThread(threadId: string, numTurns = 1): Promise<Thread> {
    if (
      !Number.isSafeInteger(numTurns) ||
      numTurns < 1 ||
      numTurns > 0xffff_ffff
    ) {
      throw new Error("control_thread_rollback_turn_count_invalid");
    }
    const current = await this.#client.getThread(threadId);
    if (
      current.thread.threadId !== threadId ||
      current.thread.status !== "active"
    ) {
      throw new Error("control_thread_rollback_state_invalid");
    }
    const command = {
      expectedRevision: current.thread.revision,
      numTurns,
    } as const;
    const response = await this.#commitThreadMutation(
      threadId,
      "thread.rollback",
      (idempotencyKey) =>
        this.#client.rollbackThread(threadId, command, idempotencyKey),
    );
    if (!isValidRollbackResponse(current.thread, response.thread)) {
      throw new Error("control_thread_rollback_response_invalid");
    }
    this.#stopRunStreamsForThread(threadId);
    this.#callbacks.onThreadRolledBack?.(threadId);
    const thread = await this.readThread(threadId);
    this.#callbacks.onThread(thread);
    return thread;
  }

  async #commitThreadMutation<Result>(
    threadId: string,
    operation: string,
    commit: (idempotencyKey: string) => Promise<Result>,
  ): Promise<Result> {
    const idempotencyKey = this.#idempotencyKey(operation);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await commit(idempotencyKey);
      } catch (error) {
        if (error instanceof ControlApiClientError && error.status === 409) {
          await this.#refreshThreadAfterConflict(threadId);
          throw error;
        }
        const retryableUnknownOutcome =
          error instanceof TypeError ||
          error instanceof ControlApiProtocolError ||
          (error instanceof ControlApiClientError &&
            error.category === "unknownOutcome");
        if (!retryableUnknownOutcome || attempt === 1) {
          throw error;
        }
      }
    }
    throw new Error("control_thread_mutation_retry_invariant");
  }

  async #refreshThreadAfterConflict(threadId: string): Promise<void> {
    try {
      this.#callbacks.onThread(await this.readThread(threadId));
    } catch (error) {
      if (
        error instanceof ControlApiClientError &&
        error.status === 404 &&
        error.category === "notFound"
      ) {
        this.#callbacks.onThreadDeleted?.(threadId);
        return;
      }
      throw error;
    }
  }

  async forkThread(threadId: string): Promise<{ thread: Thread }> {
    const current = await this.#client.getThread(threadId);
    const response = await this.#client.forkThread(
      threadId,
      {
        expectedRevision: current.thread.revision,
        throughHistorySequence: null,
      },
      this.#idempotencyKey("thread.fork"),
    );
    return { thread: controlThreadSummary(response.thread) };
  }

  async startReview(): Promise<never> {
    throw new Error("control_thread_review_not_supported");
  }

  selectThreadGoal(
    threadId: string | null,
  ): Promise<GetThreadGoalResponse | null> {
    return this.#goals.selectThread(threadId);
  }

  setThreadGoalObjective(threadId: string, objective: string) {
    return this.#goals.setObjective(threadId, objective);
  }

  setThreadGoal(threadId: string, command: SetThreadGoalRequest) {
    return this.#goals.mutateSet(threadId, command);
  }

  pauseThreadGoal(threadId: string) {
    return this.#goals.pause(threadId);
  }

  resumeThreadGoal(threadId: string) {
    return this.#goals.resume(threadId);
  }

  clearSelectedThreadGoal(threadId: string) {
    return this.#goals.clear(threadId);
  }

  clearThreadGoal(threadId: string, command: ClearThreadGoalRequest) {
    return this.#goals.mutateClear(threadId, command);
  }

  async readThread(threadId: string): Promise<Thread> {
    const projection = await this.#loadThreadProjection(threadId);
    this.#ensureThreadEventStream(threadId);
    return projection;
  }

  async #loadThreadProjection(threadId: string): Promise<Thread> {
    const [{ thread }, messages, runs] = await Promise.all([
      this.#client.getThread(threadId),
      this.#listMessages(threadId),
      this.#listRuns(threadId),
    ]);
    if (thread.threadId !== threadId) {
      throw new Error("control_thread_projection_identity_invalid");
    }
    const projection = controlThreadProjection(thread, messages, runs);
    const activeRun = runs.find((run) => !isTerminalRun(run));
    if (activeRun) {
      this.#ensureEventStream(
        threadId,
        activeRun.runId,
        activeRun.collaborationMode,
      );
    }
    return projection;
  }

  async startTurn(
    threadId: string,
    text: string,
    mentions: PendingComposerMention[] = [],
    settings?: ThreadRuntimeSettings,
    images: ComposerImageInput[] = [],
  ): Promise<TurnStartResponse> {
    validateSupportedTurnInput(mentions, settings, images);
    const [current, catalog] = await Promise.all([
      this.#client.getThread(threadId),
      this.#client.getActiveAgentVersionCatalog(),
    ]);
    const agentVersion = selectAgentVersion(catalog, settings);
    const started = await this.#client.startTurn(
      threadId,
      {
        expectedRevision: current.thread.revision,
        content: text,
        agentVersionId: agentVersion.agentVersionId,
        executionIntent: settings?.executionIntent ?? "none",
      },
      this.#idempotencyKey("turn.start"),
    );
    const turn = projectedTurn(started.message, null, started.run);
    this.#ensureEventStream(
      threadId,
      started.run.runId,
      started.run.collaborationMode,
    );
    return { turn };
  }

  async compactThread(threadId: string): Promise<void> {
    const [current, catalog] = await Promise.all([
      this.#client.getThread(threadId),
      this.#client.getActiveAgentVersionCatalog(),
    ]);
    if (
      current.thread.threadId !== threadId ||
      current.thread.status !== "active"
    ) {
      throw new Error("control_thread_compaction_state_invalid");
    }
    const agentVersion = selectAgentVersion(catalog, undefined);
    const response = await this.#commitThreadMutation(
      threadId,
      "thread.compact",
      (idempotencyKey) =>
        this.#client.compactThread(
          threadId,
          {
            expectedRevision: current.thread.revision,
            agentVersionId: agentVersion.agentVersionId,
          },
          idempotencyKey,
        ),
    );
    if (
      response.run.threadId !== threadId ||
      response.run.purpose !== "manualCompaction" ||
      response.run.status !== "queued" ||
      response.run.revision !== 1 ||
      response.run.goalBinding !== null
    ) {
      throw new Error("control_thread_compaction_response_invalid");
    }
    this.#ensureEventStream(
      threadId,
      response.run.runId,
      response.run.collaborationMode,
    );
  }

  async steerTurn(): Promise<{ turnId: string }> {
    throw new Error("control_run_steer_not_supported");
  }

  async interruptTurn(_threadId: string, runId: string): Promise<void> {
    const current = await this.#client.getRun(runId);
    await this.#client.cancelRun(
      runId,
      { expectedRevision: current.run.revision },
      this.#idempotencyKey("run.cancel"),
    );
  }

  async #listMessages(threadId: string): Promise<MessageView[]> {
    const messages: MessageView[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const response = await this.#client.listThreadMessages(threadId, {
        ...(cursor === null ? {} : { cursor }),
        limit: PAGE_SIZE,
      });
      messages.push(...response.data);
      cursor = response.nextCursor;
      if (cursor === null) {
        return messages;
      }
    }
    throw new Error("control_message_list_page_limit_exceeded");
  }

  async #listRuns(threadId: string): Promise<RunView[]> {
    const runs: RunView[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const response = await this.#client.listThreadRuns(threadId, {
        ...(cursor === null ? {} : { cursor }),
        limit: PAGE_SIZE,
      });
      runs.push(...response.data);
      cursor = response.nextCursor;
      if (cursor === null) {
        return runs;
      }
    }
    throw new Error("control_run_list_page_limit_exceeded");
  }

  #ensureEventStream(
    threadId: string,
    runId: string,
    collaborationMode: RunView["collaborationMode"],
  ): void {
    if (this.#closed || this.#runStreams.has(runId)) {
      return;
    }
    const controller = new AbortController();
    this.#runStreams.set(runId, { threadId, controller });
    void this.#consumeEventStream(
      threadId,
      runId,
      collaborationMode,
      controller,
    ).finally(() => {
      if (this.#runStreams.get(runId)?.controller === controller) {
        this.#runStreams.delete(runId);
      }
    });
  }

  #stopRunStreamsForThread(threadId: string): void {
    for (const [runId, stream] of this.#runStreams) {
      if (stream.threadId !== threadId) {
        continue;
      }
      stream.controller.abort();
      this.#runStreams.delete(runId);
      this.#callbacks.onRunSettled(threadId, runId);
    }
  }

  #ensureThreadEventStream(threadId: string): void {
    if (this.#closed || this.#threadStreams.has(threadId)) {
      return;
    }
    const controller = new AbortController();
    this.#threadStreams.set(threadId, controller);
    void this.#consumeThreadEventStream(threadId, controller).finally(() => {
      if (this.#threadStreams.get(threadId) === controller) {
        this.#threadStreams.delete(threadId);
      }
    });
  }

  async #consumeThreadEventStream(
    threadId: string,
    controller: AbortController,
  ): Promise<void> {
    let afterSequence = 0;
    let reconnectAttempt = 0;
    while (!controller.signal.aborted && !this.#closed) {
      try {
        for await (const event of this.#threadEventStream(this.#client, {
          threadId,
          afterSequence,
          view: "standard",
          signal: controller.signal,
        })) {
          if (event.sequence <= afterSequence) {
            continue;
          }
          if (event.type === "thread.rolled_back") {
            this.#stopRunStreamsForThread(threadId);
            this.#callbacks.onThreadRolledBack?.(threadId);
            this.#callbacks.onThread(
              await this.#loadThreadProjection(threadId),
            );
          }
          afterSequence = event.sequence;
          reconnectAttempt = 0;
        }
      } catch (error) {
        if (controller.signal.aborted || this.#closed) {
          return;
        }
        this.#callbacks.onThreadStreamError?.(threadId, error);
      }
      reconnectAttempt += 1;
      await this.#reconnectDelay(reconnectAttempt, controller.signal);
    }
  }

  async #consumeEventStream(
    threadId: string,
    runId: string,
    collaborationMode: RunView["collaborationMode"],
    controller: AbortController,
  ): Promise<void> {
    let afterSequence = 0;
    let reconnectAttempt = 0;
    while (!controller.signal.aborted && !this.#closed) {
      let terminal = false;
      try {
        for await (const event of this.#eventStream(this.#client, {
          runId,
          afterSequence,
          view: "client",
          signal: controller.signal,
        })) {
          if (event.sequence <= afterSequence) {
            continue;
          }
          afterSequence = event.sequence;
          reconnectAttempt = 0;
          if (
            event.type === "model.output.delta" &&
            collaborationMode !== "plan"
          ) {
            this.#callbacks.onTextDelta(threadId, event.data.delta);
          }
          if (isTerminalEvent(event)) {
            terminal = true;
            break;
          }
        }
        if (terminal) {
          const thread = await this.readThread(threadId);
          this.#callbacks.onThread(thread);
          this.#callbacks.onRunSettled(threadId, runId);
          return;
        }
      } catch (error) {
        if (controller.signal.aborted || this.#closed) {
          return;
        }
        this.#callbacks.onStreamError(threadId, runId, error);
      }
      reconnectAttempt += 1;
      await this.#reconnectDelay(reconnectAttempt, controller.signal);
    }
  }
}

export function controlThreadSummary(thread: ThreadView): Thread {
  return {
    id: thread.threadId,
    sessionId: thread.threadId,
    forkedFromId: thread.forkedFromThreadId,
    parentThreadId: null,
    preview: thread.title ?? "",
    ephemeral: false,
    modelProvider: "crewon-control",
    createdAt: unixSeconds(thread.createdAt),
    updatedAt: unixSeconds(thread.updatedAt),
    status: { type: "notLoaded" },
    path: null,
    cwd: "",
    clientVersion: "control-api-v1",
    source: { custom: "crewon-control" },
    threadSource: "control-api",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: thread.title,
    turns: [],
  };
}

export function controlThreadProjection(
  thread: ThreadView,
  messages: readonly MessageView[],
  runsNewestFirst: readonly RunView[],
): Thread {
  const summary = controlThreadSummary(thread);
  const users = messages.filter((message) => message.role === "user");
  const runs = [...runsNewestFirst].reverse();
  const turnRuns = runs.filter((run) => (run.purpose ?? "turn") === "turn");
  const turns = users.map((user, index) => {
    const nextUser = users[index + 1];
    const assistant = messages.find(
      (message) =>
        message.role === "assistant" &&
        message.sequence > user.sequence &&
        (nextUser === undefined || message.sequence < nextUser.sequence),
    );
    return projectedTurn(user, assistant ?? null, turnRuns[index] ?? null);
  });
  const activeRun = runsNewestFirst.find((run) => !isTerminalRun(run));
  return {
    ...summary,
    preview: users.at(-1)?.content ?? thread.title ?? "",
    status:
      activeRun === undefined
        ? { type: "idle" }
        : {
            type: "active",
            activeFlags:
              activeRun.status === "waitingApproval"
                ? ["waitingOnApproval"]
                : [],
          },
    turns,
  };
}

function projectedTurn(
  user: MessageView,
  assistant: MessageView | null,
  run: RunView | null,
): Turn {
  const status = run === null ? "failed" : projectedTurnStatus(run);
  const proposedPlan = assistant?.proposedPlan ?? null;
  if (
    proposedPlan !== null &&
    (run?.collaborationMode !== "plan" ||
      proposedPlan.threadId !== assistant?.threadId ||
      proposedPlan.runId !== run.runId ||
      proposedPlan.messageId !== assistant.messageId ||
      proposedPlan.content !== assistant.content)
  ) {
    throw new Error("control_proposed_plan_projection_invalid");
  }
  if (
    run?.status === "completed" &&
    run.collaborationMode === "plan" &&
    proposedPlan === null
  ) {
    throw new Error("control_proposed_plan_missing");
  }
  return {
    id: run?.runId ?? `orphan:${user.messageId}`,
    items: [
      {
        type: "userMessage",
        id: user.messageId,
        clientId: null,
        content: [{ type: "text", text: user.content, text_elements: [] }],
      },
      ...(assistant === null
        ? []
        : proposedPlan !== null
          ? [
              {
                type: "plan" as const,
                id: proposedPlan.planId,
                text: proposedPlan.content,
              },
            ]
          : [
              {
                type: "agentMessage" as const,
                id: assistant.messageId,
                text: assistant.content,
                phase: null,
                memoryCitation: null,
              },
            ]),
    ],
    itemsView: "full",
    status,
    error:
      status === "failed"
        ? {
            message: run?.failure?.code ?? "control_run_missing",
            codexErrorInfo: null,
            additionalDetails: null,
          }
        : null,
    startedAt: unixSeconds(run?.createdAt ?? user.createdAt),
    completedAt:
      run?.terminalAt === null || run?.terminalAt === undefined
        ? null
        : unixSeconds(run.terminalAt),
    durationMs:
      run?.terminalAt === null || run?.terminalAt === undefined
        ? null
        : Math.max(0, Date.parse(run.terminalAt) - Date.parse(run.createdAt)),
  };
}

function projectedTurnStatus(run: RunView): Turn["status"] {
  if (run.status === "failed") {
    return "failed";
  }
  if (run.status === "canceled") {
    return "interrupted";
  }
  if (run.status === "completed") {
    return "completed";
  }
  return "inProgress";
}

function isTerminalRun(run: RunView): boolean {
  return ["canceled", "completed", "failed"].includes(run.status);
}

function isTerminalEvent(event: RunEventView): boolean {
  return ["run.canceled", "run.completed", "run.failed"].includes(event.type);
}

function isValidRollbackResponse(
  current: ThreadView,
  response: ThreadView,
): boolean {
  const currentUpdatedAt = Date.parse(current.updatedAt);
  const responseUpdatedAt = Date.parse(response.updatedAt);
  return (
    response.threadId === current.threadId &&
    response.status === "active" &&
    response.revision === current.revision + 1 &&
    response.title === current.title &&
    response.lastMessageSequence === current.lastMessageSequence &&
    response.forkedFromThreadId === current.forkedFromThreadId &&
    response.forkedThroughHistorySequence ===
      current.forkedThroughHistorySequence &&
    response.createdAt === current.createdAt &&
    response.archivedAt === null &&
    response.deletedAt === null &&
    Number.isFinite(currentUpdatedAt) &&
    Number.isFinite(responseUpdatedAt) &&
    responseUpdatedAt >= currentUpdatedAt
  );
}

function validateSupportedTurnInput(
  mentions: readonly PendingComposerMention[],
  settings: ThreadRuntimeSettings | undefined,
  images: readonly ComposerImageInput[],
): void {
  if (mentions.length > 0) {
    throw new Error("control_mentions_not_supported");
  }
  if (images.length > 0) {
    throw new Error("control_images_not_supported");
  }
  const target = settings?.scene?.executionTarget;
  if (
    target !== undefined &&
    target.kind !== "crewon" &&
    target.kind !== "agent"
  ) {
    throw new Error("control_execution_target_not_supported");
  }
}

function selectAgentVersion(
  catalog: ActiveAgentVersionCatalogResponse,
  settings: ThreadRuntimeSettings | undefined,
): AgentVersionView {
  const target = settings?.scene?.executionTarget;
  const agentVersionId =
    target?.kind === "agent" ? target.id : catalog.defaultAgentVersionId;
  const matches = catalog.data.filter(
    (candidate) => candidate.agentVersionId === agentVersionId,
  );
  if (matches.length !== 1) {
    throw new Error(
      target?.kind === "agent"
        ? "control_agent_version_not_active"
        : "control_agent_version_catalog_invalid",
    );
  }
  const selected = matches[0];
  if (selected === undefined) {
    throw new Error("control_agent_version_catalog_invalid");
  }
  if (
    settings?.model !== undefined &&
    settings.model !== null &&
    settings.model !== selected.model.modelId
  ) {
    throw new Error("control_model_selection_mismatch");
  }
  return selected;
}

function unixSeconds(value: string): number {
  return Math.floor(Date.parse(value) / 1_000);
}

function defaultReconnectDelay(
  attempt: number,
  signal: AbortSignal,
): Promise<void> {
  const milliseconds = Math.min(5_000, 250 * 2 ** Math.min(attempt - 1, 5));
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeoutId = globalThis.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        globalThis.clearTimeout(timeoutId);
        resolve();
      },
      { once: true },
    );
  });
}
