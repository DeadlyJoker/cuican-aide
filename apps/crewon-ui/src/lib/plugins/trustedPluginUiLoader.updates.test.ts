// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlApiClientError } from "@crewon/control-client";
import type { PluginUiMountHandle } from "./trustedPluginUiLoader";
import { PluginUiLoaderError } from "./pluginUiValidation";
import { PluginUiUpdateDeferredError } from "./pluginUiPresentationUpdate";
import {
  deferred,
  flush,
  uiHarness,
  uiLease,
  uiProps,
} from "./pluginUiLoader.test-support";

const handles: PluginUiMountHandle[] = [];
afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.stop()));
  document.body.replaceChildren();
  vi.useRealTimers();
});
async function mounted(h = uiHarness(), lease = uiLease()) {
  const handle = await h.loader.mount({
    root: h.root,
    lease,
    props: uiProps(),
  });
  handles.push(handle);
  h.ports.validateMount.mockClear();
  return { h, handle, lease };
}
const timeout = () => new PluginUiLoaderError("plugin_ui_control_timeout");

describe("live mounted presentation updates", () => {
  it("does not revalidate equivalent props and does not lose a reversal during an executing update", async () => {
    const { h, handle } = await mounted();
    await handle.update(uiProps());
    expect(h.ports.validateMount).not.toHaveBeenCalled();
    await handle.update(uiProps({ a: 1, b: 2 }));
    h.ports.validateMount.mockClear();
    await handle.update(uiProps({ b: 2, a: 1 }));
    expect(h.ports.validateMount).not.toHaveBeenCalled();
    const gate = deferred<void>();
    h.ports.validateMount.mockImplementationOnce(() => gate.promise);
    const next = handle.update(uiProps({ title: "新阶段" }));
    const back = handle.update(uiProps({ a: 1, b: 2 }));
    gate.resolve();
    await next;
    await back;
    expect(h.root.textContent).toBe('{"a":1,"b":2}');
  });

  it("retains authorized content without delivering unverified props and resumes only the latest props after recovery", async () => {
    const { h, handle, lease } = await mounted();
    const gate = deferred<void>();
    h.ports.validateMount.mockImplementationOnce(() => gate.promise);
    const older = handle.update(uiProps({ stage: "角色" }));
    const latest = handle.update(uiProps({ stage: "美术" }));
    void older.catch(() => undefined);
    void latest.catch(() => undefined);
    gate.reject(timeout());
    await expect(older).rejects.toBeInstanceOf(PluginUiUpdateDeferredError);
    await expect(latest).rejects.toBeInstanceOf(PluginUiUpdateDeferredError);
    expect(h.root.textContent).toBe('{"title":"初始内容"}');
    expect(h.instances[0].update).not.toHaveBeenCalled();
    expect(h.instances[0].dispose).not.toHaveBeenCalled();
    expect(h.ports.onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ code: "plugin_ui_control_timeout" }),
    );
    h.loader.resumeDeferredUpdate(lease);
    await flush();
    expect(h.ports.validateMount).toHaveBeenCalledTimes(3);
    expect(h.instances[0].update).toHaveBeenCalledTimes(1);
    expect(h.root.textContent).toBe('{"stage":"美术"}');
    expect(h.ports.invoke).not.toHaveBeenCalled();
  });

  it("retains a post-fence transient presentation, and actions remain live without automatic retry", async () => {
    const { h, handle } = await mounted();
    h.ports.validateMount
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(timeout());
    await expect(
      handle.update(uiProps({ stage: "剧本" })),
    ).rejects.toBeInstanceOf(PluginUiUpdateDeferredError);
    expect(h.root.textContent).toBe('{"stage":"剧本"}');
    expect(h.instances[0].dispose).not.toHaveBeenCalled();
    h.ports.validateMount.mockRejectedValueOnce(timeout());
    await expect(
      h.instances[0].services.invoke("save", null, {}),
    ).rejects.toThrow("plugin_ui_control_timeout");
    expect(h.ports.invoke).not.toHaveBeenCalled();
    await flush();
    expect(h.ports.invoke).not.toHaveBeenCalled();
  });

  it.each([
    new PluginUiLoaderError("plugin_ui_lease_identity_mismatch"),
    new ControlApiClientError({
      status: 403,
      category: "authorization",
      code: "forbidden",
      requestId: "test",
    }),
    new ControlApiClientError({
      status: 401,
      category: "authentication",
      code: "unauthorized",
      requestId: "test",
    }),
    new ControlApiClientError({
      status: 404,
      category: "notFound",
      code: "not_found",
      requestId: "test",
    }),
  ])("discards immediately on a hard fence failure %s", async (error) => {
    const { h, handle } = await mounted();
    h.ports.validateMount.mockRejectedValueOnce(error);
    await expect(handle.update(uiProps({ stage: "角色" }))).rejects.toBe(error);
    expect(h.root.firstElementChild).toBeNull();
    expect(h.instances[0].update).not.toHaveBeenCalled();
  });

  it("does not preserve an expired lease or an instance error disguised as a transport timeout", async () => {
    vi.useFakeTimers();
    const lease = {
      ...uiLease(),
      expiresAt: new Date(Date.now() + 1000).toISOString(),
    };
    const { h, handle } = await mounted(uiHarness(), lease);
    h.ports.validateMount.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.parse(lease.expiresAt) + 1);
      throw timeout();
    });
    await expect(handle.update(uiProps({ stage: "角色" }))).rejects.toThrow(
      "plugin_ui_lease_expired",
    );
    expect(h.root.firstElementChild).toBeNull();
    const other = await mounted();
    other.h.instances[0].update.mockRejectedValueOnce(timeout());
    await expect(
      other.handle.update(uiProps({ stage: "美术" })),
    ).rejects.toThrow("plugin_ui_control_timeout");
    expect(other.h.root.firstElementChild).toBeNull();
  });

  it("ignores old recovery notifications after renewal, and never resurrects a stopped mount", async () => {
    const { h, handle, lease } = await mounted();
    h.ports.validateMount.mockRejectedValueOnce(timeout());
    await expect(
      handle.update(uiProps({ stage: "画面" })),
    ).rejects.toBeInstanceOf(PluginUiUpdateDeferredError);
    const next = {
      ...lease,
      expiresAt: new Date(Date.parse(lease.expiresAt) + 240_000).toISOString(),
    };
    h.loader.renewLease(lease, next);
    h.loader.resumeDeferredUpdate(lease);
    await flush();
    expect(h.instances[0].update).not.toHaveBeenCalled();
    await handle.stop();
    h.loader.resumeDeferredUpdate(next);
    await flush();
    expect(h.instances[0].update).not.toHaveBeenCalled();
    expect(h.root.firstElementChild).toBeNull();
  });
});
