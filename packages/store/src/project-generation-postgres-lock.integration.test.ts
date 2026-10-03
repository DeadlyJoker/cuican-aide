import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Client } from "pg";
import {
  appendProjectBriefRevision,
  setCreativeProjectState,
} from "@crewon/domain";
import {
  projectGenerationFixture,
  activeAuthority,
} from "./project-generation.test-support.ts";
import { receipt } from "./creative-project-store.test-support.ts";
import { extensionStoreDigester } from "./extension-store-records.ts";
import { timestamp } from "./extension-store.test-support.ts";

for (const operation of ["archive", "append-brief"] as const)
  test(
    `postgres actual project mutex serializes ${operation} ahead of paid generation and denies the stale source`,
    { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 10_000 },
    async (t) => {
      const f = await projectGenerationFixture(t, "postgres");
      const input = await f.input();
      const before = await f.counts();
      const owner = {
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        principalId: f.actor.principalId,
      };
      const project = (await f.metadata.loadProject({
        owner,
        projectId: f.reference.projectId,
      }))!;
      const blocker = new Client({
        connectionString: process.env.CREWON_TEST_POSTGRES_URL,
      });
      await blocker.connect();
      try {
        await blocker.query("BEGIN");
        const schema = f.prefix.slice(1, -2);
        const lock = JSON.stringify([
          "creative-project-project",
          schema,
          f.actor.tenantId,
          f.actor.spaceId,
          f.reference.projectId,
        ]);
        await blocker.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [lock],
        );
        const pid = Number(
          (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
        );
        const mutation =
          operation === "archive"
            ? f.metadata.commitProjectMetadata({
                kind: "set-project-state",
                actor: f.actor,
                receipt: receipt("mutex-archive"),
                expectedProjectRevision: project.revision,
                project: setCreativeProjectState({
                  project,
                  actor: f.actor,
                  expectedProjectRevision: project.revision,
                  state: "archived",
                  at: timestamp,
                }),
              })
            : f.metadata.commitProjectBrief({
                actor: f.actor,
                receipt: receipt("mutex-append"),
                expectedProjectRevision: project.revision,
                ...appendProjectBriefRevision(
                  {
                    project,
                    actor: f.actor,
                    expectedProjectRevision: project.revision,
                    text: "竞争中已提交的新需求",
                    at: timestamp,
                  },
                  extensionStoreDigester,
                ),
              });
        // Observe any rejection while waiting for the actual server-side lock queue.
        void mutation.catch(() => {});
        const waiters = async (minimum: number) => {
          const deadline = Date.now() + 2_000;
          while (Date.now() < deadline) {
            const count = Number(
              (
                await blocker.query(
                  "SELECT COUNT(*) AS n FROM pg_locks w JOIN pg_locks b ON b.locktype='advisory' AND w.locktype=b.locktype AND w.database=b.database AND w.classid=b.classid AND w.objid=b.objid AND w.objsubid=b.objsubid WHERE b.pid=$1::integer AND b.granted AND NOT w.granted",
                  [pid],
                )
              ).rows[0].n,
            );
            if (count >= minimum) return;
            await delay(5);
          }
          assert.fail(`actual project mutex did not queue ${minimum} writers`);
        };
        await waiters(1);
        const generation = f.first.store.commitExtensionTurn(
          input,
          activeAuthority,
        );
        void generation.catch(() => {});
        await waiters(2);
        await blocker.query("COMMIT");
        const [metadata, admission] = await Promise.allSettled([
          mutation,
          generation,
        ]);
        assert.equal(metadata.status, "fulfilled");
        assert.ok(admission.status === "rejected");
        assert.match(
          String(admission.reason),
          operation === "archive"
            ? /creative_project_archived/u
            : /creative_project_revision_conflict/u,
        );
        assert.deepEqual(await f.counts(), before);
        assert.equal(
          (await f.credits.getAccount(f.creditScope))?.reservedCredits,
          "0",
        );
        const current = (await f.metadata.loadProject({
          owner,
          projectId: f.reference.projectId,
        }))!;
        assert.equal(current.revision, project.revision + 1);
        assert.equal(
          current.state,
          operation === "archive" ? "archived" : "active",
        );
      } finally {
        await blocker.query("ROLLBACK").catch(() => {});
        await blocker.end();
      }
    },
  );
