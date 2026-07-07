import { describe, expect, it } from "vitest";

import type { LibraryPanel } from "../domain/crewonDomain";
import {
  knowledgeDisconnectedPanel,
  knowledgeDisconnectedPatch,
  knowledgeResetConfirmMessage,
  knowledgeResetDemoPanel,
  knowledgeResetDemoPatch,
  knowledgeResetFailurePanel,
  knowledgeResetFailurePatch,
  knowledgeResetProgressPanel,
  knowledgeResetProgressPatch,
  knowledgeResetSuccessNotice,
  knowledgeWriteFailurePanel,
  knowledgeWriteFailurePatch,
  knowledgeWriteMissingWorkspacePanel,
  knowledgeWriteMissingWorkspacePatch,
  knowledgeWriteProgressPanel,
  knowledgeWriteProgressPatch,
  knowledgeWriteSuccessNotice,
} from "./knowledgeMemoryPanel";

function panel(): LibraryPanel {
  return {
    kind: "knowledge",
    title: "Knowledge",
    subtitle: "Memory",
    body: "Current body",
    items: [{ title: "Memory", meta: "workspace" }],
  };
}

describe("knowledge memory panel helpers", () => {
  it("builds reset memory feedback", () => {
    expect(knowledgeResetDemoPatch("en")).toEqual({
      body: "Global memory reset (demo). With app-server connected this calls memory/reset and does not clear workspace knowledge files.",
      error: undefined,
    });
    expect(knowledgeDisconnectedPatch("zh")).toEqual({
      error: "未连接本地 app-server",
    });
    expect(knowledgeResetConfirmMessage("en")).toBe(
      "Resetting memory clears reusable model memory state. Continue?",
    );
    expect(knowledgeResetProgressPatch("zh")).toEqual({
      body: "正在重置全局记忆...",
      error: undefined,
    });
    expect(knowledgeResetSuccessNotice("en")).toEqual({
      text: "Global memory reset",
      tone: "success",
    });
    expect(knowledgeResetFailurePatch(null, "zh")).toEqual({
      error: "重置全局记忆失败",
    });
    expect(knowledgeResetFailurePatch(new Error("denied"), "en")).toEqual({
      error: "denied",
    });
  });

  it("applies reset memory panel updates", () => {
    expect(knowledgeResetDemoPanel(panel(), "en")).toEqual({
      ...panel(),
      body: "Global memory reset (demo). With app-server connected this calls memory/reset and does not clear workspace knowledge files.",
      error: undefined,
    });
    expect(knowledgeDisconnectedPanel(panel(), "zh")).toEqual({
      ...panel(),
      error: "未连接本地 app-server",
    });
    expect(knowledgeResetProgressPanel(panel(), "zh")).toEqual({
      ...panel(),
      body: "正在重置全局记忆...",
      error: undefined,
    });
    expect(knowledgeResetFailurePanel(panel(), null, "en")).toEqual({
      ...panel(),
      error: "Unable to reset global memory",
    });
    expect(knowledgeResetDemoPanel(null, "en")).toBeNull();
  });

  it("builds workspace knowledge write feedback", () => {
    expect(knowledgeWriteProgressPatch("en")).toEqual({
      body: "Writing workspace knowledge memory...",
      error: undefined,
    });
    expect(knowledgeWriteMissingWorkspacePatch("zh")).toEqual({
      error: "当前没有工作区路径，无法写入知识库。",
    });
    expect(knowledgeWriteSuccessNotice("/repo/.crewon/memory.md", "zh")).toEqual(
      {
        text: "已写入知识库：/repo/.crewon/memory.md",
        tone: "success",
      },
    );
    expect(knowledgeWriteFailurePatch(null, "en")).toEqual({
      error: "Unable to write knowledge",
    });
    expect(knowledgeWriteFailurePatch(new Error("disk full"), "zh")).toEqual({
      error: "disk full",
    });
  });

  it("applies workspace knowledge write panel updates", () => {
    expect(knowledgeWriteProgressPanel(panel(), "en")).toEqual({
      ...panel(),
      body: "Writing workspace knowledge memory...",
      error: undefined,
    });
    expect(knowledgeWriteMissingWorkspacePanel(panel(), "zh")).toEqual({
      ...panel(),
      error: "当前没有工作区路径，无法写入知识库。",
    });
    expect(knowledgeWriteFailurePanel(panel(), null, "zh")).toEqual({
      ...panel(),
      error: "写入知识库失败",
    });
    expect(knowledgeWriteFailurePanel(null, new Error("disk full"), "en")).toBeNull();
  });
});
