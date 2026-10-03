// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInstalledPluginTaskReceiptTransport,
  readInstalledPluginTaskReceipt,
  type InstalledPluginTaskReceiptEvent,
} from "./installedPluginTaskReceipt";
import { deferred, flush, uiLease } from "./pluginUiLoader.test-support";

const receipt = Object.freeze({
  disposition: "committed" as const,
  threadId: "thread:1",
  threadRevision: 2,
  runId: "run:1",
  messageId: "message:1",
  configurationRevision: 1,
});
afterEach(() => vi.useRealTimers());

describe("installed task receipt hints (not Run authorization)", () => {
  it("copies only complete committed/replayed receipts, including valid UTF-8 identifiers", () => {
    const input = { ...receipt, threadId: "线程1", disposition: "replayed" };
    const parsed = readInstalledPluginTaskReceipt(input)!;
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(Object.isFrozen(parsed)).toBe(true);
    input.threadId = "changed";
    expect(parsed.threadId).toBe("线程1");
    expect(
      readInstalledPluginTaskReceipt({
        ...receipt,
        threadRevision: Number.MAX_SAFE_INTEGER,
        configurationRevision: 2_147_483_647,
      }),
    ).toEqual({
      ...receipt,
      threadRevision: Number.MAX_SAFE_INTEGER,
      configurationRevision: 2_147_483_647,
    });
  });

  it("does not classify ordinary JSON or invalid identities, revisions and extra fields as receipts", () => {
    for (const value of [
      null,
      { accepted: true },
      { ...receipt, extra: "private" },
      { ...receipt, disposition: "accepted" },
      { ...receipt, threadRevision: 0 },
      { ...receipt, threadRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...receipt, configurationRevision: 2_147_483_648 },
      { ...receipt, configurationRevision: Infinity },
      { ...receipt, runId: "../run" },
      { ...receipt, runId: " run " },
      { ...receipt, messageId: "\ud800" },
      { ...receipt, threadId: "中".repeat(43) },
    ])
      expect(readInstalledPluginTaskReceipt(value)).toBeNull();
  });

  it("rejects accessors, hidden/symbol fields and private object prototypes without executing getters", () => {
    const getter = vi.fn(() => "must not read");
    const accessed = { ...receipt };
    Object.defineProperty(accessed, "runId", {
      enumerable: true,
      get: getter,
    });
    const hidden = { ...receipt };
    Object.defineProperty(hidden, "messageId", { enumerable: false });
    for (const value of [
      accessed,
      hidden,
      { ...receipt, [Symbol("extra")]: true },
      Object.assign(Object.create({ inherited: true }), receipt),
    ])
      expect(readInstalledPluginTaskReceipt(value)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it("captures the full lease before awaited transport and never turns observer exceptions into retry failures", async () => {
    const lease = uiLease();
    const original = JSON.parse(JSON.stringify(lease));
    const observerFailure = new Error("host_projection_unavailable");
    const observer = vi.fn((_event: InstalledPluginTaskReceiptEvent) => {
      throw observerFailure;
    });
    const diagnostic = vi.fn();
    const response = deferred<{ output: typeof receipt }>();
    const transport = createInstalledPluginTaskReceiptTransport({
      assertCurrent() {},
      onTaskReceipt: observer,
      onDiagnostic: diagnostic,
    });
    const actual = transport(
      lease,
      new AbortController().signal,
      () => response.promise,
    );
    await flush();
    Object.defineProperty(lease.descriptor, "title", {
      value: "a later caller mutation",
    });
    response.resolve({ output: receipt });
    await expect(actual).resolves.toEqual({ output: receipt });
    expect(observer).toHaveBeenCalledExactlyOnceWith({
      lease: original,
      receipt,
    });
    const event = observer.mock.calls[0]![0];
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.receipt)).toBe(true);
    expect(Object.isFrozen(event.lease)).toBe(true);
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(observerFailure);
  });

  it("keeps physical slots after the five-second deadline and releases them only when actual work settles", async () => {
    vi.useFakeTimers();
    const gates = Array.from({ length: 16 }, () =>
      deferred<{ output: typeof receipt }>(),
    );
    const signals: AbortSignal[] = [];
    const observer = vi.fn();
    const transport = createInstalledPluginTaskReceiptTransport({
      assertCurrent() {},
      onTaskReceipt: observer,
      onDiagnostic() {},
    });
    const request = vi.fn((signal: AbortSignal) => {
      const index = signals.push(signal) - 1;
      return gates[index]!.promise;
    });
    const calls = Array.from({ length: 16 }, () =>
      transport(uiLease(), new AbortController().signal, request),
    );
    const terminal = Promise.allSettled(calls);
    await flush();
    expect(request).toHaveBeenCalledTimes(16);
    await vi.advanceTimersByTimeAsync(5_000);
    const results = await terminal;
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await expect(
      transport(uiLease(), new AbortController().signal, request),
    ).rejects.toThrow("plugin_ui_inflight_limit");
    expect(request).toHaveBeenCalledTimes(16);
    gates.forEach((gate) => gate.resolve({ output: receipt }));
    await flush();
    const recovered = vi.fn(async () => ({ output: receipt }));
    await expect(
      transport(uiLease(), new AbortController().signal, recovered),
    ).resolves.toEqual({ output: receipt });
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("registers actual work before reentrant dispatch and caps all nested physical requests", async () => {
    const gate = deferred<{ output: typeof receipt }>();
    const transport = createInstalledPluginTaskReceiptTransport({
      assertCurrent() {},
      onTaskReceipt() {},
      onDiagnostic() {},
    });
    let nested: PromiseSettledResult<{ output: typeof receipt }>[] = [];
    let nestedTerminal!: Promise<void>;
    const request = vi.fn(() => {
      if (request.mock.calls.length === 1)
        nestedTerminal = Promise.allSettled(
          Array.from({ length: 16 }, () =>
            transport(uiLease(), new AbortController().signal, request),
          ),
        ).then((results) => {
          nested = results as typeof nested;
        });
      return gate.promise;
    });
    const first = transport(uiLease(), new AbortController().signal, request);
    await flush();
    expect(request).toHaveBeenCalledTimes(16);
    gate.resolve({ output: receipt });
    await first;
    await nestedTerminal;
    expect(
      nested.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(15);
    expect(
      nested.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });
});
