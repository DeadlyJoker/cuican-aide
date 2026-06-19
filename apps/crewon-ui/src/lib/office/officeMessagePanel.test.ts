import { describe, expect, it } from "vitest";

import type { OfficeWorkspace } from "../domain/crewonDomain";
import {
  appendOfficeUserOnlyMessage,
  buildOfficeUserMessage,
  officeMessageConnectedPanel,
  officeMessageFailurePanel,
  officeMessageFallbackError,
  officeMessageTurnPrompt,
  optimisticOfficeMessagePanel,
  officeWorkspaceWithMessageError,
  optimisticOfficeBackendStatus,
} from "./officeMessagePanel";

function workspace(overrides: Partial<OfficeWorkspace> = {}): OfficeWorkspace {
  return {
    goal: "Ship cleaner frontend",
    members: [
      {
        name: "Coordinator",
        role: "Office coordination",
        glyph: "@",
        accent: "blue",
        status: "online",
        online: true,
      },
    ],
    messages: [],
    tasks: [],
    backendStatus: "connected",
    ...overrides,
  };
}

describe("office message panel helpers", () => {
  it("builds backend office user messages", () => {
    expect(
      buildOfficeUserMessage({
        workspace: workspace(),
        rawText: "  Ship it  ",
        locale: "en",
      }),
    ).toEqual({
      author: "Coordinator",
      glyph: "@",
      accent: "slate",
      time: "now",
      text: "Ship it",
      kind: "message",
    });
    expect(
      buildOfficeUserMessage({
        workspace: workspace({ members: [] }),
        rawText: "你好",
        locale: "zh",
      })?.author,
    ).toBe("你");
    expect(
      buildOfficeUserMessage({
        workspace: workspace(),
        rawText: "   ",
        locale: "en",
      }),
    ).toBeNull();
  });

  it("appends only the user message for backend office sends", () => {
    const base = workspace();

    expect(
      appendOfficeUserOnlyMessage({
        workspace: base,
        rawText: "Update docs",
        locale: "en",
      }).messages,
    ).toEqual([
      {
        author: "Coordinator",
        glyph: "@",
        accent: "slate",
        time: "now",
        text: "Update docs",
        kind: "message",
      },
    ]);
    expect(
      appendOfficeUserOnlyMessage({
        workspace: base,
        rawText: "",
        locale: "en",
      }),
    ).toBe(base);
  });

  it("builds office message turn prompt and optimistic status", () => {
    expect(
      officeMessageTurnPrompt({
        officeTitle: "Frontend Office",
        text: "Ship it",
        threadId: "thread-1",
        locale: "en",
      }),
    ).toBe(
      [
        'Office "Frontend Office" group chat message: Ship it',
        "Backend record: submitted to office/message/send",
        "Execution thread: thread-1",
      ].join("\n"),
    );
    expect(
      optimisticOfficeBackendStatus(
        workspace({ threadId: "thread-1", backendStatus: "binding" }),
      ),
    ).toBe("connected");
    expect(optimisticOfficeBackendStatus(workspace({ backendStatus: "error" }))).toBe(
      "error",
    );
    expect(
      optimisticOfficeMessagePanel(
        {
          kind: "office",
          title: "Frontend Office",
          subtitle: "Refactor desk",
          items: [],
          workspace: workspace(),
        },
        {
          workspace: workspace({
            messages: [
              {
                author: "Coordinator",
                glyph: "@",
                accent: "slate",
                time: "now",
                text: "Hi",
                kind: "message",
              },
            ],
          }),
          backendStatus: "binding",
        },
      ),
    ).toMatchObject({
      workspace: {
        backendStatus: "binding",
        messages: [{ text: "Hi" }],
      },
    });
    expect(
      officeMessageConnectedPanel(
        {
          kind: "office",
          title: "Frontend Office",
          subtitle: "Refactor desk",
          items: [],
          workspace: workspace(),
        },
        { workspace: workspace(), threadId: "thread-1" },
      ),
    ).toMatchObject({
      workspace: {
        backendStatus: "connected",
        threadId: "thread-1",
      },
    });
  });

  it("builds office message error workspace", () => {
    expect(officeMessageFallbackError("zh")).toBe("办公室消息发送到后端失败");

    expect(
      officeWorkspaceWithMessageError({
        workspace: workspace(),
        error: "unknown",
        locale: "en",
      }),
    ).toMatchObject({
      backendStatus: "error",
      messages: [
        {
          author: "System",
          glyph: "⌗",
          accent: "rose",
          time: "now",
          kind: "system",
          text: "Unable to send office message to backend",
        },
      ],
    });
    expect(
      officeWorkspaceWithMessageError({
        workspace: workspace(),
        error: new Error("network failed"),
        locale: "en",
      }).messages[0]?.text,
    ).toBe("network failed");
    expect(
      officeMessageFailurePanel(
        {
          kind: "office",
          title: "Frontend Office",
          subtitle: "Refactor desk",
          items: [],
          workspace: workspace(),
        },
        null,
        "en",
      ),
    ).toMatchObject({
      workspace: {
        backendStatus: "error",
        messages: [{ text: "Unable to send office message to backend" }],
      },
    });
  });
});
