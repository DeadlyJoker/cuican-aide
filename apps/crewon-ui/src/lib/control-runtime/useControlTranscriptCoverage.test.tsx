// @vitest-environment happy-dom
import { act, StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import { ControlApiClient } from "@crewon/control-client";
import type { ControlThreadRuntimeCallbacks } from "./controlThreadRuntime";
import { detailThread } from "../thread/threadDetailCache.test-support";
import { useControlThreadRuntime } from "./useControlThreadRuntime";
import {
  transcriptWindow,
  type ControlWindowedThread,
} from "./controlTranscriptWindow";

const captured = vi.hoisted(() => ({
  callbacks: null as ControlThreadRuntimeCallbacks | null,
}));
vi.mock("./controlThreadRuntime", () => ({
  ControlThreadRuntime: class {
    constructor(_options: unknown, callbacks: ControlThreadRuntimeCallbacks) {
      captured.callbacks = callbacks;
    }
    setThreadEventStreamFocus() {}
    close() {}
    async connect() {}
    async selectThreadGoal() {
      return null;
    }
  },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("keeps partial transcript coverage after live tool coverage becomes complete", async () => {
  const partial: ControlWindowedThread = {
    ...detailThread("partial"),
    controlTranscriptWindow: {
      cursor: null,
      olderCursor: null,
      newerCursor: null,
      threadRevision: 1,
      firstSequence: 2,
      lastSequence: 2,
      rows: [],
    },
  };
  partial.turns = partial.turns.map((turn) => ({
    ...turn,
    itemsView: "summary",
  }));
  const full = detailThread("full");
  let shown: Thread[] = [];
  const client = new ControlApiClient({
    baseUrl: "http://fixture.invalid",
    fetch: async () => {
      throw new Error("unexpected_request");
    },
  });
  function View() {
    const [threads, setThreads] = useState<Thread[]>([partial, full]);
    shown = threads;
    useControlThreadRuntime({
      client,
      manageThreads: true,
      selectedThreadId: null,
      selectedThreadIdRef: useRef(null),
      showArchivedThreadsRef: useRef(false),
      setThreads,
      appendStreamingTextDelta() {},
      resetStreamingText() {},
      setActiveTurnByThread() {},
      setSelectedThreadId() {},
      setThreadGoal() {},
      setNotice() {},
      async waitForStreamingTextDrain() {},
    });
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <StrictMode>
          <View />
        </StrictMode>,
      ),
    );
    await act(async () => {
      for (const thread of [partial, full])
        captured.callbacks!.onToolHistoryCoverage!(
          thread.id,
          thread.turns[0]!.id,
          { complete: true, throughSequence: 10 },
        );
    });
    expect(shown[0]!.turns[0]!.itemsView).toBe("summary");
    expect(shown[1]!.turns[0]!.itemsView).toBe("full");
    await act(async () =>
      captured.callbacks!.onToolHistoryCoverage!(
        partial.id,
        partial.turns[0]!.id,
        { complete: false, throughSequence: 11 },
      ),
    );
    expect(transcriptWindow(shown[0]!)?.toolHistory).toBe("partial");
  } finally {
    await act(async () => root.unmount());
  }
});
