import type {
  ClearThreadGoalRequest,
  GetThreadGoalResponse,
  RunView,
  SetThreadGoalRequest,
  ThreadGoalEventView,
  ThreadGoalMutationResponse,
  ThreadGoalView,
} from "@crewon/contracts";
import {
  ControlApiClient,
  ControlApiClientError,
  streamThreadGoalEvents,
} from "@crewon/control-client";

export type ControlThreadGoalSnapshot = Readonly<{
  threadId: string;
  goal: ThreadGoalView | null;
  eventSequence: number;
}>;

export type ControlThreadGoalMutationSignal = Readonly<{
  threadId: string;
  response: ThreadGoalMutationResponse;
  refreshThread: true;
  adoptRun: RunView | null;
}>;

export type ThreadGoalEventStream = (
  client: ControlApiClient,
  input: {
    threadId: string;
    afterSequence?: number;
    reconnectDelayMs?: number;
    signal?: AbortSignal;
  },
) => AsyncIterable<ThreadGoalEventView>;

export type ThreadGoalControlCallbacks = Readonly<{
  onSnapshot?: (snapshot: ControlThreadGoalSnapshot) => void;
  onStreamError?: (threadId: string, error: unknown) => void;
  onMutation?: (signal: ControlThreadGoalMutationSignal) => void;
}>;

type SelectedGoal = {
  threadId: string;
  generation: number;
  controller: AbortController;
  ready: boolean;
  goal: ThreadGoalView | null;
  eventSequence: number;
  suppressedGoal: Readonly<{ goalId: string; throughRevision: number }> | null;
};

/**
 * Owns the selected Thread's Goal snapshot/SSE cursor and optimistic mutation
 * fence. The supplied authenticated client is also passed to the SSE consumer,
 * so JSON and stream requests cannot silently diverge in identity.
 */
export class ThreadGoalControlState {
  readonly #client: ControlApiClient;
  readonly #eventStream: ThreadGoalEventStream;
  readonly #idempotencyKey: (operation: string) => string;
  readonly #callbacks: ThreadGoalControlCallbacks;
  #selection: SelectedGoal | null = null;
  #generation = 0;
  #closed = false;

  constructor(config: {
    client: ControlApiClient;
    eventStream?: ThreadGoalEventStream;
    idempotencyKey: (operation: string) => string;
    callbacks?: ThreadGoalControlCallbacks;
  }) {
    this.#client = config.client;
    this.#eventStream = config.eventStream ?? streamThreadGoalEvents;
    this.#idempotencyKey = config.idempotencyKey;
    this.#callbacks = config.callbacks ?? {};
  }

  close(): void {
    this.#closed = true;
    this.#selection?.controller.abort();
    this.#selection = null;
  }

  async selectThread(
    threadId: string | null,
  ): Promise<GetThreadGoalResponse | null> {
    this.#selection?.controller.abort();
    const generation = (this.#generation += 1);
    if (threadId === null || this.#closed) {
      this.#selection = null;
      return null;
    }

    const controller = new AbortController();
    const selection: SelectedGoal = {
      threadId,
      generation,
      controller,
      ready: false,
      goal: null,
      eventSequence: 0,
      suppressedGoal: null,
    };
    this.#selection = selection;
    const snapshot = await this.#client.getThreadGoal(threadId, {
      signal: controller.signal,
    });
    validateSnapshot(snapshot, threadId);
    if (!this.#isCurrent(selection)) return snapshot;

    selection.ready = true;
    selection.goal = snapshot.goal;
    selection.eventSequence = snapshot.eventSequence;
    this.#emitSnapshot(selection);
    void this.#consumeEvents(selection);
    return snapshot;
  }

  setObjective(
    threadId: string,
    objective: string,
  ): Promise<ThreadGoalMutationResponse> {
    const nextObjective = objective.trim();
    if (nextObjective.length === 0) {
      throw new Error("control_goal_objective_invalid");
    }
    const goal = this.#requireCurrentGoal(threadId);
    return this.mutateSet(threadId, {
      expectedRevision: goal.revision,
      objective: nextObjective,
      status: null,
      tokenBudget: { kind: "keep" },
    });
  }

  pause(threadId: string): Promise<ThreadGoalMutationResponse> {
    return this.#setStatus(threadId, "paused", "thread.goal.pause");
  }

  resume(threadId: string): Promise<ThreadGoalMutationResponse> {
    return this.#setStatus(threadId, "active", "thread.goal.resume");
  }

  clear(threadId: string): Promise<ThreadGoalMutationResponse> {
    const goal = this.#requireCurrentGoal(threadId);
    return this.mutateClear(threadId, { expectedRevision: goal.revision });
  }

  mutateSet(
    threadId: string,
    command: SetThreadGoalRequest,
  ): Promise<ThreadGoalMutationResponse> {
    this.#requireCommandRevision(
      threadId,
      command.expectedRevision,
      "allowCreate",
    );
    const fixedCommand: SetThreadGoalRequest = {
      expectedRevision: command.expectedRevision,
      objective: command.objective,
      status: command.status,
      tokenBudget:
        command.tokenBudget.kind === "keep"
          ? { kind: "keep" }
          : { kind: "set", value: command.tokenBudget.value },
    };
    return this.#mutate(threadId, "thread.goal.set", "set", (_goal, key) =>
      this.#client.setThreadGoal(threadId, fixedCommand, key),
    );
  }

  mutateClear(
    threadId: string,
    command: ClearThreadGoalRequest,
  ): Promise<ThreadGoalMutationResponse> {
    this.#requireCommandRevision(
      threadId,
      command.expectedRevision,
      "requireExisting",
    );
    const fixedCommand = { expectedRevision: command.expectedRevision };
    return this.#mutate(threadId, "thread.goal.clear", "clear", (_goal, key) =>
      this.#client.clearThreadGoal(threadId, fixedCommand, key),
    );
  }

  #setStatus(
    threadId: string,
    status: "active" | "paused",
    operation: string,
  ): Promise<ThreadGoalMutationResponse> {
    const goal = this.#requireCurrentGoal(threadId);
    return this.#mutate(threadId, operation, "set", (_goal, key) =>
      this.#client.setThreadGoal(
        threadId,
        {
          expectedRevision: goal.revision,
          objective: null,
          status,
          tokenBudget: { kind: "keep" },
        },
        key,
      ),
    );
  }

  async #mutate(
    threadId: string,
    operation: string,
    kind: "set" | "clear",
    request: (
      goal: ThreadGoalView | null,
      idempotencyKey: string,
    ) => Promise<ThreadGoalMutationResponse>,
  ): Promise<ThreadGoalMutationResponse> {
    const selection = this.#requireGoal(threadId);
    const goal = selection.goal;
    const key = this.#idempotencyKey(operation);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await request(goal, key);
        validateMutationResponse(response, threadId, goal, kind);
        if (this.#isCurrent(selection)) {
          selection.suppressedGoal =
            response.goal === null && goal !== null
              ? { goalId: goal.goalId, throughRevision: goal.revision }
              : null;
          selection.goal = response.goal;
          this.#emitSnapshot(selection);
        }
        this.#callbacks.onMutation?.({
          threadId,
          response,
          refreshThread: true,
          adoptRun: response.continuationRun ?? response.retainedRun,
        });
        return response;
      } catch (error) {
        if (isUnknownOutcome(error) && attempt === 0) continue;
        if (isConflict(error) && this.#isCurrent(selection)) {
          await this.selectThread(threadId);
        }
        throw error;
      }
    }
    throw new Error("control_goal_mutation_retry_exhausted");
  }

  #requireGoal(threadId: string): SelectedGoal {
    const selection = this.#selection;
    if (
      selection === null ||
      selection.threadId !== threadId ||
      !selection.ready ||
      !this.#isCurrent(selection)
    ) {
      throw new Error("control_goal_not_selected");
    }
    return selection;
  }

  #requireCurrentGoal(threadId: string): ThreadGoalView {
    const goal = this.#requireGoal(threadId).goal;
    if (goal === null) throw new Error("control_goal_missing");
    return goal;
  }

  #requireCommandRevision(
    threadId: string,
    expectedRevision: number | null,
    mode: "allowCreate" | "requireExisting",
  ) {
    const goal = this.#requireGoal(threadId).goal;
    if (goal === null) {
      if (mode === "allowCreate" && expectedRevision === null) return;
      throw new Error("control_goal_command_revision_mismatch");
    }
    if (expectedRevision !== goal.revision) {
      throw new Error("control_goal_command_revision_mismatch");
    }
  }

  async #consumeEvents(selection: SelectedGoal): Promise<void> {
    try {
      for await (const event of this.#eventStream(this.#client, {
        threadId: selection.threadId,
        afterSequence: selection.eventSequence,
        signal: selection.controller.signal,
      })) {
        if (!this.#isCurrent(selection)) return;
        this.#applyEvent(selection, event);
      }
    } catch (error) {
      if (this.#isCurrent(selection) && !selection.controller.signal.aborted) {
        this.#callbacks.onStreamError?.(selection.threadId, error);
      }
    }
  }

  #applyEvent(selection: SelectedGoal, event: ThreadGoalEventView): void {
    if (event.threadId !== selection.threadId) {
      throw new Error("control_goal_event_thread_mismatch");
    }
    if (event.sequence !== selection.eventSequence + 1) {
      throw new Error("control_goal_event_sequence_invalid");
    }
    selection.eventSequence = event.sequence;
    if (event.type === "goal.updated") {
      if (
        selection.suppressedGoal?.goalId === event.data.goal.goalId &&
        event.data.goal.revision <= selection.suppressedGoal.throughRevision
      ) {
        this.#emitSnapshot(selection);
        return;
      }
      selection.suppressedGoal = null;
      if (
        selection.goal?.goalId !== event.data.goal.goalId ||
        event.data.goal.revision >= selection.goal.revision
      ) {
        selection.goal = event.data.goal;
      }
    } else {
      if (
        selection.suppressedGoal?.goalId === event.data.previousGoalId &&
        selection.suppressedGoal.throughRevision === event.data.previousRevision
      ) {
        selection.suppressedGoal = null;
      }
      if (
        selection.goal?.goalId === event.data.previousGoalId &&
        selection.goal.revision === event.data.previousRevision
      ) {
        selection.goal = null;
      }
    }
    this.#emitSnapshot(selection);
  }

  #emitSnapshot(selection: SelectedGoal): void {
    this.#callbacks.onSnapshot?.({
      threadId: selection.threadId,
      goal: selection.goal,
      eventSequence: selection.eventSequence,
    });
  }

  #isCurrent(selection: SelectedGoal): boolean {
    return (
      !this.#closed &&
      this.#selection === selection &&
      selection.generation === this.#generation &&
      !selection.controller.signal.aborted
    );
  }
}

function isUnknownOutcome(error: unknown): boolean {
  return (
    error instanceof ControlApiClientError &&
    error.category === "unknownOutcome"
  );
}

function isConflict(error: unknown): boolean {
  return (
    error instanceof ControlApiClientError && error.category === "conflict"
  );
}

function validateSnapshot(
  snapshot: GetThreadGoalResponse,
  threadId: string,
): void {
  if (
    !Number.isSafeInteger(snapshot.eventSequence) ||
    snapshot.eventSequence < 0 ||
    (snapshot.goal !== null && snapshot.goal.threadId !== threadId)
  ) {
    throw new Error("control_goal_snapshot_invalid");
  }
}

function validateMutationResponse(
  response: ThreadGoalMutationResponse,
  threadId: string,
  current: ThreadGoalView | null,
  kind: "set" | "clear",
): void {
  const runs = [
    response.canceledRun,
    response.retainedRun,
    response.continuationRun,
  ];
  if (runs.some((run) => run !== null && run.threadId !== threadId)) {
    throw new Error("control_goal_mutation_response_invalid");
  }
  if (kind === "clear") {
    if (current === null || response.goal !== null) {
      throw new Error("control_goal_mutation_response_invalid");
    }
    return;
  }
  if (current === null) {
    if (
      response.goal === null ||
      response.goal.threadId !== threadId ||
      response.goal.goalId.trim().length === 0 ||
      response.goal.revision !== 1
    ) {
      throw new Error("control_goal_mutation_response_invalid");
    }
    return;
  }
  if (
    response.goal === null ||
    response.goal.threadId !== threadId ||
    response.goal.goalId !== current.goalId ||
    response.goal.revision !== current.revision + 1
  ) {
    throw new Error("control_goal_mutation_response_invalid");
  }
}
