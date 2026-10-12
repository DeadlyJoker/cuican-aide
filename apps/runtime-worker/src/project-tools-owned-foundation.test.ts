import assert from "node:assert/strict";
import test from "node:test";
import {
  ProjectFoundationApplicationService,
  ProjectSourceUploadApplicationService,
  ProjectSourceUploadFoundationAdapter,
  type ProjectFoundationMutationResult,
} from "@crewon/application";
import { ProjectSourceUploadPreparationAdapter } from "@crewon/media-runtime";
import { randomUUID } from "node:crypto";
import {
  prepareOwnedUpload,
  adoptedNovel,
} from "../../control-api/src/project-foundation-source-upload.test-support.ts";
import { uploadHash } from "../../control-api/src/project-source-upload.test-support.ts";
import type { ProjectStageRunAdmission } from "@crewon/domain";
import { projectToolsOwnerFixture } from "./project-tools-service-owner.test-support.ts";
import { conversationFixture } from "../../../packages/store/src/project-conversation-store.test-support.ts";
import { foundationMetadataFixture } from "../../../packages/store/src/project-foundation-legacy-access.test-support.ts";
import { projectToolBoundReadServices } from "./plugins/project-tool-bound-read-services.ts";

for (const backend of ["sqlite", "postgres"] as const)
  for (const sharedOwner of ["same", "foreign"] as const)
    test(
      `${backend}/${sharedOwner}: actual Worker read source binds original Foundation dependency reader without lending writes or cross-project access`,
      { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
      async (t) => {
        let stage: ProjectStageRunAdmission | null = null;
        let created: ProjectFoundationMutationResult | undefined;
        const projectId = "owned-foundation-dependency";
        const novelText = "第一章 雨夜\n雨😀夜重逢。\n第二章 来信\n未来来信。";
        const sharedProjectId = "shared-source-foundation";
        const f = await projectToolsOwnerFixture(t, {
          backend,
          prepareAdmission: async (base) => {
            const store = base.first.parent.projectFoundationStore();
            await store.migrate();
            const uploads = base.first.parent.projectSourceUploadStore({
              installationAdmission: "trusted-internal-authority",
            });
            await uploads.migrate();
            const parser = new ProjectSourceUploadPreparationAdapter();
            const uploadService = new ProjectSourceUploadApplicationService({
              store: uploads,
              authorization: {
                authorize: async () => ({ outcome: "allow" as const }),
                assertActive() {},
              },
              bytes: parser,
              parser,
              clock: base.dependencies.clock,
              digester: { sha256: uploadHash },
              ids: {
                nextUploadId: () => randomUUID(),
                nextClaimId: () => randomUUID(),
              },
              preparationClaimTtlMs: 60000,
            });
            const uploaded = await prepareOwnedUpload(
              uploadService,
              Buffer.from(novelText),
              "worker-source-upload",
              base.actor,
            );
            let nextProjectId = projectId;
            const foundation = new ProjectFoundationApplicationService({
              store,
              projects: base.metadata,
              sourcePreparation: new ProjectSourceUploadFoundationAdapter(
                uploadService,
              ),
              authorization: {
                authorize: async () => ({ outcome: "allow" as const }),
              },
              clock: base.dependencies.clock,
              ids: { nextId: () => nextProjectId },
              digester: { sha256: uploadHash },
            });
            created = await foundation.createProject(
              base.actor,
              adoptedNovel(uploaded.reference, "worker-source-adoption"),
              { authority: { async assertCurrent() {}, assertActive() {} } },
            );
            assert.equal(created.foundation.origin, "novel");
            assert.ok(created.source);
            nextProjectId = sharedProjectId;
            await foundation.createProject(
              base.actor,
              adoptedNovel(uploaded.reference, "worker-shared-source-adoption"),
              { authority: { async assertCurrent() {}, assertActive() {} } },
            );
            const c = await conversationFixture(t, backend, {
              ...base,
              reference: { ...base.reference, projectId },
            });
            const prepared = await c.prepare();
            await c.store.commitBinding(prepared, { authority: c.authority });
            const accepted =
              await c.tasks.createProjectConversationTurnFromHost(
                c.actor,
                {
                  pluginId: c.pin.pluginId,
                  threadId: prepared.binding.threadId,
                  expectedThreadRevision: 1,
                  idempotencyKey: "novel-dependency-stage",
                  intent: {
                    kind: "generate",
                    input: { prompt: "inspect source dependency" },
                  },
                },
                {
                  binding: prepared.binding,
                  stage: { kind: "discussion" },
                  sources: { brief: null, outline: null },
                  content: "inspect source dependency",
                  authority: c.authority,
                  conversations: c.store,
                },
              );
            stage = accepted.stageAdmission;
            return accepted.result;
          },
          stageAdmission: () => stage,
        });
        const metadata = await foundationMetadataFixture(t, {
          backend,
          schema: backend === "postgres" ? f.prefix.slice(1, -2) : "main",
          prefix: f.prefix,
          path: f.databasePath,
        });
        await metadata.migrate();
        const owner = {
          ...f.actor,
          profileId: f.admission.profileId,
          pluginId: f.admission.pluginId,
          publisherId: f.admission.publisherId,
        };
        await metadata.mark(projectId, owner);
        const sharedScope = {
          ...owner,
          pluginId: sharedOwner === "same" ? owner.pluginId : "foreign-plugin",
        };
        await metadata.mark(sharedProjectId, sharedScope);
        const original = f.parent.projectFoundationStore();
        const query = {
          owner: {
            tenantId: f.actor.tenantId,
            spaceId: f.actor.spaceId,
            principalId: f.actor.principalId,
          },
          projectId,
        };
        const sourceQuery = {
          ...query,
          revision: created!.source!.revision,
          digest: created!.source!.digest,
        };
        const pageQuery = { ...sourceQuery, startOffset: 0, limit: 5 };
        const chapterQuery = {
          ...sourceQuery,
          afterStartOffset: null,
          limit: 1,
        };
        for (const read of [
          () => original.loadFoundation(query),
          () =>
            original.loadSource({ ...query, revision: sourceQuery.revision }),
          () => original.readSourcePage(pageQuery),
          () => original.listSourceChapters(chapterQuery),
        ])
          await assert.rejects(read());
        let observed = 0;
        let retained: ReturnType<typeof original.bindProjectReads> | undefined;
        const ownerInstance = () =>
          f.owner({
            projectOwnership: "plugin-project-v1",
            readServices: (scope) => {
              const bound = original.bindProjectReads(scope);
              retained = bound;
              assert.deepEqual(Object.keys(bound), [
                "loadFoundation",
                "loadSource",
                "readSourcePage",
                "listSourceChapters",
              ]);
              const services = projectToolBoundReadServices(
                {
                  store: f.parent,
                  authorization: f.dependencies.authorization,
                },
                scope,
              );
              return {
                ...services,
                outlines: {
                  getOutline: async (actor, input) => {
                    if (sharedOwner === "foreign") {
                      for (const read of [
                        () =>
                          bound.loadSource({
                            ...query,
                            revision: sourceQuery.revision,
                          }),
                        () => bound.readSourcePage(pageQuery),
                        () => bound.listSourceChapters(chapterQuery),
                      ])
                        await assert.rejects(
                          read(),
                          /project_source_upload_not_found/u,
                        );
                    }
                    assert.deepEqual(
                      await bound.loadFoundation(query),
                      created!.foundation,
                    );
                    observed++;
                    assert.deepEqual(
                      await bound.loadSource({
                        ...query,
                        revision: sourceQuery.revision,
                      }),
                      created!.source,
                    );
                    let offset = 0,
                      full = "";
                    while (offset < created!.source!.characterLength) {
                      const page = await bound.readSourcePage({
                        ...pageQuery,
                        startOffset: offset,
                      });
                      assert.ok(
                        Array.from(page.content).length <= pageQuery.limit,
                      );
                      assert.equal(page.startOffset, offset);
                      full += page.content;
                      assert.ok(page.endOffset > offset);
                      offset = page.endOffset;
                      assert.equal(
                        page.nextOffset,
                        offset === created!.source!.characterLength
                          ? null
                          : offset,
                      );
                    }
                    assert.equal(full, novelText);
                    const chapters =
                      await bound.listSourceChapters(chapterQuery);
                    assert.equal(chapters.chapters.length, 1);
                    assert.ok(chapters.nextStartOffset !== null);
                    const next = await bound.listSourceChapters({
                      ...chapterQuery,
                      afterStartOffset: chapters.nextStartOffset,
                    });
                    assert.equal(next.chapters.length, 1);
                    assert.equal(next.nextStartOffset, null);
                    assert.ok(
                      next.chapters[0]!.startOffset >
                        chapters.chapters[0]!.startOffset,
                    );
                    await assert.rejects(
                      bound.readSourcePage({
                        ...pageQuery,
                        digest: "sha256:" + "0".repeat(64),
                      }),
                      /project_foundation_source_digest_mismatch/u,
                    );
                    await assert.rejects(
                      bound.readSourcePage({
                        ...pageQuery,
                        projectId: f.reference.projectId,
                      }),
                    );
                    await assert.rejects(
                      bound.readSourcePage({ ...pageQuery, limit: 1025 }),
                    );
                    await assert.rejects(
                      bound.loadFoundation({
                        ...query,
                        projectId: f.reference.projectId,
                      }),
                    );
                    await assert.rejects(
                      bound.loadFoundation({
                        ...query,
                        owner: { ...query.owner, principalId: "foreign" },
                      }),
                    );
                    return services.outlines.getOutline(actor, input);
                  },
                  getRevision: services.outlines.getRevision.bind(
                    services.outlines,
                  ),
                  listRevisions: services.outlines.listRevisions.bind(
                    services.outlines,
                  ),
                },
              };
            },
          });
        // Named observation wrapper reads the real dependency within the actual Tool lifetime.
        // The upload/parser/adoption are original services with named policy. This does not prove a saved v2 outline.
        if (sharedOwner === "foreign") {
          const rejectedOwner = ownerInstance();
          const operation = await f.prepareRead("readOutline", { projectId });
          await assert.rejects(
            f.invoke(rejectedOwner, operation, (command) =>
              f
                .service(rejectedOwner)
                .readOutline({ command, request: { projectId } }),
            ),
            /project_source_upload_not_found/u,
          );
          assert.equal(observed, 0);
          await assert.rejects(retained!.loadFoundation(query));
          return;
        }
        for (let i = 0; i < 2; i++) {
          const owner = ownerInstance();
          const operation = await f.prepareRead("readOutline", { projectId });
          await f.invoke(owner, operation, (command) =>
            f.service(owner).readOutline({ command, request: { projectId } }),
          );
          await assert.rejects(retained!.loadFoundation(query));
          await assert.rejects(retained!.readSourcePage(pageQuery));
        }
        assert.equal(observed, 2);
        await assert.rejects(original.loadFoundation(query));
      },
    );
