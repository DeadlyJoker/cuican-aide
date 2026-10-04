// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parsePluginUiLease,
  type PluginUiLease,
} from "@crewon/contracts/plugins";
import type { PluginUiServices } from "@crewon/plugin-sdk/ui";
import type { PluginJsonValue } from "@crewon/plugin-sdk/contracts";
import { PluginUiLeaseLifecycle } from "./pluginUiLeaseLifecycle";
import type { PluginUiMountHandle } from "./trustedPluginUiLoader";
import {
  deferred,
  flush,
  uiHarness,
  uiLease,
  uiProps,
} from "./pluginUiLoader.test-support";

const NOW = Date.parse("2026-10-05T00:00:00.000Z");
const lease = () =>
  parsePluginUiLease({
    ...uiLease(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
  });
const extension = (previous: PluginUiLease) =>
  parsePluginUiLease({
    ...previous,
    expiresAt: new Date(Date.parse(previous.expiresAt) + 240_000).toISOString(),
  });
const handles: PluginUiMountHandle[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.stop()));
  document.body.replaceChildren();
  vi.useRealTimers();
});

function draftHarness() {
  let services!: PluginUiServices;
  const dispose = vi.fn();
  const mount = vi.fn(
    (root: HTMLElement, _props: unknown, ports: PluginUiServices) => {
      services = ports;
      const input = document.createElement("textarea");
      input.setAttribute("aria-label", "未保存剧本草稿");
      root.append(input);
      return { update: vi.fn(), dispose };
    },
  );
  const h = uiHarness(async () => ({
    default: {
      apiVersion: "crewon.plugin-ui.v1",
      pluginId: "example.workbench",
      mount,
    },
  }));
  return {
    ...h,
    mount,
    dispose,
    get services() {
      return services;
    },
  };
}

async function mount(h: ReturnType<typeof uiHarness>, current = lease()) {
  const handle = await h.loader.mount({
    root: h.root,
    lease: current,
    props: uiProps(),
  });
  handles.push(handle);
  return handle;
}

describe("trusted UI loader authenticated lease renewal", () => {
  it("retains the same DOM draft and instance and sends later actions with the renewed full lease", async () => {
    const h = draftHarness();
    const previous = lease();
    const next = extension(previous);
    const handle = await mount(h, previous);
    const child = h.root.firstElementChild;
    const textarea = h.root.querySelector("textarea")!;
    textarea.value = "黄昏港口的未保存草稿";
    textarea.focus();
    textarea.setSelectionRange(3, 8);
    const markup = h.root.innerHTML;
    h.loader.renewLease(previous, next);
    expect(h.root.firstElementChild).toBe(child);
    expect(h.root.querySelector("textarea")).toBe(textarea);
    expect(h.root.innerHTML).toBe(markup);
    expect(h.root.innerHTML).toMatchInlineSnapshot(
      `"<div data-plugin-ui-root=\"workbench\" data-plugin-id=\"example.workbench\"><textarea aria-label=\"未保存剧本草稿\"></textarea></div>"`,
    );
    expect(textarea.value).toBe("黄昏港口的未保存草稿");
    expect(document.activeElement).toBe(textarea);
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([3, 8]);
    expect(h.mount).toHaveBeenCalledTimes(1);
    expect(h.importModule).toHaveBeenCalledTimes(1);
    expect(h.dispose).not.toHaveBeenCalled();
    expect(h.ports.closeMount).not.toHaveBeenCalled();
    h.ports.validateMount.mockClear();
    vi.setSystemTime(Date.parse(previous.expiresAt) + 1);
    await expect(
      h.services.invoke("save", { draft: textarea.value }, {}),
    ).resolves.toEqual({ echoed: { draft: textarea.value } });
    expect(h.ports.invoke).toHaveBeenCalledExactlyOnceWith(
      next,
      expect.objectContaining({ action: "save" }),
    );
    expect(
      h.ports.validateMount.mock.calls.every(
        ([current]) => JSON.stringify(current) === JSON.stringify(next),
      ),
    ).toBe(true);
    await handle.stop();
    expect(h.ports.closeMount).toHaveBeenCalledExactlyOnceWith(next);
    expect(h.dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects changes to any pin, stale predecessors and excessive extension while leaving the draft intact", async () => {
    const h = draftHarness();
    const previous = lease();
    const next = extension(previous);
    await mount(h, previous);
    const textarea = h.root.querySelector("textarea")!;
    textarea.value = "保留现有草稿";
    for (const changed of [
      { ...next, selectionRevision: next.selectionRevision + 1 },
      { ...next, packageDigest: `sha256:${"b".repeat(64)}` },
      { ...next, descriptor: { ...next.descriptor, description: "changed" } },
      { ...next, publicAssets: [...next.publicAssets].reverse() },
      previous,
      {
        ...next,
        expiresAt: new Date(
          Date.parse(previous.expiresAt) + 300_001,
        ).toISOString(),
      },
    ])
      expect(() => h.loader.renewLease(previous, changed)).toThrow();
    expect(h.root.querySelector("textarea")).toBe(textarea);
    expect(textarea.value).toBe("保留现有草稿");
    expect(h.mount).toHaveBeenCalledTimes(1);
    expect(h.dispose).not.toHaveBeenCalled();
    h.loader.renewLease(previous, next);
    expect(() => h.loader.renewLease(previous, extension(next))).toThrow(
      "plugin_ui_lease_identity_mismatch",
    );
    await h.services.invoke("query", null, {});
    expect(h.ports.invoke.mock.calls[0][0]).toEqual(next);
  });

  it("rejects the same reference on another root without closing or replacing its active instance", async () => {
    const h = draftHarness();
    const previous = lease();
    await mount(h, previous);
    const textarea = h.root.querySelector("textarea")!;
    textarea.value = "原实例草稿";
    const otherRoot = document.createElement("div");
    document.body.append(otherRoot);
    await expect(
      h.loader.mount({ root: otherRoot, lease: previous, props: uiProps() }),
    ).rejects.toThrow("plugin_ui_mount_ref_already_mounted");
    expect(otherRoot.childNodes).toHaveLength(0);
    expect(h.root.querySelector("textarea")).toBe(textarea);
    expect(textarea.value).toBe("原实例草稿");
    expect(h.mount).toHaveBeenCalledTimes(1);
    expect(h.importModule).toHaveBeenCalledTimes(1);
    expect(h.ports.closeMount).not.toHaveBeenCalled();
    expect(h.dispose).not.toHaveBeenCalled();
  });

  it("tracks staged candidates and renews them without a second import or mount", async () => {
    const imported = deferred<unknown>();
    const h = uiHarness(async () => imported.promise);
    const previous = lease();
    const next = extension(previous);
    const pending = mount(h, previous);
    await flush();
    expect(h.root.childNodes).toHaveLength(0);
    await expect(
      h.loader.mount({ root: h.root, lease: previous, props: uiProps() }),
    ).rejects.toThrow("plugin_ui_mount_ref_already_mounted");
    h.loader.renewLease(previous, next);
    imported.resolve({ default: h.definition });
    await pending;
    expect(h.importModule).toHaveBeenCalledTimes(1);
    expect(h.instances).toHaveLength(1);
    expect(
      h.ports.validateMount.mock.calls
        .slice(1)
        .every(([current]) => JSON.stringify(current) === JSON.stringify(next)),
    ).toBe(true);
    expect(h.ports.closeMount).not.toHaveBeenCalled();
  });

  it("removes an owner synchronously on stop and rejects a late renewal during pending disposal", async () => {
    const h = draftHarness();
    const previous = lease();
    const handle = await mount(h, previous);
    const disposal = deferred<void>();
    h.dispose.mockImplementationOnce(async () => disposal.promise);
    const stopped = handle.stop();
    await flush();
    expect(h.loader.pendingCleanupCount).toBe(1);
    expect(() => h.loader.renewLease(previous, extension(previous))).toThrow(
      "plugin_ui_lease_not_mounted",
    );
    await expect(h.services.invoke("query", null, {})).rejects.toThrow(
      "plugin_ui_operation_aborted",
    );
    expect(h.root.childNodes).toHaveLength(0);
    disposal.resolve();
    await stopped;
    expect(h.loader.pendingCleanupCount).toBe(0);
    expect(h.dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps expiry and post-renewal authority validation fail-closed", async () => {
    const h = draftHarness();
    const previous = lease();
    const handle = await mount(h, previous);
    vi.setSystemTime(Date.parse(previous.expiresAt));
    expect(() => h.loader.renewLease(previous, extension(previous))).toThrow(
      "plugin_ui_lease_expired",
    );
    await expect(h.services.invoke("save", null, {})).rejects.toThrow(
      "plugin_ui_lease_expired",
    );
    expect(h.ports.invoke).not.toHaveBeenCalled();
    vi.setSystemTime(NOW);
    h.loader.renewLease(previous, extension(previous));
    h.ports.validateMount.mockRejectedValueOnce(
      new Error("authority withdrawn"),
    );
    await expect(h.services.invoke("save", null, {})).rejects.toThrow(
      "authority withdrawn",
    );
    expect(h.ports.invoke).not.toHaveBeenCalled();
    await handle.stop();
    expect(() =>
      h.loader.renewLease(extension(previous), extension(extension(previous))),
    ).toThrow("plugin_ui_lease_not_mounted");
  });

  it("drains real in-flight host actions while retaining the draft and queued actions use the new lease", async () => {
    const lifecycle = new PluginUiLeaseLifecycle();
    const previous = lease();
    const next = extension(previous);
    lifecycle.register(previous);
    const actionResponse = deferred<PluginJsonValue>();
    const actualInvoke = vi.fn(
      async (current: PluginUiLease, input: { input: PluginJsonValue }) => {
        if (input.input === "original") {
          expect(current).toEqual(previous);
          return actionResponse.promise;
        }
        expect(current).toEqual(next);
        return { echoed: input.input };
      },
    );
    let services!: PluginUiServices;
    const h = uiHarness(
      async () => ({
        default: {
          apiVersion: "crewon.plugin-ui.v1",
          pluginId: "example.workbench",
          mount(root: HTMLElement, _props: unknown, ports: PluginUiServices) {
            services = ports;
            const input = document.createElement("textarea");
            input.value = "续租期间保留草稿";
            root.append(input);
            return { update() {}, dispose() {} };
          },
        },
      }),
      {
        validateMount: (current, signal) =>
          lifecycle.validate(current, signal, async () => undefined),
        invoke: (current, input) =>
          lifecycle.run(current, input.signal, (latest) =>
            actualInvoke(latest, input),
          ),
        closeMount: async (current) => lifecycle.release(current),
      },
    );
    await mount(h, previous);
    const textarea = h.root.querySelector("textarea")!;
    const original = services.invoke("save", "original", {});
    await flush();
    const request = vi.fn(async () => next);
    const renewed = lifecycle.renew(
      previous,
      new AbortController().signal,
      request,
      (oldLease, renewedLease) => h.loader.renewLease(oldLease, renewedLease),
    );
    const queued = services.invoke("query", "following", {});
    await flush();
    expect(request).not.toHaveBeenCalled();
    expect(actualInvoke).toHaveBeenCalledTimes(1);
    actionResponse.resolve({ receipt: "same original action" });
    await expect(renewed).resolves.toEqual(next);
    await expect(original).resolves.toEqual({
      receipt: "same original action",
    });
    await expect(queued).resolves.toEqual({ echoed: "following" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(actualInvoke).toHaveBeenCalledTimes(2);
    expect(h.root.querySelector("textarea")).toBe(textarea);
    expect(textarea.value).toBe("续租期间保留草稿");
    expect(h.importModule).toHaveBeenCalledTimes(1);
  });
});
