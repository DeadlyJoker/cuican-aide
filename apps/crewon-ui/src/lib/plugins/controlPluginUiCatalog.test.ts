// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginUiCatalogItem } from "@crewon/contracts";
import { readControlPluginUiCatalog } from "./controlPluginUiCatalog";
import {
  controlUiClient,
  controlUiItem,
  controlUiResponse,
} from "./controlPluginUi.test-support";
import { deferred, flush, uiLease } from "./pluginUiLoader.test-support";

afterEach(() => {
  vi.useRealTimers();
});
function item(serial: number, contributions = 1): PluginUiCatalogItem {
  const lease = uiLease();
  return controlUiItem({
    ...lease,
    descriptor: {
      ...lease.descriptor,
      pluginId: `example.p${String(serial).padStart(3, "0")}`,
      contributions: Array.from({ length: contributions }, (_, index) => ({
        id: `workbench${index}`,
        title: `界面 ${index}`,
        kind: "module" as const,
        slot: "main.content" as const,
      })),
    },
  });
}
function read(
  client: ReturnType<typeof controlUiClient>["client"],
  signal = new AbortController().signal,
  assertCurrent: () => void = () => {},
) {
  return readControlPluginUiCatalog({ client, signal, assertCurrent });
}

describe("bounded authenticated UI catalog snapshots (real Control client)", () => {
  it("continues filtered empty pages by next and exposes every main-content contribution", async () => {
    const first = item(2, 2);
    const second = item(4);
    const pages = [
      { plugins: [], next: "example.p001" },
      { plugins: [first], next: "example.p003" },
      { plugins: [second], next: null },
    ];
    const wire = controlUiClient(() => controlUiResponse(pages.shift()));
    const result = await read(wire.client);
    expect(result.plugins.map((plugin) => plugin.descriptor.pluginId)).toEqual([
      "example.p002",
      "example.p004",
    ]);
    expect(result.modules.map((module) => module.contributionId)).toEqual([
      "workbench0",
      "workbench1",
      "workbench0",
    ]);
    expect(new Set(result.modules.map((module) => module.key)).size).toBe(3);
    expect(result.modules[0].plugin).toBe(result.plugins[0]);
    expect(Object.isFrozen(result.modules)).toBe(true);
    expect(Object.isFrozen(result.plugins[0].descriptor)).toBe(true);
    expect(
      wire.fetch.mock.calls.map(([url]) =>
        new URL(String(url)).searchParams.get("afterPluginId"),
      ),
    ).toEqual([null, "example.p001", "example.p003"]);
    expect(
      wire.fetch.mock.calls.every(
        ([, init]) => init?.credentials === "include",
      ),
    ).toBe(true);
  });

  it("keeps fingerprints and mount keys stable for unchanged snapshots, then changes the selected package pin", async () => {
    let current = item(1);
    const wire = controlUiClient(() =>
      controlUiResponse({ plugins: [current], next: null }),
    );
    const first = await read(wire.client);
    const same = await read(wire.client);
    expect(same.fingerprint).toBe(first.fingerprint);
    expect(same.modules[0].mountKey).toBe(first.modules[0].mountKey);
    current = {
      ...current,
      selectionRevision: 2,
      packageDigest: `sha256:${"2".repeat(64)}`,
    };
    const changed = await read(wire.client);
    expect(changed.modules[0].key).toBe(first.modules[0].key);
    expect(changed.modules[0].mountKey).not.toBe(first.modules[0].mountKey);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });

  it("returns an empty current catalog for removed entries without acquiring or importing modules", async () => {
    let current: PluginUiCatalogItem[] = [item(1)];
    const wire = controlUiClient(() =>
      controlUiResponse({ plugins: current, next: null }),
    );
    const before = await read(wire.client);
    current = [];
    const after = await read(wire.client);
    expect(after.modules).toEqual([]);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(
      wire.fetch.mock.calls.every(
        ([url, init]) =>
          new URL(String(url)).pathname === "/api/v1/plugins/ui/catalog" &&
          init?.method === "GET",
      ),
    ).toBe(true);
  });

  it("rejects repeated/backward cursors and duplicate plugin identities instead of looping", async () => {
    for (const second of [
      { plugins: [], next: "example.p001" },
      { plugins: [item(1)], next: null },
    ]) {
      const pages = [{ plugins: [item(1)], next: "example.p001" }, second];
      const wire = controlUiClient(() => controlUiResponse(pages.shift()));
      await expect(read(wire.client)).rejects.toThrow(
        "control_client_plugin_response_invalid",
      );
      expect(wire.fetch).toHaveBeenCalledTimes(2);
    }
  });

  it("bounds an endless sequence of valid empty pages at sixteen requests", async () => {
    let page = 0;
    const wire = controlUiClient(() =>
      controlUiResponse({
        plugins: [],
        next: `example.p${String(++page).padStart(3, "0")}`,
      }),
    );
    await expect(read(wire.client)).rejects.toThrow(
      "plugin_ui_catalog_page_limit",
    );
    expect(wire.fetch).toHaveBeenCalledTimes(16);
  });

  it("bounds total plugins and total module contributions across valid pages", async () => {
    let page = 0;
    const wire = controlUiClient(() => {
      const start = page++ * 50 + 1;
      const plugins = Array.from({ length: 50 }, (_, offset) =>
        item(start + offset),
      );
      return controlUiResponse({
        plugins,
        next: plugins.at(-1)!.descriptor.pluginId,
      });
    });
    await expect(read(wire.client)).rejects.toThrow(
      "plugin_ui_catalog_plugin_limit",
    );
    expect(wire.fetch).toHaveBeenCalledTimes(3);
    const many = controlUiClient(() =>
      controlUiResponse({
        plugins: Array.from({ length: 5 }, (_, index) => item(index + 1, 64)),
        next: null,
      }),
    );
    await expect(read(many.client)).rejects.toThrow(
      "plugin_ui_catalog_module_limit",
    );
  });

  it("bounds aggregate catalog bytes even when each HTTP page is within its individual limit", async () => {
    const files = Array.from({ length: 510 }, (_, index) => ({
      path: `assets/${"a".repeat(200)}${String(index).padStart(3, "0")}.png`,
      byteLength: 1,
      sha256: "a".repeat(64),
    }));
    const inventory = [...uiLease().descriptor.files.slice(0, 2), ...files];
    let page = 0;
    const wire = controlUiClient(() => {
      const start = page++ * 35 + 1;
      const plugins = Array.from({ length: 35 }, (_, index) => {
        const plugin = item(start + index);
        return {
          ...plugin,
          descriptor: { ...plugin.descriptor, files: inventory },
          publicAssets: inventory.map((file) => file.path),
        };
      });
      return controlUiResponse({
        plugins,
        next: page === 2 ? null : plugins.at(-1)!.descriptor.pluginId,
      });
    });
    await expect(read(wire.client)).rejects.toThrow(
      "plugin_ui_catalog_byte_limit",
    );
    expect(wire.fetch).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("rejects cancellation and awaited scope revocation without publishing partial snapshots", async () => {
    const gate = deferred<Response>();
    let current = true;
    const wire = controlUiClient(() => gate.promise);
    const task = read(wire.client, new AbortController().signal, () => {
      if (!current) throw new Error("revoked");
    });
    await flush();
    current = false;
    gate.resolve(controlUiResponse({ plugins: [item(1)], next: null }));
    await expect(task).rejects.toThrow("revoked");
    const controller = new AbortController();
    controller.abort();
    await expect(read(wire.client, controller.signal)).rejects.toThrow(
      "plugin_ui_operation_aborted",
    );
    expect(wire.fetch).toHaveBeenCalledTimes(1);
  });

  it("aborts the real client request on cancellation and on the five-second page deadline", async () => {
    vi.useFakeTimers();
    const wire = controlUiClient(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal!.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          ),
        ),
    );
    const controller = new AbortController();
    const cancelled = read(wire.client, controller.signal);
    const check = expect(cancelled).rejects.toThrow(
      "plugin_ui_operation_aborted",
    );
    controller.abort();
    await check;
    const timeout = read(wire.client);
    const timeoutCheck = expect(timeout).rejects.toThrow(
      "plugin_ui_control_timeout",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await timeoutCheck;
    expect(vi.getTimerCount()).toBe(0);
  });
});
