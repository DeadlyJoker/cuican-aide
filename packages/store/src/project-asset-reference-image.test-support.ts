import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  CreativeProjectApplicationService,
  ProjectAssetApplicationService,
  ProjectAssetReferenceImageApplicationService,
  type ProjectAssetReferenceImageStore,
} from "@crewon/application";
import type { ProjectAssetKind } from "@crewon/domain";
import {
  conceptSelectionFixture,
  selectionVerifier,
} from "./project-concept-selection.test-support.ts";
import { assetContent } from "./project-asset.test-support.ts";
import { extensionStoreDigester as digester } from "./extension-store-records.ts";
import { timestamp } from "./extension-store.test-support.ts";

/** Real ownership, immutable result, original admission/funding and selected reference.
 * Policy and provider decoding are named port fixtures; this is not media-I/O or App acceptance.
 */
export async function projectAssetReferenceImageFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  kind: ProjectAssetKind = "character",
) {
  const f = await conceptSelectionFixture(t, backend),
    parent = f.first.parent;
  await parent.projectTextStore().migrate();
  const store = parent.projectAssetStore({ verifier: selectionVerifier });
  await store.migrate();
  const policy = { allow: true };
  const common = {
    authorization: {
      authorize: async () =>
        policy.allow
          ? { outcome: "allow" as const }
          : {
              outcome: "deny" as const,
              reasonCode: "named_reference_policy_denied",
            },
    },
    clock: { now: () => timestamp },
    ids: { nextId: () => randomUUID() },
    digester,
  };
  const projects = new CreativeProjectApplicationService({
    ...common,
    store: parent.creativeProjectStore(),
  });
  const assets = new ProjectAssetApplicationService({
    ...common,
    store,
    projects: parent.creativeProjectStore(),
    texts: parent.projectTextStore(),
  });
  const selected = await f.selectionStore.commitConceptImageSelection(
      f.selectionInput,
      f.selectionCommitOptions,
    ),
    projectId = f.reference.projectId;
  const saved = await assets.saveCandidate(f.actor, {
    projectId,
    assetId: null,
    kind,
    expectedAssetRevision: 0,
    briefRevision: 1,
    script: null,
    content: assetContent,
    idempotencyKey: "reference-asset",
  });
  const assetId = saved.asset.assetId;
  await assets.selectRevision(f.actor, {
    projectId,
    assetId,
    expectedAssetRevision: 1,
    contentRevision: 1,
    idempotencyKey: "reference-content-selected",
  });
  await assets.saveReferenceCandidate(f.actor, {
    projectId,
    assetId,
    expectedAssetRevision: 2,
    assetContentRevision: 1,
    conceptAssetId: f.reference.assetId,
    selectionRevision: selected.pointer.selectionRevision,
    idempotencyKey: "reference-saved",
  });
  await assets.selectReference(f.actor, {
    projectId,
    assetId,
    expectedAssetRevision: 3,
    referenceRevision: 1,
    idempotencyKey: "reference-selected",
  });
  const query = {
    projectId,
    assetId,
    kind,
    expectedAssetRevision: 4,
    contentRevision: 1,
    referenceRevision: 1,
  };
  const resolver = (source: ProjectAssetReferenceImageStore = store) =>
    new ProjectAssetReferenceImageApplicationService({
      projects,
      assets,
      store: source,
      digester,
    });
  async function rows() {
    return {
      ...(await f.counts()),
      ...Object.fromEntries(
        await Promise.all(
          [
            "project_assets",
            "project_asset_revisions",
            "project_asset_reference_revisions",
            "project_asset_mutation_receipts",
            "creative_operation_result_links",
            "extension_external_operations",
          ].map(async (table) => [table, await f.count(table)]),
        ),
      ),
    };
  }
  return { ...f, store, assets, projects, policy, query, resolver, rows };
}
