// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandWorkspace } from "./CommandWorkspace";
import {
  initializeShortDramaPreviewSurface,
  ShortDramaPluginPreview,
} from "./ShortDramaPluginPreview";
import {
  detectOperatingSystem,
  detectPlatform,
  detectRuntimeSurface,
  hasDesktopBridge,
} from "../../lib/platform";
import { DEFAULT_APPEARANCE } from "../../lib/appearance/appearancePreferences";
import { setAppliedAppearance } from "../../lib/appearance/appearanceRuntime";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-03T12:00:00+08:00"));
  window.history.replaceState(null, "", "/");
  initializeShortDramaPreviewSurface();
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.classList.remove("modal-open");
  document.documentElement.removeAttribute("style");
  for (const attribute of [...document.documentElement.attributes])
    if (attribute.name.startsWith("data-"))
      document.documentElement.removeAttribute(attribute.name);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function click(element: Element | null) {
  expect(element).not.toBeNull();
  await act(async () =>
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
}

describe("ShortDramaPluginPreview", () => {
  it("keeps the existing homepage and navigation with a hidden module slot", () => {
    const markup = renderToStaticMarkup(
      <ShortDramaPluginPreview referenceImage="/sample.png" />,
    );
    expect(markup).toContain("让 CrewON 完成你的工作");
    expect(markup).toContain('class="desktop-window-frame"');
    expect(markup).toContain('class="desktop-window-controls-slot"');
    expect(markup).toContain('class="desktop-window-drag-strip"');
    expect(markup).toContain('data-od-id="desktop-command-screen"');
    expect(markup).toContain('data-host-module-target="crewon.short-drama"');
    expect(markup).toContain(
      'data-host-module-id="crewon.short-drama" hidden=""',
    );
    expect(markup).toContain('data-nav-key="team"');
    expect(markup).toContain("command-workbench-trigger");
    expect(markup).toContain('data-capability-sidebar-open="false"');
    expect(markup).not.toContain("short-drama-preview-navigation");
    expect(markup).not.toContain('class="drama-sidebar"');
    expect(markup).toMatchSnapshot();
  });

  it("opens in the host pane, returns to original views, and preserves module state without requests", async () => {
    // Observe network calls; the production shell and business components are not mocked.
    const fetch = vi.spyOn(globalThis, "fetch");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(<ShortDramaPluginPreview referenceImage="/sample.png" />),
    );
    const pane = container.querySelector<HTMLElement>(
      '[data-host-module-id="crewon.short-drama"]',
    )!;
    const sidebar = container.querySelector(".command-sidebar");
    const homepage = container.querySelector<HTMLElement>(
      '[data-shell-view="command"]',
    )!;
    expect(homepage.hidden).toBe(false);
    expect(pane.hidden).toBe(true);
    await click(container.querySelector('[data-window-action="close"]'));
    expect(hasDesktopBridge()).toBe(false);
    await click(
      container.querySelector('[data-host-module-target="crewon.short-drama"]'),
    );
    expect(pane.hidden).toBe(false);
    expect(homepage.hidden).toBe(true);
    expect(container.querySelector(".command-sidebar")).toBe(sidebar);
    const list = pane.querySelector<HTMLElement>(".project-grid")!;
    const firstProject = list.querySelector("button")!;
    const projectName = firstProject.querySelector("h2")!.textContent;
    await click(firstProject);
    expect(pane.querySelector(".page-heading h1")?.textContent).toBe(
      projectName,
    );
    await click(container.querySelector('[data-nav-key="team"]'));
    expect(pane.hidden).toBe(true);
    expect(
      container.querySelector<HTMLElement>('[data-shell-view="team"]')?.hidden,
    ).toBe(false);
    expect(window.location.hash).toBe("#view-team");
    await click(
      container.querySelector('[data-host-module-target="crewon.short-drama"]'),
    );
    expect(pane.querySelector(".page-heading h1")?.textContent).toBe(
      projectName,
    );
    await click(container.querySelector('[data-nav-key="command"]'));
    expect(pane.hidden).toBe(true);
    expect(homepage.hidden).toBe(false);
    expect(window.location.hash).toBe("#view-command");
    expect(container.querySelector(".command-sidebar")).toBe(sidebar);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not register a business module in the default host", () => {
    const markup = renderToStaticMarkup(
      <CommandWorkspace
        composerValue=""
        connectionState="disconnected"
        cwd=""
        isSending={false}
        workMode="office"
        onAttachContext={() => undefined}
        onChangeComposerValue={() => undefined}
        onModeChange={() => undefined}
        onRetryConnection={() => undefined}
        onSend={() => undefined}
      />,
    );
    expect(markup).not.toContain("data-host-module-");
    expect(markup).toContain("让 CrewON 完成你的工作");
  });

  it("keeps the real desktop frame and appearance detection aligned without granting a native bridge", () => {
    window.history.replaceState(
      { preview: true },
      "",
      "/?theme=light&project=story#view-team",
    );
    initializeShortDramaPreviewSurface();
    const params = new URLSearchParams(window.location.search);
    expect(params.get("theme")).toBe("light");
    expect(params.get("project")).toBe("story");
    expect(window.location.hash).toBe("#view-team");
    expect(window.history.state).toEqual({ preview: true });
    expect(detectRuntimeSurface()).toBe("desktop");
    expect(detectPlatform()).toBe("mac");
    expect(detectOperatingSystem()).toBe("mac");
    expect(hasDesktopBridge()).toBe(false);
    const before = renderToStaticMarkup(
      <ShortDramaPluginPreview referenceImage="/sample.png" />,
    );
    setAppliedAppearance({
      ...DEFAULT_APPEARANCE,
      themeMode: "light",
      translucentSidebar: true,
    });
    expect(document.documentElement.dataset.surface).toBe("desktop");
    expect(document.documentElement.dataset.os).toBe("mac");
    expect(document.documentElement.dataset.translucentSidebar).toBe("true");
    const after = renderToStaticMarkup(
      <ShortDramaPluginPreview referenceImage="/sample.png" />,
    );
    expect(after).toBe(before);
    expect(after).toContain('data-window-platform="mac"');
    expect(after).toContain('data-window-controls="native"');
    expect(after).toContain('data-desktop-drag-region=""');
  });

  it("uses the original sidebar collapse and right workbench controls across module and original views", async () => {
    const width = vi.spyOn(window, "innerWidth", "get").mockReturnValue(767);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(<ShortDramaPluginPreview referenceImage="/sample.png" />),
    );
    const host = container.querySelector<HTMLElement>(".command-shell-route")!;
    const commandWindow =
      container.querySelector<HTMLElement>(".command-window")!;
    const sidebar = container.querySelector(".command-sidebar");
    expect(host.querySelector('[aria-label="打开导航"]')).toBeNull();
    expect(host.querySelector('[aria-label="关闭导航"]')).toBeNull();
    expect(container.querySelectorAll(".command-sidebar")).toHaveLength(1);
    const collapse = sidebar!.querySelector("[data-sidebar-collapse]");
    await click(collapse);
    expect(commandWindow.classList.contains("sidebar-collapsed")).toBe(true);
    await click(collapse);
    expect(commandWindow.classList.contains("sidebar-collapsed")).toBe(false);
    await click(
      sidebar!.querySelector('[data-host-module-target="crewon.short-drama"]'),
    );
    expect(commandWindow.classList.contains("sidebar-collapsed")).toBe(false);
    expect(
      container.querySelector<HTMLElement>(
        '[data-host-module-id="crewon.short-drama"]',
      )?.hidden,
    ).toBe(false);
    const workbench = host.querySelector<HTMLElement>(".command-workbench")!;
    expect(workbench.hidden).toBe(true);
    await click(host.querySelector(".command-workbench-trigger"));
    expect(workbench.hidden).toBe(false);
    expect(host.dataset.capabilitySidebarOpen).toBe("true");
    expect(host.querySelector(".command-workbench-trigger")).toBeNull();
    await click(sidebar!.querySelector('[data-nav-key="team"]'));
    expect(workbench.hidden).toBe(false);
    expect(
      container.querySelector<HTMLElement>('[data-shell-view="team"]')?.hidden,
    ).toBe(false);
    width.mockReturnValue(1440);
    await act(async () => window.dispatchEvent(new Event("resize")));
    const resize = workbench.querySelector<HTMLElement>('[role="separator"]')!;
    const previousWidth = Number(resize.getAttribute("aria-valuenow"));
    await act(async () =>
      resize.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      ),
    );
    expect(Number(resize.getAttribute("aria-valuenow"))).toBe(
      previousWidth + 24,
    );
    expect(workbench.style.width).toBe(`${previousWidth + 24}px`);
    await click(host.querySelector('[aria-label="关闭工作台"]'));
    expect(workbench.hidden).toBe(true);
    expect(host.dataset.capabilitySidebarOpen).toBe("false");
    expect(host.querySelector(".command-workbench-trigger")).not.toBeNull();
    await click(sidebar!.querySelector('[data-nav-key="command"]'));
    expect(host.querySelector(".command-workbench-trigger")).not.toBeNull();
    expect(commandWindow.classList.contains("sidebar-collapsed")).toBe(false);
    expect(container.querySelector(".command-sidebar")).toBe(sidebar);
    width.mockRestore();
  });
});
