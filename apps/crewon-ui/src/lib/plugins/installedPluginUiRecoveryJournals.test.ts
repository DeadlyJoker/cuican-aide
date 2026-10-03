// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parsePluginUiRecoveryHint,
  type PluginUiRecoveryHint,
} from "@crewon/contracts/plugins";
import { createInstalledPluginGenerationJournal } from "./installedPluginGenerationJournal";
import { createInstalledPluginProjectQueryJournal } from "./installedPluginProjectQueryJournal";
import { createInstalledPluginProjectSelectionJournal } from "./installedPluginProjectSelectionJournal";
import {
  recoveryHint,
  recoveryLease,
  recoveryReceipt,
  recoveryRequests,
} from "./installedPluginUiRecovery.test-support";
import { deferred, flush } from "./pluginUiLoader.test-support";
import { selectionJournalReceipt } from "./installedPluginProjectSelection.test-support";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});
function fixture() {
  let current = true;
  const options = {
    assertCurrent() {
      if (!current) throw new Error("journal_account_changed");
    },
    onDiagnostic: vi.fn(),
  };
  const generation = createInstalledPluginGenerationJournal(options);
  const query = createInstalledPluginProjectQueryJournal(options);
  const selection = createInstalledPluginProjectSelectionJournal(options);
  const journals = [generation, query, selection] as const;
  const restore = (hints: readonly PluginUiRecoveryHint[]) => {
    const plans = journals.map((journal) => journal.restore(hints));
    plans.forEach((plan) => plan.commit());
    plans.forEach((plan) => plan.publish());
  };
  return {
    journals,
    generation,
    query,
    selection,
    restore,
    revoke() {
      current = false;
    },
  };
}

describe("pure durable hint restore plans", () => {
  it("plans are side effect free until all lanes commit, and the first notification observes all complete snapshots", () => {
    const f = fixture(),
      seen: number[][] = [];
    f.journals.forEach((journal) =>
      journal.subscribe(() =>
        seen.push(f.journals.map((lane) => lane.snapshot().length)),
      ),
    );
    const hints = recoveryRequests.map((request) => recoveryHint(request));
    const plans = f.journals.map((journal) => journal.restore(hints));
    expect(f.journals.map((journal) => journal.snapshot())).toEqual([
      [],
      [],
      [],
    ]);
    expect(seen).toEqual([]);
    plans.forEach((plan) => plan.commit());
    expect(seen).toEqual([]);
    plans.forEach((plan) => plan.publish());
    expect(seen).toEqual([
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ]);
    expect(f.journals.map((journal) => journal.snapshot()[0])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "uncertain",
          retryable: true,
          physicallyPending: false,
        }),
      ]),
    );
  });

  it("a malformed later lane leaves every original journal and observer untouched", () => {
    const f = fixture(),
      observed = vi.fn();
    f.journals.forEach((journal) => journal.subscribe(observed));
    const valid = recoveryHint(recoveryRequests[0]);
    const malformed = {
      ...recoveryHint(recoveryRequests[2], "accepted"),
      receipt: { runId: "fake" },
    };
    expect(() =>
      f.restore([valid, malformed as unknown as PluginUiRecoveryHint]),
    ).toThrow();
    expect(f.journals.map((journal) => journal.snapshot())).toEqual([
      [],
      [],
      [],
    ]);
    expect(observed).not.toHaveBeenCalled();
  });

  it("accepted receipts reject downgrade and a different valid receipt before any lane changes", () => {
    const f = fixture();
    f.restore(
      recoveryRequests.map((request) => recoveryHint(request, "accepted")),
    );
    const before = f.journals.map((journal) => journal.snapshot());
    for (const request of recoveryRequests) {
      expect(() => f.restore([recoveryHint(request, "dispatched")])).toThrow(
        "recovery_mismatch",
      );
      const accepted = recoveryHint(request, "accepted");
      const receipt =
        request.action === recoveryRequests[2].action
          ? {
              ...accepted.receipt,
              selection: {
                ...selectionJournalReceipt(recoveryRequests[2].input).selection,
                filename: "other.png",
              },
            }
          : { ...accepted.receipt, messageId: "different-valid-message" };
      expect(() =>
        f.restore([
          parsePluginUiRecoveryHint({ ...accepted, receipt, revision: 3 }),
        ]),
      ).toThrow("recovery_mismatch");
    }
    expect(f.journals.map((journal) => journal.snapshot())).toEqual(before);
  });

  it("a logically identical replay receipt preserves the first accepted bytes in every lane", () => {
    const f = fixture();
    const accepted = recoveryRequests.map((request) =>
      recoveryHint(request, "accepted"),
    );
    f.restore(accepted);
    f.restore(
      accepted.map((hint) =>
        parsePluginUiRecoveryHint({
          ...hint,
          revision: 3,
          receipt: { ...hint.receipt, disposition: "replayed" },
        }),
      ),
    );
    expect(f.journals.map((journal) => journal.snapshot()[0].receipt)).toEqual(
      accepted.map((hint) => hint.receipt),
    );
  });

  it("the same raw key belongs to independent plugin families in all three lanes", () => {
    const f = fixture();
    for (const request of recoveryRequests) {
      const a = recoveryHint({
        ...request,
        input: { ...request.input, idempotencyKey: "request-1" },
      } as typeof request);
      const b = parsePluginUiRecoveryHint({
        ...a,
        sourcePin: { ...a.sourcePin, pluginId: "example.second-plugin" },
      });
      f.restore([a]);
      f.restore([b]);
    }
    for (const journal of f.journals) {
      expect(journal.snapshot()).toHaveLength(2);
      expect(
        journal
          .snapshot()
          .every(
            (intent) =>
              intent.input.idempotencyKey === "request-1" && intent.retryable,
          ),
      ).toBe(true);
    }
  });

  it("a replayed physical response agrees with a concurrently restored committed receipt", async () => {
    const f = fixture(),
      request = recoveryRequests[1],
      gate = deferred<{ output: ReturnType<typeof recoveryReceipt> }>();
    const call = f.query.invoke({
      lease: recoveryLease(),
      input: request.input,
      signal: new AbortController().signal,
      request: () => gate.promise,
    });
    await flush();
    f.restore([recoveryHint(request, "accepted")]);
    gate.resolve({
      output: { ...recoveryReceipt(request), disposition: "replayed" },
    });
    await expect(call).resolves.toEqual({ output: recoveryReceipt(request) });
    expect(f.query.snapshot()[0].receipt).toEqual(recoveryReceipt(request));
  });

  it("a physical acknowledgement between prepare and commit invalidates the stale plan and preserves acceptance", async () => {
    const f = fixture(),
      request = recoveryRequests[1],
      gate = deferred<{ output: ReturnType<typeof recoveryReceipt> }>();
    const call = f.query.invoke({
      lease: recoveryLease(),
      input: request.input,
      signal: new AbortController().signal,
      request: () => gate.promise,
    });
    await flush();
    const plan = f.query.restore([recoveryHint(request, "dispatched")]);
    gate.resolve({ output: recoveryReceipt(request) });
    await call;
    expect(() => plan.commit()).toThrow("recovery_mismatch");
    expect(f.query.snapshot()[0]).toMatchObject({
      phase: "accepted",
      receipt: recoveryReceipt(request),
    });
  });

  it("a concurrent durable acceptance prevents business dispatch after an earlier prepared stage ACK", async () => {
    const f = fixture(),
      request = recoveryRequests[1],
      gate = deferred<PluginUiRecoveryHint>();
    const business = vi.fn(async () => ({ output: recoveryReceipt(request) }));
    const call = f.query.invoke({
      lease: recoveryLease(),
      input: request.input,
      signal: new AbortController().signal,
      stage: () => gate.promise,
      request: business,
    });
    await flush();
    f.restore([recoveryHint(request, "accepted")]);
    gate.resolve(recoveryHint(request));
    await expect(call).resolves.toEqual({ output: recoveryReceipt(request) });
    expect(business).not.toHaveBeenCalled();
    expect(f.query.snapshot()[0].phase).toBe("accepted");
  });

  it("cold hints cannot replace an existing physical request; a late acknowledgement stays accepted", async () => {
    const f = fixture(),
      request = recoveryRequests[1],
      gate = deferred<{ output: ReturnType<typeof recoveryReceipt> }>();
    const caller = new AbortController();
    const transport = vi.fn(() => gate.promise);
    const call = f.query.invoke({
      lease: recoveryLease(),
      input: request.input,
      signal: caller.signal,
      request: transport,
    });
    void call.catch(() => undefined);
    await flush();
    f.restore([recoveryHint(request, "dispatched")]);
    expect(f.query.snapshot()[0]).toMatchObject({
      phase: "pending",
      physicallyPending: true,
    });
    caller.abort();
    await expect(call).rejects.toThrow();
    expect(f.query.snapshot()[0].phase).toBe("uncertain");
    gate.resolve({ output: recoveryReceipt(request) });
    await flush();
    expect(f.query.snapshot()[0]).toMatchObject({
      phase: "accepted",
      physicallyPending: false,
    });
    expect(transport).toHaveBeenCalledOnce();
  });

  it("a restored dispatch count is sticky when an older prepared hint arrives", () => {
    const f = fixture(),
      request = recoveryRequests[2];
    f.restore([
      recoveryHint(request, "dispatched", {
        dispatchAttemptCount: 5,
        revision: 6,
      }),
    ]);
    f.restore([recoveryHint(request)]);
    expect(f.selection.snapshot()[0]).toMatchObject({
      phase: "uncertain",
      dispatchMayHaveOccurred: true,
      dispatchAttemptCount: 5,
    });
  });

  it("32 unresolved families are retained and a 33rd cannot evict any original request", () => {
    const f = fixture();
    for (let index = 0; index < 32; index++) {
      const original = recoveryRequests[2];
      const hint = recoveryHint({
        ...original,
        input: { ...original.input, idempotencyKey: `original-${index}` },
      });
      f.restore([
        parsePluginUiRecoveryHint({
          ...hint,
          sourcePin: { ...hint.sourcePin, pluginId: `example.family${index}` },
        }),
      ]);
    }
    const before = f.selection.snapshot();
    expect(before).toHaveLength(32);
    expect(() => f.restore([recoveryHint(recoveryRequests[2])])).toThrow(
      "recovery_mismatch",
    );
    expect(f.selection.snapshot()).toEqual(before);
  });

  it("a captured account change invalidates the journal and prevents prepared plans from publishing", () => {
    const f = fixture(),
      observed = vi.fn();
    f.selection.subscribe(observed);
    const plan = f.selection.restore([recoveryHint(recoveryRequests[2])]);
    f.revoke();
    expect(() => plan.commit()).toThrow("journal_account_changed");
    expect(f.selection.snapshot()).toEqual([]);
    expect(observed).not.toHaveBeenCalled();
  });

  it("getter hints are refused without evaluating the accessor", () => {
    const f = fixture(),
      getter = vi.fn(() => recoveryRequests[2]);
    const hint = Object.defineProperty(
      { ...recoveryHint(recoveryRequests[2]) },
      "request",
      { enumerable: true, get: getter },
    );
    expect(() => f.restore([hint])).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(f.selection.snapshot()).toEqual([]);
  });

  it("a refused durable selection stays a known terminal fact after package drift", () => {
    const f = fixture(),
      request = recoveryRequests[2];
    f.restore([recoveryHint(request, "refused")]);
    const lease = recoveryLease();
    const changed = { ...lease, packageDigest: `sha256:${"9".repeat(64)}` };
    expect(f.selection.current({ lease: changed })).toMatchObject({
      phase: "refused",
      reasonCode: "concept_selection_revision_conflict",
      retryable: false,
    });
    expect(f.selection.snapshot()[0].input).toEqual(request.input);
  });
});
