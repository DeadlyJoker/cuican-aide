import type { MessageView, RunEventView } from "@crewon/contracts";
import { streamRunEvents, type ControlApiClient } from "@crewon/control-client";
import type { ControlRunEventStream } from "./controlRunToolProjection";
import type {
  ControlTeamPlan,
  ControlTeamRunAcceptedEvent,
} from "./controlTeamRuntime";

export type ControlTeamProgress = Readonly<{
  threadId: string;
  content: string;
  messageId: string | null;
  phase: "preparing" | "working" | "failed";
  runs: readonly Readonly<{
    runId: string;
    memberName: string;
    kind: ControlTeamRunAcceptedEvent["kind"];
    status:
      | "queued"
      | "running"
      | "waiting"
      | "completed"
      | "failed"
      | "canceled";
    reconnecting: boolean;
  }>[];
}>;

/** Read-only presentation of accepted Runs; never exposes worker drafts as a final answer. */
export function createControlTeamProgress(input: {
  threadId: string;
  content: string;
  plan: ControlTeamPlan;
  client: ControlApiClient;
  signal: AbortSignal;
  onChange: (progress: ControlTeamProgress | null) => void;
  eventStream?: ControlRunEventStream;
  reconnectDelay?: (attempt: number, signal: AbortSignal) => Promise<void>;
}) {
  const controller = new AbortController();
  let handedOff = false;
  let progress: ControlTeamProgress = {
    threadId: input.threadId,
    content: input.content,
    messageId: null,
    phase: "preparing",
    runs: [],
  };
  const publish = () => {
    if (!controller.signal.aborted && !handedOff) {
      try {
        input.onChange(progress);
      } catch {
        /* UI cannot fail durable execution. */
      }
    }
  };
  const close = () => {
    controller.abort();
    input.signal.removeEventListener("abort", close);
  };
  if (input.signal.aborted) close();
  else input.signal.addEventListener("abort", close, { once: true });
  publish();

  const updateRun = (
    runId: string,
    patch: Partial<ControlTeamProgress["runs"][number]>,
  ) => {
    if (controller.signal.aborted || handedOff) return;
    const current = progress.runs.find((run) => run.runId === runId);
    if (
      !current ||
      Object.entries(patch).every(
        ([key, value]) => current[key as keyof typeof current] === value,
      )
    )
      return;
    progress = {
      ...progress,
      runs: progress.runs.map((run) =>
        run.runId === runId ? { ...run, ...patch } : run,
      ),
    };
    publish();
  };
  const consume = async (accepted: ControlTeamRunAcceptedEvent) => {
    let sequence = 0;
    let reconnects = 0;
    while (!controller.signal.aborted && !handedOff) {
      try {
        for await (const event of (input.eventStream ?? streamRunEvents)(
          input.client,
          {
            runId: accepted.runId,
            afterSequence: sequence,
            view: "client",
            signal: controller.signal,
          },
        )) {
          if (controller.signal.aborted || handedOff) return;
          if (event.runId !== accepted.runId)
            throw new Error("control_team_progress_identity_invalid");
          if (event.sequence <= sequence) continue;
          if (event.sequence !== sequence + 1)
            throw new Error("control_team_progress_sequence_gap");
          sequence = event.sequence;
          const status = runStatus(event);
          updateRun(accepted.runId, {
            reconnecting: false,
            ...(status ? { status } : {}),
          });
          if (
            status === "completed" ||
            status === "failed" ||
            status === "canceled"
          )
            return;
        }
      } catch {
        if (controller.signal.aborted || handedOff) return;
      }
      updateRun(accepted.runId, { reconnecting: true });
      await (input.reconnectDelay ?? reconnectDelay)(
        ++reconnects,
        controller.signal,
      );
    }
  };

  return {
    acceptedMessage: (message: MessageView) => {
      if (message.threadId !== input.threadId || message.role !== "user")
        return;
      progress = {
        ...progress,
        messageId: message.messageId,
        phase: "working",
      };
      publish();
    },
    acceptedRun: (accepted: ControlTeamRunAcceptedEvent) => {
      if (
        controller.signal.aborted ||
        handedOff ||
        progress.runs.some((run) => run.runId === accepted.runId)
      )
        return;
      if (progress.runs.length >= 32) return;
      const member = [input.plan.manager, ...input.plan.workers].find(
        (entry) => entry.memberId === accepted.memberId,
      );
      progress = {
        ...progress,
        runs: [
          ...progress.runs,
          {
            runId: accepted.runId,
            memberName: member?.displayName ?? accepted.memberId,
            kind: accepted.kind,
            status: "queued",
            reconnecting: false,
          },
        ],
      };
      publish();
      void consume(accepted).catch(() => undefined);
    },
    handoff: () => {
      if (controller.signal.aborted || handedOff) return;
      handedOff = true;
      try {
        input.onChange(null);
      } catch {
        /* Preserve the accepted final Run. */
      }
      close();
    },
    fail: () => {
      progress = { ...progress, phase: "failed" };
      publish();
      close();
    },
    close,
  };
}

function runStatus(
  event: RunEventView,
): ControlTeamProgress["runs"][number]["status"] | null {
  switch (event.type) {
    case "run.started":
      return "running";
    case "run.approval.required":
    case "run.suspended":
    case "run.reconciliation.required":
      return "waiting";
    case "run.resumed":
      return "queued";
    case "run.completed":
      return "completed";
    case "run.failed":
      return "failed";
    case "run.canceled":
      return "canceled";
    default:
      return null;
  }
}

function reconnectDelay(attempt: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(
      done,
      Math.min(5_000, 250 * 2 ** Math.min(attempt - 1, 4)),
    );
    signal.addEventListener("abort", done, { once: true });
  });
}
