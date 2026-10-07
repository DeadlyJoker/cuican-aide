import type { TestContext } from "node:test";
import type {
  ProjectReferenceMaterialArchivePort,
  ProjectAdoptedMediaMaterialFreezeAuthorizationPort,
} from "@crewon/application";
import { FilesystemProjectMaterialArchive } from "@crewon/artifacts";
import { ProjectMaterialPreparer } from "./project-material-preparer.ts";
import { ProjectReferenceMaterialFreezer } from "./project-reference-material-freezer.ts";
import { adoptedMediaReaderFixture } from "./project-adopted-media-reference-reader.test-support.ts";

/** Actual adopted result, original encrypted archives/SQL/preparer. Only permissions and supplier sockets are fixtures. */
export async function adoptedMediaMaterialFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const f = await adoptedMediaReaderFixture(t, backend),
    archives: FilesystemProjectMaterialArchive[] = [],
    policy = {
      freeze: true,
      prepare: true,
      upload: true,
      observe: true,
      active: true,
    },
    grants: Parameters<
      ProjectAdoptedMediaMaterialFreezeAuthorizationPort["authorize"]
    >[0][] = [],
    input = {
      source: {
        query: f.referenceQuery,
        idempotencyKey: "freeze-adopted-media",
      },
      target: f.input.target,
      idempotencyKey: "prepare-adopted-media",
    };
  t.after(() => {
    for (const archive of archives) archive.close();
  });
  const openFreezer = (
    sources = f.sources,
    reader = f.reader,
    override?: ProjectReferenceMaterialArchivePort,
  ) => {
    const archive = new FilesystemProjectMaterialArchive(
      f.archiveConfiguration,
    );
    archives.push(archive);
    const freezer = new ProjectReferenceMaterialFreezer({
      sourceKind: "media-result",
      sources,
      reader,
      archive: override ?? archive,
      authorization: {
        authorize: async (p) => {
          grants.push(p);
          return f.decision(policy.freeze);
        },
      },
    });
    return { freezer, archive };
  };
  const current = openFreezer();
  const preparer = (
    freezer = current.freezer,
    journal = f.journal,
    targets = f.targets,
  ) =>
    new ProjectMaterialPreparer({
      ...f.dependencies,
      freezer,
      journal,
      targets,
      authorization: {
        authorize: async (p) =>
          f.decision(
            p.action === "projectMaterial:prepare"
              ? policy.prepare
              : p.action === "projectMaterial:upload"
                ? policy.upload
                : policy.observe,
          ),
        assertActive: () => {
          if (!policy.active) throw new Error("named_preparation_retired");
        },
      },
    });
  return {
    ...f,
    ...current,
    input,
    policy,
    grants,
    openFreezer,
    makePreparer: preparer,
    preparer: preparer(),
    freeze: () =>
      current.freezer.freezeSelectedReference(f.actor, input.source, {
        signal: new AbortController().signal,
      }),
    prepare: () =>
      preparer().prepareSelectedReference(f.actor, input, {
        signal: new AbortController().signal,
      }),
  };
}
