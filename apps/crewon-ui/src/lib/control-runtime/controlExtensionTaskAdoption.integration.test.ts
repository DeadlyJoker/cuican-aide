import type { GetThreadTranscriptWindowResponse } from "@crewon/contracts";
import { fixtureTranscriptSnapshot } from "./controlTranscriptSnapshot.test-support";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunEventView, RunView } from "@crewon/contracts";
import { ControlApiClient } from "@crewon/control-client";
import { ControlThreadRuntime } from "./controlThreadRuntime";
import {
  transcriptFixture,
  transcriptRun,
} from "./controlTranscriptWindow.test-support";

const receipt = { threadId: "thread-1", runId: "run-1" };
const timestamp = "2026-09-11T00:00:00.000Z";
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((close) => close()));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function event(
  sequence: number,
  type: RunEventView["type"],
  data: object,
): RunEventView {
  return {
    eventId: `extension-event-${sequence}`,
    runId: receipt.runId,
    sequence,
    occurredAt: timestamp,
    type,
    data,
  } as RunEventView;
}

function sse(signal?: AbortSignal | null) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    signal?.removeEventListener("abort", finish);
    controller.close();
  };
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      if (signal?.aborted) finish();
      else signal?.addEventListener("abort", finish, { once: true });
    },
    cancel() {
      ended = true;
      signal?.removeEventListener("abort", finish);
    },
  });
  return {
    response: new Response(body, {
      headers: { "content-type": "text/event-stream" },
    }),
    signal,
    finish,
    send(value: RunEventView) {
      if (ended) throw new Error("fixture_stream_closed");
      controller.enqueue(
        new TextEncoder().encode(
          `id: ${value.sequence}\nevent: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`,
        ),
      );
    },
  };
}

/** Real authenticated Control HTTP client and SSE decoder; no runtime or provider methods are mocked. */
function fixture() {
  const transcript = transcriptFixture(1);
  transcript.runtime.close();
  let run: RunView = transcriptRun(receipt.runId, true);
  let activeRun: RunView | null | undefined;
  const requests: {
    path: string;
    method: string;
    headers: Headers;
    signal?: AbortSignal | null;
    credentials?: RequestCredentials;
  }[] = [];
  const runStreams: ReturnType<typeof sse>[] = [];
  const threadStreams: ReturnType<typeof sse>[] = [];
  let hold:
    | { path: string; gate: ReturnType<typeof deferred<void>> }
    | undefined;
  const callbacks = {
    onThread: vi.fn(),
    onTextDelta: vi.fn(),
    onToolItem: vi.fn(),
    onRunSettled: vi.fn(),
    onStreamError: vi.fn(),
    onToolApprovalRequired: vi.fn(),
    onToolApprovalResolved: vi.fn(),
    onThreadStreamError: vi.fn(),
  };
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json" },
    });
  const client = new ControlApiClient({
    baseUrl: "https://control.fixture.invalid",
    accessToken: "plugin-owner-session",
    origin: "https://app.fixture.invalid",
    fetch: async (input, options) => {
      const url = new URL(String(input));
      requests.push({
        path: url.pathname + url.search,
        method: options?.method ?? "GET",
        headers: new Headers(options?.headers),
        signal: options?.signal,
        credentials: options?.credentials,
      });
      if (hold?.path === url.pathname) await hold.gate.promise;
      if (url.pathname === "/api/v1/runs/run-1") return json({ run });
      if (url.pathname === "/api/v1/threads/thread-1")
        return json({
          thread: transcript.thread,
          eventSequence: transcript.thread.revision,
        });
      if (url.pathname === "/api/v1/threads/thread-1/active-run")
        return json({
          schemaVersion: "crewon.thread-active-run.v0",
          threadId: receipt.threadId,
          run:
            activeRun === undefined
              ? run.status === "completed"
                ? null
                : run
              : activeRun,
        });
      if (url.pathname === "/api/v1/threads/thread-1/transcript-window" || url.pathname === "/api/v1/threads/thread-1/transcript-snapshot") {
        const window: GetThreadTranscriptWindowResponse = {
          schemaVersion: "crewon.transcript-window.v0",
          messageWindow: {
            schemaVersion: "crewon.message-window.v0",
            threadId: receipt.threadId,
            threadRevision: transcript.thread.revision,
            eventSequence: transcript.thread.revision,
            headMessageSequence: transcript.thread.lastMessageSequence,
            data: transcript.messages,
            olderCursor: null,
            newerCursor: null,
          },
          runBindings: transcript.messages.map((message) => ({
            messageId: message.messageId,
            runId: receipt.runId,
            source:
              message.role === "user"
                ? "turnStartReceipt"
                : "messageCompletedEvent",
          })),
        };
        const current = activeRun === undefined ? (run.status === "completed" ? null : run) : activeRun;
        return json(url.pathname.endsWith("/transcript-snapshot") ? fixtureTranscriptSnapshot(window, [run], current) : window);
      }
      if (url.pathname === "/api/v1/runs/run-1/plan")
        return json({
          runId: receipt.runId,
          eventSequence: run.lastSequence,
          plan: null,
        });
      if (url.pathname.endsWith("/events")) {
        const stream = sse(options?.signal);
        (url.pathname.includes("/runs/") ? runStreams : threadStreams).push(
          stream,
        );
        return stream.response;
      }
      throw new Error(`unexpected_extension_adoption_request:${url.pathname}`);
    },
  });
  const runtime = new ControlThreadRuntime(
    {
      client,
      reconnectDelay: async () => {},
      runStatusPollDelay: (signal) =>
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    },
    callbacks,
  );
  cleanups.push(() => {
    runtime.close();
    hold?.gate.resolve();
    runStreams.forEach((stream) => stream.finish());
    threadStreams.forEach((stream) => stream.finish());
  });
  return {
    runtime,
    callbacks,
    requests,
    runStreams,
    threadStreams,
    setRun(patch: Partial<RunView>) {
      run = {
        ...run,
        ...patch,
        revision: patch.lastSequence ?? patch.revision ?? run.revision,
      };
    },
    setActiveRun(value: RunView | null) {
      activeRun = value;
    },
    hold(path: string) {
      const gate = deferred<void>();
      hold = { path, gate };
      return gate;
    },
    complete() {
      run = {
        ...run,
        status: "completed",
        revision: 8,
        lastSequence: 8,
        waitingApproval: null,
        outputRef: "message:plugin-result",
        terminalAt: timestamp,
      };
      transcript.messages.push({
        messageId: "plugin-result",
        threadId: receipt.threadId,
        sequence: 2,
        role: "assistant",
        content: "Image task submitted.",
        proposedPlan: null,
        createdAt: timestamp,
      });
      transcript.thread.revision++;
      transcript.thread.lastMessageSequence = 2;
    },
  };
}

const wait = (assert: () => void) =>
  vi.waitFor(assert, { timeout: 3000, interval: 10 });

describe("host-created extension task adoption over Control HTTP/SSE", () => {
  it("hydrates the owning transcript, resumes contiguous output, and settles approval through the existing authenticated stream", async () => {
    const f = fixture();
    await f.runtime.adoptExtensionTask(receipt);
    await wait(() => expect(f.runStreams).toHaveLength(1));
    expect(f.requests[0]).toMatchObject({
      path: "/api/v1/runs/run-1",
      method: "GET",
    });
    expect(f.callbacks.onThread).toHaveBeenCalledWith(
      expect.objectContaining({
        id: receipt.threadId,
        turns: [expect.objectContaining({ id: receipt.runId })],
      }),
    );
    const first = f.runStreams[0]!;
    first.send(event(1, "run.created", { threadId: receipt.threadId }));
    first.send(event(2, "run.started", {}));
    first.send(
      event(3, "segment.started", { segmentId: "segment-1", attempt: 1 }),
    );
    const delta = event(4, "model.output.delta", {
      segmentId: "segment-1",
      delta: "Image task ",
    });
    first.send(delta);
    await wait(() =>
      expect(f.callbacks.onTextDelta).toHaveBeenCalledWith(
        receipt.threadId,
        "Image task ",
      ),
    );
    f.setRun({ lastSequence: 4 });
    first.finish();
    await wait(() => expect(f.runStreams).toHaveLength(2));
    const streamRequests = f.requests.filter((request) =>
      request.path.startsWith("/api/v1/runs/run-1/events"),
    );
    expect(
      streamRequests.map((request) => request.headers.get("last-event-id")),
    ).toEqual([null, "4"]);
    expect(
      streamRequests.every(
        (request) =>
          request.path.includes("view=transcript") &&
          request.path.includes("extensions=run-plan-v1"),
      ),
    ).toBe(true);
    const second = f.runStreams[1]!;
    second.send(delta);
    second.send(
      event(5, "tool.requested", {
        segmentId: "segment-1",
        callId: "call-comfy",
        kind: "function",
        name: "comfy_submit",
        inputPreview: "{}",
        inputTruncated: false,
      }),
    );
    f.setRun({
      status: "waitingApproval",
      lastSequence: 6,
      waitingApproval: { approvalId: "approval-comfy" },
    });
    second.send(
      event(6, "run.approval.required", { approvalId: "approval-comfy" }),
    );
    await wait(() =>
      expect(f.callbacks.onToolApprovalRequired).toHaveBeenCalledWith({
        approvalId: "approval-comfy",
        runId: receipt.runId,
        threadId: receipt.threadId,
        toolName: "comfy_submit",
      }),
    );
    await wait(() =>
      expect(f.callbacks.onThread).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: { type: "active", activeFlags: ["waitingOnApproval"] },
          turns: [
            expect.objectContaining({
              status: "inProgress",
              items: expect.arrayContaining([
                expect.objectContaining({
                  type: "dynamicToolCall",
                  controlApproval: {
                    approvalId: "approval-comfy",
                    status: "required",
                  },
                }),
              ]),
            }),
          ],
        }),
      ),
    );
    expect(f.callbacks.onTextDelta.mock.calls).toEqual([
      [receipt.threadId, "Image task "],
    ]);
    const approvalPublications = f.callbacks.onThread.mock.calls.length;
    f.setRun({ status: "running", lastSequence: 7, waitingApproval: null });
    second.send(event(7, "run.resumed", { reasonCode: "approval_resolved" }));
    await wait(() =>
      expect(f.callbacks.onToolApprovalResolved).toHaveBeenCalledWith(
        receipt.threadId,
        receipt.runId,
      ),
    );
    await wait(() => {
      expect(f.callbacks.onThread.mock.calls.length).toBeGreaterThan(
        approvalPublications,
      );
      expect(f.callbacks.onThread).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: { type: "active", activeFlags: [] },
          turns: [expect.objectContaining({ status: "inProgress" })],
        }),
      );
    });
    f.complete();
    second.send(
      event(8, "run.completed", { outputRef: "message:plugin-result" }),
    );
    await wait(() =>
      expect(f.callbacks.onRunSettled).toHaveBeenCalledWith(
        receipt.threadId,
        receipt.runId,
      ),
    );
    expect(f.callbacks.onThread.mock.calls.at(-1)![0]).toMatchObject({
      id: receipt.threadId,
      turns: [
        expect.objectContaining({
          id: receipt.runId,
          status: "completed",
          items: expect.arrayContaining([
            expect.objectContaining({
              type: "agentMessage",
              text: "Image task submitted.",
            }),
          ]),
        }),
      ],
    });
    expect(f.callbacks.onStreamError).not.toHaveBeenCalled();
    expect(
      f.requests.every(
        (request) =>
          request.method === "GET" &&
          request.headers.get("authorization") ===
            "Bearer plugin-owner-session" &&
          request.headers.get("origin") === "https://app.fixture.invalid" &&
          request.credentials === "include",
      ),
    ).toBe(true);
    expect(f.requests.some((request) => request.path.includes("/turns"))).toBe(
      false,
    );
  });

  it.each([
    { runId: "foreign-run" },
    { threadId: "foreign-thread" },
    { purpose: "manualCompaction" as const },
  ])("rejects a receipt whose authoritative Run differs: %j", async (patch) => {
    const f = fixture();
    f.setRun(patch);
    await expect(f.runtime.adoptExtensionTask(receipt)).rejects.toThrow(
      "control_extension_task_adoption_invalid",
    );
    expect(f.requests.map((request) => request.path)).toEqual([
      "/api/v1/runs/run-1",
    ]);
    expect(f.callbacks.onThread).not.toHaveBeenCalled();
    expect(f.runStreams).toHaveLength(0);
  });

  it("rejects a cross-thread active Run returned during canonical transcript hydration", async () => {
    const f = fixture();
    f.setActiveRun({
      ...transcriptRun(receipt.runId, true),
      threadId: "foreign-thread",
    });
    await expect(f.runtime.adoptExtensionTask(receipt)).rejects.toThrow();
    expect(f.callbacks.onThread).not.toHaveBeenCalled();
    expect(f.runStreams).toHaveLength(0);
  });

  it.each(["abort", "close"] as const)(
    "ignores a late receipt response after %s",
    async (action) => {
      const f = fixture();
      const gate = f.hold("/api/v1/runs/run-1");
      const controller = new AbortController();
      const adoption = f.runtime.adoptExtensionTask(receipt, {
        signal: controller.signal,
      });
      const rejected = expect(adoption).rejects.toThrow();
      await wait(() => expect(f.requests).toHaveLength(1));
      if (action === "abort") controller.abort();
      else f.runtime.close();
      gate.resolve();
      await rejected;
      expect(f.requests.map((request) => request.path)).toEqual([
        "/api/v1/runs/run-1",
      ]);
      expect(f.callbacks.onThread).not.toHaveBeenCalled();
      expect(f.runStreams).toHaveLength(0);
    },
  );

  it.each(["abort", "close"] as const)(
    "cancels an in-flight transcript after %s without adopting a Run or publishing its late snapshot",
    async (action) => {
      const f = fixture();
      const gate = f.hold("/api/v1/threads/thread-1/transcript-snapshot");
      const controller = new AbortController();
      const adoption = f.runtime.adoptExtensionTask(receipt, {
        signal: controller.signal,
      });
      const rejected = expect(adoption).rejects.toThrow();
      await wait(() =>
        expect(
          f.requests.some((request) =>
            request.path.startsWith(
              "/api/v1/threads/thread-1/transcript-snapshot",
            ),
          ),
        ).toBe(true),
      );
      if (action === "abort") controller.abort();
      else f.runtime.close();
      await rejected;
      gate.resolve();
      await wait(() =>
        expect(
          f.requests.find((request) =>
            request.path.startsWith(
              "/api/v1/threads/thread-1/transcript-snapshot",
            ),
          )!.signal!.aborted,
        ).toBe(true),
      );
      expect(f.callbacks.onThread).not.toHaveBeenCalled();
      expect(f.runStreams).toHaveLength(0);
      expect(f.threadStreams).toHaveLength(0);
    },
  );

  it("aborts both adopted streams on close and ignores a buffered output frame", async () => {
    const f = fixture();
    await f.runtime.adoptExtensionTask(receipt);
    await wait(() => {
      expect(f.runStreams).toHaveLength(1);
      expect(f.threadStreams).toHaveLength(1);
    });
    f.runStreams[0]!.send(
      event(1, "model.output.delta", {
        segmentId: "segment-1",
        delta: "Buffered after close",
      }),
    );
    f.runtime.close();
    await wait(() =>
      expect(
        [...f.runStreams, ...f.threadStreams].every(
          (stream) => stream.signal?.aborted,
        ),
      ).toBe(true),
    );
    await Promise.resolve();
    expect(f.callbacks.onTextDelta).not.toHaveBeenCalled();
    expect(f.callbacks.onRunSettled).not.toHaveBeenCalled();
    const published = f.callbacks.onThread.mock.calls.length;
    await expect(f.runtime.adoptExtensionTask(receipt)).rejects.toThrow(
      "control_thread_runtime_closed",
    );
    expect(f.callbacks.onThread.mock.calls).toHaveLength(published);
  });
});
