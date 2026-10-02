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
import {
  LOCAL_APPEARANCE_KEY,
  persistLocalAppearanceField,
  readLocalAppearance,
} from "../../lib/appearance/localAppearanceStore";
import { getInitialLocale, persistLocale } from "../../lib/i18n";
import { THEME_STORAGE_KEY } from "../../lib/theme";
import {
  settingsCatalog,
  settingsSectionLabel,
} from "../../lib/settings/settingsCatalog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let restoreStorageWrite: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-03T12:00:00+08:00"));
  window.history.replaceState(null, "", "/");
  initializeShortDramaPreviewSurface();
  window.localStorage.removeItem(LOCAL_APPEARANCE_KEY);
  window.localStorage.removeItem(THEME_STORAGE_KEY);
  persistLocale("zh");
  setAppliedAppearance(DEFAULT_APPEARANCE);
  document.documentElement.dataset.theme = "light";
});
afterEach(async () => {
  restoreStorageWrite?.();
  restoreStorageWrite = null;
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
  window.localStorage.removeItem(LOCAL_APPEARANCE_KEY);
  window.localStorage.removeItem(THEME_STORAGE_KEY);
  window.localStorage.removeItem("crewon-ui-locale");
});

async function click(element: Element | null) {
  expect(element).not.toBeNull();
  await act(async () =>
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
}

async function mountPreview() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(<ShortDramaPluginPreview referenceImage="/sample.png" />),
  );
  return container;
}

async function openSettings() {
  await click(container!.querySelector('.sidebar-account [role="menuitem"]'));
  return container!.querySelector<HTMLElement>(".settings-command-screen")!;
}

async function openSection(section: string) {
  await click(
    [...container!.querySelectorAll(".settings-nav-group button")].find(
      (button) => button.querySelector("strong")?.textContent === section,
    ) ?? null,
  );
}

function settingField(label: string) {
  return [...container!.querySelectorAll(".settings-field-list > label")].find(
    (field) => field.querySelector("strong")?.textContent === label,
  )!;
}

async function editNumber(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function commitNumber(input: HTMLInputElement) {
  await act(async () =>
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })),
  );
}

async function chooseLocale(label: string) {
  const trigger = settingField("语言").querySelector('[role="combobox"]')!;
  await act(async () =>
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
      }),
    ),
  );
  await click(
    [...document.querySelectorAll('[role="option"]')].find(
      (option) => option.textContent?.trim() === label,
    ) ?? null,
  );
}

function rejectStorageWrites() {
  // happy-dom binds Storage methods on a Proxy; assignment-based spy restore
  // cannot replace those methods after binding. Restore its actual descriptor.
  const storage = window.localStorage;
  const original = storage.setItem;
  Object.defineProperty(storage, "setItem", {
    configurable: true,
    writable: true,
    value: () => {
      throw new Error("denied");
    },
  });
  restoreStorageWrite = () =>
    Object.defineProperty(storage, "setItem", {
      configurable: true,
      writable: true,
      value: original,
    });
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
    expect(markup).not.toContain('class="sidebar-account"');
    expect(markup).toContain("让 CrewON 完成你的工作");
  });

  it("opens every existing settings page from the signed-out footer and returns to the same project without requests or writes", async () => {
    persistLocalAppearanceField("uiFontSize", "17");
    const savedAppearance = window.localStorage.getItem(LOCAL_APPEARANCE_KEY);
    const storageWrite = vi.spyOn(window.localStorage, "setItem");
    const fetch = vi.spyOn(globalThis, "fetch");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(<ShortDramaPluginPreview referenceImage="/sample.png" />),
    );
    const shell = container.querySelector<HTMLElement>(
      ".short-drama-plugin-preview",
    )!;
    // The unchanged shell initializes its existing local unread-event cache on mount.
    // Observe settings interactions after that unrelated initialization.
    storageWrite.mockClear();
    const sidebar = shell.querySelector(".command-sidebar");
    const footer = sidebar!.querySelector(".sidebar-account")!;
    expect(footer.getAttribute("aria-label")).toBe("账号");
    expect(footer.textContent).toContain("未登录");
    expect(footer.textContent).toContain("页面预览");
    expect(footer.textContent).not.toContain("退出登录");
    expect(container.querySelector(".settings-command-screen")).toBeNull();
    await click(
      sidebar!.querySelector('[data-host-module-target="crewon.short-drama"]'),
    );
    const pane = shell.querySelector<HTMLElement>(
      '[data-host-module-id="crewon.short-drama"]',
    )!;
    await click(pane.querySelector(".project-grid button"));
    const projectName = pane.querySelector(".page-heading h1")!.textContent;
    await click(shell.querySelector(".command-workbench-trigger"));
    const workbench = shell.querySelector<HTMLElement>(".command-workbench")!;
    expect(workbench.hidden).toBe(false);
    const menu = footer.querySelector<HTMLDetailsElement>("details")!;
    menu.open = true;
    await click(footer.querySelector('[role="menuitem"]'));
    expect(menu.open).toBe(false);
    expect(shell.hidden).toBe(true);
    expect(workbench.hidden).toBe(true);
    const settings = container.querySelector<HTMLElement>(
      ".settings-command-screen",
    )!;
    expect(settings).not.toBeNull();
    expect(settings.textContent).toContain("设置暂不可用");
    for (const group of settingsCatalog) {
      for (const item of group.items) {
        const button = [
          ...settings.querySelectorAll(".settings-nav-group button"),
        ].find(
          (candidate) =>
            candidate.querySelector("strong")?.textContent ===
            settingsSectionLabel(item.id, "zh"),
        );
        await click(button ?? null);
        expect(
          settings.querySelector<HTMLElement>(".settings-page")?.dataset
            .section,
        ).toBe(item.id);
      }
    }
    await click(
      [...settings.querySelectorAll(".settings-nav-group button")].find(
        (button) => button.querySelector("strong")?.textContent === "外观",
      ) ?? null,
    );
    const appearance = settings.querySelector<HTMLInputElement>(
      'input[type="number"]',
    )!;
    expect(appearance.value).toBe("17");
    expect(appearance.disabled).toBe(false);
    expect(
      settings.querySelector(".settings-page")?.getAttribute("data-mode"),
    ).toBe("live");
    const search = settings.querySelector<HTMLInputElement>(
      ".settings-search input",
    )!;
    search.focus();
    const shortcut = new KeyboardEvent("keydown", {
      key: "p",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => document.dispatchEvent(shortcut));
    expect(shortcut.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(search);
    await click(settings.querySelector(".settings-back-button"));
    expect(shell.hidden).toBe(false);
    expect(workbench.hidden).toBe(false);
    expect(pane.querySelector(".page-heading h1")?.textContent).toBe(
      projectName,
    );
    expect(shell.querySelector(".command-sidebar")).toBe(sidebar);
    expect(
      shell.querySelector('[data-host-module-id="crewon.short-drama"]'),
    ).toBe(pane);
    expect(window.localStorage.getItem(LOCAL_APPEARANCE_KEY)).toBe(
      savedAppearance,
    );
    expect(storageWrite).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("saves and applies local theme and font size while keeping the same project mounted", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await mountPreview();
    await click(
      container!.querySelector(
        '[data-host-module-target="crewon.short-drama"]',
      ),
    );
    const pane = container!.querySelector<HTMLElement>(
      '[data-host-module-id="crewon.short-drama"]',
    )!;
    await click(pane.querySelector(".project-grid button"));
    const projectName = pane.querySelector(".page-heading h1")!.textContent;
    const settings = await openSettings();
    await openSection("外观");
    await click(
      [...settingField("主题").querySelectorAll('[role="radio"]')].find(
        (button) => button.textContent === "深色",
      ) ?? null,
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(readLocalAppearance()?.themeMode).toBe("dark");
    const size =
      settingField("界面字号").querySelector<HTMLInputElement>("input")!;
    await editNumber(size, "999");
    expect(size.value).toBe("999");
    expect(readLocalAppearance()?.uiFontSize).toBe(
      DEFAULT_APPEARANCE.uiFontSize,
    );
    await commitNumber(size);
    expect(size.value).toBe("18");
    expect(readLocalAppearance()?.uiFontSize).toBe(18);
    expect(
      document.documentElement.style.getPropertyValue("--user-ui-font-size"),
    ).toBe("18px");
    await openSection("键盘快捷键");
    expect(
      settings.querySelector(".settings-page")?.getAttribute("data-mode"),
    ).toBe("live");
    expect(settings.textContent).toContain("快捷键目前不可自定义");
    await click(
      [...settings.querySelectorAll("button")].find(
        (b) => b.textContent === "刷新",
      ) ?? null,
    );
    expect(settings.textContent).not.toContain("设置暂不可用");
    await openSection("外观");
    expect(
      settingField("界面字号").querySelector<HTMLInputElement>("input")!.value,
    ).toBe("18");
    await click(settings.querySelector(".settings-back-button"));
    expect(
      container!.querySelector('[data-host-module-id="crewon.short-drama"]'),
    ).toBe(pane);
    expect(pane.hidden).toBe(false);
    expect(pane.querySelector(".page-heading h1")!.textContent).toBe(
      projectName,
    );
    await openSettings();
    expect(
      settingField("界面字号").querySelector<HTMLInputElement>("input")!.value,
    ).toBe("18");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("persists language and updates the existing shell without losing its project", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await mountPreview();
    await click(
      container!.querySelector(
        '[data-host-module-target="crewon.short-drama"]',
      ),
    );
    const pane = container!.querySelector<HTMLElement>(
      '[data-host-module-id="crewon.short-drama"]',
    )!;
    await click(pane.querySelector(".project-grid button"));
    const projectName = pane.querySelector(".page-heading h1")!.textContent;
    const settings = await openSettings();
    await openSection("外观");
    await chooseLocale("English");
    expect(getInitialLocale()).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(
      settings.querySelector(".settings-page")?.getAttribute("data-mode"),
    ).toBe("live");
    expect(settings.textContent).toContain("Appearance");
    expect(
      container!
        .querySelector('[data-od-id="desktop-command-screen"]')
        ?.getAttribute("data-locale"),
    ).toBe("en");
    await click(settings.querySelector(".settings-back-button"));
    expect(
      container!.querySelector('[data-host-module-id="crewon.short-drama"]'),
    ).toBe(pane);
    expect(pane.querySelector(".page-heading h1")!.textContent).toBe(
      projectName,
    );
    expect(container!.querySelector(".sidebar-account")!.textContent).toContain(
      "Signed out",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rolls back a font draft and reports failed local persistence without applying it", async () => {
    persistLocalAppearanceField("uiFontSize", "15");
    setAppliedAppearance(readLocalAppearance()!);
    await mountPreview();
    const settings = await openSettings();
    await openSection("外观");
    const size =
      settingField("界面字号").querySelector<HTMLInputElement>("input")!;
    const saved = window.localStorage.getItem(LOCAL_APPEARANCE_KEY);
    rejectStorageWrites();
    await editNumber(size, "17");
    expect(size.value).toBe("17");
    await commitNumber(size);
    expect(size.value).toBe("15");
    expect(
      document.documentElement.style.getPropertyValue("--user-ui-font-size"),
    ).toBe("15px");
    expect(window.localStorage.getItem(LOCAL_APPEARANCE_KEY)).toBe(saved);
    expect(settings.querySelector('[role="status"]')!.textContent).toContain(
      "无法保存到本机存储",
    );
    expect(settings.textContent).not.toContain("已保存");
  });

  it("does not switch the shell language when its storage write fails", async () => {
    await mountPreview();
    const settings = await openSettings();
    await openSection("外观");
    rejectStorageWrites();
    await chooseLocale("English");
    expect(getInitialLocale()).toBe("zh");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(
      container!
        .querySelector('[data-od-id="desktop-command-screen"]')
        ?.getAttribute("data-locale"),
    ).toBe("zh");
    expect(
      settingField("语言").querySelector('[role="combobox"]')!.textContent,
    ).toBe("中文");
    expect(settings.querySelector('[role="status"]')!.textContent).toContain(
      "无法保存到本机存储",
    );
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
