import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client, Pool } from "pg";
import {
  extensionCanonicalJson,
  type PluginUiIntentKind,
} from "@crewon/domain";
import {
  intentJournalFixture,
  intentAuthority,
  intentReceipt,
  intentVerifier,
  assertIntentJournalGuardTamper,
  timestamp,
} from "./plugin-ui-intent-journal.test-support.ts";
import { selectionRecipe } from "./plugin-installation-store.test-support.ts";
import { SqlitePluginUiIntentJournalStore } from "./sqlite-plugin-ui-intent-journal-store.ts";
import { PostgresPluginUiIntentJournalStore } from "./postgres-plugin-ui-intent-journal-store.ts";
const options = { authority: intentAuthority };
for (const backend of ["sqlite", "postgres"] as const) {
  const run =
    backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL
      ? test.skip
      : test;
  run(
    `${backend}: verified query non-admission preserves the exact dispatch CAS and survives reopen`,
    async (t) => {
      const f = await intentJournalFixture(t, backend),
        input = f.input("query", "stale-query");
      const staged = await f.first.store.stageUiIntent(input, options);
      for (let i = 0; i < 2; i++)
        await f.first.store.markUiIntentDispatched(
          { ...input, intentId: staged.intent.intentId },
          options,
        );
      const command = {
        account: f.account(),
        intentId: staged.intent.intentId,
        requestDigest: staged.intent.requestDigest,
        expectedDispatchAttemptCount: 1,
        reasonCode: "project_query_revision_not_admitted" as const,
        at: timestamp,
      };
      assert.equal(
        (await f.first.store.refuseUiIntentUnadmittedQuery!(command)).phase,
        "dispatched",
      );
      assert.equal(
        (
          await f.first.store.refuseUiIntentUnadmittedQuery!({
            ...command,
            expectedDispatchAttemptCount: 2,
          })
        ).phase,
        "refused",
      );
      const [saved] = await f.second.store.listUiIntentHints({
        account: f.account(),
      });
      assert.equal(saved?.phase, "refused");
      assert.equal(saved?.dispatchAttemptCount, 2);
      assert.equal(saved?.requestJson, staged.intent.requestJson);
    },
  );
  run(
    `${backend}: journal construction is default-off and migration persists a trusted realm without changing old schemas`,
    async (t) => {
      const f = await intentJournalFixture(t, backend, false),
        before = await f.query(
          backend === "sqlite"
            ? "SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name"
            : `SELECT table_name FROM information_schema.tables WHERE table_schema='${f.schema}' ORDER BY table_name`,
        );
      assert.equal(f.first.store.uiIntentJournalVersion, undefined);
      assert.equal(f.first.store.uiIntentJournalRealmId, undefined);
      await assert.rejects(
        () =>
          f.first.store.listUiIntentHints({
            account: { ...f.account(), controlRealmId: "unknown" },
          }),
        /reads_not_enabled/,
      );
      await f.first.store.migratePluginUiIntentJournal();
      const realm = f.first.store.uiIntentJournalRealmId;
      assert.ok(realm);
      await f.first.store.migratePluginUiIntentJournal();
      assert.equal(f.first.store.uiIntentJournalRealmId, realm);
      await f.second.store.enablePluginUiIntentJournalReads();
      assert.equal(f.second.store.uiIntentJournalRealmId, realm);
      assert.equal(f.second.store.uiIntentJournalVersion, undefined);
      await assert.rejects(
        () => f.second.store.stageUiIntent(f.input(), options),
        /not_enabled/,
      );
      const after = await f.query(
        backend === "sqlite"
          ? "SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name"
          : `SELECT table_name FROM information_schema.tables WHERE table_schema='${f.schema}' ORDER BY table_name`,
      );
      const journalNames = new Set([
        "plugin_ui_intent_schema_version",
        "plugin_ui_intent_accounts",
        "plugin_ui_intents",
      ]);
      assert.deepEqual(
        after.filter((r) => !journalNames.has(String(r.name ?? r.table_name))),
        before,
      );
    },
  );
  run(
    `${backend}: cold new process restores all exact prepared/dispatched lanes and never sends business commands`,
    async (t) => {
      const f = await intentJournalFixture(t, backend),
        saved = [];
      for (const kind of ["generation", "query", "selection"] as const) {
        const input = f.input(kind, `cold-${kind}`),
          staged = await f.first.store.stageUiIntent(input, options);
        if (kind !== "generation")
          await f.first.store.markUiIntentDispatched(
            { ...input, intentId: staged.intent.intentId },
            options,
          );
        saved.push(input.requestJson);
      }
      await f.first.parent.close();
      await f.second.parent.close();
      const moduleUrl =
        backend === "sqlite"
          ? new URL("./sqlite-run-store.ts", import.meta.url).href
          : new URL("./postgres-domain-store.ts", import.meta.url).href;
      const helperUrl = new URL(
        "./plugin-ui-intent-journal.test-support.ts",
        import.meta.url,
      ).href;
      const script = `import {${backend === "sqlite" ? "SqliteRunStore" : "PostgresDomainStore"}} from ${JSON.stringify(moduleUrl)};import {intentVerifier} from ${JSON.stringify(helperUrl)};const config=JSON.parse(process.env.CREWON_INTENT_RESTART_INPUT);const parent=${backend === "sqlite" ? "new SqliteRunStore(config.path)" : "await PostgresDomainStore.open({connectionString:process.env.CREWON_TEST_POSTGRES_URL,schema:config.schema,maxPoolSize:1})"};try{const store=parent.pluginUiIntentJournalStore({verifier:intentVerifier});await store.enablePluginUiIntentJournalReads();process.stdout.write(JSON.stringify({realm:store.uiIntentJournalRealmId,write:store.uiIntentJournalVersion??null,hints:await store.listUiIntentHints({account:config.account})}));}finally{await parent.close();}`;
      const result = await promisify(execFile)(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "--eval", script],
        {
          env: {
            ...process.env,
            CREWON_INTENT_RESTART_INPUT: JSON.stringify({
              path: f.path,
              schema: f.schema,
              account: f.account(),
            }),
          },
          timeout: 15000,
        },
      );
      const cold = JSON.parse(result.stdout);
      assert.equal(cold.realm, f.account().controlRealmId);
      assert.equal(cold.write, null);
      assert.equal(cold.hints.length, 3);
      assert.deepEqual(
        cold.hints.map((x: { requestJson: string }) => x.requestJson).sort(),
        saved.sort(),
      );
      assert.deepEqual(
        cold.hints.map((x: { phase: string }) => x.phase),
        ["dispatched", "dispatched", "prepared"],
      );
      assert.deepEqual(
        cold.hints.map(
          (x: { dispatchAttemptCount: number }) => x.dispatchAttemptCount,
        ),
        [1, 1, 0],
      );
      const rows = await f.query(
        `SELECT phase,dispatch_attempt_count FROM ${f.prefix}plugin_ui_intents ORDER BY sequence`,
      );
      assert.deepEqual(
        rows.map((r) => Number(r.dispatch_attempt_count)),
        [0, 1, 1],
      );
      assert.equal(
        Number(
          (
            await f.query(
              `SELECT COUNT(*) AS count FROM ${f.prefix}run_snapshots`,
            )
          )[0]?.count,
        ),
        0,
      );
    },
  );
  run(
    `${backend}: same-key immutable replay and cross-tab unresolved family gate prevent a delayed old request being bypassed`,
    async (t) => {
      const f = await intentJournalFixture(t, backend),
        input = f.input("query"),
        [a, b] = await Promise.all([
          f.first.store.stageUiIntent(input, options),
          f.second.store.stageUiIntent(input, options),
        ]);
      assert.equal(a.intent.intentId, b.intent.intentId);
      assert.deepEqual([a.disposition, b.disposition].sort(), [
        "created",
        "replayed",
      ]);
      await assert.rejects(
        () =>
          f.second.store.stageUiIntent(
            f.input("query", "new-query-key"),
            options,
          ),
        /family_unresolved/,
      );
      const changed = {
        ...input,
        requestJson: input.requestJson.replace(
          '"expectedThreadRevision":1',
          '"expectedThreadRevision":2',
        ),
      };
      await assert.rejects(
        () => f.second.store.stageUiIntent(changed, options),
        /replay_mismatch/,
      );
      await assert.rejects(
        () =>
          f.second.store.markUiIntentDispatched(
            { ...input, intentId: "intent-not-staged" },
            options,
          ),
        /stage_required/,
      );
      const [first, second] = await Promise.all([
        f.first.store.markUiIntentDispatched(
          { ...input, intentId: a.intent.intentId },
          options,
        ),
        f.second.store.markUiIntentDispatched(
          { ...input, intentId: a.intent.intentId },
          options,
        ),
      ]);
      assert.deepEqual(
        [first.dispatchAttemptCount, second.dispatchAttemptCount].sort(),
        [1, 2],
      );
      assert.equal(
        (await f.first.store.listUiIntentHints({ account: f.account() }))[0]
          ?.dispatchAttemptCount,
        2,
      );
    },
  );
  run(
    `${backend}: only a durable single first selection conflict is refused; earlier UNKNOWN and generation/query cannot be refused`,
    async (t) => {
      const f = await intentJournalFixture(t, backend),
        input = f.input(),
        stage = await f.first.store.stageUiIntent(input, options);
      await f.first.store.markUiIntentDispatched(
        { ...input, intentId: stage.intent.intentId },
        options,
      );
      const refuse = {
        account: f.account(),
        intentId: stage.intent.intentId,
        requestDigest: stage.intent.requestDigest,
        expectedDispatchAttemptCount: 1 as const,
        reasonCode: "concept_selection_revision_conflict",
        at: timestamp,
      };
      await f.second.store.markUiIntentDispatched(
        { ...input, intentId: stage.intent.intentId },
        options,
      );
      assert.equal(
        (await f.first.store.refuseUiIntentFirstDispatch(refuse)).phase,
        "dispatched",
      );
      const other = {
          ...f.input("selection", "fresh-selection-key"),
          sourcePin: { ...f.pin(), contributionId: "other-workbench" },
        },
        fresh = await f.first.store.stageUiIntent(other, options);
      await f.first.store.markUiIntentDispatched(
        { ...other, intentId: fresh.intent.intentId },
        options,
      );
      assert.equal(
        (
          await f.first.store.refuseUiIntentFirstDispatch({
            ...refuse,
            intentId: fresh.intent.intentId,
            requestDigest: fresh.intent.requestDigest,
          })
        ).phase,
        "refused",
      );
      await f.second.store.stageUiIntent(
        {
          ...other,
          requestJson: other.requestJson.replace(
            "fresh-selection-key",
            "after-refresh-key",
          ),
        },
        options,
      );
      for (const kind of ["generation", "query"] as const) {
        const recipe = f.input(kind),
          staged = await f.first.store.stageUiIntent(recipe, options);
        await f.first.store.markUiIntentDispatched(
          { ...recipe, intentId: staged.intent.intentId },
          options,
        );
        await assert.rejects(
          () =>
            f.first.store.refuseUiIntentFirstDispatch({
              ...refuse,
              intentId: staged.intent.intentId,
              requestDigest: staged.intent.requestDigest,
            }),
          /refusal_unsupported/,
        );
      }
    },
  );
  run(
    `${backend}: accepted is sticky, paired logical replay preserves the first receipt, and a failed independent finalize remains unresolved`,
    async (t) => {
      const f = await intentJournalFixture(t, backend),
        input = f.input(),
        staged = await f.first.store.stageUiIntent(input, options);
      await f.first.store.markUiIntentDispatched(
        { ...input, intentId: staged.intent.intentId },
        options,
      );
      const finalize = {
        account: f.account(),
        intentId: staged.intent.intentId,
        requestDigest: staged.intent.requestDigest,
        receiptJson: intentReceipt("selection"),
        at: timestamp,
      };
      await assert.rejects(() =>
        f.first.store.confirmUiIntentAccepted({
          ...finalize,
          receiptJson: finalize.receiptJson.replace(
            '"resultIndex":0',
            '"resultIndex":1',
          ),
        }),
      );
      assert.equal(
        (await f.first.store.listUiIntentHints({ account: f.account() }))[0]
          ?.phase,
        "dispatched",
      );
      const accepted = await f.first.store.confirmUiIntentAccepted(finalize);
      assert.equal(accepted.phase, "accepted");
      const replay = await f.second.store.confirmUiIntentAccepted({
        ...finalize,
        receiptJson: intentReceipt("selection", "replayed"),
      });
      assert.equal(replay.receiptJson, finalize.receiptJson);
      assert.equal(replay.revision, accepted.revision);
      const { receiptJson: _receipt, ...refusal } = finalize;
      assert.equal(
        (
          await f.second.store.refuseUiIntentFirstDispatch({
            ...refusal,
            expectedDispatchAttemptCount: 1,
            reasonCode: "concept_selection_revision_conflict",
          })
        ).phase,
        "accepted",
      );
      await f.first.store.stageUiIntent(
        f.input("selection", "next-selection"),
        options,
      );
      const late = await f.first.store.confirmUiIntentAccepted(finalize);
      assert.equal(late.phase, "accepted");
      assert.equal(
        (await f.second.store.listUiIntentHints({ account: f.account() }))[0]
          ?.rawIdempotencyKey,
        "next-selection",
      );
    },
  );
  run(
    `${backend}: real disable/regrant keeps original audit pin/key, changed actor cannot bypass unknown, and foreign owner/realm cannot read it`,
    async (t) => {
      const f = await intentJournalFixture(t, backend),
        input = f.input(),
        staged = await f.first.store.stageUiIntent(input, options);
      const disabled = await f.installs.commitSelection(
        selectionRecipe(f.enabled.selection, "intent-disable", {
          state: "disabled",
        }),
      );
      await assert.rejects(
        () =>
          f.first.store.markUiIntentDispatched(
            { ...input, intentId: staged.intent.intentId },
            options,
          ),
        /pin_conflict/,
      );
      const enabled = await f.installs.commitSelection(
          selectionRecipe(disabled.selection, "intent-reenable"),
        ),
        current = {
          ...input,
          sourcePin: {
            ...input.sourcePin,
            selectionRevision: enabled.selection.revision,
            authorityEpoch: "intent-epoch-2",
          },
        };
      const replay = await f.first.store.stageUiIntent(current, options);
      assert.equal(replay.intent.intentId, staged.intent.intentId);
      assert.equal(replay.intent.sourcePin.authorityEpoch, "intent-epoch-1");
      const dispatched = await f.second.store.markUiIntentDispatched(
        { ...current, intentId: staged.intent.intentId },
        options,
      );
      assert.equal(
        dispatched.intent.sourcePin.selectionRevision,
        input.sourcePin.selectionRevision,
      );
      await assert.rejects(
        () =>
          f.first.store.stageUiIntent(
            {
              ...current,
              sourcePin: { ...current.sourcePin, actorId: "different-actor" },
              requestJson: input.requestJson.replace(
                "intent-key-1",
                "other-key",
              ),
            },
            options,
          ),
        /family_unresolved/,
      );
      assert.deepEqual(
        await f.first.store.listUiIntentHints({
          account: { ...f.account(), principalId: "other-principal" },
        }),
        [],
      );
      await assert.rejects(
        () =>
          f.first.store.listUiIntentHints({
            account: { ...f.account(), controlRealmId: "other-realm" },
          }),
        /realm_mismatch/,
      );
    },
  );
  run(
    `${backend}: quota preserves all 32 unknown intents and evicts only the oldest terminal record`,
    async (t) => {
      const f = await intentJournalFixture(t, backend);
      const inputs: ReturnType<typeof f.input>[] = [];
      for (let index = 0; index < 32; index++) {
        const input = {
          ...f.input("selection", `quota-${index}`),
          sourcePin: { ...f.pin(), contributionId: `workbench-${index}` },
        };
        inputs.push(input);
        await f.first.store.stageUiIntent(input, options);
      }
      const extra = {
        ...f.input("selection", "quota-extra"),
        sourcePin: { ...f.pin(), contributionId: "extra-workbench" },
      };
      await assert.rejects(
        () => f.second.store.stageUiIntent(extra, options),
        /quota_exhausted/,
      );
      assert.equal(
        (await f.first.store.listUiIntentHints({ account: f.account() }))
          .length,
        32,
      );
      const first = (await f.first.store.stageUiIntent(inputs[0]!, options))
        .intent;
      await f.first.store.markUiIntentDispatched(
        { ...inputs[0]!, intentId: first.intentId },
        options,
      );
      await f.first.store.confirmUiIntentAccepted({
        account: f.account(),
        intentId: first.intentId,
        requestDigest: first.requestDigest,
        receiptJson: intentReceipt("selection"),
        at: timestamp,
      });
      await f.second.store.stageUiIntent(extra, options);
      const hints = await f.first.store.listUiIntentHints({
        account: f.account(),
      });
      assert.equal(hints.length, 32);
      assert.ok(!hints.some((x) => x.intentId === first.intentId));
      assert.equal(hints.filter((x) => x.phase === "prepared").length, 32);
      await assert.rejects(
        () =>
          f.first.store.markUiIntentDispatched(
            { ...inputs[0]!, intentId: first.intentId },
            options,
          ),
        /stage_required/,
      );
    },
  );
  run(
    `${backend}: verifier and final active fence roll back journal writes without publishing a new intent`,
    async (t) => {
      const f = await intentJournalFixture(t, backend);
      let active = true;
      const store = f.first.parent.pluginUiIntentJournalStore({
        verifier: {
          verifyRequest(input) {
            intentVerifier.verifyRequest(input);
            active = false;
          },
          verifyReceipt: intentVerifier.verifyReceipt,
        },
      });
      await store.migratePluginUiIntentJournal();
      await assert.rejects(
        () =>
          store.stageUiIntent(f.input(), {
            authority: {
              assertCurrent: async () => {},
              assertActive() {
                if (!active) throw new Error("withdrawn-before-commit");
              },
            },
          }),
        /withdrawn-before-commit/,
      );
      assert.deepEqual(
        await f.first.store.listUiIntentHints({ account: f.account() }),
        [],
      );
      await assert.rejects(() =>
        f.first.store.stageUiIntent(
          {
            ...f.input(),
            requestJson: extensionCanonicalJson({
              action: f.pin().action,
              input: { idempotencyKey: "invalid-public-shape" },
            }),
          },
          options,
        ),
      );
      assert.deepEqual(
        await f.first.store.listUiIntentHints({ account: f.account() }),
        [],
      );
    },
  );
  run(
    `${backend}: partial schemas and changed immutability guards fail closed without silently repairing`,
    async (t) => {
      const f = await intentJournalFixture(t, backend),
        input = f.input(),
        staged = await f.first.store.stageUiIntent(input, options);
      await assert.rejects(
        () =>
          f.execute(
            `UPDATE ${f.prefix}plugin_ui_intents SET request_digest='tampered' WHERE intent_id='${staged.intent.intentId}'`,
          ),
        /immutable|check/i,
      );
      if (backend === "sqlite")
        await f.execute("DROP TRIGGER plugin_ui_intents_journal_update");
      else
        await f.execute(
          `DROP TRIGGER plugin_ui_intents_journal_update ON ${f.prefix}plugin_ui_intents`,
        );
      await assert.rejects(
        () => f.first.store.listUiIntentHints({ account: f.account() }),
        /schema_incomplete/,
      );
      await assert.rejects(
        () => f.first.store.migratePluginUiIntentJournal(),
        /schema_incomplete/,
      );
    },
  );
  for (const tamper of ["literal-case", "boolean-grouping"] as const)
    run(
      `${backend}: ${tamper} guard tamper rejects recovery reads and dispatch while preserving the unresolved row`,
      (t) => assertIntentJournalGuardTamper(t, backend, tamper),
    );
}
test("SQLite: acknowledged physical COMMIT stays accepted when local lifetime withdraws immediately afterward", async (t) => {
  const f = await intentJournalFixture(t, "sqlite"),
    db = new DatabaseSync(f.path);
  t.after(() => db.close());
  let open = true;
  const original = db.exec.bind(db);
  db.exec = (sql: string) => {
    original(sql);
    if (sql === "COMMIT") open = false;
  };
  const store = new SqlitePluginUiIntentJournalStore({
    database: db,
    assertOpen() {
      if (!open) throw new Error("closed-after-commit");
    },
    verifier: intentVerifier,
  });
  // Preparation's commit is allowed before installing the withdrawal hook.
  db.exec = original;
  await store.migratePluginUiIntentJournal();
  db.exec = (sql: string) => {
    original(sql);
    if (sql === "COMMIT") open = false;
  };
  const staged = await store.stageUiIntent(f.input(), options);
  assert.equal(staged.intent.phase, "prepared");
  assert.equal(open, false);
  assert.equal(
    (await f.first.store.listUiIntentHints({ account: f.account() }))[0]
      ?.intentId,
    staged.intent.intentId,
  );
});

test(
  "PostgreSQL maxPool1: actual source installation lock survives final policy; final withdrawal rolls back the intent",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 15000 },
  async (t) => {
    const f = await intentJournalFixture(t, "postgres"),
      observer = new Client({ connectionString: f.connectionString });
    await observer.connect();
    t.after(() => observer.end());
    let entered!: () => void,
      release!: () => void,
      calls = 0;
    const arrived = new Promise<void>((r) => {
        entered = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    const stage = f.first.store.stageUiIntent(f.input(), {
      authority: {
        async assertCurrent() {
          if (++calls === 2) {
            entered();
            await gate;
          }
        },
        assertActive() {},
      },
    });
    void stage.catch(() => {});
    let disabling: ReturnType<typeof f.installs.commitSelection> | undefined;
    try {
      await arrived;
      const secondInstalls = f.second.parent.pluginInstallationStore();
      disabling = secondInstalls.commitSelection(
        selectionRecipe(f.enabled.selection, "locked-source-disable", {
          state: "disabled",
        }),
      );
      void disabling.catch(() => {});
      const until = Date.now() + 3000;
      let observed = false;
      while (Date.now() < until) {
        await observer.query("SELECT pg_stat_clear_snapshot()");
        const rows = (
          await observer.query(
            "SELECT pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE query LIKE $1 AND wait_event_type='Lock'",
            [`%${f.schema}%plugin_profile_selections%`],
          )
        ).rows;
        if (rows.some((r) => r.blockers.length === 1)) {
          observed = true;
          break;
        }
        await delay(5);
      }
      assert.equal(
        observed,
        true,
        "the real installation update never waited on the journal's borrowed transaction",
      );
    } finally {
      release();
      await Promise.allSettled([stage, ...(disabling ? [disabling] : [])]);
    }
    const accepted = await stage;
    assert.equal(accepted.intent.phase, "prepared");
    assert.ok(disabling);
    const disabled = await disabling;
    await assert.rejects(
      () =>
        f.first.store.markUiIntentDispatched(
          { ...f.input(), intentId: accepted.intent.intentId },
          options,
        ),
      /pin_conflict/,
    );
    const enabled = await f.installs.commitSelection(
      selectionRecipe(disabled.selection, "locked-source-reenable"),
    );
    let active = true,
      checks = 0;
    await assert.rejects(
      () =>
        f.first.store.stageUiIntent(
          {
            ...f.input("query"),
            sourcePin: {
              ...f.pin("query"),
              selectionRevision: enabled.selection.revision,
            },
          },
          {
            authority: {
              async assertCurrent() {
                if (++checks === 2) active = false;
              },
              assertActive() {
                if (!active) throw new Error("journal-policy-withdrawn");
              },
            },
          },
        ),
      /journal-policy-withdrawn/,
    );
    assert.equal(
      (await f.first.store.listUiIntentHints({ account: f.account() })).length,
      1,
    );
  },
);

test(
  "PostgreSQL maxPool1: acknowledged physical COMMIT is sticky across a real delayed response and lifetime close",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 15000 },
  async (t) => {
    const f = await intentJournalFixture(t, "postgres"),
      pool = new Pool({ connectionString: f.connectionString, max: 1 });
    t.after(() => pool.end());
    let open = true,
      armed = false,
      entered!: () => void,
      release!: () => void;
    const arrived = new Promise<void>((r) => {
        entered = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    const controlled = new Proxy(pool, {
      get(target, key) {
        if (key === "connect")
          return async () => {
            const client = await target.connect();
            return new Proxy(client, {
              get(real, field) {
                if (field === "query")
                  return async (sql: string, values?: unknown[]) => {
                    const result = await real.query(sql, values);
                    if (armed && sql === "COMMIT") {
                      armed = false;
                      entered();
                      await gate;
                    }
                    return result;
                  };
                const value: unknown = Reflect.get(real, field, real);
                return typeof value === "function" ? value.bind(real) : value;
              },
            });
          };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const store = new PostgresPluginUiIntentJournalStore({
      pool: controlled,
      schema: f.schema,
      assertOpen() {
        if (!open) throw new Error("closed-after-physical-commit");
      },
      verifier: intentVerifier,
    });
    await store.migratePluginUiIntentJournal();
    armed = true;
    const pending = store.stageUiIntent(f.input(), options);
    void pending.catch(() => {});
    try {
      await arrived;
      const persisted = await f.first.store.listUiIntentHints({
        account: f.account(),
      });
      assert.equal(persisted.length, 1);
      assert.equal(persisted[0]?.phase, "prepared");
      open = false;
    } finally {
      release();
      await Promise.allSettled([pending]);
    }
    const result = await pending;
    assert.equal(result.intent.phase, "prepared");
    assert.equal(pool.idleCount, 1);
    assert.equal(pool.waitingCount, 0);
  },
);
