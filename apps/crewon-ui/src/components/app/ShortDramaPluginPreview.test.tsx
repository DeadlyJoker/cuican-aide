// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandWorkspace } from "./CommandWorkspace";
import { ShortDramaPluginPreview } from "./ShortDramaPluginPreview";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-03T12:00:00+08:00"));
  window.history.replaceState(null, "", "/");
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
    expect(markup).toContain('data-od-id="desktop-command-screen"');
    expect(markup).toContain('data-host-module-target="crewon.short-drama"');
    expect(markup).toContain(
      'data-host-module-id="crewon.short-drama" hidden=""',
    );
    expect(markup).toContain('data-nav-key="team"');
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

  it("uses the same sidebar as a narrow preview drawer and closes it when selecting original pages", async () => {
    const width = vi.spyOn(window, "innerWidth", "get").mockReturnValue(767);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(<ShortDramaPluginPreview referenceImage="/sample.png" />),
    );
    const host = container.querySelector<HTMLElement>(
      ".short-drama-plugin-preview",
    )!;
    const sidebar = container.querySelector(".command-sidebar");
    const trigger = host.querySelector('[aria-label="打开导航"]')!;
    expect(host.dataset.previewNavigationOpen).toBe("false");
    await click(trigger);
    expect(host.dataset.previewNavigationOpen).toBe("true");
    expect(container.querySelectorAll(".command-sidebar")).toHaveLength(1);
    await click(
      sidebar!.querySelector('[data-host-module-target="crewon.short-drama"]'),
    );
    expect(host.dataset.previewNavigationOpen).toBe("false");
    expect(
      container.querySelector<HTMLElement>(
        '[data-host-module-id="crewon.short-drama"]',
      )?.hidden,
    ).toBe(false);
    await click(trigger);
    await click(sidebar!.querySelector('[data-nav-key="team"]'));
    expect(host.dataset.previewNavigationOpen).toBe("false");
    expect(
      container.querySelector<HTMLElement>('[data-shell-view="team"]')?.hidden,
    ).toBe(false);
    await click(trigger);
    await click(sidebar!.querySelector("[data-sidebar-collapse]"));
    expect(host.dataset.previewNavigationOpen).toBe("false");
    expect(
      container
        .querySelector(".command-window")
        ?.classList.contains("sidebar-collapsed"),
    ).toBe(false);
    await click(trigger);
    await click(host.querySelector('[aria-label="关闭导航"]'));
    expect(host.dataset.previewNavigationOpen).toBe("false");
    expect(container.querySelector(".command-sidebar")).toBe(sidebar);
    width.mockRestore();
  });
});
