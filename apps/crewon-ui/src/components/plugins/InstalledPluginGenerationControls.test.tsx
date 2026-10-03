// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseProjectGenerationHostContext,
  PROJECT_GENERATION_HOST_CONTEXT_VERSION,
} from "@crewon/contracts/plugins";
import type { InstalledPluginGenerationContextState } from "../../lib/plugins/useInstalledPluginGenerationContext.types";
import {
  generationContextReceipt,
  generationContextRequest,
} from "../../lib/plugins/useInstalledPluginGenerationContext.test-support";
import { InstalledPluginGenerationControls } from "./InstalledPluginGenerationControls";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
describe("generic generation conversation controls", () => {
  let container: HTMLDivElement, root: Root;
  const callbacks = () => ({
    prepareThread: vi.fn(),
    refresh: vi.fn(),
    openTask: vi.fn(async () => undefined),
  });
  const state = (
    patch: Partial<InstalledPluginGenerationContextState> = {},
  ): InstalledPluginGenerationContextState => ({
    context: parseProjectGenerationHostContext({
      version: PROJECT_GENERATION_HOST_CONTEXT_VERSION,
      phase: "ready",
      thread: null,
      threadReady: false,
      intent: null,
    }),
    error: null,
    canOpenTask: false,
    ...callbacks(),
    ...patch,
  });
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const button = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (value) => value.textContent === label,
    )!;
  const render = async (
    value: InstalledPluginGenerationContextState,
    locale: "zh" | "en" = "zh",
  ) => {
    await act(async () =>
      root.render(
        <InstalledPluginGenerationControls state={value} locale={locale} />,
      ),
    );
  };

  it("creates only on an explicit click and reuses the original controls appearance without global changes", async () => {
    const action = callbacks();
    await render(state(action));
    expect(action.prepareThread).not.toHaveBeenCalled();
    await act(async () => button("创建任务会话").click());
    expect(action.prepareThread).toHaveBeenCalledTimes(1);
    expect(document.documentElement.getAttribute("style")).toBeNull();
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
    expect(container.innerHTML).toMatchSnapshot();
  });
  it("offers original creation retry without exposing a new-key action", async () => {
    const action = callbacks();
    await render(
      state({
        ...action,
        error: "unknown",
        context: parseProjectGenerationHostContext({
          version: PROJECT_GENERATION_HOST_CONTEXT_VERSION,
          phase: "uncertain",
          thread: null,
          threadReady: false,
          intent: null,
        }),
      }),
    );
    await act(async () => button("重试创建会话").click());
    expect(action.prepareThread).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "同一次请求",
    );
    expect(container.innerHTML).toMatchSnapshot();
  });
  it("never replaces an unknown generation and exposes accepted navigation only through the verified hook action", async () => {
    const action = callbacks();
    await render(
      state({
        ...action,
        error: "unknown",
        context: parseProjectGenerationHostContext({
          version: PROJECT_GENERATION_HOST_CONTEXT_VERSION,
          phase: "uncertain",
          thread: { threadId: "thread-1", revision: 17, provisional: false },
          threadReady: false,
          intent: {
            request: generationContextRequest,
            phase: "uncertain",
            retryable: false,
            receipt: null,
          },
        }),
      }),
    );
    expect(container.textContent).not.toContain("创建任务会话");
    expect(container.textContent).toContain("保留原请求");
    expect(container.innerHTML).toMatchSnapshot();
    await render(
      state({
        ...action,
        canOpenTask: true,
        context: parseProjectGenerationHostContext({
          version: PROJECT_GENERATION_HOST_CONTEXT_VERSION,
          phase: "ready",
          thread: { threadId: "thread-1", revision: 18, provisional: false },
          threadReady: true,
          intent: {
            request: generationContextRequest,
            phase: "accepted",
            retryable: false,
            receipt: generationContextReceipt,
          },
        }),
      }),
      "en",
    );
    await act(async () => button("Open generation task").click());
    expect(action.openTask).toHaveBeenCalledTimes(1);
    expect(container.innerHTML).toMatchSnapshot();
  });
});
