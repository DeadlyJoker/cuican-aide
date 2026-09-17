import { describe, expect, it, vi } from "vitest";
import {
  archiveThreadAction,
  toggleArchivedThreadsAction,
} from "./threadListActions";
import { detailThread } from "./threadDetailCache.test-support";

describe("catalog-aware lifecycle actions", () => {
  it("refreshes after archive without replacing off-page details or moving an unrelated selection", async () => {
    let selected: string | null = "off-page";
    const setThreads = vi.fn();
    const client = {
      managesThreadList: true,
      archiveThread: vi.fn(async () => {}),
      unarchiveThread: vi.fn(async () => {}),
      listThreads: vi.fn(async () => [detailThread("page")]),
    };
    const perform = (id: string) =>
      archiveThreadAction({
        client,
        isConnected: true,
        locale: "en",
        setNotice: vi.fn(),
        setSelectedThreadId: (next) => {
          selected = typeof next === "function" ? next(selected) : next;
        },
        setThreads,
        showArchivedThreads: false,
        thread: detailThread(id),
      });
    await perform("page");
    expect(selected).toBe("off-page");
    expect(setThreads).not.toHaveBeenCalled();
    expect(client.listThreads).toHaveBeenCalledWith(false);
    await perform("off-page");
    expect(selected).toBeNull();
    expect(setThreads).not.toHaveBeenCalled();
  });
  it("archive filter changes let the catalog owner load the page once and retain active detail state", async () => {
    const client = {
      managesThreadList: true,
      listThreads: vi.fn(async () => []),
    };
    const setThreads = vi.fn();
    const setShowArchivedThreads = vi.fn();
    const setThreadSearchTerm = vi.fn();
    const result = await toggleArchivedThreadsAction({
      client,
      isConnected: true,
      locale: "en",
      setNotice: vi.fn(),
      setSelectedThreadId: vi.fn(),
      setThreads,
      setShowArchivedThreads,
      setThreadSearchTerm,
      showArchivedThreads: false,
    });
    expect(result).toBe(true);
    expect(setShowArchivedThreads).toHaveBeenCalledWith(true);
    expect(setThreadSearchTerm).toHaveBeenCalledWith("");
    expect(setThreads).not.toHaveBeenCalled();
    expect(client.listThreads).not.toHaveBeenCalled();
  });
});
