import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import type { Turn } from "@crewon/app-server-protocol/v2/Turn";
import type {
  GetThreadTranscriptWindowResponse,
  MessageView,
  RunView,
} from "@crewon/contracts";

export type ControlTranscriptRow =
  | {
      kind: "run";
      runId: string;
      itemIds: string[];
      firstFragment: boolean;
      continuation: boolean;
    }
  | { kind: "unassociated"; item: ThreadItem; sequence: number };

export type ControlTranscriptWindow = {
  toolHistory?: "ready" | "partial";
  cursor: string | null;
  olderCursor: string | null;
  newerCursor: string | null;
  threadRevision: number;
  firstSequence: number | null;
  lastSequence: number | null;
  rows: ControlTranscriptRow[];
};

export type ControlWindowedThread = Thread & {
  controlTranscriptWindow?: ControlTranscriptWindow;
};

export function transcriptWindow(
  thread: Thread | null,
): ControlTranscriptWindow | undefined {
  return (thread as ControlWindowedThread | null)?.controlTranscriptWindow;
}

export function controlTranscriptMessage(
  message: MessageView,
  visibleUserContent: (content: string) => string,
): ThreadItem | null {
  if (message.role === "user")
    return {
      type: "userMessage",
      id: message.messageId,
      clientId: null,
      content: [
        {
          type: "text",
          text: visibleUserContent(message.content),
          text_elements: [],
        },
      ],
    };
  if (message.role !== "assistant") return null;
  if (message.proposedPlan !== null)
    return {
      type: "plan",
      id: message.proposedPlan.planId,
      text: message.proposedPlan.content,
    };
  return {
    type: "agentMessage",
    id: message.messageId,
    text: message.content,
    phase: null,
    memoryCitation: null,
  };
}

/** Canonical sequence owns layout. Run identity comes only from durable bindings. */
export function projectControlTranscriptWindow(input: {
  summary: Thread;
  window: GetThreadTranscriptWindowResponse;
  cursor: string | null;
  runs: readonly RunView[];
  activeRun: RunView | null;
  visibleUserContent(content: string): string;
  isInternalUser(content: string): boolean;
  projectRun(
    run: RunView,
    user: MessageView | null,
    assistants: readonly MessageView[],
  ): Turn;
}): ControlWindowedThread {
  const byRun = new Map(input.runs.map((run) => [run.runId, run]));
  const groups = new Map<
    string,
    { user: MessageView | null; assistants: MessageView[] }
  >();
  const rows: ControlTranscriptRow[] = [];
  const shownRuns = new Set<string>();
  const { data, threadRevision, olderCursor, newerCursor } =
    input.window.messageWindow;
  for (const [index, message] of data.entries()) {
    const binding = input.window.runBindings[index]!;
    const hiddenUser =
      message.role === "user" && input.isInternalUser(message.content);
    if (binding.runId !== null) {
      const run = byRun.get(binding.runId);
      if (!run || run.threadId !== input.summary.id)
        throw new Error("control_transcript_run_identity_invalid");
      let group = groups.get(run.runId);
      if (!group) {
        group = { user: null, assistants: [] };
        groups.set(run.runId, group);
      }
      if (message.role === "user" && !hiddenUser) {
        if (group.user !== null)
          throw new Error("control_transcript_multiple_users");
        group.user = message;
      }
      if (message.role === "assistant") group.assistants.push(message);
    }
    if (hiddenUser) continue;
    const item = controlTranscriptMessage(message, input.visibleUserContent);
    if (!item) continue;
    if (binding.runId === null) {
      rows.push({ kind: "unassociated", item, sequence: message.sequence });
      continue;
    }
    const previous = rows.at(-1);
    if (previous?.kind === "run" && previous.runId === binding.runId)
      previous.itemIds.push(item.id);
    else {
      rows.push({
        kind: "run",
        runId: binding.runId,
        itemIds: [item.id],
        firstFragment: !shownRuns.has(binding.runId),
        continuation: message.role !== "user",
      });
      shownRuns.add(binding.runId);
    }
  }
  const active = input.activeRun;
  if (active && !groups.has(active.runId))
    groups.set(active.runId, { user: null, assistants: [] });
  if (active && !shownRuns.has(active.runId))
    rows.push({
      kind: "run",
      runId: active.runId,
      itemIds: [],
      firstFragment: true,
      continuation: true,
    });
  const turns = [...groups].map(([runId, group]) =>
    input.projectRun(byRun.get(runId)!, group.user, group.assistants),
  );
  return {
    ...input.summary,
    status: active
      ? {
          type: "active",
          activeFlags:
            active.status === "waitingApproval" ? ["waitingOnApproval"] : [],
        }
      : { type: "idle" },
    turns,
    controlTranscriptWindow: {
      cursor: input.cursor,
      olderCursor,
      newerCursor,
      threadRevision,
      firstSequence: data[0]?.sequence ?? null,
      lastSequence: data.at(-1)?.sequence ?? null,
      rows,
    },
  };
}

/** Repeated fragments share one canonical Turn; process items appear only once. */
export function transcriptRowTurn(
  turn: Turn,
  row: Extract<ControlTranscriptRow, { kind: "run" }>,
): Turn {
  const ids = new Set(row.itemIds);
  return {
    ...turn,
    items: turn.items.filter(
      (item) =>
        ids.has(item.id) ||
        (row.firstFragment &&
          item.type !== "userMessage" &&
          item.type !== "agentMessage" &&
          item.type !== "plan"),
    ),
  };
}
