// @vitest-environment happy-dom
import { act, StrictMode, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlApiClient } from "@crewon/control-client";
import { useInstalledPluginNavigationRestore } from "./useInstalledPluginNavigationRestore";
import {
  persistInstalledPluginNavigationLocator,
  readInstalledPluginNavigationLocator,
} from "./installedPluginNavigationLocator";
import { PluginUiPageNavigation } from "../plugins/pluginUiPageNavigation";
import { installedPluginSurfaceModules } from "./installedPluginSurfaceModules";
import { useCommandWorkspaceHostModules } from "../../components/app/CommandWorkspaceHostModule";
import type { ControlPluginUiCatalog } from "../plugins/controlPluginUiCatalog";
import {
  controlUiClient,
  controlUiItem,
  controlUiResponse,
} from "../plugins/controlPluginUi.test-support";
import {
  uiLease,
  deferred,
  flush,
} from "../plugins/pluginUiLoader.test-support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const pluginId = "crewon.short-drama";
const lease = uiLease();
const item = controlUiItem({
  ...lease,
  descriptor: {
    ...lease.descriptor,
    pluginId,
    requires: [
      {
        service: "crewon.project-conversations",
        apiVersion: "1",
        optional: false,
      },
    ],
  },
});
const module = {
  key: JSON.stringify([pluginId, "workbench"]),
  mountKey: "actual-installed-mount",
  contributionId: "workbench",
  title: "AI 短剧",
  plugin: item,
};
const directory: ControlPluginUiCatalog = {
  plugins: [item],
  modules: [module],
  fingerprint: "actual-installed-v1",
};
const binding = {
  bindingId: "owned-binding",
  threadId: "owned-thread",
  projectId: "owned-project",
  workspaceId: "owned-workspace",
  revision: 3,
  state: "active",
  source: {
    pluginId,
    publisherId: item.descriptor.publisherId,
    version: item.descriptor.version,
    packageDigest: item.packageDigest,
    selectionRevision: item.selectionRevision,
  },
  createdAt: "2026-10-15T00:00:00.000Z",
  updatedAt: "2026-10-15T00:00:00.000Z",
};
const response = {
  context: { binding, projectRevision: 4, briefRevision: 2, outline: null },
};
type Scope = { client: ControlApiClient; sessionKey: string };
type Input = {
  scope: Scope;
  catalog?: ControlPluginUiCatalog | null;
  threadId?: string | null;
  navigation: PluginUiPageNavigation;
};
let root: Root;
let container: HTMLDivElement;
let state: ReturnType<typeof useCommandWorkspaceHostModules>;
const remember = vi.fn();
const diagnostic = vi.fn();
function Probe({
  scope,
  catalog = directory,
  threadId = binding.threadId,
  navigation,
}: Input) {
  const pages = useSyncExternalStore(navigation.subscribe, navigation.snapshot);
  const restore = useInstalledPluginNavigationRestore({
    scope,
    catalog,
    navigation,
    threadId,
    rememberConversation: remember,
    onDiagnostic: diagnostic,
  });
  const modules = catalog
    ? installedPluginSurfaceModules({
        catalog,
        pages,
        navigation,
        render: () => null,
      })
    : [];
  state = useCommandWorkspaceHostModules(modules, {
    request: pages.request,
    availability: {
      state: catalog ? "available" : "unavailable",
      ownerKey: scope,
      retry: () => {},
      onSelectionChange: restore.onSelectionChange,
    },
  });
  return (
    <div
      data-active-plugin={state.pluginId ?? ""}
      data-project-id={
        modules.find((m) => m.id === state.selectedId)?.conversationProjectId ??
        ""
      }
    />
  );
}
function navigation() {
  return new PluginUiPageNavigation({
    catalog: () => directory,
    assertCurrent: () => {},
  });
}
async function render(input: Input, strict = false) {
  await act(async () => {
    const node = <Probe {...input} />;
    root.render(strict ? <StrictMode>{node}</StrictMode> : node);
    await flush();
    await flush();
  });
}
beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
  remember.mockClear();
  diagnostic.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
describe("installed plugin navigation refresh through original Host route and authenticated context", () => {
  it("restores project and bounded stage after refresh, using only the original authenticated GET", async () => {
    persistInstalledPluginNavigationLocator("admin", {
      pluginId,
      projectId: binding.projectId,
      stage: "characters",
    });
    const wire = controlUiClient((url, init) => {
      expect(init.method).toBe("GET");
      expect(url.pathname).toBe(
        `/api/v1/threads/${binding.threadId}/project-conversation/context`,
      );
      return controlUiResponse(response);
    });
    const scope = { client: wire.client, sessionKey: "admin" },
      pages = navigation();
    await render({ scope, navigation: pages });
    expect(diagnostic.mock.calls).toEqual([]);
    expect(state.active).toBe(true);
    expect(state.pluginId).toBe(pluginId);
    expect(
      container
        .querySelector("[data-project-id]")
        ?.getAttribute("data-project-id"),
    ).toBe(binding.projectId);
    expect(pages.snapshot().pages[0]?.context).toEqual({
      projectId: binding.projectId,
      stage: "characters",
    });
    expect(remember).toHaveBeenCalledWith(pluginId, binding.threadId);
    expect(wire.fetch).toHaveBeenCalledTimes(1);
    expect(readInstalledPluginNavigationLocator("admin")).toEqual({
      pluginId,
      projectId: binding.projectId,
      stage: "characters",
    });
    // Page changes and equivalent catalog refreshes keep the existing catalog/Host owner and do not re-read or remount it.
    await render({ scope, navigation: pages, catalog: { ...directory } });
    expect(wire.fetch).toHaveBeenCalledTimes(1);
    expect(pages.snapshot().pages).toHaveLength(1);
    await act(async () => {
      state.close();
      await flush();
    });
    expect(readInstalledPluginNavigationLocator("admin")).toBeNull();
  });
  it("derives a missing old locator from the actual owned Thread and supports StrictMode without executing", async () => {
    const wire = controlUiClient(() => controlUiResponse(response)),
      pages = navigation();
    await render(
      {
        scope: { client: wire.client, sessionKey: "admin" },
        navigation: pages,
      },
      true,
    );
    expect(state.pluginId).toBe(pluginId);
    expect(pages.snapshot().pages).toHaveLength(1);
    expect(pages.snapshot().pages[0]?.context).toEqual({
      projectId: binding.projectId,
    });
    expect(
      wire.fetch.mock.calls.every(([, init]) => init?.method === "GET"),
    ).toBe(true);
  });
  it("keeps an explicit ordinary homepage after refresh despite a retained owned Thread URL", async () => {
    persistInstalledPluginNavigationLocator("admin", null);
    const wire = controlUiClient(() => controlUiResponse(response));
    const pages = navigation();
    await render({
      scope: { client: wire.client, sessionKey: "admin" },
      navigation: pages,
    });
    expect(state.active).toBe(false);
    expect(pages.snapshot().pages).toHaveLength(0);
    expect(wire.fetch).not.toHaveBeenCalled();
    expect(remember).not.toHaveBeenCalled();
  });
  it("does not steal ordinary navigation when an old project context arrives later", async () => {
    persistInstalledPluginNavigationLocator("admin", {
      pluginId,
      projectId: binding.projectId,
    });
    const wait = deferred<Response>();
    const wire = controlUiClient(() => wait.promise),
      pages = navigation();
    await render({
      scope: { client: wire.client, sessionKey: "admin" },
      navigation: pages,
    });
    window.history.replaceState(null, "", "/#view-tasks");
    await act(async () => {
      wait.resolve(controlUiResponse(response));
      await flush();
      await flush();
    });
    expect(state.active).toBe(false);
    expect(pages.snapshot().pages).toHaveLength(0);
    expect(remember).not.toHaveBeenCalled();
  });
  it.each([
    "uninstalled",
    "source-changed",
    "foreign-project",
    "revoked",
    "cross-profile",
  ] as const)("does not restore %s using a cached locator", async (variant) => {
    persistInstalledPluginNavigationLocator("admin", {
      pluginId,
      projectId: binding.projectId,
      stage: "art",
    });
    const wire = controlUiClient(() =>
      variant === "cross-profile"
        ? controlUiResponse(
            {
              error: {
                category: "authorization",
                code: "project_conversation_context_denied",
              },
            },
            403,
          )
        : controlUiResponse({
            context:
              variant === "revoked"
                ? null
                : {
                    ...response.context,
                    binding: {
                      ...binding,
                      ...(variant === "foreign-project"
                        ? { projectId: "other-project" }
                        : {}),
                      ...(variant === "source-changed"
                        ? {
                            source: {
                              ...binding.source,
                              packageDigest: `sha256:${"b".repeat(64)}`,
                            },
                          }
                        : {}),
                    },
                  },
          }),
    );
    const pages = navigation();
    await render({
      scope: { client: wire.client, sessionKey: "admin" },
      navigation: pages,
      catalog:
        variant === "uninstalled"
          ? { plugins: [], modules: [], fingerprint: "uninstalled" }
          : directory,
    });
    expect(state.active).toBe(false);
    expect(pages.snapshot().pages).toHaveLength(0);
    expect(remember).not.toHaveBeenCalled();
    expect(readInstalledPluginNavigationLocator("admin")).toBeNull();
  });
  it("never lets a delayed old context reopen a page after account changes or manual navigation", async () => {
    persistInstalledPluginNavigationLocator("admin", {
      pluginId,
      projectId: binding.projectId,
    });
    const wait = deferred<Response>();
    const old = controlUiClient(() => wait.promise),
      pages = navigation();
    await render({
      scope: { client: old.client, sessionKey: "admin" },
      navigation: pages,
    });
    await act(async () => {
      state.open(module.key);
      await flush();
    });
    await act(async () => {
      wait.resolve(controlUiResponse(response));
      await flush();
      await flush();
    });
    expect(pages.snapshot().pages).toHaveLength(0);
    expect(readInstalledPluginNavigationLocator("admin")).toEqual({ pluginId });
    expect(remember).not.toHaveBeenCalled();
    const replacement = controlUiClient(() =>
      controlUiResponse({ context: null }),
    );
    await render({
      scope: { client: replacement.client, sessionKey: "other-user" },
      navigation: navigation(),
    });
    expect(state.active).toBe(false);
  });
  it("restores an installed plugin homepage without a Thread and never persists auth/page payloads", async () => {
    persistInstalledPluginNavigationLocator("admin", { pluginId });
    const wire = controlUiClient(() => {
        throw Error("homepage must not request a task");
      }),
      pages = navigation();
    await render({
      scope: { client: wire.client, sessionKey: "admin" },
      navigation: pages,
      threadId: null,
    });
    expect(state.pluginId).toBe(pluginId);
    expect(pages.snapshot().pages[0]?.home).toBe(true);
    expect(wire.fetch).not.toHaveBeenCalled();
    const raw = window.sessionStorage.getItem(
      "crewon.plugin-navigation.v1:admin",
    );
    expect(JSON.parse(raw!)).toEqual({ pluginId });
    window.sessionStorage.setItem(
      "crewon.plugin-navigation.v1:admin",
      JSON.stringify({
        pluginId,
        projectId: binding.projectId,
        grant: "fake-authority",
      }),
    );
    expect(readInstalledPluginNavigationLocator("admin")).toBeNull();
  });
});
