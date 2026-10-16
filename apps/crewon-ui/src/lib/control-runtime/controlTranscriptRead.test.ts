import { describe, expect, it } from "vitest";
import { ControlApiClient } from "@crewon/control-client";
import {
  formatThreadMessageWindowCursor,
  parseThreadMessageWindowQuery,
} from "@crewon/contracts";
import type { GetThreadTranscriptSnapshotResponse } from "@crewon/contracts";
import { transcriptRun } from "./controlTranscriptWindow.test-support";
import { readControlTranscript } from "./controlTranscriptRead";

function snapshot() {
  const value: GetThreadTranscriptSnapshotResponse = {
    schemaVersion: "crewon.transcript-snapshot.v0",
    transcriptWindow: {
      schemaVersion: "crewon.transcript-window.v0",
      messageWindow: {
        schemaVersion: "crewon.message-window.v0",
        threadId: "thread-1",
        threadRevision: 21,
        eventSequence: 21,
        headMessageSequence: 20,
        olderCursor: null,
        newerCursor: null,
        data: [
          {
            messageId: "message-1",
            threadId: "thread-1",
            sequence: 1,
            role: "user",
            content: "source",
            proposedPlan: null,
            createdAt: "2026-09-11T00:00:00.000Z",
          },
        ],
      },
      runBindings: [],
    },
    runs: [transcriptRun("run-1", true)],
    activeRunId: "off-page-active",
  };
  const base = value.runs[0]!;
  value.transcriptWindow.messageWindow.threadRevision = 21;
  value.transcriptWindow.messageWindow.eventSequence = 21;
  value.transcriptWindow.messageWindow.headMessageSequence = 20;
  value.transcriptWindow.messageWindow.data = Array.from(
    { length: 20 },
    (_, i) => ({
      ...value.transcriptWindow.messageWindow.data[0]!,
      messageId: `message-${i + 1}`,
      sequence: i + 1,
      role: i % 2 === 0 ? "user" : "assistant",
    }),
  );
  value.transcriptWindow.runBindings =
    value.transcriptWindow.messageWindow.data.map((m) => ({
      messageId: m.messageId,
      runId: `run-${Math.ceil(m.sequence / 2)}`,
      source: m.role === "user" ? "turnStartReceipt" : "messageCompletedEvent",
    }));
  value.runs = Array.from({ length: 10 }, (_, i) => ({
    ...base,
    runId: `run-${i + 1}`,
    status: "completed",
    terminalAt: base.updatedAt,
  }));
  value.runs.unshift({ ...base, runId: "off-page-active", status: "running" });
  value.activeRunId = "off-page-active";
  return value;
}
const input = {
  threadId: "thread-1",
  threadRevision: 21,
  cursor: null,
  signal: undefined,
};

describe("Control transcript snapshot reads", () => {
  it("loads ten historical Runs and the off-page active Run in one authenticated HTTP request", async () => {
    const calls: URL[] = [],
      controller = new AbortController();
    const client = new ControlApiClient({
      baseUrl: "https://snapshot.example",
      accessToken: "owner-session",
      fetch: async (url, options) => {
        calls.push(new URL(String(url)));
        expect(calls[0]!.pathname).toBe(
          "/api/v1/threads/thread-1/transcript-snapshot",
        );
        expect(calls[0]!.searchParams.get("limit")).toBe("50");
        expect(new Headers(options?.headers).get("authorization")).toBe(
          "Bearer owner-session",
        );
        expect(options?.signal).toBe(controller.signal);
        return Response.json(snapshot());
      },
    });
    const result = await readControlTranscript({
      ...input,
      client,
      signal: controller.signal,
    });
    expect(calls).toHaveLength(1);
    expect(result.activeRun?.runId).toBe("off-page-active");
    expect(result.runs.map((r) => r.runId)).toEqual([
      ...Array.from({ length: 10 }, (_, i) => `run-${10 - i}`),
      "off-page-active",
    ]);
    expect(result.window.messageWindow.data).toHaveLength(20);
  });
  it("rebinds an older cursor to the current revision and rejects a changed snapshot", async () => {
    const cursor = formatThreadMessageWindowCursor("thread-1", {
      direction: "older",
      messageSequence: 21,
      threadRevision: 1,
    });
    let change = false;
    const client = new ControlApiClient({
      baseUrl: "https://snapshot.example",
      fetch: async (url) => {
        const parsed = new URL(String(url));
        const position = parseThreadMessageWindowQuery(
          Object.fromEntries(parsed.searchParams),
          "thread-1",
        ).position;
        if (position) expect(position.threadRevision).toBe(21);
        const value = snapshot();
        if (change) {
          value.transcriptWindow.messageWindow.threadRevision++;
          value.transcriptWindow.messageWindow.eventSequence++;
        }
        return Response.json(value);
      },
    });
    const result = await readControlTranscript({ ...input, client, cursor });
    expect(result.cursor).not.toBe(cursor);
    change = true;
    await expect(readControlTranscript({ ...input, client })).rejects.toThrow(
      "control_thread_projection_snapshot_changed",
    );
  });
  it("rejects a late snapshot when the transport ignores caller cancellation", async () => {
    const controller = new AbortController();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const client = new ControlApiClient({
      baseUrl: "https://snapshot.example",
      fetch: async () => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return Response.json(snapshot());
      },
    });
    const read = readControlTranscript({
      ...input,
      client,
      signal: controller.signal,
    });
    await started;
    controller.abort();
    release();
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
  });
});
