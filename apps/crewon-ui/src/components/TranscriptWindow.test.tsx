// @vitest-environment happy-dom
import { act, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { it, expect, vi } from "vitest";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import { Transcript } from "./Transcript";
import {
  TranscriptNavigationScope,
  TranscriptWindowControls,
} from "./TranscriptWindowControls";
import { MessageReplayScope } from "./messages/MessageReplayScope";
import {
  transcriptFixture,
  transcriptRun,
} from "../lib/control-runtime/controlTranscriptWindow.test-support";
import { transcriptWindow } from "../lib/control-runtime/controlTranscriptWindow";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const labels = {
  commandLabel: "Command",
  crewonLabel: "CrewON",
  emptyDescription: "Start",
  emptyTitle: "Ready",
  filesLabel: "Files",
  loadingLabel: "Loading",
  modeCodeDescription: "Code",
  modeCodeLabel: "Code",
  modeOfficeDescription: "Office",
  modeOfficeLabel: "Office",
  modeTitleLabel: "Mode",
  planLabel: "Plan",
  reasoningLabel: "Reasoning",
  stopLabel: "Stop",
  youLabel: "You",
};

it("uses the real history controls under StrictMode without losing the active stream or scroll position", async () => {
  let publish: ((thread: Thread) => void) | undefined;
  const f = transcriptFixture(2400, {
    onThread: (thread) => publish?.(thread),
  });
  f.setActive(transcriptRun("run-live", true));
  const initial = await f.runtime.readThread("thread-1");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let shown = initial;
  function View() {
    const [thread, setThread] = useState(initial);
    shown = thread;
    publish = setThread;
    return (
      <TranscriptNavigationScope runtime={f.runtime}>
        <Transcript
          {...labels}
          thread={thread}
          streamingText="Still running"
          locale="zh"
          mode="code"
          onModeChange={() => {}}
          onStop={() => {}}
        />
      </TranscriptNavigationScope>
    );
  }
  const button = (text: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === text,
    )!;
  try {
    await act(async () => {
      root.render(
        <StrictMode>
          <View />
        </StrictMode>,
      );
    });
    await act(async () => {
      await vi.waitFor(() => expect(f.activeStreams).toEqual(["run-live"]));
    });
    expect(container.textContent).toContain("Question 2351");
    await act(async () => {
      button("更早消息").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("Question 2301");
    expect(container.textContent).not.toContain("Question 2351");
    expect(container.textContent).toContain("Still running");
    expect(
      container.querySelectorAll('[data-kind="userMessage"]'),
    ).toHaveLength(25);
    expect(f.streamSignals.get("run-live")?.aborted).toBe(false);
    const scroller = container.querySelector<HTMLElement>(".message-list")!;
    scroller.scrollTop = 230;
    const firstSequence = transcriptWindow(shown)!.firstSequence;
    f.thread.revision++;
    await act(async () => {
      publish?.(await f.runtime.readThread("thread-1"));
    });
    expect(transcriptWindow(shown)!.firstSequence).toBe(firstSequence);
    expect(scroller.scrollTop).toBe(230);
    await act(async () => {
      button("回到最新").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("Question 2351");
    expect(container.textContent).not.toContain("Question 2301");
    expect(f.activeStreams).toEqual(["run-live"]);
  } finally {
    await act(async () => {
      root.unmount();
      f.runtime.close();
    });
    container.remove();
  }
});

it("retains the current page on navigation failure and cancels outstanding navigation on unmount", async () => {
  const f = transcriptFixture(100);
  const thread = await f.runtime.readThread("thread-1", {
    toolHistoryMode: "skip",
  });
  let signal: AbortSignal | undefined;
  const navigateTranscript = vi.fn(
    async (
      _id: string,
      _cursor: string | null,
      options: { signal?: AbortSignal } = {},
    ) => {
      signal = options.signal;
      throw new Error("offline");
    },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <TranscriptNavigationScope runtime={{ navigateTranscript }}>
          <Transcript
            {...labels}
            thread={thread}
            streamingText=""
            locale="zh"
            mode="code"
            onModeChange={() => {}}
            onStop={() => {}}
          />
        </TranscriptNavigationScope>,
      ),
    );
    const button = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "更早消息")!;
    await act(async () => {
      button.click();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "当前消息已保留",
    );
    expect(container.textContent).toContain("Question 51");
    navigateTranscript.mockImplementation(
      async (_id, _cursor, options = {}) => {
        signal = options.signal;
        return new Promise(() => {});
      },
    );
    await act(async () => {
      button.click();
    });
    expect(button.disabled).toBe(true);
    await act(async () => root.unmount());
    expect(signal?.aborted).toBe(true);
  } finally {
    f.runtime.close();
    container.remove();
  }
});

it("renders bounded navigation and explicit partial/unknown history states", async () => {
  const f = transcriptFixture(2);
  const fetchWindow = f.client.getThreadTranscriptSnapshot.bind(f.client);
  vi.spyOn(f.client, "getThreadTranscriptSnapshot").mockImplementation(
    (id, query, options) => fetchWindow(id, { ...query, limit: 1 }, options),
  );
  try {
    const partial = await f.runtime.readThread("thread-1", {
      toolHistoryMode: "skip",
    });
    expect(
      renderToStaticMarkup(
        <TranscriptNavigationScope runtime={f.runtime}>
          <TranscriptWindowControls thread={partial} locale="zh" />
        </TranscriptNavigationScope>,
      ),
    ).toMatchSnapshot("navigation");
    const markup = renderToStaticMarkup(
      <Transcript
        {...labels}
        thread={partial}
        streamingText=""
        locale="zh"
        mode="code"
        onModeChange={() => {}}
        onStop={() => {}}
      />,
    );
    expect(markup).toContain("本页显示本轮的部分内容");
    expect(markup).not.toContain('data-kind="userMessage"');
    expect(markup).toMatchSnapshot("partial turn");
    f.messages[1]!.content = "legacy: old answer";
    const unknown = await f.runtime.readThread("thread-1", {
      toolHistoryMode: "skip",
    });
    const unknownMarkup = renderToStaticMarkup(
      <Transcript
        {...labels}
        thread={unknown}
        streamingText=""
        locale="zh"
        mode="code"
        onModeChange={() => {}}
        onStop={() => {}}
      />,
    );
    expect(unknownMarkup).toContain("执行状态未知");
    expect(unknownMarkup).not.toContain('data-status="failed"');
    expect(unknownMarkup).toMatchSnapshot("unknown history");
  } finally {
    f.runtime.close();
  }
});

it("edits a legacy message without inventing a whole-history turn count", async () => {
  const f = transcriptFixture(1);
  f.messages[0]!.content = "legacy: Question";
  const thread = await f.runtime.readThread("thread-1", {
    toolHistoryMode: "skip",
  });
  const onReplay = vi.fn(async () => {});
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MessageReplayScope
          thread={thread}
          busy={false}
          locale="zh"
          onReplay={onReplay}
        >
          <Transcript
            {...labels}
            thread={thread}
            streamingText=""
            locale="zh"
            mode="code"
            onModeChange={() => {}}
            onStop={() => {}}
          />
        </MessageReplayScope>,
      ),
    );
    const edit = container.querySelector<HTMLButtonElement>(
      '[aria-label="编辑消息"]',
    )!;
    expect(edit).not.toBeNull();
    await act(async () => {
      edit.click();
    });
    expect(container.querySelector("textarea")?.value).toBe("legacy: Question");
    expect(container.textContent).toContain("移除从这里开始的回复与后续对话");
    expect(container.textContent).not.toContain("1 轮回复");
    const submit = container.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    )!;
    await act(async () => {
      submit.click();
    });
    expect(onReplay).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessageId: "message-1",
        expectedThreadRevision: 2,
      }),
    );
  } finally {
    await act(async () => root.unmount());
    f.runtime.close();
    container.remove();
  }
});

it("shows incomplete tool history and retries it through the real runtime without model calls", async () => {
  let publish: ((thread: Thread) => void) | undefined;
  const f = transcriptFixture(2, { onThread: (thread) => publish?.(thread) });
  const initial = await f.runtime.readThread("thread-1", {
    toolHistoryMode: "skip",
  });
  expect(transcriptWindow(initial)?.toolHistory).toBe("partial");
  const container = document.createElement("div");
  const root = createRoot(container);
  function View() {
    const [thread, setThread] = useState(initial);
    publish = setThread;
    return (
      <TranscriptNavigationScope runtime={f.runtime}>
        <Transcript
          {...labels}
          thread={thread}
          streamingText=""
          locale="zh"
          mode="code"
          onModeChange={() => {}}
          onStop={() => {}}
        />
      </TranscriptNavigationScope>
    );
  }
  try {
    await act(async () =>
      root.render(
        <StrictMode>
          <View />
        </StrictMode>,
      ),
    );
    expect(container.textContent).toContain("部分工具过程尚未完整加载");
    const retry = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "重新读取工具过程")!;
    await act(async () => {
      retry.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).not.toContain("部分工具过程尚未完整加载");
    expect(container.textContent).toContain("Answer 2");
    expect(f.mutations).toEqual([]);
    expect(
      f.calls.some((call) => call.startsWith("/api/v1/agent-versions")),
    ).toBe(false);
  } finally {
    await act(async () => root.unmount());
    f.runtime.close();
  }
});
