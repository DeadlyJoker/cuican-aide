import { describe, expect, it } from "vitest";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  activeTurnByThreadAfterTurn,
  activeTurnByThreadAfterTurnId,
  appendFileChangesToPanel,
  appendTerminalChunkToPanel,
  appendThreadText,
  clearPendingRequestById,
  clearThreadText,
  removeRecordKey,
  resolveServerRequestPanel,
} from "./appNotificationState";

describe("app notification state helpers", () => {
  it("appends terminal chunks only to command panels", () => {
    const panel: CapabilityPanel = {
      title: "Terminal",
      body: "Running...",
      commandInput: true,
    };

    expect(appendTerminalChunkToPanel(panel, "done", "en")).toEqual({
      title: "Terminal",
      body: "done",
      commandInput: true,
    });
    expect(
      appendTerminalChunkToPanel({ title: "Files" }, "done", "en"),
    ).toEqual({ title: "Files" });
  });

  it("appends file changes only to the files panel", () => {
    expect(
      appendFileChangesToPanel(
        { title: "Files", body: "Existing", error: "stale" },
        ["a.ts", "b.ts"],
        "en",
      ),
    ).toEqual({
      title: "Files",
      body: "Existing\n\nFile changes detected:\na.ts\nb.ts",
      error: undefined,
    });
    expect(
      appendFileChangesToPanel({ title: "Terminal" }, ["a.ts"], "en"),
    ).toEqual({ title: "Terminal" });
  });

  it("marks matching server request panels as resolved", () => {
    expect(
      resolveServerRequestPanel(
        {
          title: "Command approval",
          subtitle: "42",
          body: "waiting",
          actions: [{ id: "approve", label: "Approve" }],
          fields: [{ id: "reason", label: "Reason", value: "" }],
        },
        42,
        "en",
      ),
    ).toEqual({
      title: "Command approval",
      subtitle: "42",
      body: "Request resolved",
      actions: undefined,
      fields: undefined,
    });
  });

  it("updates thread text maps immutably", () => {
    expect(appendThreadText({ thread1: "a" }, "thread1", "b")).toEqual({
      thread1: "ab",
    });
    expect(clearThreadText({ thread1: "abc" }, "thread1")).toEqual({
      thread1: "",
    });
    expect(removeRecordKey({ thread1: "a", thread2: "b" }, "thread1")).toEqual(
      { thread2: "b" },
    );
  });

  it("tracks active turns only while they are in progress", () => {
    expect(
      activeTurnByThreadAfterTurnId({ thread2: "turn2" }, "thread1", "turn1"),
    ).toEqual({
      thread1: "turn1",
      thread2: "turn2",
    });

    expect(
      activeTurnByThreadAfterTurn({ thread2: "turn2" }, "thread1", {
        id: "turn1",
        status: "inProgress",
      }),
    ).toEqual({
      thread1: "turn1",
      thread2: "turn2",
    });

    const current = { thread2: "turn2" };
    expect(
      activeTurnByThreadAfterTurn(current, "thread1", {
        id: "turn1",
        status: "completed",
      }),
    ).toBe(current);
  });

  it("clears pending requests by string-equivalent id", () => {
    expect(clearPendingRequestById({ id: 7, method: "request" }, "7")).toBeNull();
    expect(clearPendingRequestById({ id: 8, method: "request" }, "7")).toEqual({
      id: 8,
      method: "request",
    });
  });
});
