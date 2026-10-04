// @vitest-environment happy-dom
import { ControlApiClient } from "@crewon/control-client";
import { PLUGIN_UI_RECOVERY_VERSION } from "@crewon/contracts/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInstalledPluginUiRecovery } from "./installedPluginUiRecovery";
import { createInstalledPluginGenerationJournal } from "./installedPluginGenerationJournal";
import { createInstalledPluginProjectQueryJournal } from "./installedPluginProjectQueryJournal";
import { createInstalledPluginProjectSelectionJournal } from "./installedPluginProjectSelectionJournal";
import { controlUiResponse } from "./controlPluginUi.test-support";
import {
  recoveryHint,
  recoveryLease,
  recoveryRequests,
  recoveryResponse,
  recoveryHostFixture,
} from "./installedPluginUiRecovery.test-support";
import { deferred, flush } from "./pluginUiLoader.test-support";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T00:00:00.000Z"));
  const previous = {
    ...recoveryLease(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  };
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "POST"
      ? controlUiResponse({
          version: PLUGIN_UI_RECOVERY_VERSION,
          disposition: "replayed",
          intent: recoveryHint(recoveryRequests[0], "accepted"),
        })
      : controlUiResponse(
          recoveryResponse(
            recoveryRequests.map((request) =>
              recoveryHint(request, "accepted"),
            ),
          ),
        ),
  );
  const client = new ControlApiClient({
    baseUrl: "http://127.0.0.1:32100",
    accessToken: "named-renewal-owner",
    csrfToken: "named-renewal-csrf",
    fetch,
  });
  const options = { assertCurrent() {}, onDiagnostic() {} };
  const generationJournal = createInstalledPluginGenerationJournal(options);
  const projectQueryJournal = createInstalledPluginProjectQueryJournal(options);
  const selectionJournal =
    createInstalledPluginProjectSelectionJournal(options);
  const journals = [generationJournal, projectQueryJournal, selectionJournal];
  const recovery = createInstalledPluginUiRecovery({
    client,
    assertCurrent: options.assertCurrent,
    generationJournal,
    projectQueryJournal,
    selectionJournal,
  });
  const next = {
    ...previous,
    expiresAt: new Date(Date.now() + 540_000).toISOString(),
  };
  return { previous, next, journals, recovery, fetch };
}

describe("durable UI recovery across a finite same-owner renewal", () => {
  it("retains the original accepted stage ACK when its caller stopped waiting before renewal", async () => {
    const f = recoveryHostFixture();
    const gate = deferred<Response>();
    f.setStage(() => gate.promise);
    const handle = await f.mount();
    try {
      const original = f.lease;
      const caller = new AbortController();
      const request = recoveryRequests[0];
      const called = f.h.instances[0].services.invoke(
        request.action,
        request.input,
        { signal: caller.signal },
      );
      const cancelled = expect(called).rejects.toThrow(
        "plugin_ui_operation_aborted",
      );
      for (let i = 0; i < 5; i++) await flush();
      expect(
        f.wire("/recovery").filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(1);
      caller.abort();
      await cancelled;
      expect(f.generationJournal.snapshot()[0].physicallyPending).toBe(true);
      f.setLease({
        ...original,
        expiresAt: new Date(
          Date.parse(original.expiresAt) + 240_000,
        ).toISOString(),
      });
      await f.host.renewLease!(original, new AbortController().signal);
      gate.resolve(
        controlUiResponse({
          version: PLUGIN_UI_RECOVERY_VERSION,
          disposition: "replayed",
          intent: recoveryHint(request, "accepted"),
        }),
      );
      for (let i = 0; i < 5; i++) await flush();
      expect(f.generationJournal.snapshot()[0]).toMatchObject({
        phase: "accepted",
        physicallyPending: false,
        input: request.input,
        receipt: recoveryHint(request, "accepted").receipt,
      });
      expect(f.wire("/actions")).toHaveLength(0);
      expect(f.importer).toHaveBeenCalledTimes(1);
    } finally {
      gate.resolve(
        controlUiResponse({
          version: PLUGIN_UI_RECOVERY_VERSION,
          disposition: "replayed",
          intent: recoveryHint(recoveryRequests[0], "accepted"),
        }),
      );
      await handle.stop();
    }
  });

  it("preserves the three original accepted snapshots without another hydrate, dispatch or observer publication", async () => {
    const f = fixture();
    await f.recovery.hydrate(f.previous, new AbortController().signal);
    const snapshots = f.journals.map((journal) =>
      JSON.stringify(journal.snapshot()),
    );
    const notifications = vi.fn();
    const unsubscribe = f.journals.map((journal) =>
      journal.subscribe(notifications),
    );
    const before = notifications.mock.calls.length;
    f.recovery.renewLease(f.previous, f.next);
    expect(
      f.journals.map((journal) => JSON.stringify(journal.snapshot())),
    ).toEqual(snapshots);
    expect(notifications).toHaveBeenCalledTimes(before);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    const hint = await f.recovery.stage(f.next, recoveryRequests[0])!(
      new AbortController().signal,
    );
    expect(hint.phase).toBe("accepted");
    expect(hint.request).toEqual(recoveryRequests[0]);
    expect(
      f.fetch.mock.calls.filter(([, init]) => init?.method === "GET"),
    ).toHaveLength(1);
    expect(
      f.fetch.mock.calls.some(([url]) => String(url).endsWith("/actions")),
    ).toBe(false);
    expect(
      f.journals.map((journal) => JSON.stringify(journal.snapshot())),
    ).toEqual(snapshots);
    unsubscribe.forEach((stop) => stop());
  });

  it("rejects replaced pins and a released recovery owner instead of rehydrating or dispatching", async () => {
    const f = fixture();
    await f.recovery.hydrate(f.previous, new AbortController().signal);
    expect(() =>
      f.recovery.renewLease(f.previous, {
        ...f.next,
        selectionRevision: f.next.selectionRevision + 1,
      }),
    ).toThrow();
    f.recovery.release(f.previous);
    expect(() => f.recovery.renewLease(f.previous, f.next)).toThrow(
      "plugin_ui_recovery_not_ready",
    );
    await expect(
      f.recovery.stage(f.next, recoveryRequests[0])!(
        new AbortController().signal,
      ),
    ).rejects.toThrow("plugin_ui_recovery_not_ready");
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
});
