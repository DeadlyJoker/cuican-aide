import { describe, expect, it } from "vitest";

import {
  contextNoteBody,
  contextNoteCreatedNotice,
  contextNoteFailureMessage,
  contextNoteFailurePanel,
  contextNoteFailurePatch,
  contextNotePanel,
  contextNoteProgressBody,
  contextNoteProgressPanel,
  contextNoteProgressPatch,
  contextThreadTitle,
  fileCopyBodyPrefix,
  fileCopyDestinationPath,
  fileCopyFailureMessage,
  fileCopyFailurePanel,
  fileCopyFailurePatch,
  fileCopyNotice,
  fileCopyProgressBody,
  fileCopyProgressPanel,
  fileCopyProgressPatch,
  fileSearchProgressBody,
  fileSearchProgressPanel,
  fileSearchProgressPatch,
  fileWatchDemoBody,
  fileWatchDemoPanel,
  fileWatchDemoPatch,
  fileWatchFailureMessage,
  fileWatchFailurePanel,
  fileWatchFailurePatch,
  fileWatchNoActiveBody,
  fileWatchNoActivePanel,
  fileWatchNoActivePatch,
  fileWatchProgressBody,
  fileWatchProgressPanel,
  fileWatchProgressPatch,
  fileWatchStartedBody,
  fileWatchStartedPanel,
  fileWatchStartedPatch,
  fileWatchStoppedBody,
  fileWatchStoppedPanel,
  fileWatchStoppedPatch,
  sendContextFailureMessage,
  sendContextFailurePanel,
  sendContextFailurePatch,
  sendContextNotice,
  sendContextProgressBody,
  sendContextProgressPanel,
  sendContextProgressPatch,
  sendContextSuccessBody,
  sendContextSuccessPanel,
  sendContextSuccessPatch,
} from "./fileActionPresentation";

describe("file action presentation helpers", () => {
  it("builds file copy and search status text", () => {
    expect(fileCopyDestinationPath("/repo/README.md")).toBe(
      "/repo/README.md.copy",
    );
    expect(fileCopyDestinationPath("/repo/src/")).toBe("/repo/src.copy");
    expect(fileCopyProgressBody("en")).toBe("Copying...");
    expect(fileCopyBodyPrefix("/repo/src.copy", "zh")).toBe(
      "已复制到：/repo/src.copy",
    );
    expect(fileCopyNotice("/repo/src.copy", "en")).toEqual({
      text: "Copied: /repo/src.copy",
      tone: "success",
    });
    expect(fileCopyFailureMessage(null, "zh")).toBe("复制失败");
    expect(fileCopyFailureMessage(new Error("denied"), "en")).toBe("denied");
    expect(fileSearchProgressBody("zh")).toBe("正在搜索...");
  });

  it("builds file copy and search panel patches", () => {
    expect(fileCopyProgressPatch("en")).toEqual({
      body: "Copying...",
      error: undefined,
    });
    expect(fileCopyFailurePatch(null, "zh")).toEqual({
      error: "复制失败",
    });
    expect(fileSearchProgressPatch("zh")).toEqual({
      body: "正在搜索...",
      error: undefined,
    });
  });

  it("applies file copy and search panel patches", () => {
    const panel = { title: "Files", body: "Ready", error: "old" };

    expect(fileCopyProgressPanel(panel, "en")).toEqual({
      title: "Files",
      body: "Copying...",
      error: undefined,
    });
    expect(fileCopyFailurePanel(panel, null, "zh")).toEqual({
      title: "Files",
      body: "Ready",
      error: "复制失败",
    });
    expect(fileSearchProgressPanel(panel, "zh")).toEqual({
      title: "Files",
      body: "正在搜索...",
      error: undefined,
    });
    expect(fileSearchProgressPanel(null, "en")).toBeNull();
  });

  it("builds context note panels and status text", () => {
    const noteBody = contextNoteBody({
      createdAtIso: "2026-06-17T10:00:00.000Z",
      locale: "en",
      root: "/repo",
    });

    expect(noteBody).toContain("# Context note");
    expect(noteBody).toContain("- Workspace: /repo");
    expect(contextNoteProgressBody("zh")).toBe("正在创建上下文笔记...");
    expect(
      contextNotePanel({
        locale: "en",
        metadataText: "Type: file",
        noteBody,
        notePath: "/repo/.crewon/context-notes/note.md",
        root: "/repo",
      }),
    ).toMatchObject({
      title: "Context note",
      subtitle: "/repo/.crewon/context-notes/note.md",
      body: expect.stringContaining("Type: file"),
      actions: expect.arrayContaining([
        { id: "create-context-note", label: "New context note" },
      ]),
    });
    expect(contextNoteCreatedNotice("/repo/note.md", "zh")).toEqual({
      text: "已创建上下文笔记：/repo/note.md",
      tone: "success",
    });
    expect(contextNoteFailureMessage(null, "en")).toBe(
      "Unable to create context note",
    );
    expect(contextNoteFailureMessage(new Error("denied"), "zh")).toBe("denied");
  });

  it("builds context note panel patches", () => {
    expect(contextNoteProgressPatch("en")).toEqual({
      body: "Creating context note...",
      error: undefined,
    });
    expect(contextNoteFailurePatch(null, "zh")).toEqual({
      error: "创建上下文笔记失败",
    });
  });

  it("applies context note panel patches", () => {
    const panel = { title: "Context note", body: "Ready", error: "old" };

    expect(contextNoteProgressPanel(panel, "en")).toEqual({
      title: "Context note",
      body: "Creating context note...",
      error: undefined,
    });
    expect(contextNoteFailurePanel(panel, null, "zh")).toEqual({
      title: "Context note",
      body: "Ready",
      error: "创建上下文笔记失败",
    });
    expect(contextNoteProgressPanel(null, "en")).toBeNull();
  });

  it("builds send context status text", () => {
    expect(sendContextProgressBody("en")).toBe(
      "Sending context to backend thread...",
    );
    expect(contextThreadTitle("/repo/README.md", "zh")).toBe(
      "读取工作区上下文：/repo/README.md",
    );
    expect(sendContextSuccessBody("Thread title", "en")).toBe(
      "Sent to backend thread: Thread title",
    );
    expect(sendContextNotice("zh")).toEqual({
      text: "上下文文件已发送到后端会话",
      tone: "success",
    });
    expect(sendContextFailureMessage(null, "zh")).toBe("发送上下文失败");
    expect(sendContextFailureMessage(new Error("denied"), "en")).toBe("denied");
  });

  it("builds send context panel patches", () => {
    expect(sendContextProgressPatch("en")).toEqual({
      body: "Sending context to backend thread...",
      error: undefined,
    });
    expect(sendContextSuccessPatch("Thread title", "zh")).toEqual({
      body: "已发送到后端会话：Thread title",
      error: undefined,
    });
    expect(sendContextFailurePatch(null, "en")).toEqual({
      error: "Unable to send context",
    });
  });

  it("applies send context panel patches", () => {
    const panel = { title: "Context file", body: "Ready", error: "old" };

    expect(sendContextProgressPanel(panel, "en")).toEqual({
      title: "Context file",
      body: "Sending context to backend thread...",
      error: undefined,
    });
    expect(sendContextSuccessPanel(panel, "Thread title", "zh")).toEqual({
      title: "Context file",
      body: "已发送到后端会话：Thread title",
      error: undefined,
    });
    expect(sendContextFailurePanel(panel, null, "en")).toEqual({
      title: "Context file",
      body: "Ready",
      error: "Unable to send context",
    });
    expect(sendContextProgressPanel(null, "en")).toBeNull();
  });

  it("builds file watch status text", () => {
    expect(fileWatchDemoBody("en")).toBe(
      "File watch updated (demo). With app-server connected this calls fs/watch or fs/unwatch.",
    );
    expect(fileWatchProgressBody("watch", "zh")).toBe("正在启动文件监听...");
    expect(fileWatchProgressBody("unwatch", "en")).toBe(
      "Stopping file watch...",
    );
    expect(fileWatchNoActiveBody("zh")).toBe("当前没有运行中的文件监听。");
    expect(fileWatchStoppedBody("/repo", "en")).toBe("Stopped watching: /repo");
    expect(fileWatchStartedBody("/repo", "zh")).toBe("正在监听：/repo");
    expect(fileWatchFailureMessage(null, "en")).toBe(
      "File watch action failed",
    );
    expect(fileWatchFailureMessage(new Error("denied"), "zh")).toBe("denied");
  });

  it("builds file watch panel patches", () => {
    expect(fileWatchDemoPatch("en")).toEqual({
      body: "File watch updated (demo). With app-server connected this calls fs/watch or fs/unwatch.",
      error: undefined,
    });
    expect(fileWatchProgressPatch("watch", "zh")).toEqual({
      body: "正在启动文件监听...",
      error: undefined,
    });
    expect(fileWatchNoActivePatch("zh")).toEqual({
      body: "当前没有运行中的文件监听。",
      error: undefined,
    });
    expect(fileWatchStoppedPatch("/repo", "en")).toEqual({
      body: "Stopped watching: /repo",
      error: undefined,
    });
    expect(fileWatchStartedPatch("/repo", "zh")).toEqual({
      body: "正在监听：/repo",
      error: undefined,
    });
    expect(fileWatchFailurePatch(null, "en")).toEqual({
      error: "File watch action failed",
    });
  });

  it("applies file watch panel patches", () => {
    const panel = { title: "Files", body: "Ready", error: "old" };

    expect(fileWatchDemoPanel(panel, "en")).toEqual({
      title: "Files",
      body: "File watch updated (demo). With app-server connected this calls fs/watch or fs/unwatch.",
      error: undefined,
    });
    expect(fileWatchProgressPanel(panel, "watch", "zh")).toEqual({
      title: "Files",
      body: "正在启动文件监听...",
      error: undefined,
    });
    expect(fileWatchNoActivePanel(panel, "zh")).toEqual({
      title: "Files",
      body: "当前没有运行中的文件监听。",
      error: undefined,
    });
    expect(fileWatchStoppedPanel(panel, "/repo", "en")).toEqual({
      title: "Files",
      body: "Stopped watching: /repo",
      error: undefined,
    });
    expect(fileWatchStartedPanel(panel, "/repo", "zh")).toEqual({
      title: "Files",
      body: "正在监听：/repo",
      error: undefined,
    });
    expect(fileWatchFailurePanel(panel, null, "en")).toEqual({
      title: "Files",
      body: "Ready",
      error: "File watch action failed",
    });
    expect(fileWatchDemoPanel(null, "en")).toBeNull();
  });
});
