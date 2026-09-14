import type { RunEventView } from "@crewon/contracts";
import { describe, expect, it } from "vitest";

import {
  applyControlTaskChangeEvent,
  applyControlToolEvent,
  backfillControlToolProjection,
  controlTaskChangeProjectionComplete,
  controlToolItems,
  controlToolItemsWithTaskChanges,
  controlToolProjectionComplete,
  createControlToolProjectionState,
  createControlTaskChangeProjectionState,
  hydrateControlToolHistories,
  settleControlToolProjection,
} from "./controlRunToolProjection";

describe("controlRunToolProjection", () => {
  it("bounds Unicode preview payloads independently of item count and frees weight on replacement", () => {
    const state = createControlToolProjectionState();
    const request = (
      sequence: number,
      callId: string,
      text: string,
    ): RunEventView =>
      ({
        ...workspaceRequestEvent(sequence),
        data: {
          ...workspaceRequestEvent(sequence).data,
          callId,
          inputPreview: text,
        },
      }) as RunEventView;
    const preview = "文".repeat(16_384);
    for (let index = 0; index < 63; index++) {
      expect(
        applyControlToolEvent(
          state,
          request(index + 1, "call-" + index, preview),
        ),
      ).not.toBeNull();
    }
    expect(
      applyControlToolEvent(state, request(64, "overflow", preview)),
    ).toBeNull();
    expect(state.size).toBe(63);
    expect(controlToolProjectionComplete(state)).toBe(false);
    expect(
      applyControlToolEvent(state, request(65, "call-0", "small")),
    ).not.toBeNull();
    expect(
      applyControlToolEvent(state, request(66, "overflow", preview)),
    ).not.toBeNull();
    expect(state.size).toBe(64);
    // Recovering capacity cannot claim the previously omitted event was seen.
    expect(controlToolProjectionComplete(state)).toBe(false);
    const ledger = createControlTaskChangeProjectionState();
    for (let index = 0; index < 63; index++) {
      expect(
        applyControlTaskChangeEvent(
          ledger,
          request(index + 1, "call-" + index, preview),
        ),
      ).not.toBeNull();
    }
    expect(
      applyControlTaskChangeEvent(ledger, request(64, "overflow", preview)),
    ).toBeNull();
    expect(ledger.size).toBe(63);
    expect(controlTaskChangeProjectionComplete(ledger)).toBe(false);
  });

  it("retains only the latest backfilled Tool item across repeated approval transitions", async () => {
    const state = createControlToolProjectionState();
    const result = await backfillControlToolProjection({
      client: {} as never,
      runId: "run-plan-history",
      afterSequence: 0,
      throughSequence: 1003,
      state,
      signal: new AbortController().signal,
      timeoutMs: 1000,
      eventStream: async function* () {
        yield workspaceRequestEvent(1);
        for (let sequence = 2; sequence <= 1001; sequence++)
          yield {
            ...terminalEvent(sequence),
            type: sequence % 2 === 0 ? "run.approval.required" : "run.resumed",
            data:
              sequence % 2 === 0
                ? { approvalId: "approval-1" }
                : { reasonCode: "approved" },
          } as RunEventView;
        yield workspaceCompletionEvent(1002);
        yield terminalEvent(1003);
      },
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: "call-plan-history",
      status: "completed",
    });
    expect(result.complete).toBe(true);
  });
  it("maps the local workspace MCP adapter to a product-facing identity", () => {
    const state = createControlToolProjectionState();
    const item = applyControlToolEvent(state, {
      runId: "run-workspace-tool",
      sequence: 1,
      occurredAt: "2026-09-01T08:00:00.000Z",
      type: "tool.requested",
      data: {
        segmentId: "segment-workspace-tool",
        callId: "call-workspace-tool",
        kind: "function",
        name: "mcp__workspace_checks__read_file",
      },
    } as RunEventView);

    expect(item).toEqual({
      type: "dynamicToolCall",
      id: "call-workspace-tool",
      namespace: "workspace",
      tool: "read_file",
      arguments: {},
      status: "inProgress",
      contentItems: null,
      success: null,
      durationMs: null,
    });
  });

  it("projects transcript previews into visible arguments and output", () => {
    const state = createControlToolProjectionState();
    const requested = applyControlToolEvent(state, {
      runId: "run-workspace-tool",
      sequence: 1,
      occurredAt: "2026-09-01T08:00:00.000Z",
      type: "tool.requested",
      data: {
        segmentId: "segment-workspace-tool",
        callId: "call-workspace-tool",
        kind: "function",
        name: "mcp__workspace_checks__read_file",
        inputPreview: '{"path":"README.md","lineStart":1}',
        inputTruncated: false,
      },
    } as RunEventView);
    const completed = applyControlToolEvent(state, {
      runId: "run-workspace-tool",
      sequence: 2,
      occurredAt: "2026-09-01T08:00:01.000Z",
      type: "tool.completed",
      data: {
        segmentId: "segment-workspace-tool",
        callId: "call-workspace-tool",
        kind: "function",
        name: "mcp__workspace_checks__read_file",
        isError: false,
        outputTruncated: false,
        artifactAvailable: false,
        outputPreview: "# Crewon\nWorkspace ready.",
      },
    } as RunEventView);

    expect(requested).toEqual({
      type: "dynamicToolCall",
      id: "call-workspace-tool",
      namespace: "workspace",
      tool: "read_file",
      arguments: { path: "README.md", lineStart: 1 },
      status: "inProgress",
      contentItems: null,
      success: null,
      durationMs: null,
    });
    expect(completed).toEqual({
      type: "dynamicToolCall",
      id: "call-workspace-tool",
      namespace: "workspace",
      tool: "read_file",
      arguments: { path: "README.md", lineStart: 1 },
      status: "completed",
      contentItems: [{ type: "inputText", text: "# Crewon\nWorkspace ready." }],
      success: true,
      durationMs: 1_000,
    });
  });

  it("projects approval-required events onto the pending tool call", () => {
    const state = createControlToolProjectionState();
    applyControlToolEvent(state, {
      runId: "run-command-approval",
      sequence: 1,
      occurredAt: "2026-09-03T03:14:22.451Z",
      type: "tool.requested",
      data: {
        segmentId: "segment-command",
        callId: "call-command",
        kind: "function",
        name: "workspace_run_command",
        inputPreview: '{"command":"pnpm test"}',
        inputTruncated: false,
      },
    } as RunEventView);

    const awaitingApproval = applyControlToolEvent(state, {
      runId: "run-command-approval",
      sequence: 2,
      occurredAt: "2026-09-03T03:14:22.483Z",
      type: "run.approval.required",
      data: { approvalId: "approval-command" },
    } as RunEventView);

    expect(awaitingApproval).toMatchObject({
      id: "call-command",
      status: "inProgress",
      controlApproval: {
        approvalId: "approval-command",
        status: "required",
      },
    });

    const resumed = applyControlToolEvent(state, {
      runId: "run-command-approval",
      sequence: 3,
      occurredAt: "2026-09-03T03:15:00.000Z",
      type: "run.resumed",
      data: { reasonCode: "approval_resolved" },
    } as RunEventView);

    expect(resumed).toMatchObject({
      id: "call-command",
      status: "inProgress",
    });
    expect(resumed).not.toHaveProperty("controlApproval");
  });

  it("preserves a non-JSON input preview as text", () => {
    const state = createControlToolProjectionState();
    const item = applyControlToolEvent(state, {
      runId: "run-custom-tool",
      sequence: 1,
      occurredAt: "2026-09-01T08:00:00.000Z",
      type: "tool.requested",
      data: {
        segmentId: "segment-custom-tool",
        callId: "call-custom-tool",
        kind: "custom",
        name: "shell",
        inputPreview: "pwd && git status",
        inputTruncated: false,
      },
    } as RunEventView);

    expect(item?.arguments).toBe("pwd && git status");
  });

  it("keeps exact workspace changes on the completed Tool item", () => {
    const state = createControlToolProjectionState();
    const item = applyControlToolEvent(state, {
      runId: "run-command",
      sequence: 2,
      occurredAt: "2026-09-01T08:00:01.000Z",
      type: "tool.completed",
      data: {
        segmentId: "segment-command",
        callId: "call-command",
        kind: "function",
        name: "workspace_run_command",
        isError: false,
        outputTruncated: false,
        artifactAvailable: false,
        outputPreview: "not used for accounting",
        workspaceChanges: {
          schemaVersion: "crewon.workspace-change-summary.v0",
          paths: ["src/task.ts"],
          additions: 4,
          deletions: 1,
          statsComplete: true,
        },
      },
    } as RunEventView);

    expect(item).toMatchObject({
      id: "call-command",
      tool: "workspace_run_command",
      workspaceChanges: {
        paths: ["src/task.ts"],
        additions: 4,
        deletions: 1,
        statsComplete: true,
      },
    });
  });

  it("marks histories above the Tool item bound incomplete", () => {
    const state = createControlToolProjectionState();
    for (let index = 1; index <= 257; index += 1) {
      applyControlToolEvent(state, {
        runId: "run-overflow",
        sequence: index,
        occurredAt: "2026-09-01T08:00:01.000Z",
        type: "tool.requested",
        data: {
          segmentId: "segment-overflow",
          callId: `call-${index}`,
          kind: "function",
          name: "read_file",
        },
      } as RunEventView);
    }

    expect(controlToolItems(state)).toHaveLength(256);
    expect(controlToolProjectionComplete(state)).toBe(false);
  });

  it("keeps mutation coverage independent from read-only Tool overflow", () => {
    const toolState = createControlToolProjectionState();
    const taskState = createControlTaskChangeProjectionState();
    for (let index = 1; index <= 257; index += 1) {
      const event = {
        runId: "run-overflow",
        sequence: index,
        occurredAt: "2026-09-01T08:00:01.000Z",
        type: "tool.requested",
        data: {
          segmentId: "segment-overflow",
          callId: `read-${index}`,
          kind: "function",
          name: "workspace_read_file",
        },
      } as RunEventView;
      applyControlToolEvent(toolState, event);
      applyControlTaskChangeEvent(taskState, event);
    }
    const mutationRequest = {
      runId: "run-overflow",
      sequence: 258,
      occurredAt: "2026-09-01T08:00:02.000Z",
      type: "tool.requested",
      data: {
        segmentId: "segment-overflow",
        callId: "mutation-1",
        kind: "function",
        name: "workspace_run_command",
      },
    } as RunEventView;
    const mutation = {
      runId: "run-overflow",
      sequence: 259,
      occurredAt: "2026-09-01T08:00:03.000Z",
      type: "tool.completed",
      data: {
        segmentId: "segment-overflow",
        callId: "mutation-1",
        kind: "function",
        name: "workspace_run_command",
        isError: false,
        outputTruncated: false,
        artifactAvailable: false,
        workspaceChanges: {
          schemaVersion: "crewon.workspace-change-summary.v0",
          paths: ["src/task.ts"],
          additions: 1,
          deletions: 0,
          statsComplete: true,
        },
      },
    } as RunEventView;

    expect(applyControlToolEvent(toolState, mutationRequest)).toBeNull();
    expect(
      applyControlTaskChangeEvent(taskState, mutationRequest),
    ).toMatchObject({
      id: "mutation-1",
      status: "inProgress",
    });
    expect(controlTaskChangeProjectionComplete(taskState)).toBe(false);
    expect(applyControlToolEvent(toolState, mutation)).toBeNull();
    expect(applyControlTaskChangeEvent(taskState, mutation)).toMatchObject({
      id: "mutation-1",
      workspaceChanges: { additions: 1 },
    });
    expect(controlToolProjectionComplete(toolState)).toBe(false);
    expect(controlTaskChangeProjectionComplete(taskState)).toBe(true);
    expect(
      controlToolItemsWithTaskChanges(toolState, taskState).at(-1),
    ).toMatchObject({
      id: "mutation-1",
      workspaceChanges: { paths: ["src/task.ts"], additions: 1 },
    });
  });

  it("fails live mutation coverage closed on orphan, mismatched, or duplicate events", () => {
    const requested = (sequence: number, segmentId = "segment-1") =>
      ({
        runId: "run-invalid-mutation",
        sequence,
        occurredAt: "2026-09-01T08:00:01.000Z",
        type: "tool.requested",
        data: {
          segmentId,
          callId: "mutation-1",
          kind: "function",
          name: "workspace_run_command",
        },
      }) as RunEventView;
    const completed = (sequence: number, segmentId = "segment-1") =>
      ({
        runId: "run-invalid-mutation",
        sequence,
        occurredAt: "2026-09-01T08:00:02.000Z",
        type: "tool.completed",
        data: {
          segmentId,
          callId: "mutation-1",
          kind: "function",
          name: "workspace_run_command",
          isError: false,
          outputTruncated: false,
          artifactAvailable: false,
          workspaceChanges: {
            schemaVersion: "crewon.workspace-change-summary.v0",
            paths: ["src/task.ts"],
            additions: 1,
            deletions: 0,
            statsComplete: true,
          },
        },
      }) as RunEventView;

    const orphan = createControlTaskChangeProjectionState();
    expect(applyControlTaskChangeEvent(orphan, completed(1))).toBeNull();
    expect(controlTaskChangeProjectionComplete(orphan)).toBe(false);

    const mismatched = createControlTaskChangeProjectionState();
    applyControlTaskChangeEvent(mismatched, requested(1));
    expect(
      applyControlTaskChangeEvent(mismatched, completed(2, "segment-other")),
    ).toBeNull();
    expect(controlTaskChangeProjectionComplete(mismatched)).toBe(false);

    const duplicateRequest = createControlTaskChangeProjectionState();
    applyControlTaskChangeEvent(duplicateRequest, requested(1));
    expect(
      applyControlTaskChangeEvent(duplicateRequest, requested(2)),
    ).toBeNull();
    expect(controlTaskChangeProjectionComplete(duplicateRequest)).toBe(false);

    const duplicateCompletion = createControlTaskChangeProjectionState();
    applyControlTaskChangeEvent(duplicateCompletion, requested(1));
    applyControlTaskChangeEvent(duplicateCompletion, completed(2));
    expect(
      applyControlTaskChangeEvent(duplicateCompletion, completed(3)),
    ).toBeNull();
    expect(controlTaskChangeProjectionComplete(duplicateCompletion)).toBe(
      false,
    );
  });

  it("settles a requested-only Tool when its Run is canceled", () => {
    const state = createControlToolProjectionState();
    applyControlToolEvent(state, {
      runId: "run-canceled-tool",
      sequence: 3,
      occurredAt: "2026-09-01T08:00:00.000Z",
      type: "tool.requested",
      data: {
        segmentId: "segment-canceled-tool",
        callId: "call-canceled-tool",
        kind: "function",
        name: "mcp__workspace_checks__read_file",
        inputPreview: '{"path":"README.md"}',
        inputTruncated: false,
      },
    } as RunEventView);
    applyControlToolEvent(state, {
      runId: "run-canceled-tool",
      sequence: 4,
      occurredAt: "2026-09-01T08:00:01.000Z",
      type: "run.approval.required",
      data: { approvalId: "approval-canceled-tool" },
    } as RunEventView);

    expect(
      settleControlToolProjection(state, {
        lastSequence: 5,
        status: "canceled",
        terminalAt: "2026-09-01T08:00:02.000Z",
      }),
    ).toEqual([
      expect.objectContaining({
        id: "call-canceled-tool",
        status: "failed",
        success: false,
        durationMs: 2_000,
      }),
    ]);
    expect(controlToolItems(state)).toEqual([
      expect.objectContaining({
        id: "call-canceled-tool",
        status: "failed",
        success: false,
      }),
    ]);
    expect(controlToolItems(state)[0]).not.toHaveProperty("controlApproval");
  });

  it("fails closed when a terminal transcript history has a sequence gap", async () => {
    const statesByRun = new Map();
    const coverageByRun = new Map();
    await hydrateControlToolHistories({
      client: {} as never,
      eventStream: async function* (_client, input) {
        expect(input.extensions).toEqual(["run-plan-v1"]);
        yield {
          runId: "run-gap",
          eventId: "event-1",
          sequence: 1,
          occurredAt: "2026-09-01T08:00:00.000Z",
          type: "run.started",
          data: {},
        } as RunEventView;
        yield {
          runId: "run-gap",
          eventId: "event-3",
          sequence: 3,
          occurredAt: "2026-09-01T08:00:02.000Z",
          type: "run.completed",
          data: { outputRef: null },
        } as RunEventView;
      },
      inFlightByRun: new Map(),
      lifecycleSignal: new AbortController().signal,
      runsNewestFirst: [
        {
          runId: "run-gap",
          threadId: "thread-1",
          status: "completed",
          revision: 1,
          lastSequence: 3,
          cancelRequested: false,
          waitingApproval: null,
          collaborationMode: "default",
          purpose: "turn",
          workflowVersionBinding: null,
          goalBinding: null,
          outputRef: null,
          failure: null,
          createdAt: "2026-09-01T08:00:00.000Z",
          updatedAt: "2026-09-01T08:00:02.000Z",
          terminalAt: "2026-09-01T08:00:02.000Z",
        },
      ],
      statesByRun,
      coverageByRun,
      timeoutMs: 1_000,
    });

    expect(statesByRun.has("run-gap")).toBe(false);
    expect(coverageByRun.has("run-gap")).toBe(false);
  });

  it("does not advance a backfill cursor across a transcript sequence gap", async () => {
    const state = createControlToolProjectionState();
    await expect(
      backfillControlToolProjection({
        client: {} as never,
        eventStream: async function* (_client, input) {
          expect(input.afterSequence).toBe(1);
          expect(input.extensions).toEqual(["run-plan-v1"]);
          yield {
            runId: "run-gap",
            eventId: "event-3",
            sequence: 3,
            occurredAt: "2026-09-01T08:00:02.000Z",
            type: "run.completed",
            data: { outputRef: null },
          } as RunEventView;
        },
        runId: "run-gap",
        afterSequence: 1,
        throughSequence: 3,
        state,
        signal: new AbortController().signal,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("control_tool_history_sequence_gap");
    expect(controlToolItems(state)).toEqual([]);
  });

  it("ignores a buffered backfill event yielded after its caller aborts", async () => {
    let releaseEvent!: () => void;
    let markStarted!: () => void;
    const eventReleased = new Promise<void>((resolve) => {
      releaseEvent = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const controller = new AbortController();
    const state = createControlToolProjectionState();
    let observedEvents = 0;
    const backfill = backfillControlToolProjection({
      client: {} as never,
      eventStream: async function* () {
        markStarted();
        await eventReleased;
        yield workspaceRequestEvent(1);
      },
      runId: "run-plan-history",
      afterSequence: 0,
      throughSequence: 1,
      state,
      signal: controller.signal,
      timeoutMs: 1_000,
      onEvent: () => {
        observedEvents += 1;
      },
    });

    await started;
    controller.abort();
    releaseEvent();

    await expect(backfill).rejects.toMatchObject({ name: "AbortError" });
    expect(observedEvents).toBe(0);
    expect(controlToolItems(state)).toEqual([]);
  });

  it("keeps hydration continuous across a negotiated Plan event", async () => {
    const statesByRun = new Map();
    const coverageByRun = new Map();
    await hydrateControlToolHistories({
      client: {} as never,
      eventStream: async function* (_client, input) {
        expect(input.extensions).toEqual(["run-plan-v1"]);
        yield workspaceRequestEvent(1);
        yield planEvent(2);
        yield workspaceCompletionEvent(3);
        yield terminalEvent(4);
      },
      inFlightByRun: new Map(),
      lifecycleSignal: new AbortController().signal,
      runsNewestFirst: [terminalRun("run-plan-history", 4)],
      statesByRun,
      coverageByRun,
      timeoutMs: 1_000,
    });

    expect(coverageByRun.get("run-plan-history")).toEqual({
      throughSequence: 4,
      complete: true,
    });
    expect(controlToolItems(statesByRun.get("run-plan-history"))).toEqual([
      expect.objectContaining({
        id: "call-plan-history",
        status: "completed",
        workspaceChanges: expect.objectContaining({ additions: 1 }),
      }),
    ]);
  });

  it("keeps terminal backfill continuous across a negotiated Plan event", async () => {
    const state = createControlToolProjectionState();
    applyControlToolEvent(state, workspaceRequestEvent(1));

    const result = await backfillControlToolProjection({
      client: {} as never,
      eventStream: async function* (_client, input) {
        expect(input.extensions).toEqual(["run-plan-v1"]);
        yield planEvent(2);
        yield workspaceCompletionEvent(3);
        yield terminalEvent(4);
      },
      runId: "run-plan-history",
      afterSequence: 1,
      throughSequence: 4,
      state,
      signal: new AbortController().signal,
      timeoutMs: 1_000,
    });

    expect(result.complete).toBe(true);
    expect(result.lastSequence).toBe(4);
    expect(controlToolItems(state)).toEqual([
      expect.objectContaining({
        id: "call-plan-history",
        status: "completed",
        workspaceChanges: expect.objectContaining({ additions: 1 }),
      }),
    ]);
  });
});

function workspaceRequestEvent(sequence: number): RunEventView {
  return {
    runId: "run-plan-history",
    eventId: `event-${sequence}`,
    sequence,
    occurredAt: "2026-09-01T08:00:00.000Z",
    type: "tool.requested",
    data: {
      segmentId: "segment-1",
      callId: "call-plan-history",
      kind: "function",
      name: "workspace_run_command",
    },
  } as RunEventView;
}

function workspaceCompletionEvent(sequence: number): RunEventView {
  return {
    runId: "run-plan-history",
    eventId: `event-${sequence}`,
    sequence,
    occurredAt: "2026-09-01T08:00:02.000Z",
    type: "tool.completed",
    data: {
      segmentId: "segment-1",
      callId: "call-plan-history",
      kind: "function",
      name: "workspace_run_command",
      isError: false,
      outputTruncated: false,
      artifactAvailable: false,
      workspaceChanges: {
        schemaVersion: "crewon.workspace-change-summary.v0",
        paths: ["src/task.ts"],
        additions: 1,
        deletions: 0,
        statsComplete: true,
      },
    },
  } as RunEventView;
}

function planEvent(sequence: number): RunEventView {
  return {
    runId: "run-plan-history",
    eventId: `event-${sequence}`,
    sequence,
    occurredAt: "2026-09-01T08:00:01.000Z",
    type: "run.plan.updated",
    data: {
      plan: {
        schemaVersion: "crewon.run-plan.v0",
        planId: "run-plan-history",
        revision: 1,
        explanation: null,
        items: [],
        createdAt: "2026-09-01T08:00:01.000Z",
        updatedAt: "2026-09-01T08:00:01.000Z",
      },
    },
  } as RunEventView;
}

function terminalEvent(sequence: number): RunEventView {
  return {
    runId: "run-plan-history",
    eventId: `event-${sequence}`,
    sequence,
    occurredAt: "2026-09-01T08:00:03.000Z",
    type: "run.completed",
    data: { outputRef: null },
  } as RunEventView;
}

function terminalRun(runId: string, lastSequence: number) {
  return {
    runId,
    threadId: "thread-1",
    status: "completed" as const,
    revision: 1,
    lastSequence,
    cancelRequested: false,
    waitingApproval: null,
    collaborationMode: "default" as const,
    purpose: "turn" as const,
    workflowVersionBinding: null,
    goalBinding: null,
    outputRef: null,
    failure: null,
    createdAt: "2026-09-01T08:00:00.000Z",
    updatedAt: "2026-09-01T08:00:03.000Z",
    terminalAt: "2026-09-01T08:00:03.000Z",
  };
}
