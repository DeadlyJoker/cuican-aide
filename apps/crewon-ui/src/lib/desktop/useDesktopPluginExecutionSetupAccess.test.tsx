// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CrewonDesktopBridge } from "./desktopBridge";
import type {
  DesktopLocalPluginExecutionSetupAccess,
  DesktopLocalPluginExecutionSetupClient,
} from "./desktopLocalPluginExecutionSetupProtocol";
import { useDesktopPluginExecutionSetupAccess } from "./useDesktopPluginExecutionSetupAccess";
import {
  retainLocalPluginExecutionSetupTicket,
  localPluginExecutionSetupTicket,
  clearLocalPluginExecutionSetupTicket,
  registerLocalPluginExecutionSetupShell,
} from "../plugins/localPluginExecutionSetupRecovery";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  delete (window as unknown as Record<string, unknown>).crewonDesktop;
  window.history.replaceState(null, "", "/");
});

function installClient(client?: DesktopLocalPluginExecutionSetupClient) {
  Object.defineProperty(window, "crewonDesktop", {
    configurable: true,
    value: { version: 1, pluginExecutionSetup: client } as CrewonDesktopBridge,
  });
}

function fakeClient() {
  let changed = () => {};
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((listener: () => void) => {
    changed = listener;
    return unsubscribe;
  });
  const client: DesktopLocalPluginExecutionSetupClient = {
    version: 1,
    preview: vi.fn(),
    confirm: vi.fn(),
    cancel: vi.fn(),
    readStatus: vi.fn(),
    subscribeStatusChanged: vi.fn(),
    subscribeOwnerChanged: subscribe,
  };
  return { client, subscribe, unsubscribe, changed: () => changed() };
}

function mount(accountKey = "account:1") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let current: DesktopLocalPluginExecutionSetupAccess | null = null;
  function View({ account }: { account: string }) {
    current = useDesktopPluginExecutionSetupAccess(account);
    return <span>{current?.ownerKey ?? "unavailable"}</span>;
  }
  const render = async (account = accountKey) => {
    await act(async () => root.render(<View account={account} />));
  };
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return { container, render, access: () => current };
}

describe("actual Native plugin execution setup capability", () => {
  it("keeps Web and older preloads unavailable even with a desktop URL", async () => {
    window.history.replaceState(null, "", "/?surface=desktop&platform=mac");
    const view = mount();
    await view.render();
    expect(view.access()).toBeNull();
    expect(view.container.textContent).toBe("unavailable");
    installClient();
    await view.render();
    expect(view.access()).toBeNull();
  });

  it("rejects an incompatible client version without subscribing or invoking it", async () => {
    const fake = fakeClient();
    installClient({
      ...fake.client,
      version: 2,
    } as unknown as DesktopLocalPluginExecutionSetupClient);
    const view = mount();
    await view.render();
    expect(view.access()).toBeNull();
    expect(fake.subscribe).not.toHaveBeenCalled();
    expect(fake.client.preview).not.toHaveBeenCalled();
    expect(fake.client.confirm).not.toHaveBeenCalled();
  });

  it("returns the actual client and updates its owner key for account and owner changes", async () => {
    const fake = fakeClient();
    installClient(fake.client);
    const view = mount();
    await view.render();
    expect(view.access()?.client).toBe(fake.client);
    expect(view.access()?.ownerKey).toBe("account:1:0");
    await act(async () => fake.changed());
    expect(view.access()?.ownerKey).toBe("account:1:1");
    await view.render("account:2");
    expect(view.access()?.ownerKey).toBe("account:2:1");
    expect(fake.subscribe).toHaveBeenCalledTimes(1);
    expect(fake.client.preview).not.toHaveBeenCalled();
    expect(fake.client.confirm).not.toHaveBeenCalled();
    expect(fake.client.cancel).not.toHaveBeenCalled();
    expect(fake.client.readStatus).not.toHaveBeenCalled();
    expect(fake.client.subscribeStatusChanged).not.toHaveBeenCalled();
    for (const cleanup of cleanups.splice(0)) await cleanup();
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("cleans up a replaced client and ignores its late owner notifications", async () => {
    const first = fakeClient();
    const second = fakeClient();
    installClient(first.client);
    const view = mount();
    await view.render();
    installClient(second.client);
    await view.render();
    expect(first.unsubscribe).toHaveBeenCalledTimes(1);
    expect(second.subscribe).toHaveBeenCalledTimes(1);
    expect(view.access()?.client).toBe(second.client);
    await act(async () => first.changed());
    expect(view.access()?.ownerKey).toBe("account:1:0");
    await act(async () => second.changed());
    expect(view.access()?.ownerKey).toBe("account:1:1");
    for (const cleanup of cleanups.splice(0)) await cleanup();
    expect(second.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("revokes access and the owner subscription when the capability disappears", async () => {
    const fake = fakeClient();
    installClient(fake.client);
    const view = mount();
    await view.render();
    installClient();
    await view.render();
    expect(view.access()).toBeNull();
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
    await act(async () => fake.changed());
    expect(view.access()).toBeNull();
  });

  it("retains an explicitly submitted ticket across a whole App remount after an earlier owner change", async () => {
    const fake = fakeClient();
    installClient(fake.client);
    const first = mount();
    await first.render();
    await act(async () => fake.changed());
    const access = first.access()!;
    expect(access.ownerKey).toBe("account:1:1");
    registerLocalPluginExecutionSetupShell(access, Symbol("original-shell"));
    const ticket = retainLocalPluginExecutionSetupTicket(access, {
      pluginId: "crewon.short-drama",
      publisherId: "example.publisher",
      version: "12.0.0",
      packageDigest: `sha256:${"a".repeat(64)}`,
      manifestDigest: `sha256:${"b".repeat(64)}`,
      implementationDigest: `sha256:${"c".repeat(64)}`,
      selectionRevision: 1,
      configurationRevision: 1,
      configurationDigest: `sha256:${"d".repeat(64)}`,
      previewId: "a".repeat(43),
      expiresAt: Date.now() + 120_000,
      baseUrl: "https://comfy.example.invalid/",
      preset: "krea2-portrait",
      networkPaths: [{ method: "POST", path: "/prompt" }],
      approvalRequirement: "none",
    });
    expect(ticket).not.toBeNull();
    for (const cleanup of cleanups.splice(0)) await cleanup();
    const reopened = mount();
    await reopened.render();
    expect(reopened.access()?.ownerKey).toBe(access.ownerKey);
    expect(localPluginExecutionSetupTicket(reopened.access()!)).toBe(ticket);
    expect(
      registerLocalPluginExecutionSetupShell(
        reopened.access()!,
        Symbol("reopened-shell"),
      ),
    ).toBe("crewon.short-drama");
    expect(fake.client.confirm).not.toHaveBeenCalled();
    await act(async () => fake.changed());
    expect(reopened.access()?.ownerKey).toBe("account:1:2");
    expect(localPluginExecutionSetupTicket(reopened.access()!)).toBeNull();
    clearLocalPluginExecutionSetupTicket(access, ticket!);
  });
});
