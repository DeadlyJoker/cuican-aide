// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlApiClient } from "@crewon/control-client";
import type { PluginUiLease } from "@crewon/contracts/plugins";
import type { PluginUiMountHandle } from "./trustedPluginUiLoader";
import {
  checkedLeaseIdentity,
  createControlPluginUiHost,
} from "./controlPluginUiHost";
import type { InstalledPluginTaskReceiptEvent } from "./installedPluginTaskReceipt";
import {
  controlUiClient,
  controlUiItem,
  controlUiResponse,
} from "./controlPluginUi.test-support";
import {
  deferred,
  flush,
  uiHarness,
  uiLease,
  uiProps,
} from "./pluginUiLoader.test-support";

const handles: PluginUiMountHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()));
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function fixture(
  overrides: {
    readLease?: () => PluginUiLease;
    closeFails?: boolean;
    actionResponse?: () => Promise<Response> | Response;
    onTaskReceipt?: (event: InstalledPluginTaskReceiptEvent) => void;
  } = {},
) {
  const lease = uiLease();
  const wire = controlUiClient((url, init) => {
    if (init.method === "POST" && url.pathname.endsWith("/actions"))
      return (
        overrides.actionResponse?.() ??
        controlUiResponse({ output: { accepted: true } })
      );
    if (init.method === "DELETE")
      return overrides.closeFails
        ? controlUiResponse(
            { error: { code: "unavailable", message: "Unavailable" } },
            503,
          )
        : controlUiResponse({ closed: true });
    return controlUiResponse(overrides.readLease?.() ?? lease);
  });
  let current = true;
  const assertCurrent = vi.fn(() => {
    if (!current) throw new Error("captured_session_revoked");
  });
  const onDiagnostic = vi.fn();
  const h = uiHarness();
  const importer = vi.fn(async () => ({ default: h.definition }));
  const host = createControlPluginUiHost({
    client: wire.client,
    assertCurrent,
    onDiagnostic,
    importer,
    onTaskReceipt: overrides.onTaskReceipt,
  });
  return {
    ...wire,
    lease,
    h,
    importer,
    host,
    acquire: () =>
      host.acquireMount(
        controlUiItem(lease),
        lease.contributionId,
        new AbortController().signal,
      ),
    onDiagnostic,
    revoke: () => {
      current = false;
    },
  };
}

describe("authenticated Control plugin UI host (real client; explicit importer fixture)", () => {
  it("uses the formal same-origin asset route and captured authenticated actions without actor fields", async () => {
    const f = fixture();
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
    handles.push(handle);
    expect(f.importer).toHaveBeenCalledWith(
      `/api/v1/plugins/ui/mounts/${lease.mountRef}/assets/ui/index.js`,
    );
    expect(f.h.root.textContent).toContain("初始内容");
    await expect(
      f.h.instances[0].services.invoke("query", { request: "saved" }, {}),
    ).resolves.toEqual({ accepted: true });
    const action = f.fetch.mock.calls.find(([url]) =>
      String(url).endsWith("/actions"),
    )!;
    expect(JSON.parse(String(action[1]?.body))).toEqual({
      action: "query",
      input: { request: "saved" },
    });
    expect(new Headers(action[1]?.headers).get("authorization")).toBe(
      "Bearer captured-user-token",
    );
    expect(new Headers(action[1]?.headers).get("x-csrf-token")).toBe(
      "captured-csrf-token",
    );
    expect(action[1]?.credentials).toBe("include");
    await handle.update(uiProps({ title: "宿主当前投影" }));
    expect(f.h.root.textContent).toContain("宿主当前投影");
    await handle.stop();
    expect(f.h.instances[0].dispose).toHaveBeenCalledTimes(1);
    const closes = f.fetch.mock.calls.filter(
      ([, init]) => init?.method === "DELETE",
    );
    expect(closes).toHaveLength(1);
    expect(closes[0][1]?.body).toBe("{}");
  });

  it("pins the complete validated lease, including descriptor, asset inventory, expiry and contribution", async () => {
    const original = uiLease();
    for (const changed of [
      { ...original, expiresAt: "2098-10-02T00:00:00.000Z" },
      {
        ...original,
        descriptor: { ...original.descriptor, title: "Changed metadata" },
      },
      { ...original, publicAssets: ["ui/index.js"] },
    ]) {
      const f = fixture({ readLease: () => changed });
      await expect(
        f.host.validateLease(original, new AbortController().signal),
      ).rejects.toThrow("plugin_ui_lease_identity_mismatch");
    }
    expect(checkedLeaseIdentity(original)).toBe(
      checkedLeaseIdentity(JSON.parse(JSON.stringify(original))),
    );
  });

  it("closes an allocated reference when open returned a changed package pin", async () => {
    const original = uiLease();
    const changed = {
      ...original,
      descriptor: { ...original.descriptor, title: "Unexpected" },
    };
    const f = fixture({ readLease: () => changed });
    await expect(
      f.host.acquireMount(
        controlUiItem(original),
        "workbench",
        new AbortController().signal,
      ),
    ).rejects.toThrow("plugin_ui_lease_identity_mismatch");
    expect(
      f.fetch.mock.calls.filter(([, init]) => init?.method === "DELETE"),
    ).toHaveLength(1);
    expect(f.importer).not.toHaveBeenCalled();
  });

  it("keeps a cancelled open response visible to its owner so that the lease can be closed", async () => {
    const gate = deferred<Response>();
    const lease = uiLease();
    let networkSignal!: AbortSignal;
    const wire = controlUiClient((_url, init) => {
      if (init.method === "DELETE") return controlUiResponse({ closed: true });
      networkSignal = init.signal!;
      return gate.promise;
    });
    const host = createControlPluginUiHost({
      client: wire.client,
      assertCurrent() {},
      onDiagnostic() {},
    });
    const caller = new AbortController();
    const opened = host.acquireMount(
      controlUiItem(lease),
      "workbench",
      caller.signal,
    );
    await flush();
    caller.abort();
    expect(networkSignal.aborted).toBe(false);
    gate.resolve(controlUiResponse(lease));
    const late = await opened;
    expect(late.mountRef).toBe(lease.mountRef);
    await host.loader.closeUnusedMount(late);
    expect(
      wire.fetch.mock.calls.filter(([, init]) => init?.method === "DELETE"),
    ).toHaveLength(1);
  });

  it("closes an allocated reference through the old client after an awaited session change", async () => {
    const gate = deferred<Response>();
    const lease = uiLease();
    let current = true;
    const wire = controlUiClient((_url, init) =>
      init.method === "DELETE"
        ? controlUiResponse({ closed: true })
        : gate.promise,
    );
    const host = createControlPluginUiHost({
      client: wire.client,
      assertCurrent() {
        if (!current) throw new Error("revoked");
      },
      onDiagnostic() {},
    });
    const task = host.acquireMount(
      controlUiItem(lease),
      "workbench",
      new AbortController().signal,
    );
    await flush();
    current = false;
    gate.resolve(controlUiResponse(lease));
    await expect(task).rejects.toThrow("revoked");
    const close = wire.fetch.mock.calls.find(
      ([, init]) => init?.method === "DELETE",
    )!;
    expect(new Headers(close[1]?.headers).get("authorization")).toBe(
      "Bearer captured-user-token",
    );
  });

  it("retains and diagnoses failed cleanup instead of claiming a leaked reference was purged", async () => {
    const f = fixture({ closeFails: true });
    f.revoke();
    await expect(f.host.loader.closeUnusedMount(f.lease)).rejects.toThrow();
    expect(f.host.loader.pendingCleanupCount).toBe(1);
    expect(f.onDiagnostic).toHaveBeenCalledTimes(1);
  });

  it("blocks stale host calls before transport and rejects stale results after the transport await", async () => {
    const f = fixture();
    f.revoke();
    await expect(
      f.host.acquireMount(
        controlUiItem(f.lease),
        "workbench",
        new AbortController().signal,
      ),
    ).rejects.toThrow("captured_session_revoked");
    await expect(
      f.host.validateLease(f.lease, new AbortController().signal),
    ).rejects.toThrow("captured_session_revoked");
    expect(f.fetch).not.toHaveBeenCalled();
    const gate = deferred<Response>();
    let current = true;
    const wire = controlUiClient(() => gate.promise);
    const host = createControlPluginUiHost({
      client: wire.client,
      assertCurrent() {
        if (!current) throw new Error("revoked");
      },
      onDiagnostic() {},
    });
    const checking = host.validateLease(f.lease, new AbortController().signal);
    await flush();
    current = false;
    gate.resolve(controlUiResponse(f.lease));
    await expect(checking).rejects.toThrow("revoked");
  });

  it("combines caller cancellation and a bounded five-second validation deadline", async () => {
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
    const host = createControlPluginUiHost({
      client: wire.client,
      assertCurrent() {},
      onDiagnostic() {},
    });
    const controller = new AbortController();
    const cancelled = host.validateLease(uiLease(), controller.signal);
    const cancelledCheck = expect(cancelled).rejects.toThrow(
      "plugin_ui_operation_aborted",
    );
    controller.abort();
    await cancelledCheck;
    const timed = host.validateLease(uiLease(), new AbortController().signal);
    const timedCheck = expect(timed).rejects.toThrow(
      "plugin_ui_control_timeout",
    );
    await vi.advanceTimersByTimeAsync(12_000);
    await timedCheck;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("enforces the deadline even when a transport has not settled its aborted fetch", async () => {
    vi.useFakeTimers();
    const gate = deferred<Response>();
    const wire = controlUiClient(() => gate.promise);
    const host = createControlPluginUiHost({
      client: wire.client,
      assertCurrent() {},
      onDiagnostic() {},
    });
    const task = host.validateLease(uiLease(), new AbortController().signal);
    const check = expect(task).rejects.toThrow("plugin_ui_control_timeout");
    await vi.advanceTimersByTimeAsync(12_000);
    await check;
    expect(wire.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    gate.resolve(controlUiResponse(uiLease()));
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("withholds an action output after the captured session changes during its HTTP request", async () => {
    const gate = deferred<Response>();
    const f = fixture({ actionResponse: () => gate.promise });
    const handle = await f.host.loader.mount({
      root: f.h.root,
      lease: await f.acquire(),
      props: uiProps(),
    });
    handles.push(handle);
    const task = f.h.instances[0].services.invoke("query", null, {});
    const check = expect(task).rejects.toThrow("captured_session_revoked");
    await flush();
    await vi.waitFor(() =>
      expect(
        f.fetch.mock.calls.some(([url]) => String(url).endsWith("/actions")),
      ).toBe(true),
    );
    f.revoke();
    gate.resolve(
      controlUiResponse({ output: { private: "must not reach plugin" } }),
    );
    await check;
    await handle.stop();
  });

  it("observes a same-session committed receipt after module navigation while cancelling delivery to disposed plugin code", async () => {
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
    const handle = await f.host.loader.mount({
      root: f.h.root,
      lease: await f.acquire(),
      props: uiProps(),
    });
    handles.push(handle);
    const called = f.h.instances[0].services.invoke(
      "arbitrary.business.command",
      null,
      {},
    );
    const rejected = expect(called).rejects.toThrow(
      "plugin_ui_operation_aborted",
    );
    await flush();
    await vi.waitFor(() =>
      expect(
        f.fetch.mock.calls.some(([url]) => String(url).endsWith("/actions")),
      ).toBe(true),
    );
    const request = f.fetch.mock.calls.find(([url]) =>
      String(url).endsWith("/actions"),
    )!;
    await handle.stop();
    await rejected;
    expect(request[1]?.signal?.aborted).toBe(false);
    gate.resolve(controlUiResponse({ output: receipt }));
    await flush();
    await vi.waitFor(() =>
      expect(observer).toHaveBeenCalledExactlyOnceWith({
        lease: f.lease,
        receipt,
      }),
    );
    expect(f.h.instances[0].dispose).toHaveBeenCalledTimes(1);
    expect(f.h.root.textContent).toBe("");
  });

  it("does not publish a late receipt to a replacement account session", async () => {
    const gate = deferred<Response>();
    const observer = vi.fn();
    const f = fixture({
      actionResponse: () => gate.promise,
      onTaskReceipt: observer,
    });
    const handle = await f.host.loader.mount({
      root: f.h.root,
      lease: await f.acquire(),
      props: uiProps(),
    });
    handles.push(handle);
    const called = f.h.instances[0].services.invoke("task", null, {});
    const rejected = expect(called).rejects.toThrow("captured_session_revoked");
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
    expect(observer).not.toHaveBeenCalled();
  });

  it("keeps ordinary or extra-field action output ordinary even with a receipt observer", async () => {
    const observer = vi.fn();
    const output = { accepted: true, runId: "run:1" };
    const f = fixture({
      actionResponse: () => controlUiResponse({ output }),
      onTaskReceipt: observer,
    });
    const handle = await f.host.loader.mount({
      root: f.h.root,
      lease: await f.acquire(),
      props: uiProps(),
    });
    handles.push(handle);
    await expect(
      f.h.instances[0].services.invoke("tasks.request", null, {}),
    ).resolves.toEqual(output);
    expect(observer).not.toHaveBeenCalled();
  });

  it("diagnoses a receipt observer failure without rejecting a confirmed response", async () => {
    const receipt = {
      disposition: "replayed",
      threadId: "thread:1",
      threadRevision: 2,
      runId: "run:1",
      messageId: "message:1",
      configurationRevision: 1,
    };
    const failure = new Error("host_task_projection_unavailable");
    const f = fixture({
      actionResponse: () => controlUiResponse({ output: receipt }),
      onTaskReceipt() {
        throw failure;
      },
    });
    const handle = await f.host.loader.mount({
      root: f.h.root,
      lease: await f.acquire(),
      props: uiProps(),
    });
    handles.push(handle);
    await expect(
      f.h.instances[0].services.invoke("business", null, {}),
    ).resolves.toEqual(receipt);
    expect(f.onDiagnostic).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it("rejects file renderers and cross-origin API configuration before acquiring or importing", () => {
    const fetch = vi.fn();
    const foreign = new ControlApiClient({
      baseUrl: "https://other.test",
      fetch,
    });
    expect(() =>
      createControlPluginUiHost({
        client: foreign,
        assertCurrent() {},
        onDiagnostic() {},
      }),
    ).toThrow("plugin_ui_asset_origin_mismatch");
    vi.stubGlobal(
      "location",
      new URL("file:///Applications/CrewON/index.html"),
    );
    expect(() =>
      createControlPluginUiHost({
        client: foreign,
        assertCurrent() {},
        onDiagnostic() {},
      }),
    ).toThrow("plugin_ui_transport_unsupported");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unapproved contributions, accessor objects and pre-aborted callers without transport", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    await expect(
      f.host.acquireMount(controlUiItem(f.lease), "other", signal),
    ).rejects.toThrow("plugin_ui_contribution_invalid");
    const getter = vi.fn();
    const malformed = Object.defineProperty({}, "descriptor", {
      enumerable: true,
      get: getter,
    });
    await expect(
      f.host.acquireMount(malformed as never, "workbench", signal),
    ).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      f.host.acquireMount(
        controlUiItem(f.lease),
        "workbench",
        cancelled.signal,
      ),
    ).rejects.toThrow("plugin_ui_operation_aborted");
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

it("accepts a valid delayed lease response within the BFF work budget instead of withdrawing the plugin at five seconds", async () => {
  vi.useFakeTimers();
  const wire = controlUiClient(
    () =>
      new Promise<Response>((resolve) =>
        setTimeout(() => resolve(controlUiResponse(uiLease())), 6000),
      ),
  );
  const host = createControlPluginUiHost({
    client: wire.client,
    assertCurrent() {},
    onDiagnostic() {},
  });
  const result = host.validateLease(uiLease(), new AbortController().signal);
  await flush();
  await vi.advanceTimersByTimeAsync(6000);
  await expect(result).resolves.toEqual(uiLease());
  expect(vi.getTimerCount()).toBe(0);
});
