import { queryJournalLease } from "./installedPluginProjectQuery.test-support";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePluginUiLease } from "@crewon/contracts/plugins";
import { createInstalledPluginGenerationJournal } from "./installedPluginGenerationJournal";
import { installedPluginProjectHistoricalQueryFamilyKey } from "./installedPluginProjectHistoricalQueryJournal";
import {
  historicalQueryFixture,
  historicalQueryInput,
  historicalQueryLease,
  historicalQueryReceipt,
} from "./installedPluginProjectHistoricalQuery.test-support";
import {
  generationJournalInput,
  generationJournalReceipt,
} from "./installedPluginGenerationJournal.test-support";
import { flush } from "./pluginUiLoader.test-support";
import { PluginUiLoaderError } from "./pluginUiValidation";

afterEach(() => vi.useRealTimers());
describe("account-owned project query journal", () => {
  it("generation and query with the same business family and raw key own separate intents and Runs", async () => {
    const f = historicalQueryFixture();
    const generation = createInstalledPluginGenerationJournal({
      assertCurrent() {},
      onDiagnostic() {},
    });
    const generated = generationJournalInput(f.input.idempotencyKey);
    await generation.invoke({
      lease: f.lease,
      input: generated,
      signal: new AbortController().signal,
      request: async () => ({ output: generationJournalReceipt(generated) }),
    });
    const query = await f.journal.invoke({
      lease: f.lease,
      input: f.input,
      signal: f.caller.signal,
      request: async () => ({ output: historicalQueryReceipt(f.input) }),
    });
    expect(query.output).toMatchObject({ runId: "target-query-run" });
    expect(generation.snapshot()[0]).toMatchObject({
      phase: "accepted",
      receipt: { runId: "original-run" },
      input: generated,
    });
    expect(f.journal.snapshot()[0]).toMatchObject({
      phase: "accepted",
      input: f.input,
    });
    f.journal.invalidate();
    expect(generation.snapshot()[0].phase).toBe("accepted");
  });

  it.each(["pending", "uncertain"] as const)(
    "%s blocks a new family key while preserving the exact original request",
    async (phase) => {
      const f = historicalQueryFixture();
      if (phase === "pending")
        f.journal.register({ lease: f.lease, input: f.input });
      else
        await f.journal
          .invoke({
            lease: f.lease,
            input: f.input,
            signal: f.caller.signal,
            request: async () => {
              throw new Error("http_409_sent_unknown");
            },
          })
          .catch(() => undefined);
      const original = f.journal.snapshot()[0];
      expect(() =>
        f.journal.register({
          lease: f.lease,
          input: { ...f.input, idempotencyKey: "new-query-key" },
        }),
      ).toThrow("plugin_ui_project_historical_query_intent_mismatch");
      expect(f.journal.snapshot()).toHaveLength(1);
      expect(f.journal.snapshot()[0].input).toEqual(f.input);
      expect(f.journal.snapshot()[0].phase).toBe(original.phase);
      await f.journal.invoke({
        lease: f.lease,
        input: f.input,
        signal: new AbortController().signal,
        request: async () => ({ output: historicalQueryReceipt(f.input) }),
      });
      expect(f.journal.snapshot()[0].phase).toBe("accepted");
    },
  );

  it("an accepted observation permits an explicitly new key for the same original operation", async () => {
    const f = historicalQueryFixture(),
      first = historicalQueryReceipt();
    await f.journal.invoke({
      lease: f.lease,
      input: f.input,
      signal: f.caller.signal,
      request: async () => ({ output: first }),
    });
    const next = {
      ...f.input,
      expectedThreadRevision: 18,
      idempotencyKey: "explicit-next-observation",
    };
    const second = {
      ...historicalQueryReceipt(next),
      runId: "second-query-run",
      messageId: "second-query-message",
    };
    await f.journal.invoke({
      lease: f.lease,
      input: next,
      signal: new AbortController().signal,
      request: async () => ({ output: second }),
    });
    expect(f.journal.snapshot()).toHaveLength(2);
    expect(f.journal.snapshot()[0]).toMatchObject({
      input: next,
      receipt: second,
      phase: "accepted",
    });
    expect(f.journal.snapshot()[1].receipt).toEqual(first);
    expect(next.operationId).toBe(f.input.operationId);
  });

  it("different business families can use the same raw key without blocking or joining", async () => {
    const f = historicalQueryFixture(),
      other = historicalQueryLease("example.other-business");
    f.journal.register({ lease: f.lease, input: f.input });
    await f.journal.invoke({
      lease: other,
      input: f.input,
      signal: new AbortController().signal,
      request: async () => ({ output: historicalQueryReceipt() }),
    });
    expect(f.journal.current({ lease: f.lease })!.phase).toBe("pending");
    expect(f.journal.current({ lease: other })!.phase).toBe("accepted");
    expect(f.journal.snapshot()).toHaveLength(2);
  });

  it("same pin remount joins the physical request and accepted same-key replay never calls transport", async () => {
    const f = historicalQueryFixture();
    const first = f.journal.invoke({
      lease: f.lease,
      input: f.input,
      signal: f.caller.signal,
      request: f.request,
    });
    await flush();
    const remount = parsePluginUiLease({
      ...f.lease,
      mountRef: "replacement_query_mount_" + "r".repeat(32),
    });
    const replacement = vi.fn(async () => ({
      output: historicalQueryReceipt(),
    }));
    const joined = f.journal.invoke({
      lease: remount,
      input: f.input,
      signal: new AbortController().signal,
      request: replacement,
    });
    f.gate.resolve({ output: historicalQueryReceipt() });
    await Promise.all([first, joined]);
    await f.journal.invoke({
      lease: remount,
      input: f.input,
      signal: new AbortController().signal,
      request: replacement,
    });
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
  });

  it("caller abort preserves the physical request and a verified same-account late acknowledgement", async () => {
    const f = historicalQueryFixture();
    const pending = f.journal.invoke({
      lease: f.lease,
      input: f.input,
      signal: f.caller.signal,
      request: f.request,
    });
    const rejected = expect(pending).rejects.toThrow(
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
    });
    f.gate.resolve({ output: historicalQueryReceipt() });
    await flush();
    expect(f.journal.snapshot()[0]).toMatchObject({
      phase: "accepted",
      physicallyPending: false,
      receipt: historicalQueryReceipt(),
    });
  });

  it("logical timeout retains ownership until the physical promise truly settles", async () => {
    vi.useFakeTimers();
    const f = historicalQueryFixture();
    const pending = f.journal.invoke({
      lease: f.lease,
      input: f.input,
      signal: f.caller.signal,
      request: f.request,
    });
    const rejected = expect(pending).rejects.toThrow(
      "plugin_ui_control_timeout",
    );
    await flush();
    await vi.advanceTimersByTimeAsync(12000);
    await rejected;
    expect(f.journal.snapshot()[0]).toMatchObject({
      phase: "uncertain",
      physicallyPending: true,
      retryable: false,
    });
    expect(f.physicalSignal()!.aborted).toBe(true);
    f.gate.resolve({ output: historicalQueryReceipt() });
    await flush();
    expect(f.journal.snapshot()[0].phase).toBe("accepted");
  });

  it.each([400, 401, 403, 404, 409, 500])(
    "HTTP-like %s after send stays UNKNOWN and exact-key retryable",
    async (status) => {
      const f = historicalQueryFixture();
      await expect(
        f.journal.invoke({
          lease: f.lease,
          input: f.input,
          signal: f.caller.signal,
          request: async () => {
            throw new Error(`http_${status}_after_send`);
          },
        }),
      ).rejects.toThrow();
      expect(f.journal.snapshot()[0]).toMatchObject({
        phase: "uncertain",
        input: f.input,
        retryable: true,
        physicallyPending: false,
      });
    },
  );

  it("pre-send caller cancellation, expiration and deferred account withdrawal send nothing", async () => {
    const canceled = historicalQueryFixture();
    const pending = canceled.journal.invoke({
      lease: canceled.lease,
      input: canceled.input,
      signal: canceled.caller.signal,
      request: canceled.request,
    });
    canceled.caller.abort();
    await expect(pending).rejects.toThrow("plugin_ui_operation_aborted");
    await flush();
    expect(canceled.request).not.toHaveBeenCalled();
    expect(canceled.journal.snapshot()[0].phase).toBe("refused");
    const expired = historicalQueryFixture();
    await expect(
      expired.journal.invoke({
        lease: { ...expired.lease, expiresAt: "2020-01-01T00:00:00.000Z" },
        input: expired.input,
        signal: expired.caller.signal,
        request: expired.request,
      }),
    ).rejects.toThrow("plugin_ui_project_historical_query_lease_expired");
    expect(expired.request).not.toHaveBeenCalled();
    const withdrawn = historicalQueryFixture();
    const refused = withdrawn.journal.invoke({
      lease: withdrawn.lease,
      input: withdrawn.input,
      signal: withdrawn.caller.signal,
      request: withdrawn.request,
    });
    withdrawn.revoke();
    await expect(refused).rejects.toThrow(
      "captured-historical-query-account-changed",
    );
    expect(withdrawn.request).not.toHaveBeenCalled();
    expect(withdrawn.journal.snapshot()).toEqual([]);
  });

  it("account invalidation clears saved context ownership and withholds late receipts", async () => {
    for (const explicit of [true, false]) {
      const f = historicalQueryFixture(),
        listener = vi.fn();
      f.journal.subscribe(listener);
      const family = installedPluginProjectHistoricalQueryFamilyKey(f.lease);
      const owner = f.journal.getOrCreateContextOwner(family, () => ({
        named: "old-account",
      }));
      expect(f.journal.getOrCreateContextOwner(family, () => ({}))).toBe(owner);
      const pending = f.journal.invoke({
        lease: f.lease,
        input: f.input,
        signal: f.caller.signal,
        request: f.request,
      });
      const rejected = expect(pending).rejects.toThrow();
      await flush();
      if (explicit) f.journal.invalidate();
      else f.revoke();
      f.gate.resolve({ output: historicalQueryReceipt() });
      await rejected;
      expect(f.journal.snapshot()).toEqual([]);
      expect(
        listener.mock.calls.some(([intent]) => intent.phase === "accepted"),
      ).toBe(false);
      expect(() =>
        f.journal.getOrCreateContextOwner(family, () => ({})),
      ).toThrow();
    }
  });

  it("changed source pin or original operation/body cannot authorize UNKNOWN retry or a replacement key", async () => {
    for (const patch of [
      { packageDigest: `sha256:${"f".repeat(64)}` },
      { selectionRevision: 3 },
      {
        descriptor: {
          ...historicalQueryLease().descriptor,
          publisherId: "example.changed-publisher",
        },
      },
      {
        descriptor: { ...historicalQueryLease().descriptor, version: "9.0.0" },
      },
    ]) {
      const f = historicalQueryFixture();
      await f.journal
        .invoke({
          lease: f.lease,
          input: f.input,
          signal: f.caller.signal,
          request: async () => {
            throw new PluginUiLoaderError("sent-query-unknown");
          },
        })
        .catch(() => undefined);
      const changed = parsePluginUiLease({ ...f.lease, ...patch });
      expect(f.journal.current({ lease: changed })!).toMatchObject({
        phase: "uncertain",
        retryable: false,
        reasonCode: "plugin_ui_project_historical_query_intent_mismatch",
      });
      expect(() =>
        f.journal.register({
          lease: changed,
          input: { ...f.input, idempotencyKey: "replacement" },
        }),
      ).toThrow();
      expect(f.journal.snapshot()[0].input).toEqual(f.input);
    }
    const f = historicalQueryFixture();
    f.journal.register({ lease: f.lease, input: f.input });
    expect(() =>
      f.journal.register({
        lease: f.lease,
        input: {
          ...f.input,
          operationId: "22222222-2222-4222-8222-222222222222",
        },
      }),
    ).toThrow();
    expect(f.journal.current({ lease: f.lease })!.retryable).toBe(false);
  });

  it("receipt mismatches and accessors remain UNKNOWN without evaluating getters", async () => {
    const patches: readonly Readonly<Record<string, string | number>>[] = [
      { threadId: "foreign-thread" },
      { threadRevision: 99 },
      { configurationRevision: 0 },
      { sourceRunId: "invented" },
    ];
    for (const patch of patches) {
      const f = historicalQueryFixture();
      await expect(
        f.journal.invoke({
          lease: f.lease,
          input: f.input,
          signal: f.caller.signal,
          request: async () => ({
            output: { ...historicalQueryReceipt(), ...patch },
          }),
        }),
      ).rejects.toThrow();
      expect(f.journal.snapshot()[0].phase).toBe("uncertain");
    }
    const f = historicalQueryFixture();
    let reads = 0;
    const output = Object.defineProperty(
      { ...historicalQueryReceipt() },
      "runId",
      {
        enumerable: true,
        get() {
          reads++;
          return "invented";
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
    expect(reads).toBe(0);
  });

  it("post-send abort errors cannot be converted into trusted pre-send refusal", async () => {
    const f = historicalQueryFixture();
    await expect(
      f.journal.invoke({
        lease: f.lease,
        input: f.input,
        signal: f.caller.signal,
        request: async () => {
          throw new DOMException("provider connection aborted", "AbortError");
        },
      }),
    ).rejects.toThrow();
    expect(f.journal.snapshot()[0]).toMatchObject({
      phase: "uncertain",
      retryable: true,
    });
  });

  it("a deferred source-pin mutation is rejected before the transport line", async () => {
    const f = historicalQueryFixture();
    const lease = structuredClone(f.lease);
    const pending = f.journal.invoke({
      lease,
      input: f.input,
      signal: f.caller.signal,
      request: f.request,
    });
    Object.assign(lease, { selectionRevision: 9 });
    await expect(pending).rejects.toThrow(
      "plugin_ui_project_historical_query_intent_mismatch",
    );
    expect(f.request).not.toHaveBeenCalled();
    expect(f.journal.snapshot()[0].retryable).toBe(false);
  });
  it("accepts only the independent service and never exposes cold restore/staging authority", () => {
    const f = historicalQueryFixture();
    expect(() =>
      f.journal.register({ lease: queryJournalLease(), input: f.input }),
    ).toThrow("plugin_ui_project_historical_query_family_unavailable");
    expect("restore" in f.journal).toBe(false);
    expect(f.journal.snapshot()).toEqual([]);
  });
  it("close immediately withdraws account state and physically joins an outstanding response without publishing a late ACK", async () => {
    const f = historicalQueryFixture();
    const work = f.journal.invoke({
      lease: f.lease,
      input: f.input,
      signal: f.caller.signal,
      request: f.request,
    });
    void work.catch(() => undefined);
    await flush();
    let joined = false;
    const closing = f.journal.close().then(() => {
      joined = true;
    });
    expect(f.physicalSignal()?.aborted).toBe(true);
    expect(f.journal.snapshot()).toEqual([]);
    await flush();
    expect(joined).toBe(false);
    f.gate.resolve({ output: historicalQueryReceipt() });
    await closing;
    await expect(work).rejects.toThrow();
    expect(joined).toBe(true);
    expect(f.journal.snapshot()).toEqual([]);
    const fresh = historicalQueryFixture();
    expect(fresh.journal.snapshot()).toEqual([]);
  });
});
