import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  ProjectMediaInputApplicationService,
  type ProjectMediaGenerationTask,
} from "@crewon/application";
import { createProjectMediaMaterialRuntime } from "@crewon/media-runtime/project-media-material-runtime";
import { ProjectMediaGenerationTaskPreparer } from "./project-media-generation-task-preparer.ts";
import { selectionVerifier } from "../../../packages/store/src/project-concept-selection.test-support.ts";
import { adoptedMediaReaderFixture } from "./project-adopted-media-reference-reader.test-support.ts";
import { materialPng } from "./project-material-png.test-support.ts";
import { seedThread } from "../../../packages/store/src/thread-store-conformance.test-support.ts";

/** Actual adopted T10 output -> saved mixed D18 input -> original preparation/Turn.
 * Only policy, source decoding and supplier sockets are fixtures. */
export async function adoptedMediaInputFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const f = await adoptedMediaReaderFixture(t, backend);
  const policy = { freeze: true, legacyReads: 0 };
  const reviews = f.reviews.map(({ targetIdentity, workflow }) => ({
    targetIdentity,
    workflow,
  }));
  const openRuntime = async (
    parent = f.parent,
    configurations = f.configurations,
    publisher = f.publisher,
    targets = f.targets,
    includeAdopted = true,
  ) => {
    const runtime = await createProjectMediaMaterialRuntime({
      store: parent,
      configurations,
      profiles: {
        resolve: async () => ({
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          profileId: f.target.installation.profileId,
        }),
      },
      projects: { authorize: async () => f.decision(f.policy.allow) },
      installations: { authorize: async () => f.decision(true) },
      metadata: f.mediaAuthorization,
      read: { authorize: async () => f.decision(true) },
      freeze: { authorize: async () => f.decision(true) },
      preparation: f.dependencies.authorization,
      sourceAdapter: {
        deriveReadDestination(source) {
          const url = new URL(source.resultLink.image.url);
          return {
            origin: url.origin + "/",
            path: url.pathname + url.search,
            output: {
              filename: source.resultLink.image.filename,
              subfolder: "named-source-output",
              type: "output",
            },
          };
        },
      },
      verifier: selectionVerifier,
      reviews,
      archive: f.archiveConfiguration,
      clock: f.dependencies.clock,
      signal: new AbortController().signal,
      ...(includeAdopted
        ? {
            adoptedMedia: {
              results: publisher,
              read: f.authorization,
              freeze: { authorize: async () => f.decision(policy.freeze) },
            },
          }
        : {}),
      network: {
        dns: f.dependencies.dns,
        source: {
          request: async (request) => {
            policy.legacyReads++;
            return {
              status: 200,
              headers: { "content-type": "image/png" },
              body: request.target.endpoint.pathname.endsWith("/1.png")
                ? materialPng(3, 1)
                : materialPng(),
            };
          },
        },
        upload: f.dependencies.uploadTransport,
        observation: f.dependencies.observationTransport,
      },
    });
    t.after(() => runtime.close());
    const inputStore = parent
      .projectAssetStore({ verifier: selectionVerifier })
      .projectMediaInputStore();
    const app = new ProjectMediaInputApplicationService({
      store: inputStore,
      sources: runtime.sources,
      targets,
      reviews,
      authorization: f.mediaAuthorization,
      ids: { nextMediaInputId: () => randomUUID() },
      clock: f.dependencies.clock,
    });
    const extensions = parent.extensionStore();
    await extensions.migrateProjectMediaGenerations();
    const issuer = new ProjectMediaGenerationTaskPreparer({
      materials: runtime.materials,
      store: inputStore,
      extensions,
      reviews,
      metadataAuthorization: f.mediaAuthorization,
      authorization: f.generationAuthorization,
      verifier: selectionVerifier,
    });
    return { runtime, app, issuer, inputStore };
  };
  const current = await openRuntime();
  const threadId = "adopted-media-thread";
  await seedThread(f.parent, { ...f.actor, threadId });
  const create = (
    task: ProjectMediaGenerationTask,
    key: string,
    service = f.service,
  ) =>
    service.createProjectMediaTaskFromHost({
      actor: f.actor,
      command: { ...f.taskCommand(task, key), threadId },
      pin: f.pin,
      task,
    });
  const mixedCommand = {
    ...f.d18Command,
    references: {
      ...f.d18Command.references,
      characterOne: f.referenceQuery,
    },
    idempotencyKey: "mixed-adopted-storyboard",
  };
  return {
    ...f,
    ...current,
    create,
    inputPolicy: policy,
    openRuntime,
    mixedCommand,
  };
}
