// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginUiMountHandle } from "./trustedPluginUiLoader";
import { createControlPluginUiHost } from "./controlPluginUiHost";
import { PluginUiUpdateDeferredError } from "./pluginUiPresentationUpdate";
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
  await Promise.allSettled(handles.splice(0).map((handle) => handle.stop()));
  document.body.replaceChildren();
});
const unavailable = () =>
  controlUiResponse(
    {
      error: {
        code: "service_unavailable",
        category: "providerUnavailable",
        requestId: "test",
      },
    },
    503,
  );

describe("host-private validation observations", () => {
  it("coalesces an in-flight GET with independently cancellable callers and never caches its result", async () => {
    const gate = deferred<Response>();
    const wire = controlUiClient(() => gate.promise);
    const assertCurrent = vi.fn();
    const host = createControlPluginUiHost({
      client: wire.client,
      assertCurrent,
      onDiagnostic() {},
    });
    const one = new AbortController();
    const first = host.validateLease(uiLease(), one.signal);
    const second = host.validateLease(uiLease(), new AbortController().signal);
    void first.catch(() => undefined);
    await flush();
    expect(wire.fetch).toHaveBeenCalledTimes(1);
    one.abort();
    await expect(first).rejects.toThrow("plugin_ui_operation_aborted");
    expect(wire.fetch.mock.calls[0][1]?.signal?.aborted).toBe(false);
    gate.resolve(controlUiResponse(uiLease()));
    await expect(second).resolves.toEqual(uiLease());
    const again = host.validateLease(uiLease(), new AbortController().signal);
    // Each GET needs its own response body even when the transport fixture already settled.
    wire.fetch.mockResolvedValueOnce(controlUiResponse(uiLease()));
    await again;
    expect(wire.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not preserve a transient result after host scope withdrawal", async () => {
    const gate = deferred<Response>();
    const wire = controlUiClient(() => gate.promise);
    let current = true;
    const host = createControlPluginUiHost({
      client: wire.client,
      assertCurrent() {
        if (!current) throw new Error("scope_withdrawn");
      },
      onDiagnostic() {},
    });
    const pending = host.validateLease(uiLease(), new AbortController().signal);
    void pending.catch(() => undefined);
    await flush();
    current = false;
    gate.resolve(unavailable());
    await expect(pending).rejects.toThrow("scope_withdrawn");
  });

  it.each([503, 502])(
    "resumes the latest deferred props after HTTP %i recovery, and actions still use fresh fences",
    async (status) => {
      const lease = uiLease();
      let offline = false;
      const wire = controlUiClient((_url, init) => {
        if (init.method === "DELETE")
          return controlUiResponse({ closed: true });
        if (init.method === "POST")
          return _url.pathname.endsWith("/actions")
            ? controlUiResponse({ output: { ok: true } })
            : controlUiResponse(lease);
        return offline
          ? status === 503
            ? unavailable()
            : new Response("upstream unavailable", {
                status,
                headers: { "content-type": "text/html" },
              })
          : controlUiResponse(lease);
      });
      const h = uiHarness();
      const diagnostic = vi.fn();
      const host = createControlPluginUiHost({
        client: wire.client,
        assertCurrent() {},
        onDiagnostic: diagnostic,
        importer: async () => ({ default: h.definition }),
      });
      const owned = await host.acquireMount(
        controlUiItem(lease),
        "workbench",
        new AbortController().signal,
      );
      const handle = await host.loader.mount({
        root: h.root,
        lease: owned,
        props: uiProps(),
      });
      handles.push(handle);
      offline = true;
      await expect(
        handle.update(uiProps({ stage: "角色" })),
      ).rejects.toBeInstanceOf(PluginUiUpdateDeferredError);
      expect(h.instances[0].update).not.toHaveBeenCalled();
      expect(h.instances[0].dispose).not.toHaveBeenCalled();
      expect(diagnostic).toHaveBeenCalledWith(
        expect.objectContaining(
          status === 503
            ? { status }
            : {
                code: "control_api_error_envelope_invalid",
                httpStatus: status,
              },
        ),
      );
      offline = false;
      const before = wire.fetch.mock.calls.length;
      await host.validateLease(lease, new AbortController().signal);
      await vi.waitFor(() =>
        expect(h.root.textContent).toBe('{"stage":"角色"}'),
      );
      await flush();
      expect(wire.fetch.mock.calls.length - before).toBe(3); // Observation + independent pre/post update fences.
      const after = wire.fetch.mock.calls.length;
      await handle.update(uiProps({ stage: "角色" }));
      expect(wire.fetch.mock.calls.length).toBe(after);
      await h.instances[0].services.invoke("query", null, {});
      const calls = wire.fetch.mock.calls.slice(after);
      expect(calls.filter(([, init]) => init?.method === "GET")).toHaveLength(
        2,
      );
      expect(calls.filter(([, init]) => init?.method === "POST")).toHaveLength(
        1,
      );
    },
  );

  it.each([200, 401, 403, 404])(
    "immediately discards malformed HTTP %i rather than preserving it as a server outage",
    async (status) => {
      const lease = uiLease();
      let malformed = false;
      const wire = controlUiClient((_url, init) => {
        if (init.method === "DELETE")
          return controlUiResponse({ closed: true });
        return malformed
          ? new Response("invalid protocol body", {
              status,
              headers: { "content-type": "text/html" },
            })
          : controlUiResponse(lease);
      });
      const h = uiHarness();
      const host = createControlPluginUiHost({
        client: wire.client,
        assertCurrent() {},
        onDiagnostic() {},
        importer: async () => ({ default: h.definition }),
      });
      const handle = await host.loader.mount({
        root: h.root,
        lease,
        props: uiProps(),
      });
      handles.push(handle);
      malformed = true;
      await expect(
        handle.update(uiProps({ stage: "角色" })),
      ).rejects.not.toBeInstanceOf(PluginUiUpdateDeferredError);
      expect(h.root.firstElementChild).toBeNull();
      expect(h.instances[0].update).not.toHaveBeenCalled();
    },
  );

  it("withdraws a released mount's pending read even if its transport ignores cancellation", async () => {
    const lease = uiLease();
    const gate = deferred<Response>();
    let waiting = false;
    const wire = controlUiClient((_url, init) => {
      if (init.method === "DELETE") return controlUiResponse({ closed: true });
      return waiting && init.method === "GET"
        ? gate.promise
        : controlUiResponse(lease);
    });
    const h = uiHarness();
    const host = createControlPluginUiHost({
      client: wire.client,
      assertCurrent() {},
      onDiagnostic() {},
      importer: async () => ({ default: h.definition }),
    });
    const owned = await host.acquireMount(
      controlUiItem(lease),
      "workbench",
      new AbortController().signal,
    );
    const handle = await host.loader.mount({
      root: h.root,
      lease: owned,
      props: uiProps(),
    });
    handles.push(handle);
    waiting = true;
    const pending = host.validateLease(lease, new AbortController().signal);
    void pending.catch(() => undefined);
    await flush();
    const request = wire.fetch.mock.calls.at(-1)!;
    await handle.stop();
    await expect(pending).rejects.toThrow("plugin_ui_operation_aborted");
    expect(request[1]?.signal?.aborted).toBe(true);
    gate.resolve(controlUiResponse(lease));
    await flush();
    expect(h.root.firstElementChild).toBeNull();
  });

  it("does not publish a cancelled old GET after renewal and validates the new epoch through a fresh GET", async () => {
    const previous = uiLease();
    const next = {
      ...previous,
      expiresAt: new Date(
        Date.parse(previous.expiresAt) + 240_000,
      ).toISOString(),
    };
    const gate = deferred<Response>();
    let current = previous;
    let waiting = false;
    const wire = controlUiClient((url, init) => {
      if (init.method === "DELETE") return controlUiResponse({ closed: true });
      if (url.pathname.endsWith("/renew")) {
        current = next;
        waiting = false;
        return controlUiResponse(next);
      }
      return waiting && init.method === "GET"
        ? gate.promise
        : controlUiResponse(current);
    });
    const h = uiHarness();
    const host = createControlPluginUiHost({
      client: wire.client,
      assertCurrent() {},
      onDiagnostic() {},
      importer: async () => ({ default: h.definition }),
    });
    const owned = await host.acquireMount(
      controlUiItem(previous),
      "workbench",
      new AbortController().signal,
    );
    const handle = await host.loader.mount({
      root: h.root,
      lease: owned,
      props: uiProps(),
    });
    handles.push(handle);
    waiting = true;
    const caller = new AbortController();
    const pending = host.validateLease(previous, caller.signal);
    void pending.catch(() => undefined);
    await flush();
    const originalGet = wire.fetch.mock.calls.at(-1)!;
    const renewed = host.renewLease!(previous, new AbortController().signal);
    caller.abort();
    await expect(pending).rejects.toThrow("plugin_ui_operation_aborted");
    await expect(renewed).resolves.toEqual(next);
    expect(originalGet[1]?.signal?.aborted).toBe(true);
    gate.resolve(controlUiResponse(previous));
    await flush();
    await expect(
      host.validateLease(previous, new AbortController().signal),
    ).rejects.toThrow("plugin_ui_lease_identity_mismatch");
    const before = wire.fetch.mock.calls.length;
    await expect(
      host.validateLease(next, new AbortController().signal),
    ).resolves.toEqual(next);
    expect(wire.fetch.mock.calls.length).toBe(before + 1);
    expect(h.root.firstElementChild).not.toBeNull();
  });
});
