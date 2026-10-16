// @vitest-environment happy-dom
import { act, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { Locale } from "../../i18n";
import { detailThread } from "../../thread/threadDetailCache.test-support";
import { useAppDemoEffects } from "./useAppDemoEffects";
import { useAppShellRuntimeState } from "../useAppShellRuntimeState";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("keeps demo localization and inspector selection independent of transport across mode changes", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const setAccountStatus = vi.fn();
  const setConversationSummary = vi.fn();
  const setGitRemoteDiff = vi.fn();
  const setThreadGoal = vi.fn();
  let threads: Thread[] = [];
  let initialConnection: string | undefined;
  function Probe({
    demo,
    locale,
    selected,
  }: {
    demo: boolean;
    locale: Locale;
    selected: boolean;
  }) {
    const shell = useAppShellRuntimeState();
    initialConnection = shell.connectionState;
    const [items, setThreads] = useState<Thread[]>([
      { ...detailThread("demo-1"), name: "Desktop UI architecture" },
    ]);
    threads = items;
    useAppDemoEffects({
      connectionState: demo ? "demo" : "disconnected",
      isDemo: demo,
      locale,
      setThreads,
      selectedThread: selected ? (items[0] ?? null) : null,
      selectedThreadId: selected ? "demo-1" : null,
      setAccountStatus,
      setConversationSummary,
      setGitRemoteDiff,
      setThreadGoal,
    });
    return <span>{items[0]?.name}</span>;
  }
  const render = (demo: boolean, locale: Locale, selected: boolean) =>
    act(() => {
      root.render(
        <StrictMode>
          <Probe demo={demo} locale={locale} selected={selected} />
        </StrictMode>,
      );
    });
  try {
    render(false, "en", true);
    expect(initialConnection).toBe("disconnected");
    expect(setAccountStatus).not.toHaveBeenCalled();
    render(true, "zh", true);
    expect(container.textContent).toBe("桌面端 UI 架构");
    expect(setThreadGoal.mock.lastCall?.[0]).not.toBeNull();
    render(true, "en", false);
    expect(container.textContent).toBe("Desktop UI architecture");
    expect(setConversationSummary).toHaveBeenLastCalledWith(null);
    expect(setGitRemoteDiff).toHaveBeenLastCalledWith(null);
    expect(setThreadGoal).toHaveBeenLastCalledWith(null);
    const previousThreads = threads;
    const previousCalls = setAccountStatus.mock.calls.length;
    render(false, "zh", true);
    expect(threads).toBe(previousThreads);
    expect(setAccountStatus).toHaveBeenCalledTimes(previousCalls);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
