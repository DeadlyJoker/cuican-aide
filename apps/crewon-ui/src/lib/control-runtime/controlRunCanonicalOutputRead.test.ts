import { describe, expect, it, vi } from "vitest";
import type {
  GetThreadResponse,
  GetThreadTranscriptWindowResponse,
  MessageView,
} from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";
import { formatThreadMessageWindowCursor } from "@crewon/contracts";
import { readControlRunCanonicalOutput } from "./controlRunCanonicalOutputRead";

const threadId = "canonical-output-thread";
const runId = "canonical-output-run";
const revision = 8;
const time = "2026-10-10T00:00:00Z";

function message(
  sequence: number,
  role: MessageView["role"] = "assistant",
): MessageView {
  return {
    messageId: `output-${sequence}`,
    threadId,
    sequence,
    role,
    content: `Canonical output ${sequence}`,
    proposedPlan: null,
    createdAt: time,
  };
}

function page(
  messages: MessageView[],
  olderCursor: string | null = null,
): GetThreadTranscriptWindowResponse {
  return {
    schemaVersion: "crewon.transcript-window.v0",
    messageWindow: {
      schemaVersion: "crewon.message-window.v0",
      threadId,
      threadRevision: revision,
      eventSequence: revision,
      headMessageSequence: 250,
      data: messages,
      olderCursor,
      newerCursor: null,
    },
    runBindings: messages.map((item) => ({
      messageId: item.messageId,
      runId,
      source:
        item.role === "user" ? "turnStartReceipt" : "messageCompletedEvent",
    })),
  };
}

function snapshot(): GetThreadResponse {
  return {
    thread: {
      threadId,
      title: "Canonical output lookup",
      status: "active",
      revision,
      lastMessageSequence: 250,
      forkedFromThreadId: null,
      forkedThroughHistorySequence: null,
      createdAt: time,
      updatedAt: time,
      archivedAt: null,
      deletedAt: null,
    },
    eventSequence: revision,
  };
}

function fixture() {
  const controller = new AbortController();
  const client = {
    getThreadTranscriptWindow:
      vi.fn<ControlApiClient["getThreadTranscriptWindow"]>(),
    getThread: vi.fn<ControlApiClient["getThread"]>(async () => snapshot()),
  };
  const read = (outputId = "output-2") =>
    readControlRunCanonicalOutput({
      client,
      threadId,
      runId,
      outputId,
      threadRevision: revision,
      signal: controller.signal,
    });
  return { controller, client, read };
}

describe("durable Run output lookup", () => {
  it("finds an old output through revision-bound transcript windows without changing browsing state", async () => {
    const { client, controller, read } = fixture();
    const latestCursor = formatThreadMessageWindowCursor(threadId, {
      direction: "older",
      threadRevision: revision,
      messageSequence: 151,
    });
    const olderCursor = formatThreadMessageWindowCursor(threadId, {
      direction: "older",
      threadRevision: revision,
      messageSequence: 51,
    });
    client.getThreadTranscriptWindow
      .mockResolvedValueOnce(
        page(
          Array.from({ length: 100 }, (_, index) => message(index + 151)),
          latestCursor,
        ),
      )
      .mockResolvedValueOnce(
        page(
          Array.from({ length: 100 }, (_, index) => message(index + 51)),
          olderCursor,
        ),
      )
      .mockResolvedValueOnce(page([message(1, "user"), message(2)]));

    await expect(read()).resolves.toEqual(message(2));
    expect(client.getThreadTranscriptWindow.mock.calls).toEqual([
      [threadId, { cursor: null, limit: 100 }, { signal: controller.signal }],
      [
        threadId,
        { cursor: latestCursor, limit: 100 },
        { signal: controller.signal },
      ],
      [
        threadId,
        { cursor: olderCursor, limit: 100 },
        { signal: controller.signal },
      ],
    ]);
    expect(client.getThread).toHaveBeenCalledExactlyOnceWith(threadId, {
      signal: controller.signal,
    });
  });

  it.each(["runId", "source", "role"] as const)(
    "rejects an exact ID with the wrong %s",
    async (field) => {
      const { client, read } = fixture();
      const value = page([message(2)]);
      if (field === "runId") value.runBindings[0]!.runId = "different-run";
      if (field === "source") value.runBindings[0]!.source = "turnStartReceipt";
      if (field === "role") value.messageWindow.data[0]!.role = "user";
      client.getThreadTranscriptWindow.mockResolvedValue(value);

      await expect(read()).rejects.toThrow(
        "control_run_canonical_output_not_observed",
      );
      expect(client.getThread).not.toHaveBeenCalled();
    },
  );

  it("rejects a changed revision before requesting another page", async () => {
    const { client, read } = fixture();
    const value = page([message(4)], "older-window");
    value.messageWindow.threadRevision++;
    client.getThreadTranscriptWindow.mockResolvedValue(value);

    await expect(read()).rejects.toThrow(
      "control_thread_projection_snapshot_changed",
    );
    expect(client.getThreadTranscriptWindow).toHaveBeenCalledOnce();
    expect(client.getThread).not.toHaveBeenCalled();
  });

  it.each(["revision", "eventSequence"] as const)(
    "rejects a final Thread %s change after finding the output",
    async (field) => {
      const { client, read } = fixture();
      client.getThreadTranscriptWindow.mockResolvedValue(page([message(2)]));
      const changed = snapshot();
      if (field === "revision") changed.thread.revision++;
      else changed.eventSequence++;
      client.getThread.mockResolvedValue(changed);

      await expect(read()).rejects.toThrow(
        "control_thread_projection_snapshot_changed",
      );
    },
  );

  it("rejects repeated pages instead of retaining or scanning them forever", async () => {
    const { client, read } = fixture();
    client.getThreadTranscriptWindow.mockResolvedValue(
      page([message(5)], "same-window"),
    );

    await expect(read()).rejects.toThrow(
      "control_run_canonical_output_window_invalid",
    );
    expect(client.getThreadTranscriptWindow).toHaveBeenCalledTimes(2);
    expect(client.getThread).not.toHaveBeenCalled();
  });

  it("fails when all finite pages omit the referenced message", async () => {
    const { client, read } = fixture();
    client.getThreadTranscriptWindow.mockResolvedValue(
      page([message(1, "user")]),
    );

    await expect(read()).rejects.toThrow(
      "control_run_canonical_output_not_observed",
    );
    expect(client.getThread).not.toHaveBeenCalled();
  });

  it("stops after four pages and 400 messages instead of scanning the entire history", async () => {
    const { client, read } = fixture();
    for (const firstSequence of [351, 251, 151, 51]) {
      const value = page(
        Array.from({ length: 100 }, (_, index) =>
          message(firstSequence + index),
        ),
        formatThreadMessageWindowCursor(threadId, {
          direction: "older",
          threadRevision: revision,
          messageSequence: firstSequence,
        }),
      );
      value.messageWindow.headMessageSequence = 450;
      client.getThreadTranscriptWindow.mockResolvedValueOnce(value);
    }
    // This fifth page must not be requested even though it would contain output.
    client.getThreadTranscriptWindow.mockResolvedValue(page([message(2)]));

    await expect(read()).rejects.toThrow(
      "control_run_canonical_output_not_observed",
    );
    expect(client.getThreadTranscriptWindow).toHaveBeenCalledTimes(4);
    expect(client.getThread).not.toHaveBeenCalled();
  });

  it("cancels a pending HTTP read without waiting for an uncooperative transport", async () => {
    const { client, controller, read } = fixture();
    client.getThreadTranscriptWindow.mockImplementation(
      () => new Promise(() => {}),
    );
    const pending = read();
    const aborted = new Error("canonical lookup canceled");
    const assertion = expect(pending).rejects.toBe(aborted);
    controller.abort(aborted);

    await assertion;
    expect(client.getThreadTranscriptWindow).toHaveBeenCalledOnce();
    expect(client.getThread).not.toHaveBeenCalled();
  });

  it("does not open HTTP after cancellation", async () => {
    const { client, controller, read } = fixture();
    const aborted = new Error("already canceled");
    controller.abort(aborted);

    await expect(read()).rejects.toBe(aborted);
    expect(client.getThreadTranscriptWindow).not.toHaveBeenCalled();
  });
});
