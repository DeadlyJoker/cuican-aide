import assert from "node:assert/strict";
import { test } from "node:test";
import { unmeteredFixture } from "./plugin-task-unmetered.test-support.ts";
import { conversationFixture } from "./project-conversation-store.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: absent opt-in schema is a read-only legacy routing check`,
    options,
    async (t) => {
      const f = await unmeteredFixture(t, backend),
        store = f.first.parent.projectConversationStore();
      const catalog = () =>
        f.rows(
          backend === "sqlite"
            ? "SELECT name,type FROM sqlite_schema ORDER BY name"
            : `SELECT relname,relkind FROM pg_catalog.pg_class WHERE relnamespace='${f.prefix.slice(1, -2)}'::regnamespace ORDER BY relname`,
        );
      const before = await catalog();
      assert.equal(
        await store.hasThreadBinding({
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          threadId: f.command().threadId,
        }),
        false,
      );
      assert.equal(
        await store.loadStageAdmission({
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          runId: "legacy-not-staged",
        }),
        null,
      );
      assert.deepEqual(await catalog(), before);
    },
  );
  test(
    `${backend}: original immutable markers refuse fallback when independent history tables are removed`,
    options,
    async (t) => {
      const f = await conversationFixture(t, backend),
        p = await f.prepare();
      await f.store.commitBinding(p, { authority: f.authority });
      const result = await f.tasks.createProjectConversationTurnFromHost(
        f.actor,
        {
          pluginId: f.pin.pluginId,
          threadId: p.binding.threadId,
          expectedThreadRevision: 1,
          idempotencyKey: "persistent-stage-marker",
          intent: { kind: "generate", input: { prompt: "Saved discussion" } },
        },
        {
          binding: p.binding,
          stage: { kind: "discussion" },
          sources: { brief: null, outline: null },
          content: "Saved discussion",
          authority: f.authority,
          conversations: f.store,
        },
      );
      const locator = {
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        runId: result.result.binding.runId,
      };
      const digest = await f.store.readRequiredStageDigest(locator);
      assert.ok(digest);
      await assert.rejects(
        f.rows(
          `UPDATE ${f.prefix}threads SET project_conversation_binding_id=NULL WHERE thread_id='${p.binding.threadId}'`,
        ),
        /project_conversation_marker_immutable/u,
      );
      await assert.rejects(
        f.rows(
          `UPDATE ${f.prefix}plugin_task_admissions SET project_stage_digest=NULL`,
        ),
        /immutable/u,
      );
      for (const table of [
        "project_stage_run_admissions",
        "project_conversation_receipts",
        "project_conversation_bindings",
        "project_conversation_schema_version",
      ])
        await f.rows(
          `DROP TABLE ${f.prefix}${table}${backend === "postgres" ? " CASCADE" : ""}`,
        );
      assert.equal(await f.store.readRequiredStageDigest(locator), digest);
      await assert.rejects(
        f.store.hasThreadBinding({
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          threadId: p.binding.threadId,
        }),
        /binding_corrupt/u,
      );
      await assert.rejects(
        f.store.loadStageAdmission(locator),
        /project_stage_marker_invalid/u,
      );
    },
  );
  test(
    `${backend}: view substitution, missing immutable trigger and unknown schema version fail closed`,
    options,
    async (t) => {
      const f = await conversationFixture(t, backend),
        p = await f.prepare();
      await f.store.commitBinding(p, { authority: f.authority });
      await f.rows(
        `ALTER TABLE ${f.prefix}project_conversation_bindings RENAME TO actual_bindings`,
      );
      await f.rows(
        `CREATE VIEW ${f.prefix}project_conversation_bindings AS SELECT * FROM ${f.prefix}actual_bindings`,
      );
      await assert.rejects(
        f.store.loadBinding({ ...f.owner, threadId: p.binding.threadId }),
        /schema_incomplete/u,
      );
      await f.rows(`DROP VIEW ${f.prefix}project_conversation_bindings`);
      await f.rows(
        `ALTER TABLE ${f.prefix}actual_bindings RENAME TO project_conversation_bindings`,
      );
      await f.rows(
        backend === "sqlite"
          ? "DROP TRIGGER project_stage_run_admissions_no_delete"
          : `DROP TRIGGER project_stage_run_admissions_immutable ON ${f.prefix}project_stage_run_admissions`,
      );
      await assert.rejects(
        f.store.loadBinding({ ...f.owner, threadId: p.binding.threadId }),
        /schema_incomplete/u,
      );
      await f.store.migrate();
      await f.rows(`DROP TABLE ${f.prefix}project_conversation_schema_version`);
      await f.rows(
        `CREATE TABLE ${f.prefix}project_conversation_schema_version(id INTEGER PRIMARY KEY,version INTEGER NOT NULL)`,
      );
      await f.rows(
        `INSERT INTO ${f.prefix}project_conversation_schema_version VALUES(1,2)`,
      );
      await assert.rejects(f.store.migrate(), /schema_version_unsupported/u);
      assert.equal(
        Number(
          (
            await f.rows(
              `SELECT version FROM ${f.prefix}project_conversation_schema_version`,
            )
          )[0]?.version,
        ),
        2,
      );
    },
  );
}
