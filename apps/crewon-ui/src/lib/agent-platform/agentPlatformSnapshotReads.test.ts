import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPlatformSnapshotReads } from "./agentPlatformSnapshotReads";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const settle = async () => {
  for (let index = 0; index < 10; index++) await Promise.resolve();
};

describe("account-scoped snapshot read borrowers", () => {
  afterEach(() => vi.useRealTimers());

  it("enforces an aggregate deadline including preflight and only aborts its own read", async () => {
    vi.useFakeTimers();
    const owner = new AgentPlatformSnapshotReads<string>({
      deadlineMs: 45_000,
    });
    const account = new AbortController();
    const physical = deferred<string>();
    let readSignal!: AbortSignal;
    const pending = owner.read({
      session: { generation: 1, signal: account.signal },
      read: (signal) => {
        readSignal = signal;
        return physical.promise;
      },
    });
    const rejected = expect(pending).rejects.toThrow(
      "agent_platform_catalog_snapshot_timeout",
    );
    await vi.advanceTimersByTimeAsync(44_999);
    expect(readSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(readSignal.aborted).toBe(true);
    expect(account.signal.aborted).toBe(false);
    physical.resolve("late data");
    await settle();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("shares StrictMode replacement work and does not cache a completed snapshot", async () => {
    const owner = new AgentPlatformSnapshotReads<string>();
    const session = { generation: 1, signal: new AbortController().signal };
    const physical = deferred<string>();
    let workSignal!: AbortSignal;
    const read = vi.fn((signal: AbortSignal) => {
      workSignal = signal;
      return physical.promise;
    });
    const firstView = new AbortController();
    const first = owner.read({ session, signal: firstView.signal, read });
    const rejected = expect(first).rejects.toThrow("StrictMode cleanup");
    firstView.abort(new Error("StrictMode cleanup"));
    const replacement = owner.read({
      session,
      signal: new AbortController().signal,
      read,
    });
    await rejected;
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    expect(workSignal.aborted).toBe(false);
    physical.resolve("snapshot");
    expect(await replacement).toBe("snapshot");
    expect(await owner.read({ session, read })).toBe("snapshot");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps shared reads alive for the remaining subscriber and aborts when the last subscriber leaves", async () => {
    const owner = new AgentPlatformSnapshotReads<void>();
    const session = { generation: 1, signal: new AbortController().signal };
    const a = new AbortController(),
      b = new AbortController();
    let workSignal!: AbortSignal;
    const read = vi.fn((signal: AbortSignal) => {
      workSignal = signal;
      return new Promise<void>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    });
    const first = owner.read({ session, signal: a.signal, read });
    const second = owner.read({ session, signal: b.signal, read });
    const firstRejected = expect(first).rejects.toThrow("A left");
    const secondRejected = expect(second).rejects.toThrow("B left");
    await settle();
    a.abort(new Error("A left"));
    await firstRejected;
    await settle();
    expect(workSignal.aborted).toBe(false);
    b.abort(new Error("B left"));
    await secondRejected;
    await settle();
    expect(workSignal.aborted).toBe(true);
    expect(session.signal.aborted).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("rejects late account A data after account B arrives and never reuses A's flight", async () => {
    const owner = new AgentPlatformSnapshotReads<string>();
    const accountA = new AbortController(),
      accountB = new AbortController();
    const oldPhysical = deferred<string>();
    let oldWorkSignal!: AbortSignal;
    const old = owner.read({
      session: { generation: 1, signal: accountA.signal },
      read: (signal) => {
        oldWorkSignal = signal;
        return oldPhysical.promise;
      },
    });
    const oldRejected = expect(old).rejects.toThrow(
      "agent_platform_session_changed",
    );
    await settle();
    accountA.abort(new Error("account changed"));
    await oldRejected;
    expect(oldWorkSignal.aborted).toBe(true);
    const newPhysical = deferred<string>();
    const readB = vi.fn(() => newPhysical.promise);
    const sessionB = { generation: 2, signal: accountB.signal };
    const fresh = owner.read({ session: sessionB, read: readB });
    await settle();
    oldPhysical.resolve("late-A");
    await settle();
    const nextBorrower = owner.read({ session: sessionB, read: readB });
    await settle();
    expect(readB).toHaveBeenCalledTimes(1);
    newPhysical.resolve("B");
    expect(await fresh).toBe("B");
    expect(await nextBorrower).toBe("B");
  });
});
