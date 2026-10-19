// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parsePluginUiLease,
  type PluginUiLease,
} from "@crewon/contracts/plugins";
import {
  PluginUiLeaseLifecycle,
  PluginUiLeaseRenewalDeferredError,
} from "./pluginUiLeaseLifecycle";
import { deferred, flush, uiLease } from "./pluginUiLoader.test-support";

const NOW = Date.parse("2026-10-05T00:00:00.000Z");
const signal = () => new AbortController().signal;
const lease = (serial = 1) =>
  parsePluginUiLease({
    ...uiLease(serial),
    expiresAt: new Date(NOW + 60_000).toISOString(),
  });
const extension = (previous: PluginUiLease) =>
  parsePluginUiLease({
    ...previous,
    expiresAt: new Date(Date.parse(previous.expiresAt) + 240_000).toISOString(),
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("plugin UI lease owner ordering", () => {
  it("retains only the confirmed unchanged owner after deferred renewal without replaying queued work or extending expiry", async () => {
    const lifecycle = new PluginUiLeaseLifecycle();
    const previous = lease();
    lifecycle.register(previous);
    const response = deferred<unknown>();
    const request = vi.fn(async () => response.promise);
    const commit = vi.fn();
    const renewing = lifecycle.renew(previous, signal(), request, commit);
    const queuedWork = vi.fn();
    const queued = lifecycle.run(previous, signal(), queuedWork);
    void renewing.catch(() => undefined);
    void queued.catch(() => undefined);
    const deferredError = new PluginUiLeaseRenewalDeferredError(previous);
    response.reject(deferredError);
    await expect(renewing).rejects.toBe(deferredError);
    await expect(queued).rejects.toBe(deferredError);
    expect(queuedWork).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    await expect(
      lifecycle.run(previous, signal(), (current) => current),
    ).resolves.toEqual(previous);
    vi.setSystemTime(Date.parse(previous.expiresAt));
    await expect(lifecycle.run(previous, signal(), queuedWork)).rejects.toThrow(
      "plugin_ui_lease_expired",
    );
    await expect(
      lifecycle.renew(previous, signal(), request, commit),
    ).rejects.toThrow("plugin_ui_lease_expired");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("never trusts deferred text, a changed lease, late expiry, or a deferred error thrown by commit", async () => {
    const previous = lease();
    for (const mode of ["message", "changed", "expired", "commit"] as const) {
      vi.setSystemTime(NOW);
      const lifecycle = new PluginUiLeaseLifecycle();
      lifecycle.register(previous);
      const request = async () => {
        if (mode === "commit") return extension(previous);
        if (mode === "expired")
          vi.setSystemTime(Date.parse(previous.expiresAt));
        if (mode === "message")
          throw new Error("plugin_ui_lease_renewal_deferred");
        throw new PluginUiLeaseRenewalDeferredError(
          mode === "changed" ? extension(previous) : previous,
        );
      };
      await expect(
        lifecycle.renew(previous, signal(), request, () => {
          throw new PluginUiLeaseRenewalDeferredError(previous);
        }),
      ).rejects.toThrow();
      await expect(lifecycle.run(previous, signal(), vi.fn())).rejects.toThrow(
        "plugin_ui_lease_owner_missing",
      );
    }
  });

  it("drains real work and singleflights renewal before waiting actions use the same owner's latest lease", async () => {
    const lifecycle = new PluginUiLeaseLifecycle();
    const previous = lease();
    const next = extension(previous);
    lifecycle.register(previous);
    const operation = deferred<string>();
    const response = deferred<unknown>();
    const request = vi.fn(
      async (_old: PluginUiLease, _signal: AbortSignal) => response.promise,
    );
    const commit = vi.fn();
    const originalWork = vi.fn(async (current: PluginUiLease) => {
      expect(current).toEqual(previous);
      return operation.promise;
    });
    const original = lifecycle.run(previous, signal(), originalWork);
    await flush();
    const renewed = lifecycle.renew(previous, signal(), request, commit);
    const joined = lifecycle.renew(previous, signal(), request, commit);
    const followingWork = vi.fn(
      async (current: PluginUiLease) => current.expiresAt,
    );
    const following = lifecycle.run(previous, signal(), followingWork);
    await flush();
    expect(request).not.toHaveBeenCalled();
    expect(followingWork).not.toHaveBeenCalled();
    operation.resolve("original receipt");
    await expect(original).resolves.toBe("original receipt");
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toEqual(previous);
    response.resolve(next);
    await expect(renewed).resolves.toEqual(next);
    await expect(joined).resolves.toEqual(next);
    await expect(following).resolves.toBe(next.expiresAt);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(previous, next);
    expect(originalWork).toHaveBeenCalledTimes(1);
    expect(followingWork).toHaveBeenCalledTimes(1);
    await expect(lifecycle.run(previous, signal(), vi.fn())).rejects.toThrow(
      "plugin_ui_lease_identity_mismatch",
    );
    vi.setSystemTime(Date.parse(previous.expiresAt) + 1);
    await expect(
      lifecycle.run(next, signal(), (current) => current),
    ).resolves.toEqual(next);
  });

  it("keeps cancelled actual work in the drain set and cancels only a renewal caller's wait", async () => {
    const lifecycle = new PluginUiLeaseLifecycle();
    const previous = lease();
    const next = extension(previous);
    lifecycle.register(previous);
    const operation = deferred<string>();
    const caller = new AbortController();
    const original = lifecycle.run(
      previous,
      caller.signal,
      () => operation.promise,
    );
    void original.catch(() => undefined);
    await flush();
    caller.abort();
    await expect(original).rejects.toThrow("plugin_ui_operation_aborted");
    const renewalCaller = new AbortController();
    const response = deferred<unknown>();
    const request = vi.fn(
      async (_old: PluginUiLease, renewalSignal: AbortSignal) => {
        expect(renewalSignal.aborted).toBe(false);
        return response.promise;
      },
    );
    const commit = vi.fn();
    const renewing = lifecycle.renew(
      previous,
      renewalCaller.signal,
      request,
      commit,
    );
    void renewing.catch(() => undefined);
    renewalCaller.abort();
    await expect(renewing).rejects.toThrow("plugin_ui_operation_aborted");
    const queuedCaller = new AbortController();
    const queuedWork = vi.fn();
    const queued = lifecycle.run(previous, queuedCaller.signal, queuedWork);
    void queued.catch(() => undefined);
    queuedCaller.abort();
    await expect(queued).rejects.toThrow("plugin_ui_operation_aborted");
    await flush();
    expect(request).not.toHaveBeenCalled();
    operation.resolve("late real receipt");
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    const joined = lifecycle.renew(previous, signal(), request, commit);
    response.resolve(next);
    await expect(joined).resolves.toEqual(next);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(queuedWork).not.toHaveBeenCalled();
  });

  it("bounds actual operations even after callers cancel and never reissues their work", async () => {
    const lifecycle = new PluginUiLeaseLifecycle();
    const previous = lease();
    lifecycle.register(previous);
    const gate = deferred<number>();
    const caller = new AbortController();
    const work = vi.fn(async () => gate.promise);
    const operations = Array.from({ length: 64 }, () =>
      lifecycle.run(previous, caller.signal, work),
    );
    for (const operation of operations) void operation.catch(() => undefined);
    await flush();
    expect(work).toHaveBeenCalledTimes(64);
    await expect(lifecycle.run(previous, signal(), work)).rejects.toThrow(
      "plugin_ui_lease_operation_limit",
    );
    caller.abort();
    await Promise.allSettled(operations);
    await expect(lifecycle.run(previous, signal(), work)).rejects.toThrow(
      "plugin_ui_lease_operation_limit",
    );
    const request = vi.fn(async () => extension(previous));
    const renewed = lifecycle.renew(previous, signal(), request, vi.fn());
    await flush();
    expect(request).not.toHaveBeenCalled();
    gate.resolve(1);
    await expect(renewed).resolves.toEqual(extension(previous));
    expect(request).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenCalledTimes(64);
  });

  it("bounds concurrent renewal waiters around one actual request", async () => {
    const lifecycle = new PluginUiLeaseLifecycle();
    const previous = lease();
    const next = extension(previous);
    lifecycle.register(previous);
    const gate = deferred<unknown>();
    const request = vi.fn(async () => gate.promise);
    const commit = vi.fn();
    const waiters = Array.from({ length: 64 }, () =>
      lifecycle.renew(previous, signal(), request, commit),
    );
    await expect(
      lifecycle.renew(previous, signal(), request, commit),
    ).rejects.toThrow("plugin_ui_lease_renewal_waiter_limit");
    const noWork = vi.fn();
    await expect(lifecycle.run(previous, signal(), noWork)).rejects.toThrow(
      "plugin_ui_lease_renewal_waiter_limit",
    );
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    gate.resolve(next);
    expect(await Promise.all(waiters)).toEqual(
      Array.from({ length: 64 }, () => next),
    );
    expect(commit).toHaveBeenCalledTimes(1);
    expect(noWork).not.toHaveBeenCalled();
  });

  it("does not revive a released owner or substitute a new owner when an old response arrives", async () => {
    const lifecycle = new PluginUiLeaseLifecycle();
    const previous = lease();
    lifecycle.register(previous);
    const gate = deferred<unknown>();
    const request = vi.fn(
      async (_old: PluginUiLease, renewalSignal: AbortSignal) => {
        expect(renewalSignal.aborted).toBe(false);
        return gate.promise;
      },
    );
    const commit = vi.fn();
    const renewal = lifecycle.renew(previous, signal(), request, commit);
    void renewal.catch(() => undefined);
    const queuedWork = vi.fn();
    const queued = lifecycle.run(previous, signal(), queuedWork);
    void queued.catch(() => undefined);
    await flush();
    lifecycle.release(previous);
    expect(request.mock.calls[0][1].aborted).toBe(true);
    lifecycle.register(previous);
    gate.resolve(extension(previous));
    await expect(renewal).rejects.toThrow("plugin_ui_operation_aborted");
    await expect(queued).rejects.toThrow("plugin_ui_operation_aborted");
    expect(commit).not.toHaveBeenCalled();
    expect(queuedWork).not.toHaveBeenCalled();
    await expect(
      lifecycle.run(previous, signal(), () => "new owner only"),
    ).resolves.toBe("new owner only");
  });

  it("checks old expiry after draining and after a delayed response", async () => {
    const lifecycle = new PluginUiLeaseLifecycle();
    const previous = lease();
    lifecycle.register(previous);
    const gate = deferred<unknown>();
    const operation = lifecycle.run(previous, signal(), () => gate.promise);
    void operation.catch(() => undefined);
    const request = vi.fn(async () => extension(previous));
    const commit = vi.fn();
    const renewing = lifecycle.renew(previous, signal(), request, commit);
    void renewing.catch(() => undefined);
    await flush();
    vi.setSystemTime(Date.parse(previous.expiresAt));
    gate.resolve(null);
    await expect(operation).rejects.toThrow("plugin_ui_lease_expired");
    await expect(renewing).rejects.toThrow("plugin_ui_lease_expired");
    expect(request).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();

    vi.setSystemTime(NOW);
    const other = lease(2);
    lifecycle.register(other);
    const response = deferred<unknown>();
    const late = lifecycle.renew(
      other,
      signal(),
      async () => response.promise,
      commit,
    );
    void late.catch(() => undefined);
    await flush();
    vi.setSystemTime(Date.parse(other.expiresAt));
    response.resolve(extension(other));
    await expect(late).rejects.toThrow("plugin_ui_lease_expired");
    expect(commit).not.toHaveBeenCalled();
  });

  it("rejects every changed pin and non-increasing or excessive extension before commit", async () => {
    const previous = lease();
    const next = extension(previous);
    const responses = [
      { ...next, mountRef: lease(2).mountRef },
      { ...next, selectionRevision: 2 },
      { ...next, packageDigest: lease(2).packageDigest },
      { ...next, descriptor: { ...next.descriptor, title: "changed" } },
      { ...next, publicAssets: [...next.publicAssets].reverse() },
      previous,
      {
        ...next,
        expiresAt: new Date(Date.parse(previous.expiresAt) - 1).toISOString(),
      },
      {
        ...next,
        expiresAt: new Date(
          Date.parse(previous.expiresAt) + 300_001,
        ).toISOString(),
      },
    ];
    for (const response of responses) {
      const lifecycle = new PluginUiLeaseLifecycle();
      lifecycle.register(previous);
      const commit = vi.fn();
      await expect(
        lifecycle.renew(previous, signal(), async () => response, commit),
      ).rejects.toThrow();
      expect(commit).not.toHaveBeenCalled();
      await expect(
        lifecycle.renew(previous, signal(), async () => next, commit),
      ).rejects.toThrow("plugin_ui_lease_owner_missing");
    }
  });

  it("withdraws after a failed request or partial synchronous commit without silently retrying", async () => {
    for (const commitFailure of [false, true]) {
      const lifecycle = new PluginUiLeaseLifecycle();
      const previous = lease();
      lifecycle.register(previous);
      const failure = new Error(
        commitFailure ? "commit failure" : "request failure",
      );
      const request = vi.fn(async () => {
        if (!commitFailure) throw failure;
        return extension(previous);
      });
      const commit = vi.fn(() => {
        throw failure;
      });
      await expect(
        lifecycle.renew(previous, signal(), request, commit),
      ).rejects.toBe(failure);
      await expect(
        lifecycle.renew(previous, signal(), request, commit),
      ).rejects.toThrow("plugin_ui_lease_owner_missing");
      const businessWork = vi.fn();
      await expect(
        lifecycle.run(previous, signal(), businessWork),
      ).rejects.toThrow("plugin_ui_lease_owner_missing");
      expect(businessWork).not.toHaveBeenCalled();
      const observed = vi.fn(async (current: PluginUiLease) => current);
      await expect(
        lifecycle.validate(previous, signal(), observed),
      ).resolves.toEqual(previous);
      expect(observed).toHaveBeenCalledTimes(1);
      await expect(
        lifecycle.run(previous, signal(), businessWork),
      ).rejects.toThrow("plugin_ui_lease_owner_missing");
      expect(request).toHaveBeenCalledTimes(1);
      expect(commit).toHaveBeenCalledTimes(commitFailure ? 1 : 0);
    }
  });

  it("rejects stale full leases and duplicate registration without replacing the original owner", async () => {
    const lifecycle = new PluginUiLeaseLifecycle();
    const previous = lease();
    lifecycle.register(previous);
    expect(() => lifecycle.register(previous)).toThrow(
      "plugin_ui_mount_ref_already_registered",
    );
    const changed = parsePluginUiLease({ ...previous, selectionRevision: 2 });
    await expect(lifecycle.run(changed, signal(), vi.fn())).rejects.toThrow(
      "plugin_ui_lease_identity_mismatch",
    );
    await expect(
      lifecycle.renew(changed, signal(), vi.fn(), vi.fn()),
    ).rejects.toThrow("plugin_ui_lease_identity_mismatch");
    expect(() => lifecycle.release(changed)).toThrow(
      "plugin_ui_lease_identity_mismatch",
    );
    await expect(
      lifecycle.run(previous, signal(), () => "original owner"),
    ).resolves.toBe("original owner");
  });

  it("permits explicit standalone validation while business work and renewal require an owner", async () => {
    const lifecycle = new PluginUiLeaseLifecycle();
    const previous = lease();
    const work = vi.fn(async (current: PluginUiLease) => current.mountRef);
    await expect(lifecycle.validate(previous, signal(), work)).resolves.toBe(
      previous.mountRef,
    );
    expect(work).toHaveBeenCalledWith(previous);
    const business = vi.fn();
    await expect(lifecycle.run(previous, signal(), business)).rejects.toThrow(
      "plugin_ui_lease_owner_missing",
    );
    expect(business).not.toHaveBeenCalled();
    const request = vi.fn();
    await expect(
      lifecycle.renew(previous, signal(), request, vi.fn()),
    ).rejects.toThrow("plugin_ui_lease_owner_missing");
    expect(request).not.toHaveBeenCalled();
    const caller = new AbortController();
    caller.abort();
    await expect(
      lifecycle.validate(previous, caller.signal, work),
    ).rejects.toThrow("plugin_ui_operation_aborted");
    expect(work).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.parse(previous.expiresAt));
    expect(() => lifecycle.register(previous)).toThrow(
      "plugin_ui_lease_expired",
    );
  });

  it("bounds registered live owners and frees their slots on explicit release", () => {
    const lifecycle = new PluginUiLeaseLifecycle();
    const owners = Array.from({ length: 128 }, (_, index) => lease(index + 1));
    for (const owner of owners) lifecycle.register(owner);
    expect(() => lifecycle.register(lease(129))).toThrow(
      "plugin_ui_lease_owner_limit",
    );
    lifecycle.release(owners[0]);
    expect(() => lifecycle.register(lease(129))).not.toThrow();
    expect(() => lifecycle.register(lease(130))).toThrow(
      "plugin_ui_lease_owner_limit",
    );
  });

  it("pre-registers synchronously started work before a reentrant renewal drains it", async () => {
    const lifecycle = new PluginUiLeaseLifecycle();
    const previous = lease();
    const next = extension(previous);
    lifecycle.register(previous);
    const gate = deferred<string>();
    const request = vi.fn(async () => next);
    const commit = vi.fn();
    let renewing!: Promise<PluginUiLease>;
    const work = vi.fn(() => {
      renewing = lifecycle.renew(previous, signal(), request, commit);
      return gate.promise;
    });
    const operation = lifecycle.run(previous, signal(), work);
    expect(work).toHaveBeenCalledTimes(1);
    await flush();
    expect(request).not.toHaveBeenCalled();
    gate.resolve("the same work");
    await expect(operation).resolves.toBe("the same work");
    await expect(renewing).resolves.toEqual(next);
    expect(request).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
