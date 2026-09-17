import { describe, expect, it } from "vitest";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import type { Turn } from "@crewon/app-server-protocol/v2/Turn";
import { workflowFixture } from "./taskWorkbenchFixture";
import {
  projectThreadWorkbench,
  projectWorkflowWorkbench,
  workbenchWebUrl,
} from "./taskWorkbenchProjection";

function thread(
  items: ThreadItem[],
  status: Turn["status"] = "completed",
): Thread {
  return { id: "task-a", turns: [{ id: "run-a", status, items }] } as Thread;
}
const message = {
  type: "agentMessage",
  id: "answer",
  phase: "final_answer",
  memoryCitation: null,
  text: "## 通知\n入会链接待补充。",
} as const;

describe("task workbench projection", () => {
  it("keeps explicit plans without duplicating replies, progress notes or private reasoning", () => {
    const snapshot = projectThreadWorkbench(
      thread([
        message,
        { type: "plan", id: "plan", text: "核对时间" },
        {
          type: "reasoning",
          id: "private",
          summary: ["private reasoning"],
          content: [],
        },
        {
          ...message,
          id: "draft",
          phase: "commentary",
          text: "阶段材料\n[[CrewON delegate:member-1]]",
        },
      ]),
      "通知",
    );
    expect(snapshot.documents.map((doc) => [doc.kind, doc.text])).toEqual([
      ["plan", "核对时间"],
    ]);
    expect(snapshot.scopeId).toBe("thread:task-a");
    expect(snapshot.documents[0]?.originId).toBe("run-a");
    expect(JSON.stringify(snapshot)).not.toContain("private reasoning");
  });
  it.each(["inProgress", "failed", "interrupted"] as const)(
    "does not promote %s prose to a workbench document",
    (status) => {
      expect(
        projectThreadWorkbench(thread([message], status), "任务").documents,
      ).toEqual([]);
    },
  );
  it("bounds output count and preview size", () => {
    const result = projectThreadWorkbench(
      thread(
        Array.from({ length: 40 }, (_, i) => ({
          type: "plan" as const,
          id: String(i),
          text: "x".repeat(40_001),
        })),
      ),
      "任务",
    );
    expect(result.documents).toHaveLength(24);
    expect(result.documents[0]).toMatchObject({
      id: "run-a:16",
      truncated: true,
    });
    expect(result.documents.every((doc) => doc.text.length === 40_000)).toBe(
      true,
    );
  });
  it("records browser tools faithfully without exposing typed values or inventing success", () => {
    const result = projectThreadWorkbench(
      thread([
        {
          type: "dynamicToolCall",
          id: "b1",
          durationMs: 20,
          namespace: "browser",
          tool: "navigate",
          arguments: {
            url: "https://example.com/",
            text: "secret input",
            cookie: "secret cookie",
          },
          status: "completed",
          success: false,
          contentItems: [],
        },
        {
          type: "webSearch",
          id: "search",
          query: "资料示例",
          action: { type: "openPage", url: "https://example.com/help" },
        },
        {
          type: "dynamicToolCall",
          id: "b2",
          durationMs: 20,
          namespace: "browser",
          tool: "snapshot",
          arguments: {},
          status: "completed",
          success: true,
          contentItems: [
            {
              type: "inputText",
              text: JSON.stringify({
                pageUrl: "https://example.com/current",
                value: "secret result",
              }),
            },
          ],
        },
        {
          type: "dynamicToolCall",
          id: "unrelated",
          durationMs: 20,
          namespace: "workspace",
          tool: "read",
          arguments: { url: "https://example.com/not-browser" },
          status: "completed",
          success: true,
          contentItems: [],
        },
      ]),
      "浏览任务",
    );
    expect(result.browser.map((item) => [item.status, item.urls])).toEqual([
      ["failed", ["https://example.com/"]],
      ["recorded", ["https://example.com/help"]],
      ["completed", ["https://example.com/current"]],
    ]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("separates stage drafts and verification, and never treats human approval as a document", () => {
    const result = projectWorkflowWorkbench(workflowFixture, "通知协作");
    expect(result.documents.map((doc) => [doc.id, doc.kind])).toEqual([
      ["draft", "draft"],
      ["verdict", "verdict"],
    ]);
    expect(result.scopeId).not.toBe(
      projectWorkflowWorkbench(
        { ...workflowFixture, executionId: "meeting-b" },
        "通知协作",
      ).scopeId,
    );
    expect(
      projectWorkflowWorkbench(
        {
          ...workflowFixture,
          executedNodes: [
            { ...workflowFixture.executedNodes[0]!, status: "failed" },
          ],
        },
        "通知",
      ).documents[0]?.kind,
    ).toBe("partial");
  });
  it.each([
    "javascript:alert(1)",
    "file:///tmp/data",
    "data:text/html,test",
    "https://user:secret@example.com/",
    "example.com",
    "https://example.com/\nsecret",
    "https://example.com/" + "a".repeat(4096),
  ])("rejects unsafe or implicit URL %s", (url) =>
    expect(workbenchWebUrl(url)).toBeNull(),
  );
  it("permits explicit HTTP previews, including local development pages", () => {
    expect(workbenchWebUrl("http://127.0.0.1:5185/help")).toBe(
      "http://127.0.0.1:5185/help",
    );
    expect(workbenchWebUrl("https://example.com")).toBe("https://example.com/");
  });
});
