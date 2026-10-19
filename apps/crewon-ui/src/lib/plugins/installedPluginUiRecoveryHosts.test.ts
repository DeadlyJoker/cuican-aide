// @vitest-environment happy-dom
import { ControlApiTransportError } from "@crewon/control-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_UI_RECOVERY_VERSION } from "@crewon/contracts/plugins";
import type { PluginUiMountHandle } from "./trustedPluginUiLoader";
import { deferred, flush } from "./pluginUiLoader.test-support";
import { controlUiResponse } from "./controlPluginUi.test-support";
import {
  recoveryHint,
  recoveryHostFixture,
  recoveryLease,
  recoveryReceipt,
  recoveryRequests,
  recoveryResponse,
} from "./installedPluginUiRecovery.test-support";

const handles: PluginUiMountHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()));
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const conflict = () =>
  controlUiResponse(
    {
      error: {
        category: "conflict",
        code: "concept_selection_revision_conflict",
        message: "Selection changed",
        requestId: "named-recovery-conflict",
      },
    },
    409,
  );

describe.each([false, true])(
  "durable recovery %s (real Web/Native Control client)",
  (native) => {
    it("an absent optional recovery route leaves the UI visible but blocks staged model execution", async () => {
      const f = recoveryHostFixture(native);
      f.setRead(() =>
        controlUiResponse(
          {
            error: {
              code: "route_not_found",
              category: "notFound",
              message: "Route absent",
              requestId: "optional-recovery-absent",
            },
          },
          404,
        ),
      );
      handles.push(await f.mount());
      expect(f.importer).toHaveBeenCalledOnce();
      const request = recoveryRequests[0];
      await expect(
        f.h.instances[0].services.invoke(request.action, request.input, {}),
      ).rejects.toThrow("plugin_ui_recovery_not_ready");
      expect(f.wire("/actions")).toHaveLength(0);
    });

    it("a package without the capability performs zero recovery reads or stages", async () => {
      const f = recoveryHostFixture(native, false);
      handles.push(await f.mount());
      const original = recoveryRequests[0];
      await f.h.instances[0].services.invoke(
        original.action,
        original.input,
        {},
      );
      expect(f.wire("/recovery")).toHaveLength(0);
      expect(f.wire("/actions")).toHaveLength(1);
      expect(f.generationJournal.snapshot()[0].phase).toBe("accepted");
    });

    it("captures every lane before publishing, waits for GET before importing, and never automatically POSTs", async () => {
      const f = recoveryHostFixture(native);
      const gate = deferred<Response>();
      f.setRead(() => gate.promise);
      const seen: number[][] = [];
      for (const journal of f.journals)
        journal.subscribe(() =>
          seen.push(f.journals.map((lane) => lane.snapshot().length)),
        );
      const mounting = f.mount();
      await flush();
      expect(f.importer).not.toHaveBeenCalled();
      expect(f.wire("/actions")).toHaveLength(0);
      const hints = [
        recoveryHint(recoveryRequests[0]),
        recoveryHint(recoveryRequests[1], "dispatched", {
          dispatchAttemptCount: 3,
          revision: 4,
        }),
        recoveryHint(recoveryRequests[2], "accepted"),
      ];
      gate.resolve(controlUiResponse(recoveryResponse(hints)));
      handles.push(await mounting);
      expect(seen).toEqual([
        [1, 1, 1],
        [1, 1, 1],
        [1, 1, 1],
      ]);
      expect(f.generationJournal.snapshot()[0]).toMatchObject({
        phase: "uncertain",
        input: recoveryRequests[0].input,
        physicallyPending: false,
        dispatchMayHaveOccurred: false,
        dispatchAttemptCount: 0,
      });
      expect(f.projectQueryJournal.snapshot()[0]).toMatchObject({
        phase: "uncertain",
        input: recoveryRequests[1].input,
        physicallyPending: false,
        dispatchMayHaveOccurred: true,
        dispatchAttemptCount: 3,
      });
      expect(f.selectionJournal.snapshot()[0]).toMatchObject({
        phase: "accepted",
        receipt: hints[2].receipt,
      });
      expect(f.wire("/recovery")).toHaveLength(1);
      expect(f.wire("/actions")).toHaveLength(0);
      const original = recoveryRequests[1];
      f.setStage((request) =>
        controlUiResponse({
          version: PLUGIN_UI_RECOVERY_VERSION,
          disposition: "replayed",
          intent: recoveryHint(request, "dispatched", {
            dispatchAttemptCount: 3,
            revision: 4,
          }),
        }),
      );
      await f.h.instances[0].services.invoke(
        original.action,
        original.input,
        {},
      );
      const writes = f.fetch.mock.calls.filter(
        ([, init]) => init?.method === "POST",
      );
      expect(writes).toHaveLength(3); // openMount, stage, original query
      expect(String(writes[1][0])).toMatch(/\/recovery$/u);
      expect(String(writes[2][0])).toMatch(/\/actions$/u);
      expect(JSON.parse(String(writes[1][1]?.body))).toEqual(original);
      expect(JSON.parse(String(writes[2][1]?.body))).toEqual(original);
    });

    it("a failed hydration closes the actual mount and blocks import; reopening performs a new GET", async () => {
      const f = recoveryHostFixture(native);
      f.setRead(() =>
        controlUiResponse(
          {
            error: {
              category: "internal",
              code: "recovery_read_failed",
              requestId: "read",
            },
          },
          503,
        ),
      );
      await expect(f.mount()).rejects.toThrow();
      expect(f.importer).not.toHaveBeenCalled();
      expect(f.journals.map((journal) => journal.snapshot())).toEqual([
        [],
        [],
        [],
      ]);
      expect(f.wire("/actions")).toHaveLength(0);
      if (native) expect(f.assets.release).toHaveBeenCalledOnce();
      else
        expect(
          f.fetch.mock.calls.filter(([, init]) => init?.method === "DELETE"),
        ).toHaveLength(1);
      f.setRead(undefined);
      handles.push(await f.mount());
      expect(f.wire("/recovery")).toHaveLength(2);
      expect(f.importer).toHaveBeenCalledOnce();
    });

    it("a lost stage ACK leaves the original key UNKNOWN and performs no business invoke", async () => {
      const f = recoveryHostFixture(native);
      handles.push(await f.mount());
      const lostResponse = new Error("stage_ack_lost");
      f.setStage(() => {
        throw lostResponse;
      });
      const original = recoveryRequests[2],
        service = f.h.instances[0].services;
      await expect(
        service.invoke(original.action, original.input, {}),
      ).rejects.toMatchObject({
        constructor: ControlApiTransportError,
        message: "control_api_transport_unavailable",
        cause: lostResponse,
      });
      expect(f.wire("/actions")).toHaveLength(0);
      expect(f.selectionJournal.snapshot()[0]).toMatchObject({
        phase: "uncertain",
        retryable: true,
        input: original.input,
        dispatchMayHaveOccurred: false,
        dispatchAttemptCount: 0,
      });
      await expect(
        service.invoke(
          original.action,
          { ...original.input, idempotencyKey: "replacement-key" },
          {},
        ),
      ).rejects.toThrow("intent_mismatch");
      expect(f.wire("/recovery")).toHaveLength(2);
      f.setStage(undefined);
      await service.invoke(original.action, original.input, {});
      expect(f.wire("/actions")).toHaveLength(1);
      expect(JSON.parse(String(f.wire("/actions")[0][1]?.body))).toEqual(
        original,
      );
    });

    it("an ACK received after caller abort cannot start the business request", async () => {
      const f = recoveryHostFixture(native),
        gate = deferred<Response>();
      handles.push(await f.mount());
      f.setStage(() => gate.promise);
      const original = recoveryRequests[2],
        caller = new AbortController();
      const call = f.h.instances[0].services.invoke(
        original.action,
        original.input,
        { signal: caller.signal },
      );
      void call.catch(() => undefined);
      await flush();
      caller.abort();
      await expect(call).rejects.toThrow();
      gate.resolve(
        controlUiResponse({
          version: PLUGIN_UI_RECOVERY_VERSION,
          disposition: "created",
          intent: recoveryHint(original),
        }),
      );
      await flush();
      expect(f.wire("/actions")).toHaveLength(0);
      expect(f.selectionJournal.snapshot()[0]).toMatchObject({
        phase: "uncertain",
        physicallyPending: false,
      });
    });

    it.each(["accepted", "refused"] as const)(
      "a reliable terminal stage %s ACK after component abort remains sticky without business dispatch",
      async (phase) => {
        const f = recoveryHostFixture(native),
          gate = deferred<Response>();
        handles.push(await f.mount());
        f.setStage(() => gate.promise);
        const original = recoveryRequests[2],
          caller = new AbortController();
        const call = f.h.instances[0].services.invoke(
          original.action,
          original.input,
          { signal: caller.signal },
        );
        void call.catch(() => undefined);
        await flush();
        caller.abort();
        await expect(call).rejects.toThrow();
        gate.resolve(
          controlUiResponse({
            version: PLUGIN_UI_RECOVERY_VERSION,
            disposition: "replayed",
            intent: recoveryHint(original, phase),
          }),
        );
        await flush();
        expect(f.selectionJournal.snapshot()[0]).toMatchObject({
          phase,
          physicallyPending: false,
          retryable: false,
          receipt: phase === "accepted" ? recoveryReceipt(original) : null,
        });
        expect(f.wire("/actions")).toHaveLength(0);
      },
    );

    it("account invalidation purges all lanes and prevents a late stage ACK from starting a write", async () => {
      const f = recoveryHostFixture(native),
        gate = deferred<Response>();
      handles.push(await f.mount());
      f.setStage(() => gate.promise);
      const original = recoveryRequests[0];
      const call = f.h.instances[0].services.invoke(
        original.action,
        original.input,
        {},
      );
      void call.catch(() => undefined);
      await flush();
      f.revoke();
      gate.resolve(
        controlUiResponse({
          version: PLUGIN_UI_RECOVERY_VERSION,
          disposition: "created",
          intent: recoveryHint(original, "accepted"),
        }),
      );
      await expect(call).rejects.toThrow();
      expect(f.journals.map((journal) => journal.snapshot())).toEqual([
        [],
        [],
        [],
      ]);
      expect(f.wire("/actions")).toHaveLength(0);
    });

    it("account invalidation during GET prevents all hydration publication and plugin import", async () => {
      const f = recoveryHostFixture(native),
        gate = deferred<Response>();
      f.setRead(() => gate.promise);
      const mounting = f.mount();
      void mounting.catch(() => undefined);
      await flush();
      f.revoke();
      gate.resolve(
        controlUiResponse(
          recoveryResponse(
            recoveryRequests.map((request) => recoveryHint(request)),
          ),
        ),
      );
      await expect(mounting).rejects.toThrow("recovery_account_changed");
      expect(f.journals.map((journal) => journal.snapshot())).toEqual([
        [],
        [],
        [],
      ]);
      expect(f.importer).not.toHaveBeenCalled();
      expect(f.wire("/actions")).toHaveLength(0);
    });

    it.each([
      { lane: "generation", original: recoveryRequests[0] },
      { lane: "query", original: recoveryRequests[1] },
    ])(
      "$lane terminal stage acceptance returns its paired receipt without business POST",
      async ({ original }) => {
        const f = recoveryHostFixture(native);
        handles.push(await f.mount());
        f.setStage((request) =>
          controlUiResponse({
            version: PLUGIN_UI_RECOVERY_VERSION,
            disposition: "replayed",
            intent: recoveryHint(request, "accepted"),
          }),
        );
        expect(
          await f.h.instances[0].services.invoke(
            original.action,
            original.input,
            {},
          ),
        ).toEqual(recoveryReceipt(original));
        expect(f.wire("/actions")).toHaveLength(0);
        expect(
          f.journals
            .find((journal) => journal.snapshot().length)
            ?.snapshot()[0],
        ).toMatchObject({
          phase: "accepted",
          receipt: recoveryReceipt(original),
          input: original.input,
        });
      },
    );

    it.each(["accepted", "refused"] as const)(
      "a verified terminal stage %s short circuits the original POST",
      async (phase) => {
        const f = recoveryHostFixture(native);
        handles.push(await f.mount());
        const original = recoveryRequests[2];
        f.setStage((request) =>
          controlUiResponse({
            version: PLUGIN_UI_RECOVERY_VERSION,
            disposition: "replayed",
            intent: recoveryHint(request, phase),
          }),
        );
        const call = f.h.instances[0].services.invoke(
          original.action,
          original.input,
          {},
        );
        if (phase === "accepted")
          expect(await call).toEqual(recoveryReceipt(original));
        else
          await expect(call).rejects.toThrow(
            "concept_selection_revision_conflict",
          );
        expect(f.selectionJournal.snapshot()[0]).toMatchObject({
          phase,
          physicallyPending: false,
          retryable: false,
        });
        expect(f.wire("/actions")).toHaveLength(0);
      },
    );

    it("cold dispatch history, including prepared count zero, cannot be a first-attempt 409 refusal", async () => {
      for (const phase of ["prepared", "dispatched"] as const) {
        const f = recoveryHostFixture(native),
          original = recoveryRequests[2];
        const hint = recoveryHint(
          original,
          phase,
          phase === "dispatched"
            ? { dispatchAttemptCount: 3, revision: 4 }
            : {},
        );
        f.setHints([hint]);
        handles.push(await f.mount());
        f.setStage(() =>
          controlUiResponse({
            version: PLUGIN_UI_RECOVERY_VERSION,
            disposition: "replayed",
            intent: hint,
          }),
        );
        f.setBusiness(conflict);
        await expect(
          f.h.instances[0].services.invoke(original.action, original.input, {}),
        ).rejects.toThrow();
        expect(f.selectionJournal.snapshot()[0]).toMatchObject({
          phase: "uncertain",
          retryable: true,
          input: original.input,
          dispatchAttemptCount: phase === "prepared" ? 1 : 4,
        });
      }
      const fresh = recoveryHostFixture(native);
      handles.push(await fresh.mount());
      fresh.setBusiness(conflict);
      await expect(
        fresh.h.instances[0].services.invoke(
          recoveryRequests[2].action,
          recoveryRequests[2].input,
          {},
        ),
      ).rejects.toThrow();
      expect(fresh.selectionJournal.snapshot()[0]).toMatchObject({
        phase: "refused",
        retryable: false,
        dispatchAttemptCount: 1,
      });
    });

    it("strict generation/query pins block regrant drift while selection retains its original stable pin", async () => {
      const f = recoveryHostFixture(native),
        next = recoveryLease(true, 2);
      f.setLease(next);
      f.setHints(recoveryRequests.map((request) => recoveryHint(request)));
      handles.push(await f.mount());
      const service = f.h.instances[0].services;
      for (const original of recoveryRequests.slice(0, 2))
        await expect(
          service.invoke(original.action, original.input, {}),
        ).rejects.toThrow("intent_mismatch");
      expect(f.generationJournal.snapshot()[0].retryable).toBe(false);
      expect(f.projectQueryJournal.snapshot()[0].retryable).toBe(false);
      expect(f.selectionJournal.snapshot()[0].retryable).toBe(true);
      await service.invoke(
        recoveryRequests[2].action,
        recoveryRequests[2].input,
        {},
      );
      expect(f.wire("/actions")).toHaveLength(1);
      expect(f.selectionJournal.snapshot()[0].sourcePin.selectionRevision).toBe(
        1,
      );
    });

    it("a different-family GET rejects the entire hydration without exposing any hint", async () => {
      const f = recoveryHostFixture(native);
      const hint = recoveryHint();
      f.setRead(() =>
        controlUiResponse(
          recoveryResponse([
            {
              ...hint,
              sourcePin: { ...hint.sourcePin, pluginId: "example.other" },
            },
          ]),
        ),
      );
      await expect(f.mount()).rejects.toThrow("family_mismatch");
      expect(f.journals.map((journal) => journal.snapshot())).toEqual([
        [],
        [],
        [],
      ]);
      expect(f.importer).not.toHaveBeenCalled();
    });

    it("a substituted stage request is not an ACK and never invokes business", async () => {
      const f = recoveryHostFixture(native);
      handles.push(await f.mount());
      const original = recoveryRequests[2];
      f.setStage(() =>
        controlUiResponse({
          version: PLUGIN_UI_RECOVERY_VERSION,
          disposition: "replayed",
          intent: recoveryHint({
            ...original,
            input: { ...original.input, resultIndex: 1 },
          }),
        }),
      );
      await expect(
        f.h.instances[0].services.invoke(original.action, original.input, {}),
      ).rejects.toThrow();
      expect(f.wire("/actions")).toHaveLength(0);
      expect(f.selectionJournal.snapshot()[0]).toMatchObject({
        phase: "uncertain",
        input: original.input,
      });
    });
  },
);
