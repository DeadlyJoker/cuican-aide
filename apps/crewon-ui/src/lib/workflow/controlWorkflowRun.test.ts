import { describe, expect, it, vi } from "vitest";
import type { RunEventView, RunView } from "@crewon/contracts";

import type { ControlWorkflowAdapter } from "./controlWorkflowAdapter";
import {
  ControlWorkflowInputError,
  createWorkflowStartIdempotencyKey,
  followControlWorkflowRun,
  parseControlWorkflowInput,
  publicWorkflowRunStatus,
  retainWorkflowStartAttempt,
  startControlWorkflowRun,
} from "./controlWorkflowRun";

describe("Control Workflow Run", () => {
  it("parses strict raw JSON through the public Workflow input contract", () => {
    expect(
      parseControlWorkflowInput({
        raw: '{"prompt":"ship","retries":2}',
        threadId: "thread-1",
        workflowVersionId: "workflow-version-1",
      }),
    ).toEqual({ prompt: "ship", retries: 2 });
    expect(() =>
      parseControlWorkflowInput({
        raw: "{prompt: ship}",
        threadId: "thread-1",
        workflowVersionId: "workflow-version-1",
      }),
    ).toThrow(new ControlWorkflowInputError("invalid_json"));
    expect(() =>
      parseControlWorkflowInput({
        raw: "1e999",
        threadId: "thread-1",
        workflowVersionId: "workflow-version-1",
      }),
    ).toThrow(new ControlWorkflowInputError("invalid_input"));
  });

  it("uses one stable idempotency key for the start mutation", async () => {
    const start = vi.fn(async () => workflowRun());
    const adapter = workflowAdapter({ start });
    const idempotencyKey = createWorkflowStartIdempotencyKey(
      () => "stable-attempt",
    );

    await expect(
      startControlWorkflowRun(
        adapter,
        {
          raw: '{"prompt":"ship"}',
          threadId: "thread-1",
          workflowVersionId: "workflow-version-1",
        },
        idempotencyKey,
      ),
    ).resolves.toEqual(workflowRun());
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({
      workflowVersionId: "workflow-version-1",
      threadId: "thread-1",
      value: { prompt: "ship" },
      idempotencyKey: "workflow.start:stable-attempt",
      signal: undefined,
    });
  });

  it("retains an unknown start key until the logical input changes", () => {
    const uuids = ["first", "second"];
    const randomUUID = () => uuids.shift()!;
    const input = {
      raw: '{"prompt":"ship"}',
      threadId: "thread-1",
      workflowVersionId: "workflow-version-1",
    };
    const first = retainWorkflowStartAttempt(null, input, randomUUID);

    expect(retainWorkflowStartAttempt(first, input, randomUUID)).toBe(first);
    expect(
      retainWorkflowStartAttempt(
        first,
        { ...input, raw: '{"prompt":"review"}' },
        randomUUID,
      ),
    ).toEqual({
      fingerprint: JSON.stringify([
        "workflow-version-1",
        "thread-1",
        '{"prompt":"review"}',
      ]),
      idempotencyKey: "workflow.start:second",
    });
  });

  it("keeps a monotonic cursor across lifecycle reads and bounded reconnect", async () => {
    const started = workflowRun();
    const requestedCursors: number[] = [];
    const canonicalRuns = [
      workflowRun({ status: "running", lastSequence: 2, revision: 2 }),
      workflowRun({ status: "running", lastSequence: 3, revision: 3 }),
      workflowRun({
        status: "completed",
        lastSequence: 4,
        revision: 4,
        outputRef: "artifact://delivery",
        terminalAt: "2026-08-13T00:01:00.000Z",
      }),
    ];
    const adapter = workflowAdapter({
      events: (input) => {
        requestedCursors.push(input.afterSequence);
        return input.afterSequence === 1
          ? events(runEvent("run.started", 2), runEvent("run.started", 2))
          : events(runEvent("run.completed", 4));
      },
      readRun: vi.fn(async () => canonicalRuns.shift() ?? started),
    });
    const runs: RunView[] = [];
    const streamStates: string[] = [];
    const waits: number[] = [];

    const result = await followControlWorkflowRun(adapter, started, {
      signal: new AbortController().signal,
      onRun: (run) => runs.push(run),
      onStreamState: (state) => streamStates.push(state.kind),
      waitBeforeReconnect: async (attempt) => {
        waits.push(attempt);
      },
    });

    expect(result.status).toBe("completed");
    expect(requestedCursors).toEqual([1, 3]);
    expect(runs.map((run) => [run.status, run.lastSequence])).toEqual([
      ["running", 2],
      ["running", 3],
      ["completed", 4],
    ]);
    expect(streamStates).toEqual([
      "connecting",
      "streaming",
      "reconnecting",
      "streaming",
      "terminal",
    ]);
    expect(waits).toEqual([1]);
  });

  it("reads canonical terminal state when an SSE boundary closes", async () => {
    const terminal = workflowRun({
      status: "failed",
      lastSequence: 2,
      revision: 2,
      failure: { code: "workflow_node_failed", retryable: false },
      terminalAt: "2026-08-13T00:01:00.000Z",
    });
    const readRun = vi.fn(async () => terminal);
    const adapter = workflowAdapter({
      events: () => events(),
      readRun,
    });

    await expect(
      followControlWorkflowRun(adapter, workflowRun(), {
        signal: new AbortController().signal,
        onRun: vi.fn(),
        waitBeforeReconnect: vi.fn(),
      }),
    ).resolves.toEqual(terminal);
    expect(readRun).toHaveBeenCalledTimes(1);
  });

  it("reads canonical Run when the start response is already terminal", async () => {
    const started = workflowRun({
      status: "completed",
      terminalAt: "2026-08-13T00:01:00.000Z",
    });
    const canonical = workflowRun({
      status: "completed",
      lastSequence: 2,
      revision: 2,
      outputRef: "artifact://delivery",
      terminalAt: "2026-08-13T00:01:00.000Z",
    });
    const readRun = vi.fn(async () => canonical);
    const eventsMock = vi.fn();
    const onRun = vi.fn();

    await expect(
      followControlWorkflowRun(
        workflowAdapter({ readRun, events: eventsMock }),
        started,
        {
          signal: new AbortController().signal,
          onRun,
        },
      ),
    ).resolves.toEqual(canonical);
    expect(readRun).toHaveBeenCalledTimes(1);
    expect(eventsMock).not.toHaveBeenCalled();
    expect(onRun).toHaveBeenCalledWith(canonical);
  });

  it("aborts the durable stream without reconnecting or reading stale state", async () => {
    const abort = new AbortController();
    const readRun = vi.fn();
    const eventsMock = vi.fn(
      (input: Parameters<ControlWorkflowAdapter["events"]>[0]) =>
        waitForAbort(input.signal!),
    );
    const adapter = workflowAdapter({ events: eventsMock, readRun });
    const following = followControlWorkflowRun(adapter, workflowRun(), {
      signal: abort.signal,
      onRun: vi.fn(),
      waitBeforeReconnect: vi.fn(),
    });

    await Promise.resolve();
    abort.abort(new Error("workflow_selection_changed"));

    await expect(following).rejects.toThrow("workflow_selection_changed");
    expect(eventsMock).toHaveBeenCalledTimes(1);
    expect(readRun).not.toHaveBeenCalled();
  });

  it("exposes only the public run-level status vocabulary", () => {
    expect(
      [
        "queued",
        "running",
        "reconciling",
        "completed",
        "failed",
        "canceled",
      ].map((status) => publicWorkflowRunStatus(status as RunView["status"])),
    ).toEqual([
      "queued",
      "running",
      "reconciling",
      "completed",
      "failed",
      "canceled",
    ]);
    expect(publicWorkflowRunStatus("waitingApproval")).toBeNull();
    expect(publicWorkflowRunStatus("suspended")).toBeNull();
  });
});

function workflowAdapter(
  overrides: Partial<ControlWorkflowAdapter> = {},
): ControlWorkflowAdapter {
  return {
    discover: vi.fn(),
    readVersion: vi.fn(),
    start: vi.fn(),
    readRun: vi.fn(),
    events: vi.fn(),
    ...overrides,
  };
}

function workflowRun(overrides: Partial<RunView> = {}): RunView {
  return {
    runId: "run-1",
    threadId: "thread-1",
    status: "queued",
    revision: 1,
    lastSequence: 1,
    cancelRequested: false,
    waitingApproval: null,
    collaborationMode: "default",
    purpose: "workflow",
    workflowVersionBinding: {
      workflowId: "workflow-1",
      workflowVersionId: "workflow-version-1",
      contentDigest: `sha256:${"a".repeat(64)}`,
    },
    goalBinding: null,
    outputRef: null,
    failure: null,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    terminalAt: null,
    ...overrides,
  };
}

function runEvent(type: RunEventView["type"], sequence: number): RunEventView {
  return {
    eventId: `event-${sequence}`,
    runId: "run-1",
    sequence,
    type,
    occurredAt: "2026-08-13T00:00:00.000Z",
    data: {},
  } as RunEventView;
}

async function* events(...items: RunEventView[]): AsyncIterable<RunEventView> {
  yield* items;
}

async function* waitForAbort(signal: AbortSignal): AsyncIterable<RunEventView> {
  await new Promise<void>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}
