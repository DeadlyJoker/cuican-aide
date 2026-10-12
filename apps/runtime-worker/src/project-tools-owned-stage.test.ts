import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectStageRunAdmission } from "@crewon/domain";
import { projectToolsOwnerFixture } from "./project-tools-service-owner.test-support.ts";
import { conversationFixture } from "../../../packages/store/src/project-conversation-store.test-support.ts";
import { foundationMetadataFixture } from "../../../packages/store/src/project-foundation-legacy-access.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: original Worker stage reads protected project and pages its brief; current lease and independent PDP remain mandatory`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      let stage: ProjectStageRunAdmission | null = null;
      const f = await projectToolsOwnerFixture(t, {
        backend,
        prepareAdmission: async (base) => {
          const c = await conversationFixture(t, backend, base);
          const prepared = await c.prepare();
          await c.store.commitBinding(prepared, { authority: c.authority });
          const admitted = await c.tasks.createProjectConversationTurnFromHost(
            c.actor,
            {
              pluginId: c.pin.pluginId,
              threadId: prepared.binding.threadId,
              expectedThreadRevision: 1,
              idempotencyKey: "worker-owned-stage",
              intent: {
                kind: "generate",
                input: { prompt: "read original project" },
              },
            },
            {
              binding: prepared.binding,
              stage: { kind: "discussion" },
              sources: { brief: null, outline: null },
              content: "read original project",
              authority: c.authority,
              conversations: c.store,
            },
          );
          stage = admitted.stageAdmission;
          return admitted.result;
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
      const ownerScope = {
        ...f.actor,
        profileId: f.admission.profileId,
        pluginId: f.admission.pluginId,
        publisherId: f.admission.publisherId,
      };
      await metadata.mark(f.reference.projectId, ownerScope);
      const request = { projectId: f.reference.projectId };
      const operation = await f.prepareRead("readProject", request);
      const ordinary = f.owner();
      await assert.rejects(
        f.invoke(ordinary, operation, (command) =>
          f.service(ordinary).readProject({ command, request }),
        ),
        /creative_project_not_found/,
      );
      const owned = f.owner({ projectOwnership: "plugin-project-v1" });
      const originalRead = f.projects.getProject.bind(f.projects);
      let retainedOptions: Parameters<typeof originalRead>[2];
      let cancelAfterProjectRead = false;
      t.mock.method(
        f.projects,
        "getProject",
        async (...args: Parameters<typeof originalRead>) => {
          const [actor, query, options] = args;
          if (options !== undefined) {
            retainedOptions = options;
            await assert.rejects(
              originalRead(actor, query, {
                readScope: { ...options.readScope },
              }),
            );
            await assert.rejects(
              originalRead(
                actor,
                { projectId: "other-owned-project" },
                options,
              ),
            );
          }
          const value = await originalRead(...args);
          if (cancelAfterProjectRead && options !== undefined) {
            const run = await f.parent.loadRun(f.locator);
            assert.ok(run);
            await metadata.execute(
              `UPDATE ${f.prefix}run_snapshots SET state_json=$1 WHERE tenant_id=$2 AND run_id=$3`,
              [
                JSON.stringify({ ...run, cancelRequested: true }),
                run.tenantId,
                run.runId,
              ],
            );
            cancelAfterProjectRead = false;
          }
          return value;
        },
      );
      const result = await f.invoke(owned, operation, (command) =>
        f.service(owned).readProject({ command, request }),
      );
      assert.equal(result.project.projectId, request.projectId);
      assert.ok(result.brief);
      const contentRequest = {
        projectId: request.projectId,
        source: { kind: "brief" as const, briefRevision: 1 },
        offset: 0,
      };
      const content = await f.prepareRead("readContent", contentRequest);
      const page = await f.invoke(owned, content, (command) =>
        f.service(owned).readContent({ command, request: contentRequest }),
      );
      assert.equal(page.format, "text");
      assert.ok(page.text.length > 0);
      assert.equal(page.contentDigest, result.brief.contentDigest);
      await owned.close();
      const cold = f.owner({ projectOwnership: "plugin-project-v1" });
      assert.deepEqual(
        await f.invoke(cold, operation, (command) =>
          f.service(cold).readProject({ command, request }),
        ),
        result,
      );
      assert.ok(retainedOptions);
      await assert.rejects(originalRead(f.actor, request, retainedOptions));
      await assert.rejects(
        f.invoke(
          cold,
          operation,
          (command) => f.service(cold).readProject({ command, request }),
          { copied: true },
        ),
      );
      f.state.policy = false;
      await assert.rejects(
        f.invoke(cold, operation, (command) =>
          f.service(cold).readProject({ command, request }),
        ),
      );
      f.state.policy = true;
      const beforeCancel = await f.parent.loadRun(f.locator);
      assert.ok(beforeCancel);
      cancelAfterProjectRead = true;
      await assert.rejects(
        f.invoke(cold, operation, (command) =>
          f.service(cold).readProject({ command, request }),
        ),
      );
      assert.equal(cancelAfterProjectRead, false);
      assert.equal((await f.parent.loadRun(f.locator))?.cancelRequested, true);
      await metadata.execute(
        `UPDATE ${f.prefix}run_snapshots SET state_json=$1 WHERE tenant_id=$2 AND run_id=$3`,
        [
          JSON.stringify(beforeCancel),
          beforeCancel.tenantId,
          beforeCancel.runId,
        ],
      );
      const expired = f.owner({
        projectOwnership: "plugin-project-v1",
        now: () => new Date(Date.parse(operation.claim.lease.expiresAt) + 1),
      });
      await assert.rejects(
        f.invoke(expired, operation, (command) =>
          f.service(expired).readProject({ command, request }),
        ),
      );
      // The caller's claim remains live in memory: only the persisted lease is expired.
      const counts = await f.counts();
      await metadata.execute(
        `UPDATE ${f.prefix}work_items SET ${backend === "sqlite" ? "lease_expires_at_ms" : "lease_expires_at"}=$1 WHERE work_item_id=$2`,
        [
          backend === "sqlite"
            ? Date.now() - 1
            : new Date(Date.now() - 1).toISOString(),
          operation.claim.workItem.workItemId,
        ],
      );
      await assert.rejects(
        f.invoke(cold, operation, (command) =>
          f.service(cold).readProject({ command, request }),
        ),
        /plugin_project_run_read_not_current/,
      );
      assert.deepEqual(await f.counts(), counts);
    },
  );
