import { describe, expect, it } from "vitest";

import {
  threadHistoryDemoRefreshBody,
  threadHistoryDemoRefreshPanel,
  threadHistoryRefreshFailureMessage,
  threadHistoryRefreshFailurePanel,
  threadHistoryRefreshInProgressBody,
  threadHistoryRefreshInProgressPanel,
  threadHistoryRefreshSuccessBody,
  threadHistoryRefreshSuccessPanel,
} from "./threadHistoryItems";

describe("thread history item helpers", () => {
  it("builds refresh status text", () => {
    const panel = {
      title: "History",
      body: "Existing",
      error: "old error",
      actions: [{ id: "refresh-thread-history", label: "Refresh" }],
    };

    expect(threadHistoryDemoRefreshBody("en")).toBe(
      "Session history refreshed (demo). With app-server connected this calls thread/turns/list.",
    );
    expect(threadHistoryRefreshInProgressBody("zh")).toBe(
      "正在读取分页会话历史...",
    );
    expect(threadHistoryRefreshSuccessBody(3, "en")).toBe(
      "Refreshed 3 turns through thread/turns/list.",
    );
    expect(threadHistoryRefreshFailureMessage(null, "zh")).toBe(
      "刷新会话历史失败",
    );
    expect(threadHistoryRefreshFailureMessage(new Error("denied"), "en")).toBe(
      "denied",
    );
    expect(threadHistoryDemoRefreshPanel(panel, "en")).toEqual({
      ...panel,
      body: "Session history refreshed (demo). With app-server connected this calls thread/turns/list.",
      error: undefined,
    });
    expect(threadHistoryRefreshInProgressPanel(panel, "zh")).toEqual({
      ...panel,
      body: "正在读取分页会话历史...",
      error: undefined,
    });
    expect(threadHistoryRefreshSuccessPanel(panel, 3, "en")).toEqual({
      ...panel,
      body: "Refreshed 3 turns through thread/turns/list.",
      error: undefined,
    });
    expect(threadHistoryRefreshFailurePanel(panel, null, "zh")).toEqual({
      ...panel,
      error: "刷新会话历史失败",
    });
    expect(threadHistoryDemoRefreshPanel(null, "en")).toBeNull();
  });
});
