import {
  parsePluginUiLease,
  type ProjectGenerationUiInput,
} from "@crewon/contracts/plugins";
import { vi } from "vitest";
import { uiLease, deferred } from "./pluginUiLoader.test-support";
import { createInstalledPluginGenerationJournal } from "./installedPluginGenerationJournal";

export function generationJournalLease(pluginId = "example.workbench") {
  const lease = uiLease();
  return parsePluginUiLease({
    ...lease,
    descriptor: {
      ...lease.descriptor,
      pluginId,
      requires: [
        {
          service: "crewon.project-generations",
          apiVersion: "1",
          optional: true,
        },
      ],
    },
  });
}
export function generationJournalInput(
  key = "original-key",
): ProjectGenerationUiInput {
  return {
    reference: {
      projectId: "project-a",
      assetId: "asset-a",
      assetRevision: 1,
      expectedProjectRevision: 3,
      expectedAssetMetadataRevision: 5,
    },
    threadId: "original-thread",
    expectedThreadRevision: 1,
    idempotencyKey: key,
  };
}
export function generationJournalReceipt(input = generationJournalInput()) {
  return {
    disposition: "committed" as const,
    threadId: input.threadId,
    threadRevision: input.expectedThreadRevision + 1,
    runId: "original-run",
    messageId: "original-message",
    configurationRevision: 7,
  };
}
export function generationJournalFixture() {
  let current = true;
  const assertCurrent = vi.fn(() => {
    if (!current) throw new Error("captured_account_changed");
  });
  const onDiagnostic = vi.fn();
  const journal = createInstalledPluginGenerationJournal({
    assertCurrent,
    onDiagnostic,
  });
  const lease = generationJournalLease(),
    input = generationJournalInput();
  const gate = deferred<{
    output: ReturnType<typeof generationJournalReceipt>;
  }>();
  let physicalSignal: AbortSignal | undefined;
  const request = vi.fn((signal: AbortSignal) => {
    physicalSignal = signal;
    return gate.promise;
  });
  const caller = new AbortController();
  return {
    journal,
    lease,
    input,
    gate,
    request,
    caller,
    onDiagnostic,
    assertCurrent,
    physicalSignal: () => physicalSignal,
    revoke: () => {
      current = false;
    },
  };
}
