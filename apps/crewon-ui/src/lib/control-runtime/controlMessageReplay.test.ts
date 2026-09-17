import { describe, expect, it, vi } from "vitest";
import type { MessageView } from "@crewon/contracts";
import { createDemoTurn, createDraftDemoThread } from "../demo/demoData";
import {
  replayControlMessage,
  replaySource,
  type MessageReplayRequest,
} from "./controlMessageReplay";

function fixture() {
  const thread = createDraftDemoThread({
    locale: "zh",
    newDraftPreview: "",
    newDraftThread: "测试",
  });
  thread.id = "thread";
  thread.turns = ["保留前文", "改这条", "删除后文"].map((text, index) => ({
    ...createDemoTurn({ text, responseText: "旧回复" }),
    id: `turn-${index}`,
    items: [
      {
        type: "userMessage" as const,
        id: `user-${index}`,
        clientId: null,
        content: [{ type: "text" as const, text, text_elements: [] }],
      },
    ],
  }));
  const request: MessageReplayRequest = {
    threadId: "thread",
    userMessageId: "user-1",
    expectedTurnIds: thread.turns.map((turn) => turn.id),
    text: "新问题",
    settings: { executionIntent: "goal" },
  };
  const runtime = {
    readThread: vi.fn(async () => thread),
    rollbackThread: vi.fn(async () => thread),
    startTurn: vi.fn(async () => ({})),
  };
  const messages = thread.turns.map(
    (_, index) =>
      ({
        messageId: `user-${index}`,
        role: "user",
        sequence: index + 1,
        content: ["保留前文", "改这条", "删除后文"][index],
      }) as MessageView,
  );
  const input = {
    request,
    runtime,
    readRevision: vi.fn(async () => 7),
    readMessages: vi.fn(async () => messages),
    preflight: vi.fn(async () => {}),
  };
  return { thread, messages, ...input, input };
}

describe("message replacement replay", () => {
  it("removes only the selected suffix under CAS before starting a fresh turn", async () => {
    const { input, runtime } = fixture();
    await replayControlMessage(input);
    expect(runtime.rollbackThread).toHaveBeenCalledWith("thread", 2, {
      expectedRevision: 7,
    });
    expect(runtime.startTurn).toHaveBeenCalledWith("thread", "新问题", [], {
      executionIntent: "none",
    });
    expect(runtime.rollbackThread.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.startTurn.mock.invocationCallOrder[0]!,
    );
  });
  it("counts internal user boundaries as well as visible team turns", async () => {
    const { input, messages, runtime } = fixture();
    messages.push({
      messageId: "internal",
      role: "user",
      sequence: 4,
    } as MessageView);
    await replayControlMessage(input);
    expect(runtime.rollbackThread).toHaveBeenCalledWith("thread", 3, {
      expectedRevision: 7,
    });
  });
  it.each(["", " ", "x".repeat(24 * 1024 + 1)])(
    "rejects empty or oversized input before any mutation",
    async (text) => {
      const { input, runtime } = fixture();
      input.request = { ...input.request, text };
      await expect(replayControlMessage(input)).rejects.toThrow(
        "message_replay_input",
      );
      expect(runtime.rollbackThread).not.toHaveBeenCalled();
    },
  );
  it("refuses stale visible turns and leaves history intact", async () => {
    const { input, thread, runtime } = fixture();
    thread.turns.pop();
    await expect(replayControlMessage(input)).rejects.toThrow(
      "message_replay_changed",
    );
    expect(runtime.rollbackThread).not.toHaveBeenCalled();
  });
  it("refuses a changed revision or an active run before rollback", async () => {
    const first = fixture();
    first.readRevision.mockResolvedValueOnce(7).mockResolvedValueOnce(8);
    await expect(replayControlMessage(first.input)).rejects.toThrow(
      "message_replay_changed",
    );
    expect(first.runtime.rollbackThread).not.toHaveBeenCalled();
    const second = fixture();
    second.thread.turns[2]!.status = "inProgress";
    await expect(replayControlMessage(second.input)).rejects.toThrow(
      "message_replay_busy",
    );
    expect(second.runtime.rollbackThread).not.toHaveBeenCalled();
  });
  it("never silently drops attached resources", async () => {
    const { input, thread, runtime } = fixture();
    const item = thread.turns[1]!.items[0]!;
    if (item.type === "userMessage")
      item.content.push({ type: "skill", name: "skill", path: "/skill" });
    expect(replaySource(thread, "user-1")?.textOnly).toBe(false);
    await expect(replayControlMessage(input)).rejects.toThrow(
      "message_replay_input",
    );
    expect(runtime.rollbackThread).not.toHaveBeenCalled();
  });
  it("leaves history intact when model preflight fails", async () => {
    const { input, runtime } = fixture();
    input.preflight.mockRejectedValue(new Error("model unavailable"));
    await expect(replayControlMessage(input)).rejects.toThrow(
      "model unavailable",
    );
    expect(runtime.rollbackThread).not.toHaveBeenCalled();
  });
  it("does not discard hidden resource context from a text-only projection", async () => {
    const { input, messages, runtime } = fixture();
    messages[1] = {
      ...messages[1]!,
      content:
        "改这条\n\n<crewon_selected_context>资料</crewon_selected_context>",
    };
    await expect(replayControlMessage(input)).rejects.toThrow(
      "message_replay_input",
    );
    expect(runtime.rollbackThread).not.toHaveBeenCalled();
  });
  it("does not start a turn if rollback fails", async () => {
    const { input, runtime } = fixture();
    runtime.rollbackThread.mockRejectedValue(new Error("conflict"));
    await expect(replayControlMessage(input)).rejects.toThrow("conflict");
    expect(runtime.startTurn).not.toHaveBeenCalled();
  });
  it("reports the committed history change without automatically retrying an uncertain send", async () => {
    const { input, runtime } = fixture();
    runtime.startTurn.mockRejectedValue(new TypeError("connection lost"));
    await expect(replayControlMessage(input)).rejects.toMatchObject({
      code: "send-failed",
      historyChanged: true,
    });
    expect(runtime.rollbackThread).toHaveBeenCalledOnce();
    expect(runtime.startTurn).toHaveBeenCalledOnce();
  });
});
