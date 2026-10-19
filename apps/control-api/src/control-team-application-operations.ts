import type {
  ActorContext,
  AppendThreadMessageCommand,
  CreateRunCommand,
  ForkThreadCommand,
  RunRouteResolverPort,
  RunApplicationService,
  OfficeApplicationService,
  ThreadApplicationService,
  ThreadGoalApplicationService,
  TurnApplicationService,
} from "@crewon/application";
import type { ControlTeamRuntimeClient as TeamClient } from "@crewon/application/team-turn";
import type { TeamTaskWriteFence } from "@crewon/application/team-task-journal";
import type { TeamRunTerminalWait } from "@crewon/application/team-turn";
import { RunEventHub, RunEventSubscription } from "./run-event-hub.ts";
import {
  formatMessageCursor,
  parseMessageListQuery,
  type AppendThreadMessageResponse,
  type AuthorizeOfficeRunResponse,
  type CreateRunRequest,
  type ForkThreadRequest,
  type ExecutionIntentCapabilityResponse,
  type GetOfficeResponse,
  type GetRunResponse,
  type GetThreadGoalResponse,
  type GetThreadResponse,
  type ListThreadMessagesResponse,
  type RunMutationResponse,
  type StartTurnRequest,
  type StartTurnResponse,
  type SetThreadGoalRequest,
  type ThreadGoalMutationResponse,
  type ThreadMutationResponse,
} from "@crewon/contracts";
import {
  projectMessage,
  projectThread,
  projectThreadGoal,
  projectThreadGoalMutation,
  projectThreadSnapshot,
} from "./thread-projection.ts";
import { projectRun } from "./run-projection.ts";

export type ControlTeamApplicationOperationsDependencies = Readonly<{
  actor: ActorContext;
  threads: ThreadApplicationService;
  runs: RunApplicationService;
  offices: OfficeApplicationService;
  goals: ThreadGoalApplicationService;
  turns: TurnApplicationService;
  routeResolver: RunRouteResolverPort;
  eventHub?: RunEventHub;
}>;

/**
 * Builds Team operations directly on the Control application services. The
 * returned facade is immutable per fence, so concurrent Team tasks cannot
 * overwrite each other's write fence or actor scope.
 */
export function createControlTeamApplicationOperations(
  dependencies: ControlTeamApplicationOperationsDependencies,
): TeamClient {
  return createBoundOperations(dependencies, null);
}

function createBoundOperations(
  dependencies: ControlTeamApplicationOperationsDependencies,
  fence: TeamTaskWriteFence | null,
): TeamClient {
  const withFence = (next: TeamTaskWriteFence): TeamClient =>
    createBoundOperations(dependencies, structuredClone(next));
  return {
    withTeamTaskFence: withFence,
    ...(dependencies.eventHub === undefined
      ? {}
      : {
          waitForRunTerminal: createRunTerminalWait(
            dependencies,
            dependencies.eventHub,
          ),
        }),
    appendThreadMessage: (threadId, body, idempotencyKey) =>
      appendThreadMessage(dependencies, fence, threadId, body, idempotencyKey),
    authorizeOfficeRun: (officeVersionId, body) =>
      authorizeOfficeRun(dependencies, officeVersionId, body),
    createRun: (body, idempotencyKey) =>
      createRun(dependencies, fence, body, idempotencyKey),
    forkThread: (threadId, body, idempotencyKey) =>
      forkThread(dependencies, fence, threadId, body, idempotencyKey),
    getExecutionIntentCapability: async () =>
      ({ version: "v1" }) satisfies ExecutionIntentCapabilityResponse,
    getOffice: (officeVersionId) => getOffice(dependencies, officeVersionId),
    getRun: (runId) => getRun(dependencies, runId),
    getThread: (threadId) => getThread(dependencies, threadId),
    getThreadGoal: (threadId) => getThreadGoal(dependencies, threadId),
    listThreadMessages: (threadId, query) =>
      listThreadMessages(dependencies, threadId, query),
    setThreadGoalWithExecutionIntentV1: (threadId, body, idempotencyKey) =>
      setThreadGoal(dependencies, fence, threadId, body, idempotencyKey),
    startTurn: (threadId, body, idempotencyKey) =>
      startTurn(dependencies, fence, threadId, body, idempotencyKey),
  };
}

const EVENT_WAIT_FALLBACK_INTERVAL_MS = 250;

function createRunTerminalWait(
  d: ControlTeamApplicationOperationsDependencies,
  eventHub: RunEventHub,
): TeamRunTerminalWait {
  return async ({ run, deadlineAt, signal }) => {
    let subscription = eventHub.subscribe(run.runId);
    try {
      let current = (await getRun(d, run.runId)).run;
      if (isTerminalRun(current)) return current;
      while (true) {
        signal?.throwIfAborted();
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0)
          throw new Error("control_team_run_deadline_exceeded");
        const next = await nextRunEvent(
          subscription,
          signal,
          Math.min(remainingMs, EVENT_WAIT_FALLBACK_INTERVAL_MS),
        );
        if (next.kind === "timeout") {
          await subscription.return();
          subscription = eventHub.subscribe(run.runId);
          current = (await getRun(d, run.runId)).run;
        } else {
          if (next.result.done)
            throw new Error("control_team_run_event_wait_closed");
          if (isTerminalEvent(next.result.value.type))
            current = (await getRun(d, run.runId)).run;
        }
        if (isTerminalRun(current)) return current;
      }
    } finally {
      await subscription.return();
    }
  };
}

function nextRunEvent(
  subscription: RunEventSubscription,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<
  | { kind: "timeout" }
  | {
      kind: "event";
      result: IteratorResult<import("@crewon/domain").RunLifecycleEvent>;
    }
> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined = setTimeout(() => {
      timer = undefined;
      resolve({ kind: "timeout" });
    }, timeoutMs);
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      reject(signal?.reason ?? new Error("control_team_run_cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    void subscription.next().then(
      (result) => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        signal?.removeEventListener("abort", onAbort);
        resolve({ kind: "event", result });
      },
      (error) => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function isTerminalEvent(
  type: import("@crewon/domain").RunLifecycleEvent["type"],
): boolean {
  return (
    type === "run.completed" || type === "run.failed" || type === "run.canceled"
  );
}

function isTerminalRun(run: { status: string }): boolean {
  return (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "canceled"
  );
}

async function appendThreadMessage(
  d: ControlTeamApplicationOperationsDependencies,
  fence: TeamTaskWriteFence | null,
  threadId: string,
  body: { expectedRevision: number; content: string },
  idempotencyKey: string,
): Promise<AppendThreadMessageResponse> {
  const command: AppendThreadMessageCommand = {
    kind: "thread.message.append",
    idempotencyKey,
    threadId,
    expectedRevision: body.expectedRevision,
    role: "user",
    content: body.content,
    ...(fence === null ? {} : { teamTaskFence: fence }),
  };
  const result = await d.threads.appendMessage(d.actor, command);
  const message = result.messages[0];
  if (message === undefined || result.messages.length !== 1)
    throw new Error("team_append_message_result_invalid");
  return {
    disposition: result.disposition,
    thread: projectThread(result.state),
    message: projectMessage(message),
  };
}

async function authorizeOfficeRun(
  d: ControlTeamApplicationOperationsDependencies,
  officeVersionId: string,
  body: { targetId: string; threadId: string },
): Promise<AuthorizeOfficeRunResponse> {
  await d.threads.getThread(d.actor, body.threadId);
  const target = await d.offices.authorizeRun(
    d.actor,
    officeVersionId,
    body.targetId,
  );
  return { target: { ...target } };
}

async function createRun(
  d: ControlTeamApplicationOperationsDependencies,
  fence: TeamTaskWriteFence | null,
  body: CreateRunRequest,
  idempotencyKey: string,
): Promise<RunMutationResponse> {
  const route = await d.routeResolver.resolveRoute({
    actor: d.actor,
    threadId: body.threadId,
    agentVersionId: body.agentVersionId ?? null,
  });
  const result = await d.runs.createRun(d.actor, {
    kind: "run.create",
    idempotencyKey,
    threadId: body.threadId,
    route,
    toolPermissionMode: body.toolPermissionMode ?? "requestApproval",
    ...(fence === null ? {} : { teamTaskFence: fence }),
  });
  return { disposition: result.disposition, run: projectRun(result.state) };
}

async function forkThread(
  d: ControlTeamApplicationOperationsDependencies,
  fence: TeamTaskWriteFence | null,
  threadId: string,
  body: ForkThreadRequest,
  idempotencyKey: string,
): Promise<ThreadMutationResponse> {
  const result = await d.threads.forkThread(d.actor, {
    kind: "thread.fork",
    idempotencyKey,
    sourceThreadId: threadId,
    expectedSourceRevision: body.expectedRevision,
    throughHistorySequence: body.throughHistorySequence,
    ...(fence === null ? {} : { teamTaskFence: fence }),
  } satisfies ForkThreadCommand);
  return {
    disposition: result.disposition,
    thread: projectThread(result.state),
  };
}

async function getOffice(
  d: ControlTeamApplicationOperationsDependencies,
  officeVersionId: string,
): Promise<GetOfficeResponse> {
  const office = await d.offices.get(d.actor, officeVersionId);
  return {
    office: {
      ...office,
      members: office.members.map((member) => ({ ...member })),
      executionTargets: office.executionTargets.map((target) => ({
        ...target,
      })),
    },
  };
}

async function getRun(
  d: ControlTeamApplicationOperationsDependencies,
  runId: string,
): Promise<GetRunResponse> {
  return { run: projectRun(await d.runs.getRun(d.actor, runId)) };
}

async function getThread(
  d: ControlTeamApplicationOperationsDependencies,
  threadId: string,
): Promise<GetThreadResponse> {
  return projectThreadSnapshot(await d.threads.getThread(d.actor, threadId));
}

async function getThreadGoal(
  d: ControlTeamApplicationOperationsDependencies,
  threadId: string,
): Promise<GetThreadGoalResponse> {
  const snapshot = await d.goals.getGoal(d.actor, threadId);
  return {
    goal: snapshot.goal === null ? null : projectThreadGoal(snapshot.goal),
    eventSequence: snapshot.eventSequence,
  };
}

async function listThreadMessages(
  d: ControlTeamApplicationOperationsDependencies,
  threadId: string,
  query?: {
    cursor?: string | null;
    limit?: number;
    view?: "standard" | "audit";
  },
): Promise<ListThreadMessagesResponse> {
  const parsed = parseMessageListQuery({
    cursor: query?.cursor,
    limit: query?.limit === undefined ? undefined : String(query.limit),
    view: query?.view,
  });
  const data = (
    await d.threads.listMessages(d.actor, {
      threadId,
      afterSequence: parsed.afterSequence,
      limit: parsed.limit,
      view: parsed.view,
    })
  ).map(projectMessage);
  return {
    data,
    nextCursor:
      data.length === parsed.limit && data.at(-1) !== undefined
        ? formatMessageCursor(data.at(-1)!.sequence)
        : null,
  };
}

async function setThreadGoal(
  d: ControlTeamApplicationOperationsDependencies,
  fence: TeamTaskWriteFence | null,
  threadId: string,
  body: SetThreadGoalRequest,
  idempotencyKey: string,
): Promise<ThreadGoalMutationResponse> {
  const result = await d.goals.setGoal(d.actor, {
    kind: "thread.goal.set",
    threadId,
    idempotencyKey,
    executionIntentVersion: "v1",
    expectedRevision: body.expectedRevision,
    objective: body.objective,
    status: body.status,
    tokenBudget: body.tokenBudget,
    ...(fence === null ? {} : { teamTaskFence: fence }),
  });
  return projectThreadGoalMutation(result);
}

async function startTurn(
  d: ControlTeamApplicationOperationsDependencies,
  fence: TeamTaskWriteFence | null,
  threadId: string,
  body: StartTurnRequest,
  idempotencyKey: string,
): Promise<StartTurnResponse> {
  const command = {
    kind: "turn.start" as const,
    idempotencyKey,
    executionIntentVersion: "v1" as const,
    threadId,
    expectedThreadRevision: body.expectedRevision,
    content: body.content,
    requestedAgentVersionId: body.agentVersionId,
    executionIntent: body.executionIntent,
    toolPermissionMode: body.toolPermissionMode ?? "requestApproval",
    ...(fence === null ? {} : { teamTaskFence: fence }),
  };
  const replay = await d.turns.replayTurn(d.actor, command);
  const result =
    replay ??
    (await d.turns.startTurn(d.actor, {
      ...command,
      route: await d.routeResolver.resolveRoute({
        actor: d.actor,
        threadId,
        agentVersionId: body.agentVersionId,
      }),
    }));
  const message = result.messages[0];
  if (message === undefined || result.messages.length !== 1)
    throw new Error("team_start_turn_result_invalid");
  return {
    disposition: result.disposition,
    acceptedExecutionIntent: body.executionIntent,
    thread: projectThread(result.threadState),
    message: projectMessage(message),
    run: projectRun(result.runState),
  };
}
