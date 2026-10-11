// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlThreadRuntime } from "../control-runtime/controlThreadRuntime";
import { ControlThreadCatalog } from "../control-runtime/controlThreadCatalog";
import { catalogThread } from "../control-runtime/controlThreadCatalog.test-support";
import { useControlThreadCatalog } from "../control-runtime/useControlThreadCatalog";
import { useThreadSelectionRead } from "../thread/useThreadSelectionRead";
import {
  detailThread,
  transcriptLabels,
} from "../thread/threadDetailCache.test-support";
import { Transcript } from "../../components/Transcript";
import { useAppThreadState } from "./useAppThreadState";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const a = "01a12aee-b4f3-740c-ad86-c5d9de442782";
const b = "01a12aee-b64b-76ce-bba3-ed4218bbee70";
const url = (id: string) =>
  `/?sceneThread=${id}&scene=office&executionTargetThread=${id}&executionTarget=crewon`;
const roots: Root[] = [];
const catalogs: ControlThreadCatalog[] = [];

function tab() {
  // The first page deliberately contains A only: the routed B must be read by
  // the original authenticated selection path even when outside this page.
  const catalog = new ControlThreadCatalog({
    getThreadCatalog: vi.fn(async () => ({
      schemaVersion: "crewon.thread-catalog.v0" as const,
      scannedCount: 1,
      data: [{ ...catalogThread(0), threadId: a }],
      olderCursor: null,
      newerCursor: null,
    })),
  });
  catalogs.push(catalog);
  const readThread = vi.fn(async (id: string) =>
    detailThread(id, id === a ? "Only tab A content" : "Only tab B content"),
  );
  const runtime = { catalog, readThread } as unknown as ControlThreadRuntime;
  let state!: ReturnType<typeof useAppThreadState>;
  function Probe({ connected }: { connected: boolean }) {
    state = useAppThreadState();
    const runSelectionRead = useThreadSelectionRead({
      identity: connected ? runtime : null,
      selectedThreadId: connected ? state.selectedThreadId : null,
    });
    useControlThreadCatalog({
      runtime: connected ? runtime : null,
      runSelectionRead,
      connected,
      search: "",
      archived: false,
      preserveEmptySelection: false,
      selectedThreadId: state.selectedThreadId,
      setSelectedThreadId: state.setSelectedThreadId,
      setThreadCatalogPage: state.setThreadCatalogPage,
      setThreads: state.setThreads,
    });
    const thread =
      state.threads.find((item) => item.id === state.selectedThreadId) ?? null;
    return (
      <>
        <output>{state.selectedThreadId ?? "draft"}</output>
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
  roots.push(root);
  return {
    element,
    readThread,
    state: () => state,
    render: (connected: boolean) =>
      act(() =>
        root.render(
          <StrictMode>
            <Probe connected={connected} />
          </StrictMode>,
        ),
      ),
  };
}

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const catalog of catalogs.splice(0)) catalog.close();
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

describe("URL-owned thread restoration", () => {
  it("captures the explicit URL conversation before login and catalog restoration", () => {
    window.history.replaceState(null, "", url(b));
    const current = tab();
    current.render(false);
    expect(current.state().selectedThreadId).toBe(b);
    expect(current.readThread).not.toHaveBeenCalled();
  });

  it("keeps two mounted tabs independent through login/catalog restoration and refresh", async () => {
    window.history.replaceState(null, "", url(a));
    const first = tab();
    first.render(false);
    window.history.replaceState(null, "", url(b));
    const second = tab();
    second.render(false);
    // A page-owned state must not re-read another page's URL or newest catalog
    // item while its authentication/runtime is becoming available.
    window.history.replaceState(null, "", url(a));
    first.render(true);
    second.render(true);
    await vi.waitFor(async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
      });
      expect(first.element.textContent).toContain("Only tab A content");
      expect(second.element.textContent).toContain("Only tab B content");
    });
    expect(first.state().selectedThreadId).toBe(a);
    expect(second.state().selectedThreadId).toBe(b);
    expect(second.readThread.mock.calls.map(([id]) => id)).toEqual([b]);
    expect(second.element.textContent).not.toContain("Only tab A content");
    window.history.replaceState(null, "", url(b));
    const refreshed = tab();
    refreshed.render(true);
    await vi.waitFor(async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
      });
      expect(refreshed.element.textContent).toContain("Only tab B content");
    });
    expect(first.state().selectedThreadId).toBe(a);
    expect(refreshed.state().selectedThreadId).toBe(b);
  });

  it("retains the original catalog fallback when the URL has no conversation", async () => {
    window.history.replaceState(null, "", "/");
    const current = tab();
    current.render(true);
    await vi.waitFor(async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
      });
      expect(current.state().selectedThreadId).toBe(a);
      expect(current.element.textContent).toContain("Only tab A content");
    });
  });
});
