import { composeInstalledPluginProjectFoundationToolsDependencies } from "./installed-plugin-project-foundation-tools.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationError } from "@crewon/application";
import { foundationToolsOwnerFixture } from "./project-foundation-tools-service-owner.test-support.ts";
import { foundationMetadataFixture } from "../../../../packages/store/src/project-foundation-legacy-access.test-support.ts";
for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: original checked Foundation Tool dispatch reads protected novel pages through scoped original service and cold owner`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await foundationToolsOwnerFixture(t, "novel", backend);
      const metadata = await foundationMetadataFixture(t, {
        backend,
        schema: f.schema ?? "main",
        prefix: f.prefix,
        path: f.databasePath,
      });
      await metadata.migrate();
      const ownerScope = {
        ...f.actor,
        profileId: f.taskAdmission.profileId,
        pluginId: f.taskAdmission.pluginId,
        publisherId: f.taskAdmission.publisherId,
      };
      await metadata.mark(f.admission.projectId, ownerScope);
      assert.ok(f.admission.source);
      const request = {
        projectId: f.admission.projectId,
        sourceRevision: f.admission.source.revision,
        sourceDigest: f.admission.source.digest,
        startOffset: 0,
        limit: 5,
      };
      let reads = 0;
      const composed = composeInstalledPluginProjectFoundationToolsDependencies(
        {
          store: f.parent,
          config: {
            version: "crewon.project-foundation-tools.v1",
            projectOwnership: "plugin-project-v1",
            createFoundations: () => f.foundations,
            authorization: f.dependencies.authorization,
            authorizeService: async (_admission, signal) =>
              f.dependencies.authorizeFoundationService(signal),
          },
          resolveActor: f.dependencies.resolveActor,
        },
      );
      const createOwner = () =>
        f.owner({
          projectOwnership: composed.projectOwnership,
          readService(scope) {
            reads++;
            return composed.readService!(scope);
          },
        });
      const first = createOwner();
      const op = await f.prepare("readSourcePage", request);
      const before = await f.counts();
      await assert.rejects(
        f.invoke(
          first,
          op,
          (command) => f.service(first).readSourcePage({ command, request }),
          { copied: true },
        ),
      );
      await assert.rejects(
        f.invoke(first, op, (command) =>
          f
            .service(first)
            .readSourcePage({
              command,
              request: { ...request, projectId: "foreign-project" },
            }),
        ),
      );
      assert.equal(reads, 0);
      const value = (await f.invoke(first, op, (command) =>
        f.service(first).readSourcePage({ command, request }),
      )) as { page: { content: string; nextOffset: number | null } };
      assert.equal(value.page.content, "雨😀夜\n重");
      assert.equal(value.page.nextOffset, 5);
      assert.equal(reads, 1);
      assert.deepEqual(await f.counts(), before);
      const cold = createOwner();
      const next = await f.prepare("readSourcePage", {
        ...request,
        startOffset: 5,
      });
      const second = (await f.invoke(cold, next, (command) =>
        f
          .service(cold)
          .readSourcePage({ command, request: { ...request, startOffset: 5 } }),
      )) as { page: { content: string } };
      assert.equal(second.page.content, "逢 caf");
      const missing = f.owner({ projectOwnership: "plugin-project-v1" });
      const denied = await f.prepare("readSourcePage", request);
      await assert.rejects(
        f.invoke(missing, denied, (command) =>
          f.service(missing).readSourcePage({ command, request }),
        ),
        (error) =>
          error instanceof ApplicationError &&
          error.code === "plugin_project_foundation_read_binding_unavailable",
      );
      f.controls.service = false;
      await assert.rejects(
        f.invoke(cold, denied, (command) =>
          f.service(cold).readSourcePage({ command, request }),
        ),
        /named_foundation_service_denied/u,
      );
    },
  );
