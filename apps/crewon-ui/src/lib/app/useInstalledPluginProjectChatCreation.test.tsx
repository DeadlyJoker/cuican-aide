// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ControlPluginUiHost } from "../plugins/controlPluginUiHost";
import type { PluginUiPageNavigation } from "../plugins/pluginUiPageNavigation";
import type { ProjectChatCreationPorts } from "../plugins/projectChatCreation";
import {
  subscribeDesktopLocalManagementAccess,
  type DesktopLocalManagementAccess,
} from "../desktop/desktopLocalManagementAccess";
import { controlUiClient } from "../plugins/controlPluginUi.test-support";
import { useInstalledPluginProjectChatCreation } from "./useInstalledPluginProjectChatCreation";
const captured = vi.hoisted(() => ({
  ports: [] as ProjectChatCreationPorts[],
}));
vi.mock("../plugins/projectChatCreation", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../plugins/projectChatCreation")>();
  return {
    ...original,
    createProjectChatCreation: (ports: ProjectChatCreationPorts) => {
      captured.ports.push(ports);
      return original.createProjectChatCreation(ports);
    },
  };
});
const initialLocation = location.href;
afterEach(() => {
  captured.ports.length = 0;
  vi.unstubAllGlobals();
  location.href = initialLocation;
  localStorage.clear();
});
async function nativeAccess() {
  let changed = () => {};
  const current: { access: DesktopLocalManagementAccess | null } = {
    access: null,
  };
  vi.stubGlobal("window", {
    crewonDesktop: {
      version: 1,
      runtime: {
        localManagementAccess: async () => ({
          schemaVersion: "crewon.desktop-local-management-access.v1",
          generation: 4,
        }),
        onLocalManagementAccessChanged: (listener: () => void) => {
          changed = listener;
          return () => {};
        },
      },
    },
  });
  const stop = subscribeDesktopLocalManagementAccess((value) => {
    current.access = value;
  });
  await vi.waitFor(() => expect(current.access).not.toBeNull());
  const access = current.access;
  if (access === null) throw new Error("native_owner_fixture_not_issued");
  return {
    access,
    stop,
    changed: () => changed(),
  };
}

it.each([
  "nativeAccount",
  "nativeOffline",
  "copiedOwner",
  "missingOwner",
  "nativeOnWeb",
  "webAccount",
] as const)(
  "project creation keeps original coordinator and real owner fences: %s",
  async (scenario) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const native = await nativeAccess();
    location.href = "https://app.fixture.invalid/";
    const fetch = vi.fn(async () => {
      throw new Error("creation_must_not_dispatch_before_user_send");
    });
    const wire = controlUiClient(fetch);
    if (scenario !== "nativeOnWeb" && scenario !== "webAccount")
      location.href = "file:///crewon/dist/index.html";
    const scope = {
      client: wire.client,
      sessionKey:
        scenario === "nativeOffline" || scenario === "nativeOnWeb"
          ? null
          : "signed-in-account",
      assets: scenario === "webAccount" ? null : {},
    };
    const currentScope = { current: scope },
      mountedScope = { current: scope };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let value: ReturnType<typeof useInstalledPluginProjectChatCreation>;
    const owner =
      scenario === "copiedOwner"
        ? { ...native.access }
        : scenario === "missingOwner"
          ? null
          : native.access;
    const host = {
      acquireMount: vi.fn(),
      loader: { closeUnusedMount: vi.fn() },
    } as unknown as ControlPluginUiHost;
    function Probe() {
      value = useInstalledPluginProjectChatCreation({
        scope,
        host,
        pageNavigation: {} as PluginUiPageNavigation,
        enabled: true,
        localManagementAccess: owner,
        currentScope,
        mountedScope,
        onDiagnostic: vi.fn(),
        rememberConversation: vi.fn(),
        taskContextRef: { current: undefined },
      });
      return null;
    }
    try {
      await act(async () => root.render(<Probe />));
      const enabled = ["nativeAccount", "nativeOffline", "webAccount"].includes(
        scenario,
      );
      expect(typeof value).toBe(enabled ? "function" : "undefined");
      expect(fetch).not.toHaveBeenCalled();
      expect(host.acquireMount).not.toHaveBeenCalled();
      if (enabled) {
        const ports = captured.ports.at(-1)!;
        expect(ports.client).toBe(wire.client);
        ports.assertCurrent();
        currentScope.current = { ...scope };
        expect(() => ports.assertCurrent()).toThrow(
          "plugin_ui_session_changed",
        );
        currentScope.current = scope;
        mountedScope.current = { ...scope };
        expect(() => ports.assertCurrent()).toThrow(
          "plugin_ui_session_changed",
        );
        mountedScope.current = scope;
        if (scenario !== "webAccount") {
          expect(ports.ownerKey).toBe(
            JSON.stringify([
              "desktop-local-management",
              "/crewon/dist/index.html",
              scope.sessionKey,
            ]),
          );
          native.changed();
          expect(() => ports.assertCurrent()).toThrow(
            "plugin_ui_session_changed",
          );
        } else {
          expect(ports.ownerKey).toBe(
            JSON.stringify([wire.client.requestOrigin, scope.sessionKey]),
          );
          mountedScope.current = { ...scope };
          expect(() => ports.assertCurrent()).toThrow(
            "plugin_ui_session_changed",
          );
        }
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
      native.stop();
    }
  },
);
