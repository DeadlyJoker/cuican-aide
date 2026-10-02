// @vitest-environment happy-dom
import { act, useEffect, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import { CommandWorkspace } from "./CommandWorkspace";
import {
  mergeCommandWorkspaceHostModules,
  type CommandWorkspaceHostModule,
} from "./CommandWorkspaceHostModule";
import { emptyAgentPlatformSnapshot } from "./commandWorkspaceState";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => undefined;
const base: ComponentProps<typeof CommandWorkspace> = {
  composerValue: "",
  connectionState: "disconnected",
  cwd: "",
  isSending: false,
  platform: "mac",
  platformSnapshotLoader: async () => emptyAgentPlatformSnapshot,
  workMode: "office",
  workspaceAuthority: "control",
  onAttachContext: noop,
  onChangeComposerValue: noop,
  onModeChange: noop,
  onRetryConnection: noop,
  onSend: noop,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-03T12:00:00+08:00"));
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.classList.remove("modal-open");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function render(props: Partial<ComponentProps<typeof CommandWorkspace>>) {
  if (!container) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () =>
    root!.render(<CommandWorkspace {...base} {...props} />),
  );
}

async function click(element: Element | null) {
  expect(element).not.toBeNull();
  await act(async () =>
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
}

function navigation(id: string) {
  return [...container!.querySelectorAll("[data-host-module-target]")].find(
    (element) => element.getAttribute("data-host-module-target") === id,
  )!;
}

function pane(id: string) {
  return [
    ...container!.querySelectorAll<HTMLElement>("[data-host-module-id]"),
  ].find((element) => element.dataset.hostModuleId === id)!;
}

function fixtureModule(
  pluginId: string,
  contributionId: string,
  label: string,
) {
  const id = JSON.stringify([pluginId, contributionId]);
  const activity = vi.fn();
  const rendered = vi.fn();
  function Content({ active }: Readonly<{ active: boolean }>) {
    const [revision, setRevision] = useState(1);
    useEffect(() => {
      activity(active);
      return () => activity("cleanup");
    }, [active]);
    return (
      <article data-fixture-active={String(active)}>
        <output>{revision}</output>
        <button onClick={() => setRevision((value) => value + 1)}>
          保存本模块
        </button>
      </article>
    );
  }
  const module: CommandWorkspaceHostModule = {
    id,
    label,
    content: (state) => {
      rendered(state);
      return <Content {...state} />;
    },
  };
  return { module, activity, rendered };
}

describe("CommandWorkspace multiple host contributions", () => {
  it("preserves default SSR and the existing single-module API byte for byte", () => {
    const module = fixtureModule("example.drama", "main", "AI 短剧").module;
    expect(
      renderToStaticMarkup(<CommandWorkspace {...base} hostModules={[]} />),
    ).toBe(renderToStaticMarkup(<CommandWorkspace {...base} />));
    expect(
      renderToStaticMarkup(
        <CommandWorkspace {...base} hostModules={[module]} />,
      ),
    ).toBe(
      renderToStaticMarkup(<CommandWorkspace {...base} hostModule={module} />),
    );
  });

  it("keeps the legacy entry first and rejects duplicate route identities before rendering content", () => {
    const a = fixtureModule("example.drama", "main", "AI 短剧");
    const b = fixtureModule("example.drama", "assets", "专业资产");
    expect(
      mergeCommandWorkspaceHostModules({
        hostModule: a.module,
        hostModules: [b.module],
      }),
    ).toEqual([a.module, b.module]);
    const markup = renderToStaticMarkup(
      <CommandWorkspace
        {...base}
        hostModule={a.module}
        hostModules={[b.module]}
      />,
    );
    expect(markup.indexOf("AI 短剧")).toBeLessThan(markup.indexOf("专业资产"));
    a.rendered.mockClear();
    expect(() =>
      renderToStaticMarkup(
        <CommandWorkspace
          {...base}
          hostModule={a.module}
          hostModules={[a.module]}
        />,
      ),
    ).toThrow("command_workspace_host_module_id_duplicate");
    expect(a.rendered).not.toHaveBeenCalled();
  });

  it("switches distinct contributions without replacing the shell or losing module state", async () => {
    const a = fixtureModule("example.drama", "main/assets", "AI 短剧");
    const b = fixtureModule("example.drama/main", "assets", "专业资产");
    await render({ hostModules: [a.module, b.module] });
    const sidebar = container!.querySelector(".command-sidebar");
    const homepage = container!.querySelector<HTMLElement>(
      '[data-shell-view="command"]',
    )!;
    expect(
      container!.querySelectorAll("[data-host-module-target]"),
    ).toHaveLength(2);
    expect(a.module.id).not.toBe(b.module.id);
    expect(pane(a.module.id).hidden).toBe(true);
    expect(pane(b.module.id).hidden).toBe(true);
    await click(navigation(a.module.id));
    expect(homepage.hidden).toBe(true);
    expect(a.rendered.mock.calls.at(-1)).toEqual([{ active: true }]);
    expect(b.rendered.mock.calls.at(-1)).toEqual([{ active: false }]);
    await click(pane(a.module.id).querySelector("button"));
    const aContent = pane(a.module.id).querySelector("article");
    await click(navigation(b.module.id));
    expect(pane(a.module.id).hidden).toBe(true);
    expect(pane(b.module.id).hidden).toBe(false);
    expect(a.rendered.mock.calls.at(-1)).toEqual([{ active: false }]);
    expect(b.rendered.mock.calls.at(-1)).toEqual([{ active: true }]);
    expect(navigation(a.module.id).hasAttribute("aria-current")).toBe(false);
    expect(navigation(b.module.id).getAttribute("aria-current")).toBe("page");
    await click(navigation(a.module.id));
    expect(pane(a.module.id).querySelector("article")).toBe(aContent);
    expect(pane(a.module.id).querySelector("output")?.textContent).toBe("2");
    expect(container!.querySelector(".command-sidebar")).toBe(sidebar);
    expect(
      navigation(a.module.id).querySelector(".nav-glyph svg"),
    ).not.toBeNull();
    await click(container!.querySelector('[data-nav-key="command"]'));
    expect(homepage.hidden).toBe(false);
    expect(a.rendered.mock.calls.at(-1)).toEqual([{ active: false }]);
    expect(b.rendered.mock.calls.at(-1)).toEqual([{ active: false }]);
  });

  it("preserves selection across catalog refresh and returns to the original view when the selected module disappears", async () => {
    const a = fixtureModule("example.drama", "main", "AI 短剧");
    const b = fixtureModule("example.enterprise", "main", "企业能力");
    await render({ hostModules: [a.module, b.module] });
    await click(container!.querySelector('[data-nav-key="team"]'));
    await click(navigation(a.module.id));
    await click(pane(a.module.id).querySelector("button"));
    const aPane = pane(a.module.id);
    await render({
      hostModules: [b.module, { ...a.module, label: "AI 短剧新版" }],
    });
    expect(pane(a.module.id)).toBe(aPane);
    expect(aPane.hidden).toBe(false);
    expect(navigation(a.module.id).textContent).toBe("AI 短剧新版");
    expect(aPane.querySelector("output")?.textContent).toBe("2");
    await render({ hostModules: [b.module] });
    expect(
      container!.querySelector<HTMLElement>('[data-shell-view="team"]')?.hidden,
    ).toBe(false);
    expect(
      container!
        .querySelector('[data-nav-key="team"]')
        ?.getAttribute("aria-current"),
    ).toBe("page");
    expect(a.activity.mock.calls.at(-1)).toEqual(["cleanup"]);
    await render({ hostModules: [a.module, b.module] });
    expect(pane(a.module.id).hidden).toBe(true);
    expect(a.rendered.mock.calls.at(-1)).toEqual([{ active: false }]);
    expect(
      container!.querySelector<HTMLElement>('[data-shell-view="team"]')?.hidden,
    ).toBe(false);
  });

  it("revokes module activity when the host changes thread, scene, or browser view", async () => {
    const a = fixtureModule("example.drama", "main", "AI 短剧");
    const onSceneChange = vi.fn();
    const onSelectLinkedThread = vi.fn();
    const linkedThread: Thread = {
      id: "existing-thread",
      sessionId: "existing-session",
      forkedFromId: null,
      parentThreadId: null,
      preview: "已有任务",
      ephemeral: false,
      modelProvider: "fixture",
      createdAt: 1,
      updatedAt: 2,
      status: { type: "idle" },
      path: null,
      cwd: "/fixture",
      clientVersion: "fixture",
      source: "appServer",
      threadSource: "command",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: "已有任务",
      turns: [],
    };
    const props = {
      hostModules: [a.module],
      linkedThreads: [linkedThread],
      onSceneChange,
      onSelectLinkedThread,
    };
    await render({
      ...props,
      selectedThreadId: "thread-a",
    });
    await click(navigation(a.module.id));
    a.rendered.mockClear();
    await render({
      ...props,
      selectedThreadId: "thread-b",
    });
    expect(a.rendered.mock.calls[0]).toEqual([{ active: false }]);
    expect(pane(a.module.id).hidden).toBe(true);
    await click(navigation(a.module.id));
    await click(
      container!.querySelector('[data-linked-thread-id="existing-thread"]'),
    );
    expect(onSelectLinkedThread.mock.calls.at(-1)).toEqual(["existing-thread"]);
    expect(a.rendered.mock.calls.at(-1)).toEqual([{ active: false }]);
    await click(navigation(a.module.id));
    const nextScene = container!.querySelector('[data-scene-target="code"]');
    expect(nextScene).not.toBeNull();
    await act(async () =>
      nextScene!.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 }),
      ),
    );
    expect(onSceneChange.mock.calls.at(-1)).toEqual(["code"]);
    expect(a.rendered.mock.calls.at(-1)).toEqual([{ active: false }]);
    await click(navigation(a.module.id));
    await act(async () => {
      window.history.replaceState(null, "", "/#view-team");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(a.rendered.mock.calls.at(-1)).toEqual([{ active: false }]);
    expect(
      container!.querySelector<HTMLElement>('[data-shell-view="team"]')?.hidden,
    ).toBe(false);
  });

  it("retains the original sidebar collapse controls across module and host navigation", async () => {
    const a = fixtureModule("example.drama", "main", "AI 短剧");
    const b = fixtureModule("example.enterprise", "main", "企业能力");
    await render({ hostModules: [a.module, b.module] });
    const commandWindow =
      container!.querySelector<HTMLElement>(".command-window")!;
    const sidebar = container!.querySelector(".command-sidebar")!;
    const collapse = sidebar.querySelector("[data-sidebar-collapse]");
    await click(collapse);
    expect(commandWindow.classList.contains("sidebar-collapsed")).toBe(true);
    await click(navigation(a.module.id));
    await click(navigation(b.module.id));
    expect(commandWindow.classList.contains("sidebar-collapsed")).toBe(true);
    await click(container!.querySelector('[data-nav-key="team"]'));
    expect(commandWindow.classList.contains("sidebar-collapsed")).toBe(true);
    await click(collapse);
    expect(commandWindow.classList.contains("sidebar-collapsed")).toBe(false);
    expect(container!.querySelector(".command-sidebar")).toBe(sidebar);
    expect(container!.querySelectorAll(".command-sidebar")).toHaveLength(1);
  });
});
