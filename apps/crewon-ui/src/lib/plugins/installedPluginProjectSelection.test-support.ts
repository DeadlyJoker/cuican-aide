import { vi } from "vitest";
import type { SelectConceptImageResponse } from "@crewon/contracts";
import {
  parsePluginUiLease,
  type ProjectGenerationSelectionUiInput,
} from "@crewon/contracts/plugins";
import type { ControlPluginUiModule } from "./controlPluginUiCatalog";
import { createInstalledPluginProjectSelectionJournal } from "./installedPluginProjectSelectionJournal";
import { deferred, uiLease } from "./pluginUiLoader.test-support";

export function selectionJournalLease(
  pluginId = "example.workbench",
  serial = 1,
) {
  const lease = {
    ...uiLease(),
    mountRef: uiLease(serial).mountRef,
    selectionRevision: serial,
  };
  return parsePluginUiLease({
    ...lease,
    descriptor: {
      ...lease.descriptor,
      pluginId,
      requires: [
        "crewon.project-generation-selections",
        "crewon.project-generation-queries",
        "crewon.project-generations",
      ].map((service) => ({ service, apiVersion: "1", optional: true })),
    },
  });
}
export function selectionJournalInput(
  key = "select-original-key",
): ProjectGenerationSelectionUiInput {
  return {
    reference: {
      projectId: "project-1",
      assetId: "asset-1",
      assetRevision: 2,
      expectedProjectRevision: 7,
      expectedAssetMetadataRevision: 4,
    },
    operationId: "11111111-1111-4111-8111-111111111111",
    expectedOperationRevision: 3,
    resultIndex: 2,
    expectedSelectionRevision: 0,
    idempotencyKey: key,
  };
}
export function selectionJournalReceipt(
  input = selectionJournalInput(),
): SelectConceptImageResponse {
  return {
    disposition: "committed",
    selectionRevision: input.expectedSelectionRevision + 1,
    selection: {
      reference: {
        projectId: input.reference.projectId,
        assetId: input.reference.assetId,
        assetRevision: input.reference.assetRevision,
      },
      operationId: input.operationId,
      operationRevision: input.expectedOperationRevision,
      resultIndex: input.resultIndex,
      filename: "second.png",
      url: "https://provider.fixture.invalid/view?file=second.png",
      selectedAt: "2026-10-04T00:00:00.000Z",
    },
  };
}
export function selectionJournalFixture() {
  let current = true;
  const assertCurrent = vi.fn(() => {
    if (!current) throw new Error("captured-selection-account-changed");
  });
  const journal = createInstalledPluginProjectSelectionJournal({
    assertCurrent,
    onDiagnostic: vi.fn(),
  });
  const lease = selectionJournalLease(),
    input = selectionJournalInput();
  const gate = deferred<{ output: SelectConceptImageResponse }>();
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
    assertCurrent,
    physicalSignal: () => physicalSignal,
    revoke: () => {
      current = false;
    },
  };
}
export function selectionContextModule(serial = 1): ControlPluginUiModule {
  const lease = selectionJournalLease("example.workbench", serial);
  return {
    key: JSON.stringify([lease.descriptor.pluginId, lease.contributionId]),
    mountKey: JSON.stringify([
      lease.descriptor.pluginId,
      lease.contributionId,
      serial,
      lease.packageDigest,
    ]),
    title: "Selection fixture",
    contributionId: lease.contributionId,
    plugin: {
      descriptor: lease.descriptor,
      packageDigest: lease.packageDigest,
      selectionRevision: lease.selectionRevision,
      publicAssets: lease.publicAssets,
    },
  };
}
