// @vitest-environment happy-dom
// @ts-expect-error Vitest reads styles in Node; the browser bundle omits Node types.
import { readFileSync } from "node:fs";
// @ts-expect-error Vitest resolves saved files in Node; the browser omits Node types.
import { URL as NodeURL } from "node:url";
import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import { AppCommandShellRoute } from "./AppCommandShellRoute";
import { CommandWorkspacePluginPanelHeader } from "./CommandWorkspacePluginPanel";
import type { CommandWorkspaceHostModule } from "./CommandWorkspaceHostModule";
import { emptyAgentPlatformSnapshot } from "./commandWorkspaceState";
import { emptyTerminalOutputStream } from "../../lib/terminal/terminalOutputStream";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const noop = () => undefined;
const thread = {
  id: "existing-agent-conversation",
  name: "原 Agent 会话",
  preview: "原 Agent 会话",
  cwd: "/fixture/project",
  createdAt: 1,
  updatedAt: 2,
  turns: [],
  status: { type: "idle" },
  modelProvider: "fixture",
  gitInfo: null,
  clientVersion: "fixture",
  source: "appServer",
} as unknown as Thread;
const base: ComponentProps<typeof AppCommandShellRoute> = {
  composerValue: "原来的输入草稿",
  connectionState: "connected",
  cwd: "",
  isSending: false,
  locale: "zh",
  platform: "web",
  platformSnapshotLoader: async () => emptyAgentPlatformSnapshot,
  selectedThread: thread,
  selectedThreadId: thread.id,
  linkedThreads: [thread],
  workspaceAuthority: "control",
  workMode: "office",
  onAttachContext: noop,
  onChangeComposerValue: noop,
  onModeChange: noop,
  onRetryConnection: noop,
  onSend: noop,
  confirmDialog: {
    locale: "zh",
    request: null,
    onCancel: noop,
    onConfirm: noop,
  },
  capabilityDrawer: {
    busyToolId: null,
    commandValue: "",
    disabled: false,
    locale: "zh",
    open: false,
    panel: null,
    scene: "office",
    terminalCwd: null,
    terminalOutput: emptyTerminalOutputStream,
    terminalProcessId: null,
    onClose: noop,
    onCommandChange: noop,
    onCommandSubmit: noop,
    onFiles: noop,
    onOpen: noop,
    onPanelAction: noop,
    onPanelFieldChange: noop,
    onPanelItem: noop,
    onReview: noop,
    onSideChat: noop,
    onTerminal: noop,
    onTerminalResize: noop,
    onTerminalStart: noop,
    onTerminalStop: noop,
    onTerminalWrite: noop,
  },
};

function contribution(id: string, label: string): CommandWorkspaceHostModule {
  function Content({ active }: { active: boolean }) {
    const [revision, setRevision] = useState(1);
    return (
      <article data-plugin-fixture={id} data-active={String(active)}>
        <output>{revision}</output>
        <button onClick={() => setRevision((value) => value + 1)}>
          编辑产物
        </button>
      </article>
    );
  }
  return { id, label, content: (state) => <Content {...state} /> };
}
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.history.replaceState(null, "", "/#view-command");
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
async function render(
  props: Partial<ComponentProps<typeof AppCommandShellRoute>> = {},
) {
  await act(async () =>
    root.render(<AppCommandShellRoute {...base} {...props} />),
  );
}
async function click(selector: string) {
  const button = container.querySelector<HTMLButtonElement>(selector);
  expect(button).not.toBeNull();
  await act(async () => button!.click());
}
async function openPlugin(id: string) {
  if (!container.querySelector(`[data-host-module-target="${id}"]`))
    await click('[data-nav-key="resources"]');
  await click(`[data-host-module-target="${id}"]`);
}

describe("plugin panels in the formal Agent shell", () => {
  it("contains original absolute shell views inside the plugin content row instead of covering the host header", async () => {
    const style = document.createElement("style");
    style.textContent =
      readFileSync(
        new NodeURL("./CommandWorkspacePluginPanel.css", import.meta.url),
        "utf8",
      ) + "\n.shell-view { position: absolute; inset: 0px; }";
    document.head.append(style);
    try {
      await render({ hostModules: [contribution("fixture", "项目产物")] });
      await openPlugin("fixture");
      const pane = container.querySelector<HTMLElement>(
        '.command-plugin-panels > [data-host-module-id="fixture"]',
      )!;
      expect(pane.closest(".command-plugin-panel-target")).not.toBeNull();
      expect(getComputedStyle(pane).position).toBe("relative");
      expect(getComputedStyle(pane).inset).toBe("auto");
      expect(
        container.querySelector(".command-plugin-panel-header"),
      ).not.toBeNull();
    } finally {
      style.remove();
    }
  });
  it.each([
    { width: 640, height: 360 },
    { width: 360, height: 320 },
    { width: 800, height: 600 },
  ])(
    "makes the two 220px surfaces reachable at $width × $height without turning the plugin into an overlay",
    async ({ width, height }) => {
      const viewport = window as unknown as {
        happyDOM: {
          setWindowSize(size: { width: number; height: number }): void;
        };
      };
      const previousSize = {
        width: window.innerWidth,
        height: window.innerHeight,
      };
      viewport.happyDOM.setWindowSize({ width, height });
      const originalStyles: string = readFileSync(
        new NodeURL(
          "../../styles/original-shell-overrides.css",
          import.meta.url,
        ),
        "utf8",
      );
      const routeBaseStart = originalStyles.indexOf(".command-shell-route {");
      expect(routeBaseStart).toBeGreaterThan(-1);
      const style = document.createElement("style");
      // Load the real narrow overlay and plugin rules before the later shell
      // base rule, so the regression also catches insufficient specificity.
      style.textContent = [
        readFileSync(
          new NodeURL("./AppCommandShellRoute.css", import.meta.url),
          "utf8",
        ),
        readFileSync(
          new NodeURL("./CommandWorkspacePluginPanel.css", import.meta.url),
          "utf8",
        ),
        originalStyles.slice(
          routeBaseStart,
          originalStyles.indexOf("}", routeBaseStart) + 1,
        ),
      ].join("\n");
      document.head.append(style);
      try {
        await render({ hostModules: [contribution("fixture", "项目产物")] });
        await openPlugin("fixture");
        const route = container.querySelector<HTMLElement>(
          ".command-shell-route",
        )!;
        const panel =
          container.querySelector<HTMLElement>(".command-workbench")!;
        const composer = container.querySelector(
          '[data-shell-view="command"] textarea',
        );
        expect(window.matchMedia("(max-width: 880px)").matches).toBe(true);
        expect(window.getComputedStyle(route).overflowY).toBe("auto");
        expect(
          window
            .getComputedStyle(route)
            .gridTemplateRows.match(/minmax\(\s*220px,\s*1fr\s*\)/gu),
        ).toHaveLength(2);
        expect(window.getComputedStyle(panel).position).toBe("relative");
        expect(window.getComputedStyle(panel).gridRow).toBe("3");
        expect(
          window.getComputedStyle(
            panel.querySelector<HTMLElement>(".command-plugin-panel-target")!,
          ).overflow,
        ).toBe("auto");
        expect(composer).not.toBeNull();
        await click('[aria-label="关闭插件面板"]');
        expect(route.hasAttribute("data-plugin-panel-open")).toBe(false);
        expect(window.getComputedStyle(route).overflow).toBe("hidden");
        expect(
          container.querySelector('[data-shell-view="command"] textarea'),
        ).toBe(composer);
      } finally {
        style.remove();
        viewport.happyDOM.setWindowSize(previousSize);
      }
    },
  );

  it("keeps the original conversation, composer and capabilities while switching and closing right-panel modules", async () => {
    const modules = [
      contribution("fixture-a", "项目 A"),
      contribution("fixture-b", "项目 B"),
    ];
    await render({ hostModules: modules });
    const conversation = container.querySelector('[data-shell-view="command"]');
    const composer = conversation!.querySelector("textarea");
    const capabilityControls = [...conversation!.querySelectorAll("button")];
    await openPlugin("fixture-a");
    const panel = container.querySelector<HTMLElement>(".command-workbench")!;
    const fixture = panel.querySelector('[data-plugin-fixture="fixture-a"]')!;
    expect(panel.hidden).toBe(false);
    expect(container.querySelectorAll(".command-workbench")).toHaveLength(1);
    expect(conversation!.contains(fixture)).toBe(false);
    expect((conversation as HTMLElement).hidden).toBe(false);
    expect(conversation!.querySelector("textarea")).toBe(composer);
    expect(composer?.value).toBe("原来的输入草稿");
    expect([...conversation!.querySelectorAll("button")]).toEqual(
      capabilityControls,
    );
    expect(
      container.querySelector(".command-panel-heading > strong")?.textContent,
    ).toBe("原 Agent 会话");
    expect(
      panel.querySelector(".command-plugin-panel-header > strong")?.textContent,
    ).toBe("项目 A");
    expect(panel.querySelector('[aria-label="全屏工作台"]')).toBeNull();
    await click('[data-plugin-fixture="fixture-a"] button');
    await openPlugin("fixture-b");
    expect(panel.querySelector('[data-plugin-fixture="fixture-a"]')).toBe(
      fixture,
    );
    expect(fixture.closest<HTMLElement>("[data-host-module-id]")?.hidden).toBe(
      true,
    );
    await openPlugin("fixture-a");
    expect(fixture.querySelector("output")?.textContent).toBe("2");
    await click('[aria-label="关闭插件面板"]');
    expect(panel.hidden).toBe(true);
    expect(conversation!.querySelector("textarea")).toBe(composer);
    expect(
      container
        .querySelector(".command-sidebar-workspaces")
        ?.getAttribute("hidden"),
    ).toBeNull();
  });

  it("uses the original resizer and restores already open desktop tool tabs after closing a plugin", async () => {
    const capabilityClose = vi.fn();
    const capabilityDrawer = {
      ...base.capabilityDrawer,
      open: true,
      onClose: capabilityClose,
    };
    await render({
      platform: "mac",
      capabilityDrawer,
      hostModules: [contribution("fixture", "插件项目")],
    });
    const panel = container.querySelector<HTMLElement>(".command-workbench")!;
    const toolSurface = panel.querySelector(".command-workbench-launcher");
    await openPlugin("fixture");
    const separator = panel.querySelector('[role="separator"]')!;
    const width = Number.parseInt(panel.style.width, 10);
    await act(async () =>
      separator.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      ),
    );
    expect(panel.style.width).toBe(`${width - 24}px`);
    await click('[aria-label="关闭插件面板"]');
    expect(panel.hidden).toBe(false);
    expect(panel.querySelector(".command-workbench-launcher")).toBe(
      toolSurface,
    );
    expect(capabilityClose).not.toHaveBeenCalled();
  });

  it("withdraws failed-directory content in the panel and keeps the original conversation visible", async () => {
    const module = contribution("fixture", "项目产物");
    const available = {
      state: "available" as const,
      ownerKey: {},
      retry: vi.fn(),
    };
    await render({ hostModules: [module], hostModuleAvailability: available });
    await openPlugin(module.id);
    const composer = container.querySelector(
      '[data-shell-view="command"] textarea',
    );
    await render({
      hostModules: [module],
      hostModuleAvailability: { ...available, state: "unavailable" },
    });
    const panel = container.querySelector<HTMLElement>(".command-workbench")!;
    expect(panel.hidden).toBe(false);
    expect(panel.querySelector("[data-plugin-fixture]")).toBeNull();
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain(
      "模块暂时不可用",
    );
    expect(
      container.querySelector('[data-shell-view="command"] textarea'),
    ).toBe(composer);
    expect(
      container.querySelector<HTMLElement>('[data-shell-view="command"]')
        ?.hidden,
    ).toBe(false);
    await render({ hostModules: [], hostModuleAvailability: available });
    expect(container.querySelector("[data-host-module-id]")).toBeNull();
    expect(container.querySelector(".command-workbench")).toBeNull();
  });

  it("has no plugin surface or desktop tool launcher in an empty Web profile", async () => {
    await render({ hostModules: [] });
    expect(container.querySelector(".command-workbench")).toBeNull();
    expect(container.querySelector("[data-host-module-target]")).toBeNull();
    expect(container.querySelector('[aria-label="打开工作台"]')).toBeNull();
    expect(
      container.querySelector('[data-shell-view="command"] textarea'),
    ).not.toBeNull();
  });

  it("opens a host planning request in the right panel and Escape closes it while keeping the Agent draft", async () => {
    await render({
      hostModules: [contribution("fixture", "项目阶段")],
      hostModuleRequest: { id: "fixture", requestKey: "planning-request-1" },
    });
    const conversation = container.querySelector<HTMLElement>(
      '[data-shell-view="command"]',
    )!;
    const composer = conversation.querySelector("textarea");
    const panel = container.querySelector<HTMLElement>(".command-workbench")!;
    expect(panel.hidden).toBe(false);
    expect(conversation.hidden).toBe(false);
    await act(async () =>
      panel.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(panel.hidden).toBe(true);
    expect(conversation.querySelector("textarea")).toBe(composer);
    expect(composer?.value).toBe("原来的输入草稿");
  });

  it("snapshots the quiet plugin header with only a title and a working close action", () => {
    expect(
      renderToStaticMarkup(
        <CommandWorkspacePluginPanelHeader
          selection={{ id: "fixture", label: "项目产物", close: noop }}
          locale="zh"
        />,
      ),
    ).toMatchSnapshot();
  });
});
