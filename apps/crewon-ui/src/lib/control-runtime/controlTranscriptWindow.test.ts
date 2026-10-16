import { describe, it, expect, vi } from "vitest";
import { formatThreadMessageWindowCursor } from "@crewon/contracts";
import { transcriptWindow } from "./controlTranscriptWindow";
import {
  transcriptFixture,
  transcriptRun,
} from "./controlTranscriptWindow.test-support";
import { readControlReplayBoundary } from "./controlReplayBoundary";
import { ControlTranscriptReads } from "./controlTranscriptReads";

describe("actual Control transcript windows", () => {
  it("traverses 2,400 messages and 1,200 Runs both ways with only one page retained", async () => {
    const f = transcriptFixture();
    try {
      let thread = await f.runtime.readThread("thread-1", {
        toolHistoryMode: "skip",
      });
      const visited = new Set<string>();
      let pages = 0;
      while (true) {
        expect(thread.turns).toHaveLength(25);
        for (const turn of thread.turns)
          for (const item of turn.items) visited.add(item.id);
        pages++;
        const cursor = transcriptWindow(thread)!.olderCursor;
        if (!cursor) break;
        thread = await f.runtime.navigateTranscript("thread-1", cursor);
      }
      expect(pages).toBe(48);
      expect(visited.size).toBe(2400);
      expect(transcriptWindow(thread)!.firstSequence).toBe(1);
      expect(
        transcriptWindow(
          await f.runtime.navigateTranscript(
            "thread-1",
            transcriptWindow(thread)!.newerCursor,
          ),
        )!.firstSequence,
      ).toBe(51);
      expect(
        transcriptWindow(await f.runtime.navigateTranscript("thread-1", null))!
          .firstSequence,
      ).toBe(2351);
      expect(
        f.calls.some((call) =>
          /\/threads\/thread-1\/(messages|runs|task-changes)(?:\?|$)/u.test(
            call,
          ),
        ),
      ).toBe(false);
    } finally {
      f.runtime.close();
    }
  });

  it("uses exact bindings when every timestamp is equal and exposes legacy and partial turns honestly", async () => {
    const f = transcriptFixture(101);
    f.messages[52]!.content = "legacy: retained source";
    try {
      const thread = await f.runtime.readThread("thread-1", {
        toolHistoryMode: "skip",
      });
      expect(transcriptWindow(thread)!.firstSequence).toBe(52);
      expect(thread.turns[0]!.id).toBe("run-26");
      expect(
        thread.turns[0]!.items.some((item) => item.type === "userMessage"),
      ).toBe(false);
      expect(transcriptWindow(thread)!.rows[0]).toMatchObject({
        kind: "run",
        continuation: true,
      });
      expect(transcriptWindow(thread)!.rows).toContainEqual(
        expect.objectContaining({
          kind: "unassociated",
          item: expect.objectContaining({ id: "message-53" }),
        }),
      );
      expect(
        thread.turns.some(
          (turn) => turn.id.startsWith("orphan:") || turn.status === "failed",
        ),
      ).toBe(false);
      expect(f.calls.filter((call) => call.endsWith("/plan"))).toEqual([
        "/api/v1/runs/run-51/plan",
      ]);
    } finally {
      f.runtime.close();
    }
  });

  it("keeps an off-page active Run streaming while reading old pages and refreshing after an append", async () => {
    const onTextDelta = vi.fn();
    const f = transcriptFixture(200, { onTextDelta });
    f.setActive(transcriptRun("run-live", true));
    try {
      let thread = await f.runtime.readThread("thread-1");
      await vi.waitFor(() =>
        expect(onTextDelta).toHaveBeenCalledWith("thread-1", "Still running"),
      );
      thread = await f.runtime.navigateTranscript(
        "thread-1",
        transcriptWindow(thread)!.olderCursor,
      );
      const before = transcriptWindow(thread)!.firstSequence;
      f.messages.push({
        ...f.messages.at(-1)!,
        messageId: "message-201",
        sequence: 201,
        role: "user",
        content: "New message",
      });
      f.thread.lastMessageSequence++;
      f.thread.revision++;
      const refreshed = await f.runtime.readThread("thread-1");
      expect(transcriptWindow(refreshed)!.firstSequence).toBe(before);
      expect(refreshed.status.type).toBe("active");
      expect(f.streamSignals.get("run-live")?.aborted).toBe(false);
      expect(f.activeStreams).toEqual(["run-live"]);
      expect(refreshed.turns.some((turn) => turn.id === "run-live")).toBe(true);
    } finally {
      f.runtime.close();
    }
    expect(f.streamSignals.get("run-live")?.aborted).toBe(true);
  });

  it("reads the whole task change ledger only when explicitly requested", async () => {
    const f = transcriptFixture(4);
    try {
      await f.runtime.readThread("thread-1");
      expect(f.calls.some((call) => call.endsWith("/task-changes"))).toBe(
        false,
      );
      const thread = await f.runtime.navigateTranscript("thread-1", null, {
        includeTaskChanges: true,
      });
      expect(thread).toMatchObject({
        controlTaskChangeLedger: { complete: true },
      });
      expect(
        f.calls.filter((call) => call.endsWith("/task-changes")),
      ).toHaveLength(1);
    } finally {
      f.runtime.close();
    }
  });

  it("counts edit rollback beyond 1,000 messages, including hidden Team users, with version checks", async () => {
    const f = transcriptFixture(2400);
    f.messages[1000]!.content = "[Team Runtime · Expert · 成员报告]\nresult";
    try {
      const result = await readControlReplayBoundary({
        client: f.client,
        threadId: "thread-1",
        userMessageId: "message-1",
        revision: f.thread.revision,
        signal: new AbortController().signal,
      });
      expect(result.numTurns).toBe(1200);
      expect(result.message.messageId).toBe("message-1");
      expect(
        f.calls.filter((call) => call.includes("/message-window")),
      ).toHaveLength(24);
      await expect(
        readControlReplayBoundary({
          client: f.client,
          threadId: "thread-1",
          userMessageId: "message-1",
          revision: f.thread.revision - 1,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("message_replay_changed");
    } finally {
      f.runtime.close();
    }
  });

  it("replays an old visible message through the real client with the complete suffix and one guarded send", async () => {
    const f = transcriptFixture(2400);
    f.messages[1000]!.content = "[Team Runtime · Expert · 成员报告]\nresult";
    try {
      const cursor = formatThreadMessageWindowCursor("thread-1", {
        direction: "older",
        messageSequence: 51,
        threadRevision: f.thread.revision,
      });
      const page = await f.runtime.navigateTranscript("thread-1", cursor);
      expect(transcriptWindow(page)!.firstSequence).toBe(1);
      await f.runtime.replayMessage({
        threadId: "thread-1",
        userMessageId: "message-1",
        expectedThreadRevision: 2401,
        expectedTurnIds: page.turns.map((turn) => turn.id),
        text: "Replacement question",
      });
      expect(f.mutations).toEqual([
        {
          path: "/api/v1/threads/thread-1:rollback",
          body: { expectedRevision: 2401, numTurns: 1200 },
        },
        {
          path: "/api/v1/threads/thread-1/turns",
          body: expect.objectContaining({
            expectedRevision: 2402,
            content: "Replacement question",
            executionIntent: "none",
          }),
        },
      ]);
      expect(f.messages.map((message) => message.content)).toEqual([
        "Replacement question",
      ]);
      expect(
        f.calls.filter((call) => call.includes("/message-window")),
      ).toHaveLength(24);
    } finally {
      f.runtime.close();
    }
  });
});

it("cancels repeated full-runtime reads even when transport ignores abort, and rejects all late publications", async () => {
  vi.useFakeTimers();
  const onThread = vi.fn();
  const f = transcriptFixture(2, { onThread });
  f.runtime.setThreadEventStreamFocus(null);
  const realRead = f.client.getThreadTranscriptSnapshot.bind(f.client);
  const response = await realRead("thread-1");
  const releases: (() => void)[] = [];
  let entered: (() => void) | undefined;
  const read = vi
    .spyOn(f.client, "getThreadTranscriptSnapshot")
    .mockImplementation(
      async () =>
        new Promise((resolve) => {
          releases.push(() => resolve(response));
          entered?.();
        }),
    );
  const results: Promise<unknown>[] = [];
  try {
    for (let index = 0; index < 30; index++) {
      const gate = new Promise<void>((resolve) => {
        entered = resolve;
      });
      results.push(
        f.runtime
          .readThread("thread-1", {
            publishBase: false,
            toolHistoryMode: "skip",
          })
          .catch((error: unknown) => error),
      );
      await gate;
    }
    read.mockRestore();
    const latest = await f.runtime.readThread("thread-1", {
      publishBase: false,
      toolHistoryMode: "skip",
    });
    expect(latest.turns).toHaveLength(1);
    for (const release of releases) release();
    for (const result of await Promise.all(results))
      expect(result).toMatchObject({
        message: "control_thread_projection_superseded",
      });
    expect(onThread).not.toHaveBeenCalled();
  } finally {
    f.runtime.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  }
});

it("expires an unresponsive replay preflight without mutations and releases the per-thread replay lock", async () => {
  vi.useFakeTimers();
  const f = transcriptFixture(2);
  f.runtime.setThreadEventStreamFocus(null);
  try {
    const page = await f.runtime.readThread("thread-1");
    const catalog = await f.client.getActiveAgentVersionCatalog();
    let release!: (value: typeof catalog) => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const catalogRead = vi
      .spyOn(f.client, "getActiveAgentVersionCatalog")
      .mockImplementation(
        async () =>
          new Promise((resolve) => {
            release = resolve;
            entered();
          }),
      );
    const request = {
      threadId: "thread-1",
      userMessageId: "message-1",
      expectedThreadRevision: 3,
      expectedTurnIds: page.turns.map((turn) => turn.id),
      text: "Replacement question",
    };
    const pending = f.runtime.replayMessage(request);
    const rejected = expect(pending).rejects.toThrow(
      "control_replay_read_timeout",
    );
    await gate;
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    release(catalog);
    await Promise.resolve();
    expect(f.mutations).toEqual([]);
    catalogRead.mockRestore();
    await f.runtime.replayMessage(request);
    expect(f.mutations.map((mutation) => mutation.path)).toEqual([
      "/api/v1/threads/thread-1:rollback",
      "/api/v1/threads/thread-1/turns",
    ]);
  } finally {
    f.runtime.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  }
});

it("supersedes an uncooperative request, preserves the desired page, and clears deadlines on close", async () => {
  vi.useFakeTimers();
  const reads = new ControlTranscriptReads<string>();
  let finish!: (value: string) => void;
  const old = reads.run({
    threadId: "thread-1",
    cursor: "older",
    mode: "hydrate",
    read: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const rejected = expect(old).rejects.toThrow(
    "control_thread_projection_superseded",
  );
  await Promise.resolve();
  const latest = await reads.run({
    threadId: "thread-1",
    mode: "hydrate",
    read: async (cursor) => cursor!,
  });
  expect(latest).toBe("older");
  finish("late");
  await rejected;
  const pending = reads.run({
    threadId: "thread-2",
    mode: "hydrate",
    read: async () => new Promise(() => {}),
  });
  const timedOut = expect(pending).rejects.toThrow(
    "control_transcript_read_timeout",
  );
  await vi.advanceTimersByTimeAsync(30_000);
  await timedOut;
  reads.close();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});
