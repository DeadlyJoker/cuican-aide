import { describe, expect, it } from "vitest";
import {
  PLUGIN_UI_NAVIGATION_ACTIONS as actions,
  parsePluginUiNavigationRequest,
} from "@crewon/contracts/plugins";
import { PluginUiPageNavigation } from "./pluginUiPageNavigation";
import type { ControlPluginUiCatalog } from "./controlPluginUiCatalog";
import { uiLease } from "./pluginUiLoader.test-support";
import { controlUiItem } from "./controlPluginUi.test-support";
function fixture() {
  const lease = uiLease();
  const item = controlUiItem(lease);
  let catalog: ControlPluginUiCatalog | null = {
    plugins: [item],
    modules: [
      {
        key: "module",
        mountKey: "mount",
        title: "工作台",
        contributionId: "workbench",
        plugin: item,
      },
    ],
    fingerprint: "first",
  };
  let current = true;
  let serial = 0;
  const pages = new PluginUiPageNavigation({
    catalog: () => catalog,
    assertCurrent() {
      if (!current) throw new Error("session_revoked");
    },
    nextId: () => `page-${++serial}`,
  });
  const invoke = (action: string, input: unknown) =>
    pages.invoke(
      lease,
      parsePluginUiNavigationRequest(action, input),
      new AbortController().signal,
    );
  const open = (key = "plan", mode: "reuse" | "new" = "reuse") =>
    invoke(actions.openPage, {
      contributionId: "workbench",
      key,
      title: "方案",
      mode,
      context: { view: key },
    });
  return {
    pages,
    lease,
    invoke,
    open,
    setCatalog(value: ControlPluginUiCatalog | null) {
      catalog = value;
    },
    revoke() {
      current = false;
    },
  };
}
describe("leased plugin page lifecycle", () => {
  it("closing the last page of one plugin activates another plugin page instead of hiding the whole workbench", () => {
    const f = fixture(),
      first = controlUiItem(f.lease),
      second = controlUiItem({
        ...f.lease,
        descriptor: { ...f.lease.descriptor, pluginId: "example.other" },
      });
    f.setCatalog({
      plugins: [first, second],
      modules: [
        {
          key: "module",
          mountKey: "first",
          title: "短剧",
          contributionId: "workbench",
          plugin: first,
        },
        {
          key: "other",
          mountKey: "second",
          title: "出行",
          contributionId: "workbench",
          plugin: second,
        },
      ],
      fingerprint: "two",
    });
    f.pages.openHomeFromHost("other");
    f.pages.openHomeFromHost("module");
    const [other, current] = f.pages.snapshot().pages;
    f.pages.closeFromHost(current.pageId);
    expect(f.pages.snapshot().pages).toEqual([other]);
    expect(f.pages.snapshot().request).toMatchObject({
      id: other.routeId,
      panelOpen: true,
    });
  });
  it("opens one home tab from navigation and closing one page preserves another page", () => {
    const f = fixture();
    f.pages.openHomeFromHost("module");
    f.pages.openHomeFromHost("module");
    expect(f.pages.snapshot().pages).toHaveLength(1);
    f.pages.openFromHost("module");
    const pages = f.pages.snapshot().pages;
    expect(pages).toHaveLength(2);
    f.pages.closeFromHost(pages[1].pageId);
    expect(f.pages.snapshot().pages).toEqual([pages[0]]);
    expect(f.pages.snapshot().request?.id).toBe(pages[0].routeId);
    f.pages.activateFromHost(pages[0].pageId);
    expect(f.pages.snapshot().request?.panelOpen).toBe(true);
  });
  it("reuses requested pages and supports independent new instances", async () => {
    const f = fixture();
    await f.open();
    await f.open();
    expect(f.pages.snapshot().pages).toHaveLength(1);
    await f.open("plan", "new");
    expect(f.pages.snapshot().pages).toHaveLength(2);
    expect(f.pages.snapshot().pages[0].context).toEqual({ view: "plan" });
  });
  it("keeps the original home instance and differentiates additional pages", () => {
    const f = fixture();
    f.pages.openFromHost("module");
    expect(f.pages.snapshot().pages).toHaveLength(1);
    f.pages.openFromHost("module");
    const pages = f.pages.snapshot().pages;
    expect(pages).toHaveLength(2);
    expect(pages[0].home).toBe(true);
    expect(pages[0].routeId).toBe("module");
    expect(pages[1].title).toBe("工作台 2");
    expect(pages[1].pageId).not.toBe(pages[0].pageId);
  });
  it("retains metadata during temporary catalog reads, withdraws on fresh removal", async () => {
    const f = fixture();
    await f.open();
    f.setCatalog(null);
    f.pages.synchronize();
    expect(f.pages.snapshot().pages).toHaveLength(1);
    await expect(f.open()).rejects.toThrow("plugin_ui_catalog_unavailable");
    f.setCatalog({ plugins: [], modules: [], fingerprint: "empty" });
    f.pages.synchronize();
    expect(f.pages.snapshot().pages).toHaveLength(0);
  });
  it("blocks stale sources and foreign page ids", async () => {
    const f = fixture();
    await expect(
      f.invoke(actions.activatePage, { pageId: "foreign" }),
    ).rejects.toThrow("plugin_ui_page_unavailable");
    f.revoke();
    await expect(f.open()).rejects.toThrow("session_revoked");
  });
  it("bounds mounted instances without removing existing drafts", async () => {
    const f = fixture();
    for (let i = 0; i < 8; i++) await f.open(`${i}`);
    await expect(f.open("extra")).rejects.toThrow(
      "plugin_ui_page_capacity_exceeded",
    );
    expect(f.pages.snapshot().pages).toHaveLength(8);
  });
  it("closing a background page cannot steal focus and final close can hide only its own plugin", async () => {
    const f = fixture();
    await f.open("one");
    await f.open("two");
    const [one, two] = f.pages.snapshot().pages;
    f.pages.closeFromHost(one.pageId);
    expect(f.pages.snapshot().request).toMatchObject({
      activateOnlyIfSelectedId: one.routeId,
      id: two.routeId,
      panelOpen: true,
    });
    f.pages.closeFromHost(two.pageId);
    expect(f.pages.snapshot().request).toMatchObject({
      hideOnlyGroup: f.lease.descriptor.pluginId,
      panelOpen: false,
    });
  });
  it("rejects caller identity injection and unknown navigation actions", () => {
    expect(() =>
      parsePluginUiNavigationRequest(actions.listPages, { pluginId: "other" }),
    ).toThrow();
    expect(() =>
      parsePluginUiNavigationRequest("crewon.plugin-navigation.unknown", {}),
    ).toThrow();
  });
  it("does not accept duplicate ids created atomically with a home page", () => {
    const f = fixture();
    const duplicate = new PluginUiPageNavigation({
      catalog: () => ({
        plugins: [],
        modules: [
          {
            key: "module",
            mountKey: "mount",
            title: "工作台",
            contributionId: "workbench",
            plugin: controlUiItem(),
          },
        ],
        fingerprint: "one",
      }),
      assertCurrent() {},
      nextId: () => "same",
    });
    duplicate.openFromHost("module");
    expect(() => duplicate.openFromHost("module")).toThrow(
      "plugin_ui_page_identity_duplicate",
    );
    expect(duplicate.snapshot().pages).toHaveLength(1);
  });
});

it("reusing a page updates its display context without changing its mount identity", async () => {
  const f = fixture();
  await f.open();
  const before = f.pages.snapshot().pages[0];
  await f.invoke(actions.openPage, {
    contributionId: "workbench",
    key: "plan",
    title: "监测",
    mode: "reuse",
    context: { view: "watch" },
  });
  const after = f.pages.snapshot().pages[0];
  expect(after.pageId).toBe(before.pageId);
  expect(after.routeId).toBe(before.routeId);
  expect(after.context).toEqual({ view: "watch" });
  expect(after.title).toBe("监测");
});
