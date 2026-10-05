import { parsePluginUiLease } from "@crewon/contracts/plugins";
import { vi } from "vitest";
import {
  queryJournalInput,
  queryJournalReceipt,
  queryJournalLease,
  queryContextFixture,
  queryContextModule,
} from "./installedPluginProjectQuery.test-support";
import { createInstalledPluginProjectHistoricalQueryJournal } from "./installedPluginProjectHistoricalQueryJournal";
import { deferred } from "./pluginUiLoader.test-support";
export const historicalQueryInput = queryJournalInput;
export const historicalQueryReceipt = queryJournalReceipt;
export function historicalQueryLease(
  pluginId = "example.workbench",
  serial = 1,
) {
  const raw = queryJournalLease(pluginId, serial);
  return parsePluginUiLease({
    ...raw,
    descriptor: {
      ...raw.descriptor,
      requires: raw.descriptor.requires.map((item) =>
        item.service === "crewon.project-generation-queries"
          ? { ...item, service: "crewon.project-historical-queries" }
          : item,
      ),
    },
  });
}
export function historicalQueryFixture() {
  let current = true;
  const assertCurrent = vi.fn(() => {
    if (!current) throw new Error("captured-historical-query-account-changed");
  });
  const journal = createInstalledPluginProjectHistoricalQueryJournal({
    assertCurrent,
    onDiagnostic: vi.fn(),
  });
  const lease = historicalQueryLease(),
    input = historicalQueryInput();
  const gate = deferred<{
    output: ReturnType<typeof historicalQueryReceipt>;
  }>();
  let signal: AbortSignal | undefined;
  const request = vi.fn((actual: AbortSignal) => {
    signal = actual;
    return gate.promise;
  });
  return {
    journal,
    lease,
    input,
    gate,
    request,
    caller: new AbortController(),
    signal: () => signal,
    physicalSignal: () => signal,
    revoke: () => {
      current = false;
    },
  };
}

export function historicalQueryContextModule(serial = 1, mountSerial = serial) {
  const original = queryContextModule(serial, mountSerial);
  const lease = historicalQueryLease(
    original.plugin.descriptor.pluginId,
    serial,
  );
  return {
    ...original,
    plugin: { ...original.plugin, descriptor: lease.descriptor },
  };
}
export function historicalQueryContextFixture() {
  const original = queryContextFixture();
  const journal = createInstalledPluginProjectHistoricalQueryJournal({
    assertCurrent: original.assertSessionCurrent,
    onDiagnostic: vi.fn(),
  });
  return {
    ...original,
    journal,
    ports: { ...original.ports, journal },
    withdraw() {
      original.withdraw();
      journal.invalidate();
    },
    async unknown(
      input = historicalQueryInput(),
      lease = historicalQueryLease("example.business-workbench"),
    ) {
      await journal
        .invoke({
          lease,
          input,
          signal: new AbortController().signal,
          request: async () => {
            throw new Error("named-sent-historical-query-unknown");
          },
        })
        .catch(() => undefined);
    },
    async accept(
      input = historicalQueryInput(),
      lease = historicalQueryLease("example.business-workbench"),
    ) {
      await journal.invoke({
        lease,
        input,
        signal: new AbortController().signal,
        request: async () => ({ output: historicalQueryReceipt(input) }),
      });
    },
  };
}

export const historicalQueryContextLease = (serial = 1) =>
  historicalQueryLease("example.business-workbench", serial);
