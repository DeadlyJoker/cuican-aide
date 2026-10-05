import assert from "node:assert/strict";
import test from "node:test";
import {
  extensionCanonicalJson,
  saveProjectOutlineCandidate,
} from "@crewon/domain";
import {
  textIntentFixture,
  intentAt,
  intentScript,
} from "./project-text-ui-intent.test-support.ts";
import { textDigester, textAt } from "./project-text-store.test-support.ts";
import { selectionRecipe } from "./plugin-installation-store.test-support.ts";
import { SqliteProjectTextUiIntentJournalStore } from "./project-text-ui-intent-sqlite-store.ts";
const error =
  (pattern: RegExp) =>
  (e: unknown): boolean =>
    e instanceof Error &&
    (pattern.test(e.message) ||
      (e.cause !== undefined && error(pattern)(e.cause)));
for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 30000,
  };
  test(
    `${backend} text unknown and accepted intents survive cold reopen; original receipt replay and explicit ACK do not write a second result`,
    options,
    async (t) => {
      const f = await textIntentFixture(t, backend),
        g = f.outline();
      const staged = await f.stage(g);
      assert.equal(staged.phase, "pending");
      assert.equal((await f.pending())?.input.idempotencyKey, "outline-key");
      await assert.rejects(f.ack(staged), /pending/u);
      const cold = await f.reopen();
      assert.deepEqual(await f.pending(cold.journal), staged);
      assert.equal((await f.textCounts()).project_text_mutation_receipts, 0);
      const result = await f.write(g),
        accepted = await f.pending(cold.journal);
      assert.ok(accepted);
      assert.equal(accepted.phase, "accepted");
      assert.equal(accepted.receipt?.artifactId, result.artifact.artifactId);
      assert.equal(accepted.receipt?.artifactRevision, 1);
      assert.equal(
        accepted.receipt?.requestDigest,
        g.actual.receipt.requestDigest,
      );
      assert.ok(!extensionCanonicalJson(accepted.receipt).includes("synopsis"));
      const before = await f.textCounts();
      const replay = await f.write(g);
      assert.equal(replay.disposition, "replayed");
      assert.deepEqual(replay.artifact, result.artifact);
      assert.deepEqual(await f.textCounts(), before);
      assert.deepEqual(await f.pending(cold.journal), accepted);
      await assert.rejects(
        f.text.saveOutlineCandidate(f.actor, g.actual.command as never),
        error(/intent_authority_required/u),
      );
      const ack = await f.ack(accepted, cold.journal);
      assert.equal(ack.disposition, "acknowledged");
      assert.equal(ack.intent.revision, accepted.revision + 1);
      assert.equal(
        (await f.ack(accepted, cold.journal)).disposition,
        "replayed",
      );
      assert.equal(await f.pending(), null);
      await assert.rejects(
        f.text.saveOutlineCandidate(f.actor, g.actual.command as never),
        error(/intent_authority_required/u),
      );
      assert.deepEqual(await f.textCounts(), before);
      await cold.parent.close();
      await assert.rejects(f.pending(cold.journal), /closed/u);
      await f.otherInstallations.commitSelection(
        selectionRecipe(
          f.source.selection,
          "withdraw-completed-journal-source",
          { actor: f.actor, state: "disabled" },
        ),
      );
      await assert.rejects(
        f.textStore.loadMutationReceipt(
          { actor: f.actor, kind: g.actual.kind, receipt: g.actual.receipt },
          g.options,
        ),
        error(/source_changed|selection|pin/u),
      );
    },
  );
  test(
    `${backend} all four actual text actions atomically bind receipt summaries; one unacknowledged intent gates the project`,
    options,
    async (t) => {
      const f = await textIntentFixture(t, backend),
        g = f.outline();
      await f.stage(g);
      await f.write(g);
      await assert.rejects(f.stage(f.outline("new-key", 1)), /unacknowledged/u);
      const accepted = await f.pending();
      assert.ok(accepted);
      await f.ack(accepted);
      const chosen = f.mutation("crewon.project-texts.v1.selectRevision", {
        projectId: f.scope.projectId,
        artifactId: accepted.receipt!.artifactId,
        request: { expectedArtifactRevision: 1, contentRevision: 1 },
        idempotencyKey: "choose",
      });
      await f.stage(chosen);
      const selected = await f.write(chosen);
      const chooseIntent = await f.pending();
      assert.ok(chooseIntent);
      assert.equal(chooseIntent.receipt?.artifactRevision, 2);
      await f.ack(chooseIntent);
      const script = f.mutation("crewon.project-texts.v1.saveScriptCandidate", {
        projectId: f.scope.projectId,
        episodeId: "ep-1",
        request: {
          expectedArtifactRevision: 0,
          briefRevision: 1,
          outline: {
            artifactId: selected.artifact.artifactId,
            contentRevision: 1,
          },
          content: intentScript,
        },
        idempotencyKey: "script",
      });
      await f.stage(script);
      await f.write(script);
      const scriptIntent = await f.pending();
      assert.ok(scriptIntent);
      assert.equal(scriptIntent.receipt?.kind, "save-script");
      await f.ack(scriptIntent);
      const lock = f.mutation("crewon.project-texts.v1.setLocked", {
        projectId: f.scope.projectId,
        artifactId: selected.artifact.artifactId,
        request: { expectedArtifactRevision: 2, locked: true },
        idempotencyKey: "lock",
      });
      await f.stage(lock);
      await f.write(lock);
      const lockIntent = await f.pending();
      assert.ok(lockIntent);
      assert.equal(lockIntent.receipt?.contentRevision, null);
      await f.ack(lockIntent);
      assert.deepEqual(await f.textCounts(), {
        project_text_artifacts: 2,
        project_text_revisions: 2,
        project_text_mutation_receipts: 4,
      });
    },
  );
  test(
    `${backend} original action/body/key and full actor/pin scope cannot be replaced or read through foreign authority`,
    options,
    async (t) => {
      const f = await textIntentFixture(t, backend),
        g = f.outline();
      await f.stage(g);
      const changed = f.mutation(g.actionId, {
        ...(g.input as Record<string, unknown>),
        request: {
          ...(g.input as { request: object }).request,
          expectedArtifactRevision: 1,
        },
      });
      await assert.rejects(f.stage(changed), error(/idempotency_conflict/u));
      for (const scope of [
        { ...f.scope, contributionId: "foreign" },
        { ...f.scope, actor: { ...f.actor, actorId: "other" } },
        {
          ...f.scope,
          installation: {
            ...f.installation,
            selectionRevision: f.installation.selectionRevision + 1,
          },
        },
        { ...f.scope, installation: { ...f.installation, profileId: "other" } },
      ]) {
        const r = f.recovery(
          "getPending",
          { projectId: scope.projectId },
          scope,
        );
        if (
          scope.contributionId === "foreign" ||
          scope.actor.actorId === "other"
        )
          assert.equal(await f.journal.getPending({ scope }, r.options), null);
        else await assert.rejects(f.journal.getPending({ scope }, r.options));
      }
      let getters = 0;
      await assert.rejects(
        f.journal.stage(
          {
            scope: f.scope,
            actionId: g.actionId,
            input: g.input,
            intentId: g.intentId,
            get at() {
              getters++;
              return intentAt;
            },
          },
          g.options,
        ),
      );
      assert.equal(getters, 0);
      assert.deepEqual(await f.pending(), await f.stage(g));
      const current = f.source.selection;
      await f.otherInstallations.commitSelection(
        selectionRecipe(current, "disable-journal", {
          actor: f.actor,
          state: "disabled",
        }),
      );
      await assert.rejects(
        f.pending(),
        error(/pin|selection|enabled|installation|metadata_source_changed/u),
      );
      await assert.rejects(
        f.write(g),
        error(/pin|selection|enabled|installation|metadata_source_changed/u),
      );
      assert.equal((await f.textCounts()).project_text_mutation_receipts, 0);
    },
  );
  test(
    `${backend} deterministic CAS conflict becomes real refusal; ACK cannot permit a late original or HTTP alias commit`,
    options,
    async (t) => {
      const f = await textIntentFixture(t, backend);
      const legacy = f.grant(
        "crewon.project-texts.v1.saveOutlineCandidate",
        f.outline().input,
      );
      await f.text.saveOutlineCandidate(
        f.actor,
        f.outline().actual.command as never,
        legacy.options,
      );
      const g = f.outline("conflicting", 0),
        staged = await f.stage(g);
      await assert.rejects(f.write(g), error(/revision_conflict/u));
      const refused = await f.journal.observeRejected(
        {
          scope: f.scope,
          intentId: staged.intentId,
          at: intentAt,
          code: "project_text_revision_conflict",
        },
        g.options,
      );
      assert.equal(refused.phase, "refused");
      assert.equal(refused.receipt, null);
      await f.ack(refused);
      await assert.rejects(f.write(g), error(/intent_refused/u));
      const recipe = saveProjectOutlineCandidate(
        {
          project: f.project.project,
          brief: f.project.brief,
          artifact: null,
          artifactId: "late-outline",
          actor: f.actor,
          expectedArtifactRevision: 0,
          content: (
            g.actual.command as {
              content: Parameters<
                typeof saveProjectOutlineCandidate
              >[0]["content"];
            }
          ).content,
          at: textAt,
        },
        textDigester,
      );
      await assert.rejects(
        f.textStore.commitCandidate({
          kind: "save-outline",
          actor: f.actor,
          receipt: g.actual.receipt,
          project: f.project.project,
          expectedArtifactRevision: 0,
          artifact: recipe.artifact,
          contentRevision: recipe.contentRevision,
        }),
        error(/intent_authority_required/u),
      );
      const next = f.outline("next-valid", 1);
      await f.stage(next);
      const stillPending = await f.journal.observeRejected(
        {
          scope: f.scope,
          intentId: next.intentId,
          at: intentAt,
          code: "project_text_revision_conflict",
        },
        next.options,
      );
      assert.equal(stillPending.phase, "pending");
      await f.write(next);
      assert.equal((await f.pending())?.phase, "accepted");
    },
  );
  test(
    `${backend} withdrawal after receipt SQL rolls back business and acceptance together; transport failures never refuse`,
    options,
    async (t) => {
      const f = await textIntentFixture(t, backend),
        g = f.outline();
      await f.stage(g);
      if (f.database) {
        f.database.function("withdraw_text_intent", () => {
          g.state.active = false;
          return 0;
        });
        f.database.exec(
          "CREATE TRIGGER withdraw_text_intent AFTER INSERT ON project_text_mutation_receipts BEGIN SELECT withdraw_text_intent(); END;",
        );
      } else
        f.observeTextSql(async (sql) => {
          if (
            sql.startsWith(
              `INSERT INTO "${f.schema}".project_text_mutation_receipts`,
            )
          )
            g.state.active = false;
        });
      await assert.rejects(f.write(g), error(/withdrawn|denied|closed/u));
      assert.deepEqual(await f.textCounts(), {
        project_text_artifacts: 0,
        project_text_revisions: 0,
        project_text_mutation_receipts: 0,
      });
      const pending = await f.pending();
      assert.ok(pending);
      assert.equal(pending.phase, "pending");
      assert.equal(pending.revision, 1);
      await assert.rejects(
        f.journal.observeRejected(
          {
            scope: f.scope,
            intentId: g.intentId,
            at: intentAt,
            code: "AbortError" as never,
          },
          g.options,
        ),
      );
      await assert.rejects(f.ack(pending), /pending/u);
    },
  );
  test(
    `${backend} separate journal migration is fail-closed and does not create Runs, credits or fake installation tables`,
    options,
    async (t) => {
      const f = await textIntentFixture(t, backend),
        before = await f.textCounts();
      await f.journal.migrate();
      assert.deepEqual(await f.textCounts(), before);
      if (f.database)
        await f.execute("DROP INDEX project_text_ui_intents_one_active");
      else
        await f.execute(
          `DROP INDEX ${f.prefix}project_text_ui_intents_one_active`,
        );
      await assert.rejects(f.journal.migrate(), /schema_invalid/u);
      await assert.rejects(f.stage(f.outline()), /schema_invalid/u);
    },
  );
  test(
    `${backend} acknowledged terminal intent is immutable; pending may not be acknowledged by a copied request`,
    options,
    async (t) => {
      const f = await textIntentFixture(t, backend),
        g = f.outline();
      await f.stage(g);
      const pending = await f.pending();
      assert.ok(pending);
      const bad = f.recovery("getPending", { projectId: f.scope.projectId });
      await assert.rejects(
        f.journal.acknowledge(
          {
            scope: f.scope,
            intentId: g.intentId,
            expectedRevision: 1,
            at: intentAt,
          },
          bad.options,
        ),
      );
      await f.write(g);
      const accepted = await f.pending();
      assert.ok(accepted);
      await f.ack(accepted);
      await assert.rejects(
        f.execute(`DELETE FROM ${f.prefix}project_text_ui_intents`),
        /immutable/u,
      );
      const another = f.outline("second", 1);
      await f.stage(another);
      await assert.rejects(
        f.ack({ ...accepted, revision: accepted.revision - 1 }),
        /revision_conflict/u,
      );
      assert.equal((await f.pending())?.intentId, another.intentId);
    },
  );
  test(
    `${backend} confirmed business COMMIT remains accepted after its invocation is withdrawn`,
    options,
    async (t) => {
      const f = await textIntentFixture(t, backend),
        g = f.outline();
      await f.stage(g);
      let receiptWritten = false;
      if (backend === "postgres")
        f.observeTextSql(async (sql) => {
          if (
            sql.startsWith(
              `INSERT INTO "${f.schema}".project_text_mutation_receipts`,
            )
          )
            receiptWritten = true;
          if (receiptWritten && sql.trim() === "COMMIT") g.state.active = false;
        });
      const result = await f.write(g);
      if (backend === "sqlite") g.state.active = false;
      assert.equal(result.disposition, "committed");
      const actual = await f.pending();
      assert.ok(actual);
      assert.equal(actual.phase, "accepted");
      assert.equal(actual.receipt?.artifactId, result.artifact.artifactId);
      await assert.rejects(f.write(g), error(/withdrawn/u));
      assert.equal((await f.textCounts()).project_text_mutation_receipts, 1);
    },
  );
  test(
    `${backend} real journal and receipt evidence views are rejected instead of used as terminal facts`,
    options,
    async (t) => {
      const f = await textIntentFixture(t, backend),
        g = f.outline();
      await f.stage(g);
      const table = "project_text_mutation_receipts";
      await f.execute(
        `ALTER TABLE ${f.prefix}${table} RENAME TO ${table}_owned_original`,
      );
      await f.execute(
        `CREATE VIEW ${f.prefix}${table} AS SELECT * FROM ${f.prefix}${table}_owned_original`,
      );
      await assert.rejects(f.pending(), /schema_invalid/u);
      await assert.rejects(f.journal.migrate(), /schema_invalid/u);
      const rows = await f.query(
        `SELECT phase,revision FROM ${f.prefix}project_text_ui_intents`,
      );
      assert.equal(rows[0]?.phase, "pending");
      assert.equal(Number(rows[0]?.revision), 1);
    },
  );
  test(
    `${backend} marker view cannot impersonate the independent journal`,
    options,
    async (t) => {
      const f = await textIntentFixture(t, backend);
      await f.stage(f.outline());
      if (f.database) {
        await f.execute(
          "ALTER TABLE project_text_ui_intent_schema_version RENAME TO project_text_ui_intent_schema_version_owned",
        );
        await f.execute(
          "CREATE VIEW project_text_ui_intent_schema_version AS SELECT * FROM project_text_ui_intent_schema_version_owned",
        );
      } else {
        await f.execute(
          `ALTER TABLE ${f.prefix}project_text_ui_intent_schema_version RENAME TO project_text_ui_intent_schema_version_owned`,
        );
        await f.execute(
          `CREATE VIEW ${f.prefix}project_text_ui_intent_schema_version AS SELECT * FROM ${f.prefix}project_text_ui_intent_schema_version_owned`,
        );
      }
      await assert.rejects(f.pending(), /schema_invalid/u);
      await assert.rejects(f.journal.migrate(), /schema_invalid/u);
    },
  );
  test(
    `${backend} journal staging and ACK withdrawal roll back only the unconfirmed journal transaction`,
    options,
    async (t) => {
      const f = await textIntentFixture(t, backend),
        g = f.outline();
      const journal = f.database
        ? new SqliteProjectTextUiIntentJournalStore({
            database: f.database,
            assertOpen() {},
          })
        : f.journal;
      if (f.database) {
        f.database.function("withdraw_stage_owner", () => {
          g.state.active = false;
          return 0;
        });
        f.database.exec(
          "CREATE TRIGGER withdraw_stage_owner AFTER INSERT ON project_text_ui_intents BEGIN SELECT withdraw_stage_owner(); END;",
        );
      } else
        g.state.transactionHook = async () => {
          g.state.active = false;
        };
      await assert.rejects(f.stage(g, journal), error(/withdrawn/u));
      assert.equal(
        Number(
          (
            await f.query(
              `SELECT COUNT(*) AS n FROM ${f.prefix}project_text_ui_intents`,
            )
          )[0]?.n,
        ),
        0,
      );
      g.state.active = true;
      g.state.transactionHook = null;
      if (f.database) f.database.exec("DROP TRIGGER withdraw_stage_owner");
      await f.stage(g, journal);
      await f.write(g);
      const accepted = await f.pending();
      assert.ok(accepted);
      const recovery = f.recovery("acknowledge", {
        projectId: f.scope.projectId,
        intentId: g.intentId,
        expectedRevision: accepted.revision,
      });
      if (f.database) {
        f.database.function("withdraw_ack_owner", () => {
          recovery.state.active = false;
          return 0;
        });
        f.database.exec(
          "CREATE TRIGGER withdraw_ack_owner AFTER UPDATE ON project_text_ui_intents WHEN NEW.acknowledged=1 BEGIN SELECT withdraw_ack_owner(); END;",
        );
      } else
        recovery.state.transactionHook = async () => {
          recovery.state.active = false;
        };
      await assert.rejects(
        journal.acknowledge(
          {
            scope: f.scope,
            intentId: g.intentId,
            expectedRevision: accepted.revision,
            at: intentAt,
          },
          recovery.options,
        ),
        error(/withdrawn/u),
      );
      const stillAccepted = await f.pending();
      assert.deepEqual(stillAccepted, accepted);
      assert.equal((await f.textCounts()).project_text_mutation_receipts, 1);
    },
  );
}

test(
  "postgres real receipt-lock waiter observes accepted COMMIT instead of falsely refusing an in-flight write",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 30000 },
  async (t) => {
    const f = await textIntentFixture(t, "postgres"),
      g = f.outline();
    await f.stage(g);
    const cold = await f.reopen();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
      }),
      released = new Promise<void>((resolve) => {
        release = resolve;
      });
    let gated = false;
    f.observeTextSql(async (sql) => {
      if (
        !gated &&
        sql.startsWith(
          `INSERT INTO "${f.schema}".project_text_mutation_receipts`,
        )
      ) {
        gated = true;
        enter();
        await released;
      }
    });
    t.after(() => release());
    const write = f.track(f.write(g));
    await entered;
    const originalPid = f.metadataPid;
    assert.ok(originalPid);
    const options = {
      authority: {
        ...g.authority,
        assertCurrent: async () => {
          if (!g.state.active) throw new Error("metadata_invocation_withdrawn");
        },
      },
    };
    const observe = f.track(
      cold.journal.observeRejected(
        {
          scope: f.scope,
          intentId: g.intentId,
          at: intentAt,
          code: "project_text_revision_conflict",
        },
        options,
      ),
    );
    let waiter: number | null = null;
    for (let i = 0; i < 100; i++) {
      const rows = await f.query(
        "SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))",
        [originalPid],
      );
      if (rows.length > 0) {
        waiter = Number(rows[0]?.pid);
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(
      waiter,
      "actual pg_blocking_pids must identify the owned receipt-lock waiter",
    );
    release();
    const [result, observed] = await Promise.all([write, observe]);
    assert.equal(result.disposition, "committed");
    assert.equal(observed.phase, "accepted");
    assert.equal(observed.receipt?.artifactId, result.artifact.artifactId);
    assert.equal((await f.textCounts()).project_text_mutation_receipts, 1);
  },
);

test(
  "postgres journal ACK returns confirmed durable result even when owner withdraws after physical COMMIT",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 30000 },
  async (t) => {
    const f = await textIntentFixture(t, "postgres"),
      g = f.outline();
    await f.stage(g);
    await f.write(g);
    const accepted = await f.pending();
    assert.ok(accepted);
    const r = f.recovery("acknowledge", {
      projectId: f.scope.projectId,
      intentId: g.intentId,
      expectedRevision: accepted.revision,
    });
    const gate = f.arm("commit");
    const result = f.track(
      f.journal.acknowledge(
        {
          scope: f.scope,
          intentId: g.intentId,
          expectedRevision: accepted.revision,
          at: intentAt,
        },
        r.options,
      ),
    );
    await gate.entered.promise;
    const durable = (
      await f.query(
        `SELECT acknowledged,revision FROM ${f.prefix}project_text_ui_intents WHERE intent_id=$1`,
        [g.intentId],
      )
    )[0];
    assert.equal(Number(durable?.acknowledged), 1);
    r.state.active = false;
    gate.resume.resolve();
    const confirmed = await result;
    assert.equal(confirmed.disposition, "acknowledged");
    assert.equal(confirmed.intent.revision, accepted.revision + 1);
    assert.equal(await f.pending(), null);
  },
);
