import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import { describe, expect, it } from "vitest";

import { appDocumentTitle } from "./appDocumentActions";

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    sessionId: "session-1",
    forkedFromId: null,
    parentThreadId: null,
    preview: "Preview title",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "idle" },
    path: null,
    cwd: "/repo",
    clientVersion: "test",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: "Named thread",
    turns: [],
    ...overrides,
  };
}

describe("app document actions", () => {
  it("uses the product name when no thread is selected", () => {
    expect(
      appDocumentTitle({
        composerValue: "",
        thread: null,
        untitledThreadLabel: "Untitled",
      }),
    ).toBe("Crewon");
  });

  it("uses the selected thread title", () => {
    expect(
      appDocumentTitle({
        composerValue: "",
        thread: thread(),
        untitledThreadLabel: "Untitled",
      }),
    ).toBe("Named thread - Crewon");
  });

  it("falls back for untitled threads and marks dirty composer drafts", () => {
    expect(
      appDocumentTitle({
        composerValue: " draft ",
        thread: thread({ name: null, preview: "" }),
        untitledThreadLabel: "Untitled",
      }),
    ).toBe("* Untitled - Crewon");
  });
});
