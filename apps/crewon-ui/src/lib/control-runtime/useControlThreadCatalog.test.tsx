// @vitest-environment happy-dom
import { act, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { ControlThreadRuntime } from "./controlThreadRuntime";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import { selectThreadAction } from "../thread/threadListActions";
import { ControlThreadCatalog } from "./controlThreadCatalog";
import { useControlThreadCatalog } from "./useControlThreadCatalog";
import { useThreadSelectionRead } from "../thread/useThreadSelectionRead";
import {
  catalogClientFixture,
  catalogThread,
} from "./controlThreadCatalog.test-support";
import { useAppThreadState } from "../app/useAppThreadState";
import {
  detailThread,
  transcriptLabels,
} from "../thread/threadDetailCache.test-support";
import { CommandSidebar } from "../../components/app/CommandWorkspaceChrome";
import { Transcript } from "../../components/Transcript";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
async function flush(ms = 15) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe("React catalog lifecycle", () => {
  it.each([false, true])(
    "shares startup/list cancellation and preserves real failures (preloaded=%s)",
    async (preloaded) => {
      const catalog = new ControlThreadCatalog(catalogClientFixture());
      if (preloaded) await catalog.load({ status: "active", search: "" });
      const pending: {
        id: string;
        signal: AbortSignal;
        resolve(thread: Thread): void;
      }[] = [];
      let offline = false;
      const runtime = {
        catalog,
        readThread: async (
          id: string,
          options: { signal?: AbortSignal } = {},
        ) => {
          if (offline) throw new Error("offline");
          return new Promise<Thread>((resolve) =>
            pending.push({ id, signal: options.signal!, resolve }),
          );
        },
      } as unknown as ControlThreadRuntime;
      let state!: ReturnType<typeof useAppThreadState>;
      const setNotice = vi.fn(),
        preserve = vi.fn();
      let selection: Promise<Thread | null> | undefined;
      const second = catalogThread(1299).threadId;
      function Probe() {
        state = useAppThreadState();
        state.selectedThreadIdRef.current = state.selectedThreadId;
        const runSelectionRead = useThreadSelectionRead({
          identity: runtime,
          selectedThreadId: state.selectedThreadId,
        });
        useControlThreadCatalog({
          runtime,
          runSelectionRead,
          connected: true,
          search: "",
          archived: false,
          preserveEmptySelection: false,
          selectedThreadId: state.selectedThreadId,
          setSelectedThreadId: state.setSelectedThreadId,
          setThreadCatalogPage: state.setThreadCatalogPage,
          setThreads: state.setThreads,
        });
        return (
          <button
            onClick={() => {
              selection = selectThreadAction({
                client: runtime,
                runSelectionRead,
                isConnected: true,
                locale: "en",
                threadId: second,
                setSelectedThreadId: state.setSelectedThreadId,
                setThreads: state.setThreads,
                setNotice,
                preserveThreadsAfterConnectionLoss: preserve,
                setAppView() {},
                setInspectorOpen() {},
                setSidebarOpen() {},
                shouldAutoCloseSidebar: () => false,
              });
            }}
          >
            Select next
          </button>
        );
      }
      const element = document.createElement("div");
      const root = createRoot(element);
      try {
        await act(async () =>
          root.render(
            <StrictMode>
              <Probe />
            </StrictMode>,
          ),
        );
        await vi.waitFor(async () => {
          await flush();
          expect(pending).toHaveLength(1);
        });
        expect(pending[0]!.signal.aborted).toBe(false);
        await act(async () => element.querySelector("button")!.click());
        expect(pending).toHaveLength(2);
        expect(pending[0]!.signal.aborted).toBe(true);
        expect(pending[1]!.signal.aborted).toBe(false);
        await act(async () => {
          pending[0]!.resolve(detailThread(pending[0]!.id));
          pending[1]!.resolve(detailThread(second));
          await selection;
        });
        expect(state.selectedThreadId).toBe(second);
        expect(
          state.threads.find((thread) => thread.id === second)?.turns.length,
        ).toBeGreaterThan(0);
        expect(
          state.threads.find((thread) => thread.id === pending[0]!.id)?.turns ??
            [],
        ).toHaveLength(0);
        expect(setNotice).not.toHaveBeenCalled();
        expect(preserve).not.toHaveBeenCalled();
        offline = true;
        await act(async () => {
          element.querySelector("button")!.click();
          await selection;
        });
        expect(setNotice).toHaveBeenLastCalledWith({
          text: "offline",
          tone: "warning",
        });
        expect(preserve).toHaveBeenCalledOnce();
      } finally {
        await act(async () => root.unmount());
        pending.forEach((request) => request.resolve(detailThread(request.id)));
        catalog.close();
      }
    },
  );

  it("keeps the selected transcript and streaming output across paging and a sparse search in StrictMode", async () => {
    const client = catalogClientFixture();
    const catalog = new ControlThreadCatalog(client);
    const readThread = vi.fn(async (id: string) => {
      const thread = detailThread(id);
      thread.status = { type: "active", activeFlags: [] };
      thread.turns[0]!.status = "inProgress";
      return thread;
    });
    const runtime = { catalog, readThread } as unknown as ControlThreadRuntime;
    let state!: ReturnType<typeof useAppThreadState>;
    let catalogNavigation!: ReturnType<typeof useControlThreadCatalog>;
    function Probe() {
      state = useAppThreadState();
      state.selectedThreadIdRef.current = state.selectedThreadId;
      const [query, setQuery] = useState("");
      const runSelectionRead = useThreadSelectionRead({
        identity: runtime,
        selectedThreadId: state.selectedThreadId,
      });
      const navigation = useControlThreadCatalog({
        runSelectionRead,
        runtime,
        connected: true,
        search: query,
        archived: false,
        preserveEmptySelection: false,
        selectedThreadId: state.selectedThreadId,
        setSelectedThreadId: state.setSelectedThreadId,
        setThreadCatalogPage: state.setThreadCatalogPage,
        setThreads: state.setThreads,
      });
      catalogNavigation = navigation;
      const thread =
        state.threads.find((thread) => thread.id === state.selectedThreadId) ??
        null;
      return (
        <>
          <output data-visible="">{state.threadCatalogIds?.join(",")}</output>
          <CommandSidebar
            activeView="command"
            cwd="/repo"
            isSearchOpen
            linkedThreads={state.threads
              .filter((item) => state.threadCatalogIds?.includes(item.id))
              .map((item) => ({
                cwd: item.cwd,
                id: item.id,
                title: item.name ?? "",
                preview: item.preview,
                updatedLabel: "now",
              }))}
            locale="en"
            query={query}
            selectedLinkedThreadId={state.selectedThreadId}
            slots={{
              agent: {
                label: "Agent",
                title: "Agent",
                detail: "",
                value: "agent",
              },
              knowledge: {
                label: "Knowledge",
                title: "Knowledge",
                detail: "",
                value: "knowledge",
              },
              workflow: {
                label: "Workflow",
                title: "Workflow",
                detail: "",
                value: "workflow",
              },
              mcps: [
                { label: "MCP", title: "MCP", detail: "", value: "mcp" },
                { label: "MCP", title: "MCP", detail: "", value: "mcp2" },
              ],
              skills: [
                { label: "Skill", title: "Skill", detail: "", value: "skill" },
                { label: "Skill", title: "Skill", detail: "", value: "skill2" },
              ],
              model: "test",
            }}
            threadCatalogNavigation={navigation}
            workspaceAuthority="control"
            onCloseSearch={() => {}}
            onNewThread={() => {}}
            onOpenLinkedThread={state.setSelectedThreadId}
            onQueryChange={setQuery}
            onSwitchView={() => {}}
            onToggleCollapse={() => {}}
            onToggleSearch={() => {}}
          />
          <Transcript
            {...transcriptLabels}
            thread={thread}
            locale="en"
            mode="code"
            onModeChange={() => {}}
            onStop={() => {}}
            streamingText={
              state.streamingTextByThread[state.selectedThreadId ?? ""] ?? ""
            }
          />
        </>
      );
    }
    const element = document.createElement("div");
    document.body.append(element);
    const root = createRoot(element);
    try {
      act(() =>
        root.render(
          <StrictMode>
            <Probe />
          </StrictMode>,
        ),
      );
      await flush();
      const selected = catalogThread(1300).threadId;
      expect(state.selectedThreadId).toBe(selected);
      expect(readThread).toHaveBeenCalledTimes(1);
      expect(
        [...element.querySelectorAll("button")].some((button) =>
          ["Older", "Newer", "Latest"].includes(button.textContent ?? ""),
        ),
      ).toBe(false);
      expect(catalogNavigation).toBeDefined();
      act(() => catalogNavigation!.onOlder());
      await flush();
      expect(state.threadCatalogIds).not.toContain(selected);
      expect(state.selectedThreadId).toBe(selected);
      expect(element.textContent).toContain(`Answer ${selected}`);
      act(() =>
        state.appendStreamingTextDelta(selected, "stream survives paging"),
      );
      await act(async () => {
        await state.waitForStreamingTextDrain(selected);
      });
      expect(element.textContent).toContain("stream survives paging");
      const searchInput = element.querySelector<HTMLInputElement>(
        "[data-sidebar-search-input]",
      )!;
      act(() => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!.call(searchInput, "needle");
        searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await flush(210);
      expect(client.getThreadCatalog).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: "needle" }),
        expect.anything(),
      );
      expect(state.threadCatalogIds).toEqual([]);
      expect(state.selectedThreadId).toBe(selected);
      const continuation = [...element.querySelectorAll("button")].find(
        (button) => button.textContent === "Continue search",
      );
      expect(continuation).toBeUndefined();
      expect(catalogNavigation?.hasOlder).toBe(true);
      expect(
        element.querySelector<HTMLElement>("[data-search-empty]")?.hidden,
      ).toBe(true);
      expect(state.threads.some((thread) => thread.id === selected)).toBe(true);
      expect(state.threads.length).toBeLessThanOrEqual(4);
    } finally {
      act(() => root.unmount());
      catalog.close();
      element.remove();
    }
  });
});
