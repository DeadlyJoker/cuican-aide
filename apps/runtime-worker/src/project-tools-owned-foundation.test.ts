import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectFoundationMutationResult } from "@crewon/application";
import type { ProjectStageRunAdmission } from "@crewon/domain";
import { projectToolsOwnerFixture } from "./project-tools-service-owner.test-support.ts";
import { conversationFixture } from "../../../packages/store/src/project-conversation-store.test-support.ts";
import { foundationCreationRecipe } from "../../../packages/store/src/project-foundation-store.test-support.ts";
import { foundationMetadataFixture } from "../../../packages/store/src/project-foundation-legacy-access.test-support.ts";
import { projectToolBoundReadServices } from "./plugins/project-tool-bound-read-services.ts";

for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: actual Worker read source binds original Foundation dependency reader without lending writes or cross-project access`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      let stage: ProjectStageRunAdmission | null = null;
      let created: ProjectFoundationMutationResult | undefined;
      const projectId = "owned-foundation-dependency";
      const f = await projectToolsOwnerFixture(t, {
        backend,
        prepareAdmission: async (base) => {
          const store = base.first.parent.projectFoundationStore();
          await store.migrate();
          created = await store.commitCreation(
            foundationCreationRecipe(
              projectId,
              "novel-dependency-create",
              "creative",
              base.actor,
            ),
          );
          const c = await conversationFixture(t, backend, {
            ...base,
            reference: { ...base.reference, projectId },
          });
          const prepared = await c.prepare();
          await c.store.commitBinding(prepared, { authority: c.authority });
          const accepted = await c.tasks.createProjectConversationTurnFromHost(
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
      const original = f.parent.projectFoundationStore();
      const query = {
        owner: {
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          principalId: f.actor.principalId,
        },
        projectId,
      };
      await assert.rejects(original.loadFoundation(query));
      let observed = 0;
      let retained: ReturnType<typeof original.bindProjectReads> | undefined;
      const ownerInstance = () =>
        f.owner({
          projectOwnership: "plugin-project-v1",
          readServices: (scope) => {
            const bound = original.bindProjectReads(scope);
            retained = bound;
            assert.deepEqual(Object.keys(bound), ["loadFoundation"]);
            const services = projectToolBoundReadServices(
              { store: f.parent, authorization: f.dependencies.authorization },
              scope,
            );
            return {
              ...services,
              outlines: {
                getOutline: async (actor, input) => {
                  assert.deepEqual(
                    await bound.loadFoundation(query),
                    created!.foundation,
                  );
                  observed++;
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
      // It does not prove a saved v2 outline or uploaded-file adoption.
      for (let i = 0; i < 2; i++) {
        const owner = ownerInstance();
        const operation = await f.prepareRead("readOutline", { projectId });
        await f.invoke(owner, operation, (command) =>
          f.service(owner).readOutline({ command, request: { projectId } }),
        );
        await assert.rejects(retained!.loadFoundation(query));
      }
      assert.equal(observed, 2);
      await assert.rejects(original.loadFoundation(query));
    },
  );
