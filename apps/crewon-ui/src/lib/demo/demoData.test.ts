import { describe, expect, it } from "vitest";

import { createDemoTurn, createDraftDemoThread } from "./demoData";

describe("demo data factories", () => {
  it("creates draft demo threads from prompts", () => {
    const thread = createDraftDemoThread({
      locale: "en",
      initialPrompt:
        "Summarize the frontend architecture and propose the next clean extraction.",
      newDraftPreview: "New draft",
      newDraftThread: "Untitled",
      nowMs: 1_700_000_000_123,
    });

    expect(thread).toMatchObject({
      id: "demo-1700000000123",
      sessionId: "demo-session-1700000000123",
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_000,
      name: "Summarize the frontend architecture and propose the next clean extrac...",
      preview:
        "Summarize the frontend architecture and propose the next clean extrac...",
      turns: [],
      ephemeral: true,
      source: "appServer",
    });
  });

  it("uses localized fallback labels for empty draft demo threads", () => {
    expect(
      createDraftDemoThread({
        locale: "zh",
        newDraftPreview: "新草稿",
        newDraftThread: "未命名",
        nowMs: 1_700_000_000_000,
      }),
    ).toMatchObject({
      name: "未命名",
      preview: "新草稿",
    });
  });

  it("creates completed demo turns with user and agent messages", () => {
    expect(
      createDemoTurn({
        text: "Run the smoke test",
        responseText: "Smoke test completed.",
        nowMs: 1_700_000_001_000,
      }),
    ).toEqual({
      id: "demo-turn-1700000001000",
      itemsView: "full",
      status: "completed",
      error: null,
      startedAt: 1_700_000_001,
      completedAt: 1_700_000_001,
      durationMs: 0,
      items: [
        {
          type: "userMessage",
          id: "demo-user-1700000001000",
          clientId: null,
          content: [
            {
              type: "text",
              text: "Run the smoke test",
              text_elements: [],
            },
          ],
        },
        {
          type: "agentMessage",
          id: "demo-agent-1700000001000",
          text: "Smoke test completed.",
          phase: null,
          memoryCitation: null,
        },
      ],
    });
  });
});
