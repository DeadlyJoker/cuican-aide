import { foundationMetadataFixture } from "./project-foundation-legacy-access.test-support.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  issuePluginProjectFoundationRunReadScope,
  captureProjectFoundationRunReadAuthority,
} from "@crewon/application/host-project-workspaces";
import { foundationToolsOwnerFixture } from "../../../apps/runtime-worker/src/plugins/project-foundation-tools-service-owner.test-support.ts";
import {
  assertSqliteFoundationRunRead,
  assertPostgresFoundationRunRead,
} from "./project-foundation-run-read.ts";
for (const backend of ["sqlite", "postgres"] as const)
  for (const withdrawal of ["lease", "binding", "owned"] as const)
    test(
      `${backend}/${withdrawal}: independent Foundation read checks original stored sidecar, binding and physical Tool lease on borrowed transaction`,
      { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
      async (t) => {
        const f = await foundationToolsOwnerFixture(t, "novel", backend);
        assert.ok(f.admission.source);
        const op = await f.prepare("readSourcePage", {
          projectId: f.admission.projectId,
          sourceRevision: f.admission.source.revision,
          sourceDigest: f.admission.source.digest,
          startOffset: 0,
          limit: 5,
        });
        const scope = {
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          profileId: f.admission.installation.profileId,
        };
        const selection = await f.dependencies.installations.loadSelection({
          scope,
          pluginId: f.admission.installation.pluginId,
        });
        const pkg = await f.dependencies.installations.loadPackage({
          scope,
          packageDigest: f.admission.installation.packageDigest,
        });
        const q = captureProjectFoundationRunReadAuthority({
          version: "crewon.project-foundation-run-read.v1",
          actor: f.actor,
          run: op.run,
          receipt: op.receipt,
          claim: op.claim,
          commandInput: op.command.input,
          operationId: "foundation_source_page",
          installation: f.admission.installation,
          admission: f.taskAdmission,
          projectStageAdmission: f.stage,
          foundationAdmission: f.admission,
          selection,
          package: pkg,
          async assertCurrent() {},
        });
        async function read() {
          if (f.db) {
            f.db.exec("BEGIN IMMEDIATE");
            try {
              assertSqliteFoundationRunRead(f.db, q);
            } finally {
              f.db.exec("ROLLBACK");
            }
          } else {
            const client = await f.pool!.connect();
            try {
              await client.query("BEGIN");
              await assertPostgresFoundationRunRead(client, f.schema!, q);
            } finally {
              await client.query("ROLLBACK");
              client.release();
            }
          }
        }
        const before = await f.counts();
        await read();
        assert.deepEqual(await f.counts(), before);
        if (withdrawal === "owned") {
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
          await assert.rejects(
            f.foundationRuns.loadFoundationRunAdmission({
              tenantId: f.actor.tenantId,
              spaceId: f.actor.spaceId,
              runId: f.admission.runId,
            }),
          );
          let active = true;
          const issue = () =>
            issuePluginProjectFoundationRunReadScope({
              authority: q,
              assertActive() {
                assert.ok(active, "named-foundation-read-ended");
              },
            });
          const source = await issue();
          assert.throws(() =>
            f.parent.projectFoundationStore().bindProjectReads({ ...source }),
          );
          const view = f.parent
            .projectFoundationStore()
            .bindProjectReads(source);
          const query = {
            owner: {
              tenantId: f.actor.tenantId,
              spaceId: f.actor.spaceId,
              principalId: f.actor.principalId,
            },
            projectId: f.admission.projectId,
          };
          const pageQuery = {
            ...query,
            revision: f.admission.source!.revision,
            digest: f.admission.source!.digest,
            startOffset: 0,
            limit: 5,
          };
          assert.equal(
            (await view.readSourcePage(pageQuery)).content,
            "雨😀夜\n重",
          );
          assert.equal(
            (await view.loadFoundation(query))?.projectId,
            f.admission.projectId,
          );
          assert.equal(
            (await view.loadSource({ ...query, revision: pageQuery.revision }))
              ?.digest,
            pageQuery.digest,
          );
          await assert.rejects(
            view.readSourcePage({
              ...pageQuery,
              revision: pageQuery.revision + 1,
            }),
            /plugin_project_read_target_mismatch/u,
          );
          await assert.rejects(
            view.listSourceChapters({
              ...query,
              revision: pageQuery.revision,
              digest: pageQuery.digest,
              afterStartOffset: null,
              limit: 1,
            }),
            /plugin_project_read_method_mismatch/u,
          );
          await assert.rejects(
            view.loadFoundation({ ...query, projectId: "foreign-project" }),
          );
          const cold = f.parent
            .projectFoundationStore()
            .bindProjectReads(await issue());
          assert.deepEqual(
            await cold.readSourcePage(pageQuery),
            await view.readSourcePage(pageQuery),
          );
          const beforeRead = await f.counts();
          await f.sql(
            `UPDATE ${f.prefix}work_items SET ${backend === "sqlite" ? "lease_expires_at_ms" : "lease_expires_at"}=${backend === "sqlite" ? "?" : "$1"} WHERE work_item_id=${backend === "sqlite" ? "?" : "$2"}`,
            [
              backend === "sqlite"
                ? Date.now() - 1
                : new Date(Date.now() - 1).toISOString(),
              op.claim.workItem.workItemId,
            ],
          );
          await assert.rejects(
            view.readSourcePage(pageQuery),
            /creative_project_run_commit_not_current/u,
          );
          assert.deepEqual(await f.counts(), beforeRead);
          active = false;
          await assert.rejects(
            cold.readSourcePage(pageQuery),
            /named-foundation-read-ended/u,
          );
          return;
        }
        if (withdrawal === "lease") {
          // Original SQL lease changes; the captured caller claim stays unmodified.
          await f.sql(
            `UPDATE ${f.prefix}work_items SET ${backend === "sqlite" ? "lease_expires_at_ms" : "lease_expires_at"}=${backend === "sqlite" ? "?" : "$1"} WHERE work_item_id=${backend === "sqlite" ? "?" : "$2"}`,
            [
              backend === "sqlite"
                ? Date.now() - 1
                : new Date(Date.now() - 1).toISOString(),
              op.claim.workItem.workItemId,
            ],
          );
          await assert.rejects(
            read(),
            /creative_project_run_commit_not_current/u,
          );
        } else {
          const binding = await f.conversations.store.loadBinding({
            actor: f.actor,
            profileId: f.taskAdmission.profileId,
            threadId: f.admission.threadId,
          });
          assert.ok(binding);
          await f.conversations.store.commitBinding(
            f.conversations.mutate(binding, "set-state"),
            { authority: f.conversations.authority },
          );
          const afterWithdrawal = await f.counts();
          await assert.rejects(read());
          assert.deepEqual(await f.counts(), afterWithdrawal);
        }
      },
    );
