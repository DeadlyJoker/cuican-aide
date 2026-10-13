import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePluginUiLease } from "@crewon/contracts/plugins";
import { createInstalledPluginGenerationJournal } from "./installedPluginGenerationJournal";
import { createInstalledPluginProjectQueryJournal } from "./installedPluginProjectQueryJournal";
import {
  generationJournalInput,
  generationJournalReceipt,
} from "./installedPluginGenerationJournal.test-support";
import {
  queryJournalInput,
  queryJournalReceipt,
} from "./installedPluginProjectQuery.test-support";
import {
  selectionJournalFixture,
  selectionJournalInput,
  selectionJournalLease,
  selectionJournalReceipt,
} from "./installedPluginProjectSelection.test-support";
import { flush } from "./pluginUiLoader.test-support";

afterEach(() => vi.useRealTimers());
describe("account-owned exact image selection journal", () => {
  it("same family and raw key remain independent from generation and query", async () => {
    const f = selectionJournalFixture(),
      options = { assertCurrent() {}, onDiagnostic() {} };
    const generation = createInstalledPluginGenerationJournal(options),
      query = createInstalledPluginProjectQueryJournal(options);
    const generated = generationJournalInput(f.input.idempotencyKey),
      queried = queryJournalInput(f.input.idempotencyKey);
    await generation.invoke({
      lease: f.lease,
      input: generated,
      signal: f.caller.signal,
      request: async () => ({ output: generationJournalReceipt(generated) }),
    });
    await query.invoke({
      lease: f.lease,
      input: queried,
      signal: f.caller.signal,
      request: async () => ({ output: queryJournalReceipt(queried) }),
    });
    await f.journal.invoke({
      lease: f.lease,
      input: f.input,
      signal: f.caller.signal,
      request: async () => ({ output: selectionJournalReceipt(f.input) }),
    });
    expect(f.journal.snapshot()[0].receipt).not.toHaveProperty("runId");
    f.journal.invalidate();
    expect(generation.snapshot()[0].phase).toBe("accepted");
    expect(query.snapshot()[0].phase).toBe("accepted");
  });
  it.each(["pending", "uncertain"] as const)(
    "%s preserves exact source5, operation/index/CAS and blocks a replacement key",
    async (phase) => {
      const f = selectionJournalFixture();
      if (phase === "pending")
        f.journal.register({ lease: f.lease, input: f.input });
      else
        await f.journal
          .invoke({
            lease: f.lease,
            input: f.input,
            signal: f.caller.signal,
            request: async () => {
              throw new Error("reply lost");
            },
          })
          .catch(() => {});
      expect(() =>
        f.journal.register({
          lease: f.lease,
          input: { ...f.input, idempotencyKey: "replacement-key" },
        }),
      ).toThrow("intent_mismatch");
      expect(f.journal.snapshot()).toHaveLength(1);
      expect(f.journal.snapshot()[0].input).toEqual(f.input);
      const call = await f.journal.invoke({
        lease: f.lease,
        input: f.input,
        signal: f.caller.signal,
        request: async () => ({ output: selectionJournalReceipt(f.input) }),
      });
      expect(call.output).toEqual(selectionJournalReceipt(f.input));
    },
  );
  it("caller cancellation and remount share physical ownership and retain a same-account late receipt", async () => {
    const f = selectionJournalFixture();
    const first = f.journal.invoke({
      lease: f.lease,
      input: f.input,
      signal: f.caller.signal,
      request: f.request,
    });
    void first.catch(() => {});
    await flush();
    f.caller.abort();
    await expect(first).rejects.toThrow();
    expect(f.journal.snapshot()[0]).toMatchObject({
      phase: "uncertain",
      retryable: false,
      physicallyPending: true,
    });
    expect(f.physicalSignal()?.aborted).toBe(false);
    const replacement = vi.fn();
    const second = f.journal.invoke({
      lease: selectionJournalLease("example.workbench", 2),
      input: f.input,
      signal: new AbortController().signal,
      request: replacement,
    });
    f.gate.resolve({ output: selectionJournalReceipt(f.input) });
    await second;
    expect(replacement).not.toHaveBeenCalled();
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.journal.snapshot()[0]).toMatchObject({
      phase: "accepted",
      receipt: selectionJournalReceipt(f.input),
    });
  });
  it("lost reply only becomes retryable after physical settlement; fresh regrant retains original audit pin", async () => {
    const f = selectionJournalFixture();
    await f.journal
      .invoke({
        lease: f.lease,
        input: f.input,
        signal: f.caller.signal,
        request: async () => {
          throw new Error("lost reply");
        },
      })
      .catch(() => {});
    const original = f.journal.snapshot()[0].sourcePin;
    const lease = parsePluginUiLease({
      ...selectionJournalLease("example.workbench", 2),
      selectionRevision: 7,
    });
    expect(f.journal.current({ lease })?.retryable).toBe(true);
    const request = vi.fn(async () => ({
      output: {
        ...selectionJournalReceipt(f.input),
        disposition: "replayed" as const,
      },
    }));
    await f.journal.invoke({
      lease,
      input: f.input,
      signal: new AbortController().signal,
      request,
    });
    expect(request).toHaveBeenCalledOnce();
    expect(f.journal.snapshot()[0].sourcePin).toEqual(original);
    expect(f.journal.snapshot()[0].sourcePin.selectionRevision).toBe(1);
  });
  it.each(["package", "publisher", "version", "input"] as const)(
    "changed %s cannot authorize an UNKNOWN replacement",
    async (kind) => {
      const f = selectionJournalFixture();
      await f.journal
        .invoke({
          lease: f.lease,
          input: f.input,
          signal: f.caller.signal,
          request: async () => {
            throw new Error("lost reply");
          },
        })
        .catch(() => {});
      const lease = parsePluginUiLease({
        ...f.lease,
        ...(kind === "package"
          ? { packageDigest: `sha256:${"9".repeat(64)}` }
          : {}),
        descriptor: {
          ...f.lease.descriptor,
          ...(kind === "publisher"
            ? { publisherId: "other.publisher" }
            : kind === "version"
              ? { version: "2.0.0" }
              : {}),
        },
      });
      const input = kind === "input" ? { ...f.input, resultIndex: 3 } : f.input,
        request = vi.fn();
      await expect(
        f.journal.invoke({ lease, input, signal: f.caller.signal, request }),
      ).rejects.toThrow("intent_mismatch");
      expect(request).not.toHaveBeenCalled();
      expect(f.journal.snapshot()[0].input).toEqual(f.input);
      expect(f.journal.snapshot()[0].retryable).toBe(false);
    },
  );
  it("deadline retains ownership until physical settle and never posts a second attempt implicitly", async () => {
    vi.useFakeTimers();
    const f = selectionJournalFixture();
    const first = f.journal.invoke({
      lease: f.lease,
      input: f.input,
      signal: f.caller.signal,
      request: f.request,
    });
    void first.catch(() => {});
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(12000);
    await expect(first).rejects.toThrow("timeout");
    expect(f.physicalSignal()?.aborted).toBe(true);
    expect(f.journal.snapshot()[0].retryable).toBe(false);
    const retry = vi.fn();
    const second = f.journal.invoke({
      lease: f.lease,
      input: f.input,
      signal: new AbortController().signal,
      request: retry,
    });
    void second.catch(() => {});
    f.gate.reject(new Error("physical settled"));
    await expect(second).rejects.toThrow();
    expect(retry).not.toHaveBeenCalled();
    expect(f.journal.snapshot()[0].retryable).toBe(true);
  });
  it("pre-send expiry/cancellation sends nothing; cancellation during retry preserves original UNKNOWN", async () => {
    const f = selectionJournalFixture(),
      request = vi.fn();
    f.caller.abort();
    await expect(
      f.journal.invoke({
        lease: f.lease,
        input: f.input,
        signal: f.caller.signal,
        request,
      }),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(f.journal.snapshot()[0].phase).toBe("refused");
    const unknown = selectionJournalFixture();
    await unknown.journal
      .invoke({
        lease: unknown.lease,
        input: unknown.input,
        signal: unknown.caller.signal,
        request: async () => {
          throw new Error("lost reply");
        },
      })
      .catch(() => {});
    const expired = parsePluginUiLease({
      ...unknown.lease,
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    await expect(
      unknown.journal.invoke({
        lease: expired,
        input: unknown.input,
        signal: unknown.caller.signal,
        request,
      }),
    ).rejects.toThrow("lease_expired");
    expect(unknown.journal.snapshot()[0]).toMatchObject({
      phase: "uncertain",
      retryable: true,
    });
    unknown.caller.abort();
    await expect(
      unknown.journal.invoke({
        lease: unknown.lease,
        input: unknown.input,
        signal: unknown.caller.signal,
        request,
      }),
    ).rejects.toThrow();
    expect(unknown.journal.snapshot()[0].phase).toBe("uncertain");
    expect(request).not.toHaveBeenCalled();
  });
  it("account replacement erases recovery and withholds a late physical acknowledgement", async () => {
    const f = selectionJournalFixture(),
      listener = vi.fn();
    f.journal.subscribe(listener);
    const call = f.journal.invoke({
      lease: f.lease,
      input: f.input,
      signal: f.caller.signal,
      request: f.request,
    });
    void call.catch(() => {});
    await flush();
    f.revoke();
    f.journal.invalidate();
    const count = listener.mock.calls.length;
    f.gate.resolve({ output: selectionJournalReceipt(f.input) });
    await expect(call).rejects.toThrow();
    expect(f.journal.snapshot()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(count);
    expect(f.physicalSignal()?.aborted).toBe(true);
  });
  it("accepted old receipt is immutable while an explicitly new selection owns a separate CAS and receipt", async () => {
    const f = selectionJournalFixture(),
      first = selectionJournalReceipt(f.input);
    await f.journal.invoke({
      lease: f.lease,
      input: f.input,
      signal: f.caller.signal,
      request: async () => ({ output: first }),
    });
    const next = {
      ...selectionJournalInput("select-another-image"),
      resultIndex: 3,
      expectedSelectionRevision: 1,
    };
    await f.journal.invoke({
      lease: f.lease,
      input: next,
      signal: f.caller.signal,
      request: async () => ({ output: selectionJournalReceipt(next) }),
    });
    const oldTransport = vi.fn();
    expect(
      (
        await f.journal.invoke({
          lease: f.lease,
          input: f.input,
          signal: f.caller.signal,
          request: oldTransport,
        })
      ).output,
    ).toEqual(first);
    expect(oldTransport).not.toHaveBeenCalled();
    expect(f.journal.snapshot()[0].input).toEqual(next);
    expect(f.journal.snapshot()[1].receipt).toEqual(first);
  });
  it("detaches mutable requests and rejects queued mutations and invalid paired receipts", async () => {
    const f = selectionJournalFixture(),
      input = { ...f.input, reference: { ...f.input.reference } },
      request = vi.fn();
    const call = f.journal.invoke({
      lease: f.lease,
      input,
      signal: f.caller.signal,
      request,
    });
    input.resultIndex = 9;
    await expect(call).rejects.toThrow("intent_mismatch");
    expect(request).not.toHaveBeenCalled();
    expect(f.journal.snapshot()[0].input.resultIndex).toBe(2);
    const bad = selectionJournalFixture();
    await expect(
      bad.journal.invoke({
        lease: bad.lease,
        input: bad.input,
        signal: bad.caller.signal,
        request: async () => ({
          output: selectionJournalReceipt({ ...bad.input, resultIndex: 9 }),
        }),
      }),
    ).rejects.toThrow();
    expect(bad.journal.snapshot()[0]).toMatchObject({
      phase: "uncertain",
      receipt: null,
      retryable: true,
    });
  });
});
