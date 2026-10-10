import { describe, expect, it, vi } from "vitest";
import type { MessageView, RunEventView } from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";
import type {
  ControlTeamPlan,
  ControlTeamRunAcceptedEvent,
} from "./controlTeamRuntime";
import {
  createControlTeamProgress,
  type ControlTeamProgress,
} from "./controlTeamProgress";

const plan: ControlTeamPlan = {
  officeVersionId: "office-1",
  officeTitle: "方案评审",
  manager: {
    memberId: "lead",
    displayName: "团长",
    agentVersionId: "agent-1",
    targetId: "lead",
  },
  workers: [
    {
      memberId: "qa",
      displayName: "核验员",
      agentVersionId: "agent-1",
      targetId: "qa",
    },
  ],
};
const accepted: ControlTeamRunAcceptedEvent = {
  runId: "run-1",
  runThreadId: "branch-1",
  memberId: "qa",
  agentVersionId: "agent-1",
  kind: "worker",
  phaseIndex: 0,
};
const message: MessageView = {
  messageId: "message-1",
  threadId: "main",
  sequence: 1,
  role: "user",
  content: "核对预算",
  proposedPlan: null,
  createdAt: "2026-09-07T10:00:00.000Z",
};
function event(
  sequence: number,
  type: RunEventView["type"],
  runId = "run-1",
): RunEventView {
  return {
    runId,
    eventId: `event-${sequence}`,
    sequence,
    type,
    occurredAt: message.createdAt,
    data: {},
  } as RunEventView;
}
const base = {
  plan,
  threadId: "main",
  content: message.content,
  client: {} as ControlApiClient,
};

describe("Control Team progress", () => {
  it("retains local submission identity through acceptance and failure without changing durable messages", () => {
    const changes: Array<ControlTeamProgress | null> = [];
    const tracker = createControlTeamProgress({
      ...base,
      clientSubmissionId: "local-submission",
      signal: new AbortController().signal,
      onChange: (progress) => changes.push(progress),
    });
    expect(changes[0]).toMatchObject({
      clientSubmissionId: "local-submission",
      messageId: null,
    });
    tracker.acceptedMessage(message);
    tracker.fail();
    expect(changes.at(-1)).toMatchObject({
      clientSubmissionId: "local-submission",
      messageId: message.messageId,
      phase: "failed",
    });
    expect(message).not.toHaveProperty("clientSubmissionId");
    tracker.close();
  });

  it("shows preparation, durable acceptance, queue and execution without publishing worker text", async () => {
    const changes: Array<ControlTeamProgress | null> = [];
    const tracker = createControlTeamProgress({
      ...base,
      signal: new AbortController().signal,
      onChange: (p) => changes.push(p),
      eventStream: async function* () {
        yield event(1, "run.created");
        yield event(2, "run.started");
        yield {
          ...event(3, "model.output.delta"),
          data: { segmentId: "s1", delta: "PRIVATE DRAFT" },
        } as RunEventView;
        yield event(4, "run.completed");
      },
    });
    expect(changes[0]).toMatchObject({
      phase: "preparing",
      messageId: null,
      content: "核对预算",
      runs: [],
    });
    tracker.acceptedMessage(message);
    tracker.acceptedRun(accepted);
    await vi.waitFor(() =>
      expect(changes.at(-1)?.runs[0]?.status).toBe("completed"),
    );
    expect(changes.some((p) => p?.runs[0]?.status === "queued")).toBe(true);
    expect(changes.some((p) => p?.runs[0]?.status === "running")).toBe(true);
    expect(changes.at(-1)?.phase).toBe("working");
    expect(JSON.stringify(changes)).not.toContain("PRIVATE DRAFT");
    tracker.handoff();
    expect(changes.at(-1)).toBeNull();
  });

  it("reconnects from the validated cursor, ignores replay and rejects foreign/gapped events", async () => {
    const changes: Array<ControlTeamProgress | null> = [];
    let attempt = 0;
    const stream = vi.fn(async function* (_client, input) {
      attempt++;
      if (attempt === 1) {
        yield event(1, "run.created");
        yield event(2, "run.started");
        throw new Error("offline");
      }
      expect(input.afterSequence).toBe(2);
      if (attempt === 2) {
        yield event(3, "run.completed", "foreign-run");
        return;
      }
      if (attempt === 3) {
        yield event(4, "run.completed");
        return;
      }
      yield event(2, "run.started");
      yield event(3, "run.completed");
    });
    const tracker = createControlTeamProgress({
      ...base,
      signal: new AbortController().signal,
      onChange: (p) => changes.push(p),
      eventStream: stream,
      reconnectDelay: async () => {},
    });
    tracker.acceptedRun(accepted);
    await vi.waitFor(() =>
      expect(changes.at(-1)?.runs[0]).toMatchObject({
        status: "completed",
        reconnecting: false,
      }),
    );
    expect(changes.some((p) => p?.runs[0]?.reconnecting)).toBe(true);
    expect(stream).toHaveBeenCalledTimes(4);
    tracker.close();
  });

  it("closes streams and suppresses late updates on runtime disposal", async () => {
    const owner = new AbortController();
    const onChange = vi.fn();
    let streamSignal: AbortSignal | undefined;
    const tracker = createControlTeamProgress({
      ...base,
      signal: owner.signal,
      onChange,
      eventStream: async function* (_client, input) {
        streamSignal = input.signal;
        await new Promise<void>((resolve) =>
          input.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        yield event(1, "run.completed");
      },
    });
    tracker.acceptedRun(accepted);
    await vi.waitFor(() => expect(streamSignal).toBeDefined());
    owner.abort();
    const calls = onChange.mock.calls.length;
    tracker.acceptedRun({ ...accepted, runId: "late-run" });
    tracker.handoff();
    expect(streamSignal?.aborted).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(calls);
  });

  it("keeps failed coordination separate from the status of already accepted Runs", () => {
    const onChange = vi.fn();
    const tracker = createControlTeamProgress({
      ...base,
      signal: new AbortController().signal,
      onChange,
      eventStream: async function* (_client, input) {
        await new Promise<void>((resolve) =>
          input.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
      },
    });
    tracker.acceptedMessage(message);
    tracker.acceptedRun(accepted);
    tracker.fail();
    expect(onChange.mock.calls.at(-1)?.[0]).toMatchObject({
      phase: "failed",
      messageId: "message-1",
      runs: [{ status: "queued" }],
    });
  });
});
