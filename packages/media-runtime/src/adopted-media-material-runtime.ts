import {
  ProjectAssetMediaReferenceImageApplicationService,
  ProjectMediaReferenceImageApplicationService,
  projectMediaInputBound as bound,
  materialPreparationFields,
  type ProjectMediaResultAuthorizationPort,
  type ProjectAdoptedMediaMaterialFreezeAuthorizationPort,
  type ProjectAssetApplicationService,
  type CreativeProjectApplicationService,
  type ProjectAssetReferenceImageApplicationService,
  type ProjectReferenceMaterialArchivePort,
} from "@crewon/application";
import type { SqliteRunStore, PostgresDomainStore } from "@crewon/store";
import { ProjectMediaResultPublisher } from "./project-media-result-publisher.ts";
import { ProjectAdoptedMediaReferenceReader } from "./project-adopted-media-reference-reader.ts";
import { ProjectReferenceMaterialFreezer } from "./project-reference-material-freezer.ts";

/** Explicit host composition; result publisher lifetime belongs to its original owner. */
export type AdoptedMediaMaterialRuntimeInput = Readonly<{
  results: ProjectMediaResultPublisher;
  read: ProjectMediaResultAuthorizationPort;
  freeze: ProjectAdoptedMediaMaterialFreezeAuthorizationPort;
}>;
export async function createAdoptedMediaMaterialSources(
  input: Readonly<{
    config: AdoptedMediaMaterialRuntimeInput;
    store: SqliteRunStore | PostgresDomainStore;
    projects: CreativeProjectApplicationService;
    assets: ProjectAssetApplicationService;
    concepts: ProjectAssetReferenceImageApplicationService;
    archive: ProjectReferenceMaterialArchivePort;
    signal: AbortSignal;
  }>,
) {
  const c = materialPreparationFields(input.config, [
      "results",
      "read",
      "freeze",
    ]),
    read = bound<ProjectMediaResultAuthorizationPort["authorize"]>(
      c.read,
      "authorize",
    ),
    readActive = bound<ProjectMediaResultAuthorizationPort["assertActive"]>(
      c.read,
      "assertActive",
    ),
    freeze = bound<
      ProjectAdoptedMediaMaterialFreezeAuthorizationPort["authorize"]
    >(c.freeze, "authorize"),
    active = () => input.signal.throwIfAborted(),
    store = input.store.extensionStore().projectMediaResults();
  active();
  await store.enableResultReads();
  active();
  const media = new ProjectAssetMediaReferenceImageApplicationService({
      projects: input.projects,
      assets: input.assets,
      store,
      authorization: {
        authorize: async (p) => {
          active();
          const result = await read(p);
          active();
          return result;
        },
        assertActive: (p) => {
          active();
          const result = readActive(p);
          active();
          return result;
        },
      },
    }),
    reader = new ProjectAdoptedMediaReferenceReader({
      sources: media,
      results: c.results as ProjectMediaResultPublisher,
    }),
    sources = new ProjectMediaReferenceImageApplicationService({
      assets: input.assets,
      concepts: input.concepts,
      media,
    }),
    freezer = new ProjectReferenceMaterialFreezer({
      sourceKind: "media-result",
      sources: media,
      reader,
      archive: input.archive,
      authorization: {
        authorize: async (p) => {
          active();
          const result = await freeze(p);
          active();
          return result;
        },
      },
    });
  return Object.freeze({ sources, freezer });
}
