import type { CollabAgentStatus } from "@crewon/app-server-protocol/v2/CollabAgentStatus";
import type { PatchApplyStatus } from "@crewon/app-server-protocol/v2/PatchApplyStatus";
import type { SubAgentActivityKind } from "@crewon/app-server-protocol/v2/SubAgentActivityKind";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ThreadActiveFlag } from "@crewon/app-server-protocol/v2/ThreadActiveFlag";
import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import {
  parseThreadTaskChangeLedgerResponse,
  parseWorkspaceChangeSummary,
  type ThreadTaskChangeLedgerResponse,
} from "@crewon/contracts";

import type { Locale } from "../i18n";

export const DEFAULT_TASK_DETAIL_SOURCE_LIMIT = 24;
const MAX_SOURCE_LIMIT = 100;
const MAX_TASK_CHANGE_PATHS = 1_024;
const MAX_TASK_CHANGE_PATH_BYTES = 256 * 1_024;

export type TaskDetailStatusPhase =
  | "notLoaded"
  | "idle"
  | "running"
  | "waitingOnApproval"
  | "waitingOnUserInput"
  | "completed"
  | "interrupted"
  | "failed";

export type TaskDetailStatus = Readonly<{
  phase: TaskDetailStatusPhase;
  label: string;
  basis: "threadStatus" | "latestTurn";
  activeFlags: readonly ThreadActiveFlag[];
  latestTurnId: string | null;
  errorMessage: string | null;
}>;

export type TaskDetailEnvironment = Readonly<{
  cwd: string;
  workspaceName: string | null;
  modelProvider: string;
  gitSnapshot: Readonly<{
    basis: "threadCreationSnapshot";
    branch: string | null;
    sha: string | null;
    originUrl: string | null;
  }> | null;
}>;

export type TaskDetailChangeSummary = Readonly<{
  /** Durable Thread mutation ledger plus the current contiguous live Run overlay. */
  basis: "threadRecordedChanges";
  /** Exact only when the ledger and every non-ledger overlay are complete. */
  complete: boolean;
  isLiveGitStatus: false;
  eventCount: number;
  fileCount: number;
  paths: readonly string[];
  recordedAdditions: number;
  recordedDeletions: number;
  statusCounts: Readonly<Record<PatchApplyStatus, number>>;
}>;

export type TaskDetailSubagentStatus = CollabAgentStatus | "unknown";
export type TaskDetailSubagent = Readonly<{
  threadId: string;
  displayName: string;
  role: string | null;
  status: TaskDetailSubagentStatus;
  lastActivity: SubAgentActivityKind | null;
  message: string | null;
}>;
export type TaskDetailSubagentSummary = Readonly<{
  total: number;
  statusCounts: Readonly<Record<TaskDetailSubagentStatus, number>>;
  agents: readonly TaskDetailSubagent[];
}>;

export type TaskDetailSourceKind =
  | "image"
  | "localImage"
  | "skill"
  | "mention"
  | "webSearch"
  | "mcpResource";
export type TaskDetailSource = Readonly<{
  kind: TaskDetailSourceKind;
  displayName: string;
  reference: string;
  turnId: string;
  itemId: string;
}>;
export type TaskDetailSourceSummary = Readonly<{
  total: number;
  truncatedCount: number;
  items: readonly TaskDetailSource[];
}>;

export type TaskDetailProjection = Readonly<{
  threadId: string;
  environment: TaskDetailEnvironment;
  status: TaskDetailStatus;
  changes: TaskDetailChangeSummary;
  subagents: TaskDetailSubagentSummary;
  sources: TaskDetailSourceSummary;
}>;

export type ProjectTaskDetailParams = Readonly<{
  thread: Thread;
  linkedThreads: readonly Thread[];
  locale: Locale;
  sourceLimit?: number;
}>;

type MutableAgent = {
  order: number;
  threadId: string;
  status: TaskDetailSubagentStatus;
  lastActivity: SubAgentActivityKind | null;
  message: string | null;
};

const LABELS: Record<TaskDetailStatusPhase, readonly [string, string]> = {
  notLoaded: ["未加载", "Not loaded"],
  idle: ["待开始", "Idle"],
  running: ["执行中", "Running"],
  waitingOnApproval: ["等待审批", "Waiting for approval"],
  waitingOnUserInput: ["等待输入", "Waiting for input"],
  completed: ["已完成", "Completed"],
  interrupted: ["已中断", "Interrupted"],
  failed: ["失败", "Failed"],
};
const AGENT_STATUSES: readonly TaskDetailSubagentStatus[] = [
  "unknown",
  "pendingInit",
  "running",
  "interrupted",
  "completed",
  "errored",
  "shutdown",
  "notFound",
];

export function projectTaskDetail({
  thread,
  linkedThreads,
  locale,
  sourceLimit,
}: ProjectTaskDetailParams): TaskDetailProjection {
  return {
    threadId: thread.id,
    environment: projectEnvironment(thread),
    status: projectStatus(thread, locale),
    changes: projectChanges(thread),
    subagents: projectSubagents(thread, linkedThreads),
    sources: projectSources(thread, locale, sourceLimit),
  };
}

function projectEnvironment(thread: Thread): TaskDetailEnvironment {
  return {
    cwd: thread.cwd,
    workspaceName: thread.cwd ? displayName(thread.cwd, thread.cwd) : null,
    modelProvider: thread.modelProvider,
    gitSnapshot: thread.gitInfo
      ? {
          basis: "threadCreationSnapshot",
          branch: thread.gitInfo.branch,
          sha: thread.gitInfo.sha,
          originUrl: thread.gitInfo.originUrl,
        }
      : null,
  };
}

function projectStatus(thread: Thread, locale: Locale): TaskDetailStatus {
  const latest = thread.turns.at(-1) ?? null;
  const activeFlags =
    thread.status.type === "active"
      ? [...thread.status.activeFlags].sort(compareText)
      : [];
  let phase: TaskDetailStatusPhase;
  let basis: TaskDetailStatus["basis"] = "threadStatus";

  if (thread.status.type === "systemError") phase = "failed";
  else if (thread.status.type === "active") {
    phase = activeFlags.includes("waitingOnApproval")
      ? "waitingOnApproval"
      : activeFlags.includes("waitingOnUserInput")
        ? "waitingOnUserInput"
        : "running";
  } else if (latest) {
    basis = "latestTurn";
    phase = latest.status === "inProgress" ? "running" : latest.status;
  } else {
    phase = thread.status.type === "notLoaded" ? "notLoaded" : "idle";
  }

  return {
    phase,
    label: LABELS[phase][locale === "zh" ? 0 : 1],
    basis,
    activeFlags,
    latestTurnId: latest?.id ?? null,
    errorMessage: latest?.error?.message ?? null,
  };
}

function projectChanges(thread: Thread): TaskDetailChangeSummary {
  const paths = new Set<string>();
  const statusCounts: Record<PatchApplyStatus, number> = {
    inProgress: 0,
    completed: 0,
    failed: 0,
    declined: 0,
  };
  let eventCount = 0;
  let recordedAdditions = 0;
  let recordedDeletions = 0;
  let changesComplete = true;
  let changePathBytes = 0;
  let countOverflowed = false;
  const rawLedger = (
    thread as Thread & {
      controlTaskChangeLedger?: ThreadTaskChangeLedgerResponse;
    }
  ).controlTaskChangeLedger;
  const hasControlLedger = rawLedger !== undefined;
  let hasCompleteControlLedger = false;
  let includedRunIds = new Set<string>();
  const activeTurnIds = new Set(
    thread.turns
      .filter((turn) => turn.status === "inProgress")
      .map((turn) => turn.id),
  );
  const addPath = (path: string): void => {
    if (paths.has(path)) return;
    const nextBytes =
      changePathBytes + new TextEncoder().encode(path).byteLength;
    if (
      paths.size >= MAX_TASK_CHANGE_PATHS ||
      nextBytes > MAX_TASK_CHANGE_PATH_BYTES
    ) {
      changesComplete = false;
      return;
    }
    paths.add(path);
    changePathBytes = nextBytes;
  };
  const addCounts = (additions: number, deletions: number): void => {
    if (countOverflowed) return;
    const nextAdditions = recordedAdditions + additions;
    const nextDeletions = recordedDeletions + deletions;
    if (
      !Number.isSafeInteger(nextAdditions) ||
      !Number.isSafeInteger(nextDeletions)
    ) {
      countOverflowed = true;
      changesComplete = false;
      recordedAdditions = 0;
      recordedDeletions = 0;
      return;
    }
    recordedAdditions = nextAdditions;
    recordedDeletions = nextDeletions;
  };

  if (rawLedger !== undefined) {
    try {
      const ledger = parseThreadTaskChangeLedgerResponse(rawLedger);
      if (ledger.threadId !== thread.id || !ledger.complete) {
        changesComplete = false;
      } else {
        hasCompleteControlLedger = true;
        includedRunIds = new Set(ledger.includedRunIds);
        eventCount = ledger.eventCount / 2;
        for (const path of ledger.summary.paths) addPath(path);
        addCounts(ledger.summary.additions, ledger.summary.deletions);
      }
    } catch {
      changesComplete = false;
    }
  }

  for (const { turnId, item } of threadItems(thread)) {
    // The durable ledger already includes every change representation belonging
    // to an effective terminal Run, including legacy fileChange items.
    if (includedRunIds.has(turnId)) continue;
    // A complete Control ledger is authoritative for effective terminal Runs.
    // A terminal Turn missing from includedRunIds was rolled back (or is not a
    // task Turn) and must never be resurrected as a client-side overlay.
    if (hasCompleteControlLedger && !activeTurnIds.has(turnId)) {
      if (
        item.type === "fileChange" ||
        (item.type === "dynamicToolCall" && isWorkspaceMutationTool(item))
      ) {
        // This can be a rolled-back Run left in the broad Run listing, or an
        // active→terminal race across the ledger and Run APIs. Never re-add it,
        // but also never advertise a silently incomplete exact total.
        changesComplete = false;
      }
      continue;
    }
    if (item.type === "dynamicToolCall" && isWorkspaceMutationTool(item)) {
      eventCount += 1;
      if (!Object.hasOwn(item, "workspaceChanges")) {
        changesComplete = false;
        continue;
      }
      try {
        const summary = parseWorkspaceChangeSummary(
          (item as unknown as { workspaceChanges: unknown }).workspaceChanges,
        );
        if (!summary.statsComplete) {
          changesComplete = false;
          continue;
        }
        for (const path of summary.paths) addPath(path);
        addCounts(summary.additions, summary.deletions);
      } catch {
        changesComplete = false;
      }
      continue;
    }
    if (item.type !== "fileChange") continue;
    eventCount += 1;
    statusCounts[item.status] += 1;
    if (item.status === "inProgress") changesComplete = false;
    if (item.status !== "completed") continue;
    for (const change of item.changes) {
      addPath(change.path);
      let additions = 0;
      let deletions = 0;
      for (const line of change.diff.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
        if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
      }
      addCounts(additions, deletions);
    }
  }
  const sortedPaths = [...paths].sort(compareText);
  return {
    basis: "threadRecordedChanges",
    complete:
      changesComplete &&
      thread.turns.every((turn) =>
        hasCompleteControlLedger
          ? includedRunIds.has(turn.id) ||
            (turn.status === "inProgress" && taskChangesView(turn) === "full")
          : hasControlLedger
            ? false
            : turn.itemsView === "full",
      ),
    isLiveGitStatus: false,
    eventCount,
    fileCount: sortedPaths.length,
    paths: sortedPaths,
    recordedAdditions,
    recordedDeletions,
    statusCounts,
  };
}

function taskChangesView(turn: Thread["turns"][number]): "full" | "summary" {
  const value = (turn as typeof turn & { taskChangesView?: "full" | "summary" })
    .taskChangesView;
  return value === "full" ? "full" : "summary";
}

function isWorkspaceMutationTool(
  item: Extract<ThreadItem, { type: "dynamicToolCall" }>,
): boolean {
  const controlKind = (
    item as typeof item & { controlToolKind?: "custom" | "function" }
  ).controlToolKind;
  return (
    item.namespace === null &&
    item.tool === "workspace_run_command" &&
    controlKind !== "custom"
  );
}

function projectSubagents(
  thread: Thread,
  linkedThreads: readonly Thread[],
): TaskDetailSubagentSummary {
  const agents = new Map<string, MutableAgent>();
  const ensure = (threadId: string): MutableAgent => {
    const existing = agents.get(threadId);
    if (existing) return existing;
    const agent: MutableAgent = {
      order: agents.size,
      threadId,
      status: "unknown",
      lastActivity: null,
      message: null,
    };
    agents.set(threadId, agent);
    return agent;
  };

  for (const { item } of threadItems(thread)) {
    if (item.type === "collabAgentToolCall") {
      const receivers = new Set(item.receiverThreadIds);
      const stateOnly = Object.keys(item.agentsStates)
        .filter((id) => !receivers.has(id))
        .sort(compareText);
      for (const id of [...receivers, ...stateOnly]) {
        const agent = ensure(id);
        const state = item.agentsStates[id];
        if (!state) continue;
        Object.assign(agent, { status: state.status, message: state.message });
      }
    } else if (item.type === "subAgentActivity") {
      Object.assign(ensure(item.agentThreadId), {
        lastActivity: item.kind,
        status: item.kind === "interrupted" ? "interrupted" : "running",
        message: null,
      });
    }
  }

  const linkedById = new Map(
    linkedThreads.map((linked) => [linked.id, linked]),
  );
  linkedThreads
    .filter(
      (linked) => linked.parentThreadId === thread.id && !agents.has(linked.id),
    )
    .sort((a, b) => a.createdAt - b.createdAt || compareText(a.id, b.id))
    .forEach((linked) => ensure(linked.id));

  const projected = [...agents.values()]
    .sort((a, b) => a.order - b.order || compareText(a.threadId, b.threadId))
    .map((agent): TaskDetailSubagent => {
      const linked = linkedById.get(agent.threadId);
      let status = agent.status;
      if (status === "unknown" && linked) {
        const turnStatus = linked.turns.at(-1)?.status;
        if (linked.status.type === "active" || turnStatus === "inProgress")
          status = "running";
        else if (
          linked.status.type === "systemError" ||
          turnStatus === "failed"
        )
          status = "errored";
        else if (turnStatus === "completed" || turnStatus === "interrupted")
          status = turnStatus;
      }
      return {
        threadId: agent.threadId,
        displayName:
          linked?.name?.trim() ||
          linked?.agentNickname?.trim() ||
          agent.threadId,
        role: linked?.agentRole?.trim() || null,
        status,
        lastActivity: agent.lastActivity,
        message: agent.message,
      };
    });
  const statusCounts = Object.fromEntries(
    AGENT_STATUSES.map((status) => [status, 0]),
  ) as Record<TaskDetailSubagentStatus, number>;
  projected.forEach((agent) => {
    statusCounts[agent.status] += 1;
  });
  return { total: projected.length, statusCounts, agents: projected };
}

function projectSources(
  thread: Thread,
  locale: Locale,
  sourceLimit: number | undefined,
): TaskDetailSourceSummary {
  const items: TaskDetailSource[] = [];
  const seen = new Set<string>();
  const add = (
    kind: TaskDetailSourceKind,
    name: string,
    rawReference: string,
    turnId: string,
    itemId: string,
  ): void => {
    const reference = safeSourceReference(rawReference);
    const key = `${kind}\0${reference}`;
    if (!reference || seen.has(key)) return;
    seen.add(key);
    items.push({
      kind,
      displayName: name.trim() || displayName(reference, kind),
      reference,
      turnId,
      itemId,
    });
  };

  for (const { turnId, item } of threadItems(thread)) {
    if (item.type === "userMessage") {
      for (const input of item.content) {
        if (input.type === "image" || input.type === "localImage") {
          const reference = input.type === "image" ? input.url : input.path;
          add(
            input.type,
            displayName(reference, locale === "zh" ? "图片" : "Image"),
            reference,
            turnId,
            item.id,
          );
        } else if (input.type === "skill" || input.type === "mention") {
          add(input.type, input.name, input.path, turnId, item.id);
        }
      }
    } else if (item.type === "webSearch") {
      let reference = item.query.trim();
      const action = item.action;
      if (action?.type === "openPage" || action?.type === "findInPage") {
        reference = action.url?.trim() || reference;
      } else if (action?.type === "search") {
        reference =
          action.query?.trim() ||
          action.queries?.find((query) => query.trim())?.trim() ||
          reference;
      }
      add("webSearch", item.query || reference, reference, turnId, item.id);
    } else if (item.type === "mcpToolCall" && item.mcpAppResourceUri) {
      add(
        "mcpResource",
        `${item.server}/${item.tool}`,
        item.mcpAppResourceUri,
        turnId,
        item.id,
      );
    }
  }

  const limit =
    sourceLimit === undefined || !Number.isFinite(sourceLimit)
      ? DEFAULT_TASK_DETAIL_SOURCE_LIMIT
      : Math.min(MAX_SOURCE_LIMIT, Math.max(0, Math.trunc(sourceLimit)));
  return {
    total: items.length,
    truncatedCount: Math.max(0, items.length - limit),
    items: items.slice(0, limit),
  };
}

function* threadItems(
  thread: Thread,
): Generator<{ turnId: string; item: ThreadItem }> {
  for (const turn of thread.turns) {
    for (const item of turn.items) yield { turnId: turn.id, item };
  }
}

function displayName(reference: string, fallback: string): string {
  if (/^data:/iu.test(reference)) return fallback;
  const path = reference
    .split("#", 1)[0]
    ?.split("?", 1)[0]
    ?.replace(/[\\/]+$/u, "");
  return path?.split(/[\\/]/u).at(-1)?.trim() || fallback;
}

function safeSourceReference(rawReference: string): string {
  const reference = rawReference.trim();
  if (/^data:/iu.test(reference)) {
    const mediaType = reference.slice(5).split(/[;,]/u, 1)[0]?.trim();
    return `data:${mediaType || "application/octet-stream"}`;
  }
  try {
    const url = new URL(reference);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return reference;
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
