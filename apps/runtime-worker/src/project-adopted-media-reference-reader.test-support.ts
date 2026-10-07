import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  ProjectAssetMediaReferenceImageApplicationService,
  CreativeProjectApplicationService,
  ProjectAssetApplicationService,
  type ProjectAssetMediaReferenceImageStore,
} from "@crewon/application";
import {
  ProjectAdoptedMediaReferenceReader,
  ProjectMediaResultPublisher,
} from "@crewon/media-runtime";
import { selectionVerifier } from "../../../packages/store/src/project-concept-selection.test-support.ts";
import { assetMediaAdoptionFixture } from "./project-asset-media-adoption.test-support.ts";

/** Actual V2 adoption, current project/asset services, original Store and encrypted candidate. PDP/provider are named fixtures. */
export async function adoptedMediaReaderFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const f = await assetMediaAdoptionFixture(t, backend),
    adopted = await f.adopt(),
    referenceQuery = {
      projectId: f.query.projectId,
      assetId: adopted.asset.assetId,
      kind: "character" as const,
      expectedAssetRevision: adopted.asset.revision,
      contentRevision: adopted.asset.selectedContentRevision!,
      referenceRevision: adopted.referenceRevision.referenceRevision,
    };
  const readers = (
    store: ProjectAssetMediaReferenceImageStore = f.store,
    parent = f.parent,
    publisher: ProjectMediaResultPublisher = f.publisher,
  ) => {
    const common = {
      authorization: { authorize: async () => f.decision(f.policy.allow) },
      clock: { now: () => f.at },
      ids: { nextId: () => randomUUID() },
      digester: f.digester,
    };
    const projects = new CreativeProjectApplicationService({
        ...common,
        store: parent.creativeProjectStore(),
      }),
      assets = new ProjectAssetApplicationService({
        ...common,
        store: parent.projectAssetStore({ verifier: selectionVerifier }),
        projects: parent.creativeProjectStore(),
        texts: parent.projectTextStore(),
      });
    const sources = new ProjectAssetMediaReferenceImageApplicationService({
        projects,
        assets,
        store,
        authorization: f.authorization,
      }),
      reader = new ProjectAdoptedMediaReferenceReader({
        sources,
        results: publisher,
      });
    return { sources, reader };
  };
  const current = readers();
  return {
    ...f,
    adopted,
    referenceQuery,
    ...current,
    readers,
    read: (signal = new AbortController().signal) =>
      current.reader.readSelectedReferenceBytes(f.actor, referenceQuery, {
        signal,
      }),
  };
}
