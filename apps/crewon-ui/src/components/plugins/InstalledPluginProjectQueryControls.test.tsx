// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseProjectGenerationQueryHostContext,
  PROJECT_GENERATION_QUERY_HOST_CONTEXT_VERSION,
} from "@crewon/contracts/plugins";
import type { InstalledPluginProjectQueryContextState } from "../../lib/plugins/useInstalledPluginProjectQueryContext";
import {
  queryJournalInput,
  queryJournalReceipt,
} from "../../lib/plugins/installedPluginProjectQuery.test-support";
import { InstalledPluginProjectQueryControls } from "./InstalledPluginProjectQueryControls";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
describe("generic original task query controls", () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  function state(
    phase: "pending" | "uncertain" | "accepted" | "refused",
  ): InstalledPluginProjectQueryContextState {
    return {
      context: parseProjectGenerationQueryHostContext({
        version: PROJECT_GENERATION_QUERY_HOST_CONTEXT_VERSION,
        phase:
          phase === "pending"
            ? "loading"
            : phase === "uncertain"
              ? "uncertain"
              : "ready",
        thread: { threadId: "thread-1", revision: 18, provisional: false },
        threadReady: phase === "accepted" || phase === "refused",
        intent: {
          request: queryJournalInput(),
          phase,
          retryable: phase === "uncertain",
          receipt: phase === "accepted" ? queryJournalReceipt() : null,
        },
      }),
      error:
        phase === "uncertain"
          ? "unknown"
          : phase === "refused"
            ? "refused"
            : null,
      canOpenTask: phase === "accepted",
      refresh: vi.fn(),
      openTask: vi.fn(async () => undefined),
    };
  }
  async function render(
    value: InstalledPluginProjectQueryContextState,
    locale: "zh" | "en" = "zh",
  ) {
    await act(async () =>
      root.render(
        <InstalledPluginProjectQueryControls state={value} locale={locale} />,
      ),
    );
  }
  it("uses original control appearance and only opens an accepted query after an explicit click", async () => {
    const value = state("accepted");
    await render(value);
    expect(value.openTask).not.toHaveBeenCalled();
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "打开查询任务")!
        .click();
    });
    expect(value.openTask).toHaveBeenCalledTimes(1);
    expect(document.documentElement.getAttribute("style")).toBeNull();
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
    expect(container.innerHTML).toMatchSnapshot();
  });
  it("shows pending and UNKNOWN without a Host button that could create or replace a query", async () => {
    for (const phase of ["pending", "uncertain"] as const) {
      const value = state(phase);
      await render(value);
      expect(container.textContent).toContain("查询请求待确认");
      expect(container.textContent).not.toContain("打开查询任务");
      expect(container.textContent).not.toContain("创建任务");
      expect(value.openTask).not.toHaveBeenCalled();
      expect(container.innerHTML).toMatchSnapshot(phase);
    }
  });
  it("refreshes refused state without presenting accepted status or issuing a new task", async () => {
    const value = state("refused");
    await render(value, "en");
    expect(container.textContent).not.toContain("Query task accepted");
    await act(async () =>
      container.querySelector<HTMLButtonElement>("button")!.click(),
    );
    expect(value.refresh).toHaveBeenCalledTimes(1);
    expect(value.openTask).not.toHaveBeenCalled();
    expect(container.innerHTML).toMatchSnapshot();
  });
});
