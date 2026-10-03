import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePluginUiLease } from "@crewon/contracts/plugins";
import { PluginUiLoaderError } from "./pluginUiValidation";
import {
  createInstalledPluginGenerationJournal,
  installedPluginGenerationFamilyKey,
  installedPluginGenerationSourcePin,
} from "./installedPluginGenerationJournal";
import {
  generationJournalFixture,
  generationJournalInput,
  generationJournalLease,
  generationJournalReceipt,
} from "./installedPluginGenerationJournal.test-support";
import { deferred, flush } from "./pluginUiLoader.test-support";

afterEach(() => vi.useRealTimers());
describe("account-owned generation intent journal", () => {
  it("captures full immutable source and original intent and returns only an exact verified receipt", async () => {
    const f = generationJournalFixture(),
      seen = vi.fn();
    f.journal.subscribe(seen);
    const original = f.journal.register({ lease: f.lease, input: f.input });
    expect(original.familyKey).toBe(
      JSON.stringify(["example.workbench", "workbench"]),
    );
    expect(original.sourcePin).toEqual(
      installedPluginGenerationSourcePin(f.lease),
    );
    expect(original.input).not.toBe(f.input);
    expect(Object.isFrozen(original.input.reference)).toBe(true);
    const called = f.journal.invoke({
      lease: f.lease,
      input: f.input,
      signal: f.caller.signal,
      request: f.request,
    });
    await flush();
    f.gate.resolve({ output: generationJournalReceipt() });
    await expect(called).resolves.toEqual({
      output: generationJournalReceipt(),
    });
    expect(f.journal.snapshot()[0]).toMatchObject({
      phase: "accepted",
      receipt: generationJournalReceipt(),
      retryable: false,
      physicallyPending: false,
    });
    expect(f.journal.snapshot()).toBe(f.journal.snapshot());
    expect(seen).toHaveBeenCalled();
    await f.journal.invoke({
      lease: f.lease,
      input: f.input,
      signal: new AbortController().signal,
      request: f.request,
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it("caller cancellation retains the original key and observes a genuine same-account physical late acknowledgement", async () => {
    const f = generationJournalFixture();
    const called = f.journal.invoke({
      lease: f.lease,
      input: f.input,
      signal: f.caller.signal,
      request: f.request,
    });
    const rejected = expect(called).rejects.toThrow(
      "plugin_ui_operation_aborted",
    );
    await flush();
    f.caller.abort();
    await rejected;
    expect(f.physicalSignal()!.aborted).toBe(false);
    expect(f.journal.snapshot()[0]).toMatchObject({
      phase: "uncertain",
      physicallyPending: true,
      retryable: false,
      input: f.input,
    });
    f.gate.resolve({ output: generationJournalReceipt() });
    await flush();
    expect(f.journal.snapshot()[0]).toMatchObject({
      phase: "accepted",
      physicallyPending: false,
      receipt: generationJournalReceipt(),
    });
  });

  it("a real 5 second deadline keeps the physical slot until settlement and accepts a verified late response", async () => {
    vi.useFakeTimers();
    const f = generationJournalFixture();
    const called = f.journal.invoke({
      lease: f.lease,
      input: f.input,
      signal: f.caller.signal,
      request: f.request,
    });
    const rejected = expect(called).rejects.toThrow(
      "plugin_ui_control_timeout",
    );
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(f.physicalSignal()!.aborted).toBe(true);
    expect(f.journal.snapshot()[0]).toMatchObject({
      phase: "uncertain",
      physicallyPending: true,
      retryable: false,
    });
    f.gate.resolve({ output: generationJournalReceipt() });
    await flush();
    expect(f.journal.snapshot()[0].phase).toBe("accepted");
  });

  it("physical capacity stays bounded at 16 after logical timeout and frees only a truly settled slot", async () => {
    vi.useFakeTimers();
    const journal = createInstalledPluginGenerationJournal({
      assertCurrent() {},
      onDiagnostic() {},
    });
    const gates = Array.from({ length: 16 }, () =>
      deferred<{ output: ReturnType<typeof generationJournalReceipt> }>(),
    );
    const requests = gates.map((gate) => vi.fn(() => gate.promise));
    const calls = gates.map((_, index) =>
      journal
        .invoke({
          lease: generationJournalLease(`example.module-${index}`),
          input: generationJournalInput(`key-${index}`),
          signal: new AbortController().signal,
          request: requests[index],
        })
        .catch(() => undefined),
    );
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(calls);
    const extra = vi.fn(async () => ({ output: generationJournalReceipt() }));
    await expect(
      journal.invoke({
        lease: generationJournalLease("example.extra"),
        input: generationJournalInput("extra-key"),
        signal: new AbortController().signal,
        request: extra,
      }),
    ).rejects.toThrow("plugin_ui_inflight_limit");
    expect(extra).not.toHaveBeenCalled();
    expect(
      journal.snapshot().filter((intent) => intent.physicallyPending),
    ).toHaveLength(16);
    gates[0].resolve({ output: generationJournalReceipt() });
    await flush();
    await journal.invoke({
      lease: generationJournalLease("example.extra"),
      input: generationJournalInput("explicit-new-extra-key"),
      signal: new AbortController().signal,
      request: extra,
    });
    expect(extra).toHaveBeenCalledTimes(1);
    for (const gate of gates.slice(1))
      gate.resolve({ output: generationJournalReceipt() });
    await flush();
  });

  it("every error after actual send is UNKNOWN, including explicit HTTP-like refusal and abort", async () => {
    for (const error of [
      new Error("http_403_forbidden"),
      new Error("http_409_conflict"),
      new DOMException("Aborted", "AbortError"),
      new PluginUiLoaderError("plugin_ui_operation_aborted"),
    ]) {
      const f = generationJournalFixture();
      await expect(
        f.journal.invoke({
          lease: f.lease,
          input: f.input,
          signal: f.caller.signal,
          request: async () => {
            throw error;
          },
        }),
      ).rejects.toBe(error);
      expect(f.journal.snapshot()[0]).toMatchObject({
        phase: "uncertain",
        retryable: true,
        physicallyPending: false,
        input: f.input,
      });
    }
  });

  it("wrong original thread/revision and accessor receipts cannot manufacture acceptance", async () => {
    for (const output of [
      { ...generationJournalReceipt(), threadId: "foreign-thread" },
      { ...generationJournalReceipt(), threadRevision: 3 },
      { ...generationJournalReceipt(), configurationRevision: 0 },
      { ...generationJournalReceipt(), source: "foreign" },
    ]) {
      const f = generationJournalFixture();
      await expect(
        f.journal.invoke({
          lease: f.lease,
          input: f.input,
          signal: f.caller.signal,
          request: async () => ({ output }),
        }),
      ).rejects.toThrow();
      expect(f.journal.snapshot()[0].phase).toBe("uncertain");
    }
    let evaluated = 0;
    const f = generationJournalFixture();
    const output = Object.defineProperty(
      { ...generationJournalReceipt() },
      "runId",
      {
        enumerable: true,
        get() {
          evaluated++;
          throw new Error("must_not_evaluate");
        },
      },
    );
    await expect(
      f.journal.invoke({
        lease: f.lease,
        input: f.input,
        signal: f.caller.signal,
        request: async () => ({ output }),
      }),
    ).rejects.toThrow();
    expect(evaluated).toBe(0);
  });

  it("queued cancellation and expired original lease are trusted pre-send refusals", async () => {
    const aborted = generationJournalFixture();
    const called = aborted.journal.invoke({
      lease: aborted.lease,
      input: aborted.input,
      signal: aborted.caller.signal,
      request: aborted.request,
    });
    aborted.caller.abort();
    await expect(called).rejects.toThrow("plugin_ui_operation_aborted");
    await flush();
    expect(aborted.request).not.toHaveBeenCalled();
    expect(aborted.journal.snapshot()[0]).toMatchObject({
      phase: "refused",
      physicallyPending: false,
      input: aborted.input,
    });
    const expired = generationJournalFixture();
    const lease = parsePluginUiLease({
      ...expired.lease,
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    await expect(
      expired.journal.invoke({
        lease,
        input: expired.input,
        signal: expired.caller.signal,
        request: expired.request,
      }),
    ).rejects.toThrow("plugin_ui_generation_lease_expired");
    expect(expired.request).not.toHaveBeenCalled();
    expect(expired.journal.snapshot()[0].phase).toBe("refused");
    expect(expired.journal.snapshot()[0].retryable).toBe(false);
  });

  it("a trusted refusal requires an explicitly confirmed new key and cannot use the uncertain retry route", async () => {
    const f = generationJournalFixture();
    const expired = parsePluginUiLease({
      ...f.lease,
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    await expect(
      f.journal.invoke({
        lease: expired,
        input: f.input,
        signal: f.caller.signal,
        request: f.request,
      }),
    ).rejects.toThrow("plugin_ui_generation_lease_expired");
    expect(f.journal.current({ lease: f.lease })!).toMatchObject({
      phase: "refused",
      retryable: false,
    });
    await expect(
      f.journal.invoke({
        lease: f.lease,
        input: f.input,
        signal: f.caller.signal,
        request: f.request,
      }),
    ).rejects.toThrow("plugin_ui_generation_intent_refused");
    expect(f.request).not.toHaveBeenCalled();
    const next = { ...f.input, idempotencyKey: "explicit-new-intent" };
    await f.journal.invoke({
      lease: f.lease,
      input: next,
      signal: f.caller.signal,
      request: async () => ({ output: generationJournalReceipt(next) }),
    });
    expect(f.journal.snapshot()).toHaveLength(2);
    expect(f.journal.snapshot()[0]).toMatchObject({
      phase: "accepted",
      input: next,
    });
  });

  it("register explicitly refuses a new family key while preserving the original unresolved intent", () => {
    const f = generationJournalFixture();
    f.journal.register({ lease: f.lease, input: f.input });
    expect(() =>
      f.journal.register({
        lease: f.lease,
        input: { ...f.input, idempotencyKey: "new-key" },
      }),
    ).toThrow("plugin_ui_generation_intent_mismatch");
    expect(f.journal.snapshot()).toHaveLength(1);
    expect(f.journal.snapshot()[0].input).toEqual(f.input);
    expect(f.journal.current({ lease: f.lease })!.phase).toBe("pending");
  });

  it("session guard is repeated after deferred scheduling and clears the old account before sending", async () => {
    const f = generationJournalFixture();
    const called = f.journal.invoke({
      lease: f.lease,
      input: f.input,
      signal: f.caller.signal,
      request: f.request,
    });
    f.revoke();
    await expect(called).rejects.toThrow("captured_account_changed");
    expect(f.request).not.toHaveBeenCalled();
    expect(f.journal.snapshot()).toEqual([]);
  });

  it("account replacement or explicit invalidation withholds late acknowledgement and purges preparation", async () => {
    for (const invalidate of [false, true]) {
      const f = generationJournalFixture(),
        listener = vi.fn();
      f.journal.subscribe(listener);
      f.journal.getOrCreatePreparationOwner(
        installedPluginGenerationFamilyKey(f.lease),
        () => ({ key: "original-thread-key" }),
      );
      const called = f.journal.invoke({
        lease: f.lease,
        input: f.input,
        signal: f.caller.signal,
        request: f.request,
      });
      const rejected = expect(called).rejects.toThrow();
      await flush();
      if (invalidate) f.journal.invalidate();
      else f.revoke();
      f.gate.resolve({ output: generationJournalReceipt() });
      await rejected;
      expect(f.journal.snapshot()).toEqual([]);
      expect(
        listener.mock.calls.some(([intent]) => intent.phase === "accepted"),
      ).toBe(false);
      expect(() =>
        f.journal.getOrCreatePreparationOwner("replacement", () => ({})),
      ).toThrow();
    }
  });

  it("same source remount joins the original physical request and never changes its key", async () => {
    const f = generationJournalFixture();
    const first = f.journal.invoke({
      lease: f.lease,
      input: f.input,
      signal: f.caller.signal,
      request: f.request,
    });
    await flush();
    const remount = parsePluginUiLease({
      ...f.lease,
      mountRef: "replacement_mount_" + "r".repeat(32),
    });
    const replacement = vi.fn(async () => ({
      output: generationJournalReceipt(),
    }));
    expect(f.journal.current({ lease: remount })!.input.idempotencyKey).toBe(
      f.input.idempotencyKey,
    );
    const joined = f.journal.invoke({
      lease: remount,
      input: f.input,
      signal: new AbortController().signal,
      request: replacement,
    });
    f.gate.resolve({ output: generationJournalReceipt() });
    await Promise.all([first, joined]);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
  });

  it("a synchronous journal observer can reenter and join only the already-owned physical request", async () => {
    const f = generationJournalFixture();
    let joined: ReturnType<typeof f.journal.invoke> | undefined;
    f.journal.subscribe((intent) => {
      if (intent.physicallyPending && joined === undefined)
        joined = f.journal.invoke({
          lease: f.lease,
          input: f.input,
          signal: new AbortController().signal,
          request: f.request,
        });
    });
    const first = f.journal.invoke({
      lease: f.lease,
      input: f.input,
      signal: f.caller.signal,
      request: f.request,
    });
    await flush();
    f.gate.resolve({ output: generationJournalReceipt() });
    await Promise.all([first, joined]);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.onDiagnostic).not.toHaveBeenCalled();
  });

  it("changed full pin keeps UNKNOWN nonretryable and blocks a newly generated key", async () => {
    for (const change of [
      (lease: ReturnType<typeof generationJournalLease>) => ({
        ...lease,
        packageDigest: `sha256:${"e".repeat(64)}`,
      }),
      (lease: ReturnType<typeof generationJournalLease>) => ({
        ...lease,
        selectionRevision: 2,
      }),
      (lease: ReturnType<typeof generationJournalLease>) => ({
        ...lease,
        descriptor: { ...lease.descriptor, version: "2.0.0" },
      }),
      (lease: ReturnType<typeof generationJournalLease>) => ({
        ...lease,
        descriptor: {
          ...lease.descriptor,
          requires: [
            {
              service: "crewon.project-generations",
              apiVersion: "2",
              optional: true,
            },
          ],
        },
      }),
    ]) {
      const f = generationJournalFixture();
      await expect(
        f.journal.invoke({
          lease: f.lease,
          input: f.input,
          signal: f.caller.signal,
          request: async () => {
            throw new Error("network_unknown");
          },
        }),
      ).rejects.toThrow();
      const changed = parsePluginUiLease(change(f.lease));
      expect(f.journal.current({ lease: changed })).toMatchObject({
        phase: "uncertain",
        retryable: false,
        input: f.input,
      });
      const fresh = { ...f.input, idempotencyKey: "fresh-key" },
        request = vi.fn(async () => ({ output: generationJournalReceipt() }));
      await expect(
        f.journal.invoke({
          lease: changed,
          input: fresh,
          signal: new AbortController().signal,
          request,
        }),
      ).rejects.toThrow("plugin_ui_generation_intent_mismatch");
      expect(request).not.toHaveBeenCalled();
      expect(f.journal.snapshot()).toHaveLength(1);
      expect(f.journal.snapshot()[0].input.idempotencyKey).toBe(
        f.input.idempotencyKey,
      );
    }
  });

  it("changed original input/key cannot replace a queued immutable intent", async () => {
    const f = generationJournalFixture();
    const mutable = structuredClone(f.input);
    const called = f.journal.invoke({
      lease: f.lease,
      input: mutable,
      signal: f.caller.signal,
      request: f.request,
    });
    (mutable as { expectedThreadRevision: number }).expectedThreadRevision++;
    await expect(called).rejects.toThrow(
      "plugin_ui_generation_intent_mismatch",
    );
    expect(f.request).not.toHaveBeenCalled();
    expect(f.journal.snapshot()[0].input.expectedThreadRevision).toBe(1);
    expect(f.journal.snapshot()[0].phase).toBe("refused");
  });

  it("a full pin change inside the deferred queue cannot send or discard the original UNKNOWN key", async () => {
    const f = generationJournalFixture();
    const lease = structuredClone(f.lease);
    const called = f.journal.invoke({
      lease,
      input: f.input,
      signal: f.caller.signal,
      request: f.request,
    });
    (lease as { packageDigest: string }).packageDigest =
      `sha256:${"e".repeat(64)}`;
    await expect(called).rejects.toThrow(
      "plugin_ui_generation_intent_mismatch",
    );
    expect(f.request).not.toHaveBeenCalled();
    expect(f.journal.snapshot()[0]).toMatchObject({
      phase: "uncertain",
      retryable: false,
      physicallyPending: false,
      input: f.input,
      sourcePin: installedPluginGenerationSourcePin(f.lease),
    });
  });

  it("same original accepted source cannot implicitly generate again, while an explicit new saved source is retained separately", async () => {
    const f = generationJournalFixture();
    const accepted = async () => ({ output: generationJournalReceipt() });
    await f.journal.invoke({
      lease: f.lease,
      input: f.input,
      signal: f.caller.signal,
      request: accepted,
    });
    const duplicate = vi.fn(accepted);
    await expect(
      f.journal.invoke({
        lease: f.lease,
        input: { ...f.input, idempotencyKey: "second-key" },
        signal: f.caller.signal,
        request: duplicate,
      }),
    ).rejects.toThrow("plugin_ui_generation_intent_mismatch");
    expect(duplicate).not.toHaveBeenCalled();
    const next = {
      ...f.input,
      reference: { ...f.input.reference, assetRevision: 2 },
      expectedThreadRevision: 2,
      idempotencyKey: "next-source-key",
    };
    await f.journal.invoke({
      lease: f.lease,
      input: next,
      signal: f.caller.signal,
      request: async () => ({ output: generationJournalReceipt(next) }),
    });
    expect(f.journal.snapshot()).toHaveLength(2);
    expect(
      f.journal.snapshot().every((intent) => intent.phase === "accepted"),
    ).toBe(true);
    expect(f.journal.current({ lease: f.lease })!.input).toEqual(next);
  });

  it("UNKNOWN capacity never discards any of 32 original keys", async () => {
    const journal = createInstalledPluginGenerationJournal({
      assertCurrent() {},
      onDiagnostic() {},
    });
    for (let index = 0; index < 32; index++)
      await expect(
        journal.invoke({
          lease: generationJournalLease(`example.module-${index}`),
          input: generationJournalInput(`key-${index}`),
          signal: new AbortController().signal,
          request: async () => {
            throw new Error("unknown");
          },
        }),
      ).rejects.toThrow();
    expect(journal.snapshot()).toHaveLength(32);
    expect(() =>
      journal.register({
        lease: generationJournalLease("example.extra"),
        input: generationJournalInput("extra-key"),
      }),
    ).toThrow("plugin_ui_generation_journal_limit");
    expect(
      journal.snapshot().map((intent) => intent.input.idempotencyKey),
    ).toContain("key-0");
  });

  it("bounded terminal history retires only settled confirmed entries and preparation survives mount/pin replacement", async () => {
    const journal = createInstalledPluginGenerationJournal({
      assertCurrent() {},
      onDiagnostic() {},
    });
    for (let index = 0; index < 33; index++)
      await journal.invoke({
        lease: generationJournalLease(`example.module-${index}`),
        input: generationJournalInput(`key-${index}`),
        signal: new AbortController().signal,
        request: async () => ({ output: generationJournalReceipt() }),
      });
    expect(journal.snapshot()).toHaveLength(32);
    expect(journal.snapshot()[0].input.idempotencyKey).toBe("key-32");
    const lease = generationJournalLease(),
      familyKey = installedPluginGenerationFamilyKey(lease),
      factory = vi.fn(() => ({ key: "original-create-key", phase: "unknown" }));
    const owner = journal.getOrCreatePreparationOwner(familyKey, factory);
    expect(
      journal.getOrCreatePreparationOwner(
        installedPluginGenerationFamilyKey(
          parsePluginUiLease({
            ...lease,
            packageDigest: `sha256:${"f".repeat(64)}`,
          }),
        ),
        factory,
      ),
    ).toBe(owner);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
