// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserExecutionAuthorizationState,
  BrowserExecutionBridge,
  BrowserGrantScope,
} from "../../lib/browser-execution/browserExecutionGrant";
import {
  BrowserExecutionAuthorization,
  type BrowserExecutionAuthorizationProps,
} from "./BrowserExecutionAuthorization";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const skillVersionRef = {
  skillId: "report-skill",
  versionId: "version-1",
  contentDigest: "sha256:content-1",
};
const scope: BrowserGrantScope = {
  skillVersionRef,
  origins: ["https://reports.example.com"],
  rules: [
    {
      action: "navigate",
      urlTemplate: "https://reports.example.com/export?date={date}",
    },
    { action: "click", target: { role: "button", name: "筛选" } },
    {
      action: "fill",
      target: { role: "textbox", name: "日期" },
      value: { parameter: "date" },
    },
    {
      action: "select",
      target: { role: "combobox", name: "部门" },
      value: { literal: "销售" },
    },
    { action: "download", target: { role: "link", name: "导出 CSV" } },
  ],
};

function grant(
  threadId = "thread-a",
  mode: "scoped" | "perAction" = "perAction",
): BrowserExecutionAuthorizationState {
  return { threadId, mode, sessionId: "browser-session-1", revision: 1 };
}

function fakeBridge() {
  return {
    authorize: vi
      .fn<BrowserExecutionBridge["authorize"]>()
      .mockResolvedValue(grant()),
    revoke: vi
      .fn<BrowserExecutionBridge["revoke"]>()
      .mockResolvedValue(undefined),
    status: vi.fn<BrowserExecutionBridge["status"]>().mockResolvedValue(null),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("BrowserExecutionAuthorization", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(
    props: Partial<BrowserExecutionAuthorizationProps> = {},
  ) {
    await act(async () =>
      root.render(
        <BrowserExecutionAuthorization
          threadId="thread-a"
          skillVersionRef={skillVersionRef}
          {...props}
        />,
      ),
    );
  }

  function button(label: string): HTMLButtonElement {
    const result = Array.from(container.querySelectorAll("button")).find(
      (element) => element.textContent === label,
    );
    if (!result) throw new Error(`Missing button: ${label}`);
    return result;
  }

  it("only authorizes after an explicit DOM click, including StrictMode mounting", async () => {
    const bridge = fakeBridge();
    const onAuthorized = vi.fn();
    await act(async () =>
      root.render(
        <StrictMode>
          <BrowserExecutionAuthorization
            threadId="thread-a"
            skillVersionRef={skillVersionRef}
            bridge={bridge}
            onAuthorized={onAuthorized}
          />
        </StrictMode>,
      ),
    );
    expect(bridge.status).toHaveBeenCalledWith("thread-a");
    expect(bridge.authorize).not.toHaveBeenCalled();
    expect(container.textContent).toContain("浏览器动作仍需逐次确认");
    await act(async () => button("允许此任务使用浏览器").click());
    expect(bridge.authorize).toHaveBeenCalledExactlyOnceWith({
      threadId: "thread-a",
    });
    expect(onAuthorized).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("已授权 · 逐次确认");
    expect(button("接管并撤销授权").disabled).toBe(false);
  });

  it("displays every reviewed scope field and sends precisely that scope on click", async () => {
    const bridge = fakeBridge();
    bridge.authorize.mockResolvedValue(grant("thread-a", "scoped"));
    await render({ bridge, scope });
    expect(container.textContent).toContain(scope.origins[0]);
    expect(container.textContent).toContain("button · 筛选");
    expect(container.textContent).toContain("combobox · 部门");
    expect(container.textContent).toContain("参数：date（运行时提供）");
    expect(container.textContent).toContain("固定值：销售");
    expect(container.textContent).toContain("打开页面");
    expect(container.textContent).toContain("下载文件");
    expect(bridge.authorize).not.toHaveBeenCalled();
    await act(async () => button("允许此任务使用浏览器").click());
    expect(bridge.authorize).toHaveBeenCalledExactlyOnceWith({
      threadId: "thread-a",
      scope,
    });
    expect(container.textContent).toContain("已授权 · 限定范围连续执行");
    expect(
      container.innerHTML.replace(/_r_[a-z0-9]+_/g, "_react-id_"),
    ).toMatchSnapshot();
  });

  it.each(["skillId", "versionId", "contentDigest"] as const)(
    "blocks scoped authorization when %s differs from the selected Skill",
    async (field) => {
      const bridge = fakeBridge();
      await render({
        bridge,
        scope: {
          ...scope,
          skillVersionRef: { ...skillVersionRef, [field]: "mismatch" },
        },
      });
      expect(container.textContent).toContain("授权范围与当前技能版本不一致");
      expect(button("允许此任务使用浏览器").disabled).toBe(true);
      await act(async () => button("允许此任务使用浏览器").click());
      expect(bridge.authorize).not.toHaveBeenCalled();
    },
  );

  it("disables disconnected, missing-task, and incomplete-scope authorization", async () => {
    await render();
    expect(container.textContent).toContain("当前浏览器未连接");
    expect(button("允许此任务使用浏览器").disabled).toBe(true);
    const bridge = fakeBridge();
    await render({ bridge, threadId: null });
    expect(container.textContent).toContain("请先选择一个任务");
    expect(button("允许此任务使用浏览器").disabled).toBe(true);
    expect(bridge.status).not.toHaveBeenCalled();
    await render({ bridge, scope: { ...scope, rules: [] } });
    expect(container.textContent).toContain("本次授权范围尚未配置完整");
    expect(button("允许此任务使用浏览器").disabled).toBe(true);
  });

  it("resolves the optional desktop bridge without granting on mount", async () => {
    const bridge = fakeBridge();
    Object.defineProperty(window, "crewonDesktop", {
      configurable: true,
      value: { browserExecution: bridge },
    });
    try {
      await render();
      expect(bridge.status).toHaveBeenCalledWith("thread-a");
      expect(bridge.authorize).not.toHaveBeenCalled();
      await act(async () => button("允许此任务使用浏览器").click());
      expect(bridge.authorize).toHaveBeenCalledExactlyOnceWith({
        threadId: "thread-a",
      });
    } finally {
      Reflect.deleteProperty(window, "crewonDesktop");
    }
  });

  it("ignores a stale status response after switching threads", async () => {
    const stale = deferred<BrowserExecutionAuthorizationState | null>();
    const bridge = fakeBridge();
    bridge.status.mockImplementation((threadId) =>
      threadId === "thread-a" ? stale.promise : Promise.resolve(null),
    );
    await render({ bridge });
    expect(button("允许此任务使用浏览器").disabled).toBe(true);
    await render({ bridge, threadId: "thread-b" });
    await act(async () => stale.resolve(grant("thread-a", "scoped")));
    expect(bridge.status).toHaveBeenLastCalledWith("thread-b");
    expect(container.textContent).toContain("尚未授权");
    expect(container.textContent).not.toContain("已授权");
    expect(container.textContent).not.toContain("接管并撤销授权");
  });

  it("ignores a stale authorization result and callback after switching tasks", async () => {
    const stale = deferred<BrowserExecutionAuthorizationState>();
    const bridge = fakeBridge();
    bridge.authorize.mockReturnValue(stale.promise);
    const onAuthorized = vi.fn();
    await render({ bridge, onAuthorized });
    await act(async () => button("允许此任务使用浏览器").click());
    expect(button("允许此任务使用浏览器").disabled).toBe(true);
    await render({ bridge, onAuthorized, threadId: "thread-b" });
    await act(async () => stale.resolve(grant()));
    expect(onAuthorized).not.toHaveBeenCalled();
    expect(container.textContent).toContain("尚未授权");
    expect(container.textContent).not.toContain("接管并撤销授权");
  });

  it("clears local authorization on thread changes and ignores stale revoke completion", async () => {
    const stale = deferred<void>();
    const bridge = fakeBridge();
    bridge.status.mockImplementation(async (threadId) =>
      grant(threadId, threadId === "thread-a" ? "scoped" : "perAction"),
    );
    bridge.revoke.mockReturnValue(stale.promise);
    await render({ bridge });
    await act(async () => button("接管并撤销授权").click());
    expect(bridge.revoke).toHaveBeenCalledExactlyOnceWith("thread-a");
    await render({ bridge, threadId: "thread-b" });
    await act(async () => stale.resolve(undefined));
    expect(container.textContent).toContain("已授权 · 逐次确认");
    expect(container.textContent).not.toContain("授权已撤销");
  });

  it("keeps revocation available after failure and only claims takeover on success", async () => {
    const bridge = fakeBridge();
    bridge.status.mockResolvedValue(grant());
    bridge.revoke.mockRejectedValueOnce(new Error("internal sensitive error"));
    await render({ bridge });
    await act(async () => button("接管并撤销授权").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "撤销未完成，请重试。",
    );
    expect(container.textContent).not.toContain("internal sensitive error");
    expect(container.textContent).toContain("已授权");
    await act(async () => button("接管并撤销授权").click());
    expect(container.textContent).toContain("授权已撤销，浏览器由你接管。");
    expect(container.textContent).not.toContain("接管并撤销授权");
  });

  it("rejects a mismatched authorization response without invoking the callback", async () => {
    const bridge = fakeBridge();
    bridge.authorize.mockResolvedValue(grant("thread-b"));
    const onAuthorized = vi.fn();
    await render({ bridge, onAuthorized });
    await act(async () => button("允许此任务使用浏览器").click());
    expect(onAuthorized).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "授权未完成",
    );
    expect(container.textContent).not.toContain("已授权");
  });

  it("refreshes status after a read failure and on return from the teaching browser", async () => {
    const bridge = fakeBridge();
    bridge.status.mockRejectedValueOnce(new Error("unavailable"));
    await render({ bridge });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "无法读取浏览器授权",
    );
    bridge.status.mockResolvedValue(grant());
    await act(async () => button("刷新授权状态").click());
    expect(container.textContent).toContain("已授权 · 逐次确认");
    bridge.status.mockResolvedValue(null);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(container.textContent).toContain("尚未授权");
    expect(bridge.authorize).not.toHaveBeenCalled();
  });

  it("snapshots disconnected SSR", () => {
    const markup = renderToStaticMarkup(
      <BrowserExecutionAuthorization
        threadId="thread-a"
        skillVersionRef={skillVersionRef}
      />,
    );
    expect(markup).toContain("当前浏览器未连接");
    expect(markup).toMatchSnapshot();
  });
});
