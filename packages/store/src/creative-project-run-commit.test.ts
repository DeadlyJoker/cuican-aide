import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool, type PoolClient } from "pg";
import {
  ProjectTextApplicationService,
  type CreativeProjectRunCommitTransactionAuthority,
} from "@crewon/application";
import { selectionRecipe } from "./plugin-installation-store.test-support.ts";
import { PostgresProjectTextStore } from "./project-text-postgres-store.ts";
import { projectRunCommitFixture } from "./creative-project-run-commit.test-support.ts";

const outline = {
  title: "雨夜",
  logline: "一封未寄出的信",
  synopsis: "修复师追查雨夜谜题。",
  episodes: [{ episodeId: "episode-1", title: "来信", summary: "发现旧信。" }],
};
const script = {
  title: "来信",
  scenes: [
    {
      sceneId: "scene-1",
      location: "工作室",
      timeOfDay: "夜",
      action: "拆开信封。",
      dialogue: [{ speaker: "修复师", text: "这不是我的笔迹。" }],
    },
  ],
};
const rejected = (error: unknown): boolean =>
  error instanceof Error &&
  (/creative_project_run_|project_tool_test_|authorization_denied|plugin_installation_pin_/u.test(
    error.message,
  ) ||
    (error.cause !== undefined && rejected(error.cause)));

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 30000,
  };
  test(
    `${backend} genuine Run/Tool qualifies project and text commands, immutable replay and selection/lock`,
    options,
    async (t) => {
      const f = await projectRunCommitFixture(t, backend);
      const create = await f.prepareOperation("project_create", {
        title: "Agent 项目",
        briefText: "在雨夜寻找未寄出的信。",
      });
      const first = await f.projects.createProject(
        f.actor,
        create.commandBody as never,
        create.options,
      );
      assert.equal(first.disposition, "committed");
      const repeat = await f.projects.createProject(
        f.actor,
        create.commandBody as never,
        create.options,
      );
      assert.equal(repeat.disposition, "replayed");
      assert.deepEqual(repeat.project, first.project);
      assert.deepEqual(repeat.brief, first.brief);
      const brief = await f.prepareOperation("brief_append", {
        projectId: first.project.projectId,
        expectedProjectRevision: first.project.revision,
        text: "三集悬疑，保持雨夜场景。",
      });
      const appended = await f.projects.appendBrief(
        f.actor,
        brief.commandBody as never,
        brief.options,
      );
      const save = await f.prepareOperation("outline_save", {
        projectId: first.project.projectId,
        expectedArtifactRevision: 0,
        briefRevision: appended.brief.briefRevision,
        content: outline,
      });
      const saved = await f.text.saveOutlineCandidate(
        f.actor,
        save.commandBody as never,
        save.options,
      );
      const select = await f.prepareOperation("text_select", {
        projectId: first.project.projectId,
        artifactId: saved.artifact.artifactId,
        expectedArtifactRevision: saved.artifact.revision,
        contentRevision: 1,
      });
      const selected = await f.text.selectRevision(
        f.actor,
        select.commandBody as never,
        select.options,
      );
      const lock = await f.prepareOperation("text_lock", {
        projectId: first.project.projectId,
        artifactId: saved.artifact.artifactId,
        expectedArtifactRevision: selected.artifact.revision,
        locked: true,
      });
      const locked = await f.text.setLocked(
        f.actor,
        lock.commandBody as never,
        lock.options,
      );
      const later = await f.prepareOperation("outline_save", {
        projectId: first.project.projectId,
        expectedArtifactRevision: locked.artifact.revision,
        briefRevision: appended.brief.briefRevision,
        content: { ...outline, synopsis: "新增候选不能覆盖锁定成果。" },
      });
      const candidate = await f.text.saveOutlineCandidate(
        f.actor,
        later.commandBody as never,
        later.options,
      );
      assert.equal(candidate.artifact.locked, true);
      assert.equal(candidate.artifact.selectedContentRevision, 1);
      const imported = await f.prepareOperation("script_save", {
        projectId: first.project.projectId,
        episodeId: "episode-import",
        expectedArtifactRevision: 0,
        briefRevision: appended.brief.briefRevision,
        content: script,
      });
      const importedBody = { ...imported.commandBody, outline: null };
      const importedResult = await f.text.saveScriptCandidate(
        f.actor,
        importedBody as never,
        imported.options,
      );
      assert.equal(importedResult.contentRevision?.outline, null);
      const counts = await f.counts();
      assert.equal(counts.extension_external_operations, 0);
      assert.equal(counts.project_text_revisions, 3);
      assert.deepEqual(await f.creditObjects(), []);
      assert.equal(
        (await f.parent.loadRun(f.locator))?.revision,
        create.run.revision,
      );
    },
  );

  test(
    `${backend} actual Tool input, Run, principal, installation, digest and lease reject altered qualification`,
    options,
    async (t) => {
      const f = await projectRunCommitFixture(t, backend);
      const op = await f.prepareOperation("outline_save", {
        projectId: f.reference.projectId,
        expectedArtifactRevision: 0,
        briefRevision: 1,
        content: outline,
      });
      const before = await f.counts();
      const attempt = (
        transaction: CreativeProjectRunCommitTransactionAuthority,
        body: Record<string, unknown> = op.commandBody,
      ) =>
        f.text.saveOutlineCandidate(f.actor, body as never, {
          authority: { ...op.options.authority!, runTransaction: transaction },
        });
      const bad = [
        {
          ...op.transaction,
          actor: { ...f.actor, principalId: "foreign-principal" },
        },
        { ...op.transaction, run: { ...op.run, runId: "foreign-run" } },
        {
          ...op.transaction,
          installation: {
            ...op.transaction.installation,
            packageDigest: `sha256:${"f".repeat(64)}`,
          },
        },
        {
          ...op.transaction,
          commandInput: JSON.stringify({
            ...(op.request as object),
            expectedArtifactRevision: 1,
          }),
        },
        {
          ...op.transaction,
          receipt: { ...op.receipt, actionDigest: `sha256:${"f".repeat(64)}` },
        },
        {
          ...op.transaction,
          claim: {
            ...op.claim,
            lease: { ...op.claim.lease, leaseId: "foreign-lease" },
          },
        },
        { ...op.transaction, operationId: "script_save" as const },
      ];
      for (const changed of bad)
        await assert.rejects(
          attempt(changed),
          (error) => error instanceof Error,
        );
      await assert.rejects(
        attempt(op.transaction, {
          ...op.commandBody,
          content: { ...outline, title: "改写输入" },
        }),
        (error) => error instanceof Error,
      );
      let getterCalls = 0;
      const getter = { ...op.transaction };
      Object.defineProperty(getter, "commandInput", {
        enumerable: true,
        get: () => {
          getterCalls++;
          return op.transaction.commandInput;
        },
      });
      await assert.rejects(attempt(getter), (error) => error instanceof Error);
      assert.equal(getterCalls, 0);
      assert.deepEqual(await f.counts(), before);
    },
  );

  test(
    `${backend} same-key publication requires current original installation, live owner and actual scheduling lease`,
    options,
    async (t) => {
      const f = await projectRunCommitFixture(t, backend);
      const op = await f.prepareOperation("outline_save", {
        projectId: f.reference.projectId,
        expectedArtifactRevision: 0,
        briefRevision: 1,
        content: outline,
      });
      const first = await f.text.saveOutlineCandidate(
        f.actor,
        op.commandBody as never,
        op.options,
      );
      const before = await f.counts();
      f.state.policy = false;
      await assert.rejects(
        f.text.saveOutlineCandidate(
          f.actor,
          op.commandBody as never,
          op.options,
        ),
        rejected,
      );
      f.state.policy = true;
      f.state.live = false;
      await assert.rejects(
        f.text.saveOutlineCandidate(
          f.actor,
          op.commandBody as never,
          op.options,
        ),
        rejected,
      );
      f.state.live = true;
      const renewed = await f.parent.renewWorkItemLease({
        ...f.lease,
        leaseDurationMs: 300000,
      });
      assert.ok(
        Date.parse(renewed.expiresAt) >= Date.parse(op.claim.lease.expiresAt),
      );
      const replay = await f.text.saveOutlineCandidate(
        f.actor,
        op.commandBody as never,
        op.options,
      );
      assert.equal(replay.disposition, "replayed");
      assert.deepEqual(replay.artifact, first.artifact);
      await f.installs.commitSelection(
        selectionRecipe(f.enabled.selection, "actual-disable", {
          actor: f.actor,
          state: "disabled",
        }),
      );
      await assert.rejects(
        f.text.saveOutlineCandidate(
          f.actor,
          op.commandBody as never,
          op.options,
        ),
        rejected,
      );
      assert.deepEqual(await f.counts(), before);
    },
  );

  test(
    `${backend} evidence views cannot replace real persisted Tool tables`,
    options,
    async (t) => {
      const f = await projectRunCommitFixture(t, backend);
      const op = await f.prepareOperation("outline_save", {
        projectId: f.reference.projectId,
        expectedArtifactRevision: 0,
        briefRevision: 1,
        content: outline,
      });
      const before = await f.counts();
      if (backend === "sqlite") {
        await f.sql(
          "CREATE TEMP VIEW run_steps AS SELECT * FROM main.run_steps",
        );
        // Qualification uses the parent connection, so create a view on its own shared database catalog instead.
        await f.sql("DROP VIEW temp.run_steps");
      }
      await f.sql(`ALTER TABLE ${f.prefix}run_steps RENAME TO run_steps_real`);
      await f.sql(
        `CREATE VIEW ${f.prefix}run_steps AS SELECT * FROM ${f.prefix}run_steps_real`,
      );
      try {
        await assert.rejects(
          f.text.saveOutlineCandidate(
            f.actor,
            op.commandBody as never,
            op.options,
          ),
          (error) =>
            error instanceof Error &&
            error.cause instanceof Error &&
            error.cause.message ===
              "creative_project_run_commit_schema_invalid",
        );
      } finally {
        await f.sql(`DROP VIEW ${f.prefix}run_steps`);
        await f.sql(
          `ALTER TABLE ${f.prefix}run_steps_real RENAME TO run_steps`,
        );
      }
      assert.deepEqual(await f.counts(), before);
    },
  );

  test(
    `${backend} retired Store and replaced queue lease recover the same original receipt without a second write`,
    options,
    async (t) => {
      const f = await projectRunCommitFixture(t, backend);
      const op = await f.prepareOperation("outline_save", {
        projectId: f.reference.projectId,
        expectedArtifactRevision: 0,
        briefRevision: 1,
        content: outline,
      });
      const first = await f.text.saveOutlineCandidate(
        f.actor,
        op.commandBody as never,
        op.options,
      );
      const unknown = await f.parent.transitionToolExecution({
        ...f.locator,
        receiptId: op.receipt.receiptId,
        lease: f.lease,
        expectedRevision: op.receipt.revision,
        transition: {
          kind: "unknownOutcome",
          providerReceiptId: null,
          occurredAt: new Date().toISOString(),
        },
      });
      // Scheduling retirement uses the original public queue port; no clock/DB fact is fabricated.
      await f.parent.retryWorkItem({
        ...f.lease,
        retryAfterMs: 0,
        reasonCode: "named-owner-retired",
      });
      await f.parent.close();
      const next = f.second.parent;
      const claim = await next.claimNextWorkItem({
        ownerId: "new-project-worker",
        leaseId: "new-project-lease",
        leaseDurationMs: 300000,
      });
      assert.ok(claim);
      assert.ok(claim.lease.epoch > op.claim.lease.epoch);
      const lease = {
        workItemId: claim.workItem.workItemId,
        ownerId: claim.lease.ownerId,
        leaseId: claim.lease.leaseId,
        leaseEpoch: claim.lease.epoch,
      };
      await next.beginRunAttempt({
        ...f.locator,
        lease,
        stepId: unknown.stepId,
        attemptId: "new-recovery-attempt",
        kind: "tool",
        startedAt: new Date().toISOString(),
      });
      const run = await next.loadRun(f.locator);
      assert.ok(run);
      const service = new ProjectTextApplicationService({
        store: next.projectTextStore(),
        projects: next.creativeProjectStore(),
        authorization: { authorize: async () => ({ outcome: "allow" }) },
        clock: { now: () => new Date().toISOString() },
        ids: {
          nextId: () => assert.fail("replay cannot allocate an artifact"),
        },
        digester: f.digester,
      });
      const before = await f.counts();
      await assert.rejects(
        service.saveOutlineCandidate(
          f.actor,
          op.commandBody as never,
          op.options,
        ),
        rejected,
      );
      const transaction = { ...op.transaction, run, receipt: unknown, claim };
      const recovered = await service.saveOutlineCandidate(
        f.actor,
        op.commandBody as never,
        {
          authority: { ...op.options.authority!, runTransaction: transaction },
        },
      );
      assert.equal(recovered.disposition, "replayed");
      assert.deepEqual(recovered.artifact, first.artifact);
      assert.deepEqual(recovered.contentRevision, first.contentRevision);
      assert.deepEqual(await f.counts(), before);
      assert.deepEqual(await f.creditObjects(), []);
    },
  );
}

test(
  "postgres transaction policy withdrawal rolls back actual text INSERT; confirmed COMMIT remains successful",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 30000 },
  async (t) => {
    for (const phase of ["receipt", "committed"] as const) {
      const f = await projectRunCommitFixture(t, "postgres");
      assert.ok(f.schema);
      const op = await f.prepareOperation("outline_save", {
        projectId: f.reference.projectId,
        expectedArtifactRevision: 0,
        briefRevision: 1,
        content: outline,
      });
      const original = new Pool({
        connectionString: process.env.CREWON_TEST_POSTGRES_URL,
        max: 1,
      });
      let borrowed = 0,
        closed = false,
        observed = false,
        inserted = false;
      t.after(async () => {
        assert.equal(borrowed, 0);
        await original.end();
      });
      const pool = new Proxy(original, {
        get(target, key) {
          if (key === "connect")
            return async () => {
              const client = await target.connect();
              borrowed++;
              return new Proxy(client, {
                get(connection, property) {
                  if (property === "query")
                    return async (sql: string, values?: unknown[]) => {
                      const result = await connection.query(sql, values);
                      if (
                        sql.startsWith(
                          `INSERT INTO ${f.prefix}project_text_mutation_receipts`,
                        )
                      )
                        inserted = true;
                      if (
                        phase === "receipt"
                          ? inserted
                          : inserted && sql === "COMMIT"
                      ) {
                        observed = true;
                        if (phase === "receipt") f.state.policy = false;
                        else {
                          f.state.live = false;
                          closed = true;
                        }
                      }
                      return result;
                    };
                  if (property === "release")
                    return () => {
                      borrowed--;
                      connection.release();
                    };
                  const value: unknown = Reflect.get(
                    connection,
                    property,
                    connection,
                  );
                  return typeof value === "function"
                    ? value.bind(connection)
                    : value;
                },
              }) as PoolClient;
            };
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const store = new PostgresProjectTextStore({
        pool,
        schema: f.schema,
        assertOpen: () => {
          if (closed) throw new Error("owned-host-closed");
        },
      });
      const service = new ProjectTextApplicationService({
        store,
        projects: f.metadata,
        authorization: {
          authorize: async () =>
            f.state.policy
              ? { outcome: "allow" }
              : { outcome: "deny", reasonCode: "withdrawn" },
        },
        clock: { now: () => new Date().toISOString() },
        ids: { nextId: () => "fresh-artifact" },
        digester: f.digester,
      });
      const before = await f.counts();
      const pending = service.saveOutlineCandidate(
        f.actor,
        op.commandBody as never,
        op.options,
      );
      if (phase === "receipt") {
        await assert.rejects(pending, (error) => error instanceof Error);
        assert.deepEqual(await f.counts(), before);
      } else {
        const result = await pending;
        assert.equal(result.disposition, "committed");
        assert.equal(
          (await f.counts()).project_text_revisions,
          before.project_text_revisions! + 1,
        );
      }
      assert.equal(observed, true);
      assert.equal(borrowed, 0);
    }
  },
);
