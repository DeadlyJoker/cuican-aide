// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { PluginUiLease } from "@crewon/contracts/plugins";
import { PluginUiValidationFlights } from "./pluginUiValidationFlights";
import { deferred, flush, uiLease } from "./pluginUiLoader.test-support";

describe("current lease validation flights", () => {
  it("shares pending reads only and issues a new read after settlement", async () => {
    const flights = new PluginUiValidationFlights();
    const gate = deferred<PluginUiLease>();
    const request = vi.fn<(signal: AbortSignal) => Promise<PluginUiLease>>(
      () => gate.promise,
    );
    const first = flights.run(uiLease(), new AbortController().signal, request);
    const second = flights.run(
      uiLease(),
      new AbortController().signal,
      request,
    );
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    gate.resolve(uiLease());
    await expect(first).resolves.toEqual(uiLease());
    await expect(second).resolves.toEqual(uiLease());
    await flights.run(uiLease(), new AbortController().signal, request);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps another caller alive when one cancels; cancels the request when all leave", async () => {
    const flights = new PluginUiValidationFlights();
    const gate = deferred<PluginUiLease>();
    const request = vi.fn<(signal: AbortSignal) => Promise<PluginUiLease>>(
      () => gate.promise,
    );
    const one = new AbortController();
    const two = new AbortController();
    const first = flights.run(uiLease(), one.signal, request);
    const second = flights.run(uiLease(), two.signal, request);
    void first.catch(() => undefined);
    void second.catch(() => undefined);
    await flush();
    one.abort();
    await expect(first).rejects.toThrow("plugin_ui_operation_aborted");
    expect(request.mock.calls[0][0].aborted).toBe(false);
    two.abort();
    await expect(second).rejects.toThrow("plugin_ui_operation_aborted");
    expect(request.mock.calls[0][0].aborted).toBe(true);
    // A transport ignoring cancellation cannot publish its late result into a new flight.
    const fresh = flights.run(
      uiLease(),
      new AbortController().signal,
      async () => uiLease(),
    );
    gate.resolve(uiLease());
    await expect(fresh).resolves.toEqual(uiLease());
  });

  it("does not combine mounts or lease epochs and withdraws an old epoch immediately", async () => {
    const flights = new PluginUiValidationFlights();
    const gate = deferred<PluginUiLease>();
    const old = uiLease();
    const renewed = { ...old, expiresAt: "2099-10-03T00:00:00.000Z" };
    const request = vi.fn<(signal: AbortSignal) => Promise<PluginUiLease>>(
      () => gate.promise,
    );
    const stale = flights.run(old, new AbortController().signal, request);
    void stale.catch(() => undefined);
    const next = flights.run(
      renewed,
      new AbortController().signal,
      async () => renewed,
    );
    const other = flights.run(
      uiLease(2),
      new AbortController().signal,
      async () => uiLease(2),
    );
    await flush();
    flights.withdraw(old);
    await expect(stale).rejects.toThrow("plugin_ui_operation_aborted");
    expect(request.mock.calls[0][0].aborted).toBe(true);
    await expect(next).resolves.toEqual(renewed);
    await expect(other).resolves.toEqual(uiLease(2));
    gate.resolve(old);
    await flush();
  });
});
