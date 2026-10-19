// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlApiClient } from "@crewon/control-client";
import { createDesktopPluginUiHost } from "./desktopPluginUiHost";
import {
  controlUiItem,
  controlUiResponse,
} from "./controlPluginUi.test-support";
import {
  uiLease,
  uiHarness,
  uiProps,
  deferred,
  flush,
} from "./pluginUiLoader.test-support";
import { desktopPluginUiAssetUrl } from "../desktop/desktopPluginUiProtocol";
import type { InstalledPluginTaskReceiptEvent } from "./installedPluginTaskReceipt";
import type { DesktopPluginUiAssets } from "../desktop/desktopPluginUiProtocol";
import { PluginUiLeaseRenewalDeferredError } from "./pluginUiLeaseLifecycle";
import { subscribeProjectWorkspaceSourceChanges } from "./projectWorkspaceChanges";
import {
  textAdoptionRequest,
  textAdoptionResponse,
} from "./projectTextMutationChanges.test-support";
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
function fixture(
  options: {
    actionResponse?: () => Promise<Response> | Response;
    onTaskReceipt?: (event: InstalledPluginTaskReceiptEvent) => void;
    renewResult?: DesktopPluginUiAssets["renewResult"];
  } = {},
) {
  vi.stubGlobal("location", { protocol: "file:", origin: "null" });
  const lease = uiLease(),
    h = uiHarness();
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "POST" && String(input).endsWith("/actions")
      ? (options.actionResponse?.() ??
        controlUiResponse({ output: { accepted: true } }))
      : controlUiResponse(init?.method === "DELETE" ? { closed: true } : lease),
  );
  const client = new ControlApiClient({
    baseUrl: "http://127.0.0.1:32100",
    accessToken: "actual-fixture-native-session",
    csrfToken: "actual-fixture-csrf",
    fetch,
  });
  const binding = {
    bindingRef: "c".repeat(64),
    entryUrl: desktopPluginUiAssetUrl("c".repeat(64), "ui/index.js"),
    controlOrigin: client.requestOrigin,
  };
  const assets = {
    version: 1 as const,
    adopt: vi.fn(async () => binding),
    release: vi.fn(async () => {}),
    invalidate: vi.fn(async () => {}),
    ...(options.renewResult ? { renewResult: options.renewResult } : {}),
  };
  let current = true;
  const assertCurrent = () => {
    if (!current) throw new Error("actual_scope_changed");
  };
  const importer = vi.fn(async () => ({ default: h.definition }));
  const host = createDesktopPluginUiHost({
    client,
    assets,
    importer,
    assertCurrent,
    onDiagnostic: vi.fn(),
    onTaskReceipt: options.onTaskReceipt,
  });
  return {
    client,
    lease,
    h,
    assets,
    host,
    fetch,
    importer,
    binding,
    revoke: () => {
      current = false;
    },
  };
}
describe("file renderer installed UI adapter", () => {
  it("notifies the exact project only after an authenticated text adoption acknowledgement", async () => {
    let output: unknown = textAdoptionResponse;
    const f = fixture({ actionResponse: () => controlUiResponse({ output }) });
    const changed = vi.fn();
    const source = {
      pluginId: f.lease.descriptor.pluginId,
      publisherId: f.lease.descriptor.publisherId,
      version: f.lease.descriptor.version,
      packageDigest: f.lease.packageDigest,
      selectionRevision: f.lease.selectionRevision,
    };
    const off = subscribeProjectWorkspaceSourceChanges(
      f.client,
      "project",
      source,
      "texts",
      changed,
    );
    const lease = await f.host.acquireMount(
      controlUiItem(f.lease),
      "workbench",
      new AbortController().signal,
    );
    const handle = await f.host.loader.mount({
      root: f.h.root,
      lease,
      props: uiProps(),
    });
    try {
      await f.h.instances[0].services.invoke(
        textAdoptionRequest.action,
        textAdoptionRequest.input,
        {},
      );
      expect(changed).toHaveBeenCalledTimes(1);
      output = {
        ...textAdoptionResponse,
        artifact: {
          ...textAdoptionResponse.artifact,
          projectId: "foreign-project",
        },
      };
      await f.h.instances[0].services.invoke(
        textAdoptionRequest.action,
        textAdoptionRequest.input,
        {},
      );
      expect(changed).toHaveBeenCalledTimes(1);
    } finally {
      off();
      await handle.stop();
    }
  });
  it("keeps the exact owner only for a trusted strict deferred result and rechecks real action authority", async () => {
    const original = uiLease();
    const renewResult = vi.fn(async () => ({
      kind: "deferred" as const,
      lease: original,
    }));
    const f = fixture({ renewResult });
    const lease = await f.host.acquireMount(
      controlUiItem(f.lease),
      "workbench",
      new AbortController().signal,
    );
    const handle = await f.host.loader.mount({
      root: f.h.root,
      lease,
      props: uiProps(),
    });
    await expect(
      f.host.renewLease!(lease, new AbortController().signal),
    ).rejects.toBeInstanceOf(PluginUiLeaseRenewalDeferredError);
    expect(f.assets.release).not.toHaveBeenCalled();
    expect(f.h.instances[0].dispose).not.toHaveBeenCalled();
    await expect(
      f.h.instances[0].services.invoke("query", null, {}),
    ).resolves.toEqual({ accepted: true });
    f.revoke();
    await expect(
      f.h.instances[0].services.invoke("query", null, {}),
    ).rejects.toThrow("actual_scope_changed");
    expect(
      f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/actions")),
    ).toHaveLength(1);
    await handle.stop();
  });

  it("rejects malformed or changed deferred native outcomes without preserving their local owner", async () => {
    const original = uiLease();
    const changed = {
      ...original,
      selectionRevision: original.selectionRevision + 1,
    };
    const getter = vi.fn(() => "deferred");
    for (const response of [
      { kind: "deferred", lease: changed },
      { kind: "deferred", lease: original, extra: true },
      { kind: "unknown", lease: original },
      Object.defineProperty({ lease: original }, "kind", {
        enumerable: true,
        get: getter,
      }),
      {
        kind: "deferred",
        lease: {
          ...original,
          expiresAt: new Date(Date.now() - 1).toISOString(),
        },
      },
    ]) {
      const f = fixture({
        renewResult: vi.fn(
          async () => response,
        ) as DesktopPluginUiAssets["renewResult"],
      });
      const lease = await f.host.acquireMount(
        controlUiItem(f.lease),
        "workbench",
        new AbortController().signal,
      );
      const handle = await f.host.loader.mount({
        root: f.h.root,
        lease,
        props: uiProps(),
      });
      await expect(
        f.host.renewLease!(lease, new AbortController().signal),
      ).rejects.toThrow();
      await expect(
        f.h.instances[0].services.invoke("query", null, {}),
      ).rejects.toThrow("plugin_ui_lease_owner_missing");
      expect(
        f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/actions")),
      ).toHaveLength(0);
      await handle.stop();
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("adopts a fully checked Control mount and imports only its exact native entry URI; native owner closes once", async () => {
    const f = fixture();
    const lease = await f.host.acquireMount(
      controlUiItem(f.lease),
      "workbench",
      new AbortController().signal,
    );
    expect(f.assets.adopt).toHaveBeenCalledWith({
      lease,
      expectedControlOrigin: "http://127.0.0.1:32100",
    });
    const handle = await f.host.loader.mount({
      root: f.h.root,
      lease,
      props: uiProps(),
    });
    expect(f.importer).toHaveBeenCalledWith(f.binding.entryUrl);
    expect(f.h.root.textContent).toContain("初始内容");
    await handle.stop();
    expect(f.assets.release).toHaveBeenCalledExactlyOnceWith(
      f.binding.bindingRef,
    );
    expect(
      f.fetch.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
  });

  it("observes and closes an adopted lease that arrives after account scope changes, without importing", async () => {
    const f = fixture(),
      late = deferred<typeof f.binding>();
    f.assets.adopt.mockImplementation(() => late.promise);
    const acquire = f.host.acquireMount(
      controlUiItem(f.lease),
      "workbench",
      new AbortController().signal,
    );
    void acquire.catch(() => {});
    await flush();
    f.revoke();
    late.resolve(f.binding);
    await expect(acquire).rejects.toThrow("actual_scope_changed");
    expect(f.assets.release).toHaveBeenCalledExactlyOnceWith(
      f.binding.bindingRef,
    );
    expect(f.importer).not.toHaveBeenCalled();
  });

  it("rejects malformed native bindings and actively cleans the unobservable allocation", async () => {
    const f = fixture();
    f.assets.adopt.mockResolvedValue({
      ...f.binding,
      entryUrl: "https://foreign.example/ui.js",
    });
    await expect(
      f.host.acquireMount(
        controlUiItem(f.lease),
        "workbench",
        new AbortController().signal,
      ),
    ).rejects.toThrow("plugin_ui_native_binding_invalid");
    expect(f.assets.invalidate).toHaveBeenCalledTimes(1);
    expect(f.importer).not.toHaveBeenCalled();
  });

  it("retires its native mount while observing a same-session late committed task through the actual client", async () => {
    const gate = deferred<Response>();
    const observer = vi.fn();
    const receipt = {
      disposition: "committed",
      threadId: "thread:1",
      threadRevision: 2,
      runId: "run:1",
      messageId: "message:1",
      configurationRevision: 1,
    };
    const f = fixture({
      actionResponse: () => gate.promise,
      onTaskReceipt: observer,
    });
    const lease = await f.host.acquireMount(
      controlUiItem(f.lease),
      "workbench",
      new AbortController().signal,
    );
    const handle = await f.host.loader.mount({
      root: f.h.root,
      lease,
      props: uiProps(),
    });
    const called = f.h.instances[0].services.invoke(
      "arbitrary.command",
      null,
      {},
    );
    const rejected = expect(called).rejects.toThrow(
      "plugin_ui_operation_aborted",
    );
    await flush();
    const request = f.fetch.mock.calls.find(([url]) =>
      String(url).endsWith("/actions"),
    )!;
    await handle.stop();
    await rejected;
    expect(request[1]?.signal?.aborted).toBe(false);
    expect(f.assets.release).toHaveBeenCalledExactlyOnceWith(
      f.binding.bindingRef,
    );
    gate.resolve(controlUiResponse({ output: receipt }));
    await flush();
    expect(observer).toHaveBeenCalledExactlyOnceWith({
      lease: f.lease,
      receipt,
    });
    expect(f.h.root.textContent).toBe("");
  });

  it("withholds the confirmed hint from a replacement native session", async () => {
    const gate = deferred<Response>();
    const observer = vi.fn();
    const f = fixture({
      actionResponse: () => gate.promise,
      onTaskReceipt: observer,
    });
    const lease = await f.host.acquireMount(
      controlUiItem(f.lease),
      "workbench",
      new AbortController().signal,
    );
    const handle = await f.host.loader.mount({
      root: f.h.root,
      lease,
      props: uiProps(),
    });
    const called = f.h.instances[0].services.invoke("business", null, {});
    const rejected = expect(called).rejects.toThrow("actual_scope_changed");
    await flush();
    f.revoke();
    gate.resolve(
      controlUiResponse({
        output: {
          disposition: "committed",
          threadId: "thread:1",
          threadRevision: 2,
          runId: "run:1",
          messageId: "message:1",
          configurationRevision: 1,
        },
      }),
    );
    await rejected;
    await handle.stop();
    expect(observer).not.toHaveBeenCalled();
  });

  it("preserves ordinary read output without interpreting its action name as task authority", async () => {
    const observer = vi.fn();
    const output = { runId: "read-only-data" };
    const f = fixture({
      actionResponse: () => controlUiResponse({ output }),
      onTaskReceipt: observer,
    });
    const lease = await f.host.acquireMount(
      controlUiItem(f.lease),
      "workbench",
      new AbortController().signal,
    );
    const handle = await f.host.loader.mount({
      root: f.h.root,
      lease,
      props: uiProps(),
    });
    await expect(
      f.h.instances[0].services.invoke("tasks.request", null, {}),
    ).resolves.toEqual(output);
    await handle.stop();
    expect(observer).not.toHaveBeenCalled();
  });
});
