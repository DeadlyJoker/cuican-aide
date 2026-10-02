import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, test, type TestContext } from "node:test";
import { Client } from "pg";
import type { CommitExtensionTurnInput } from "@crewon/application";
import {
  createExtensionCreditAdmission,
  parsePluginTaskAdmission,
  type PluginTaskAdmission,
} from "@crewon/domain";
import { extensionFixture, scope } from "./extension-store.test-support.ts";
import { extensionTurnInput } from "./extension-turn.test-support.ts";
import {
  extensionStoreDigester,
  validateExtensionTurnCommit,
} from "./extension-store-records.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "./plugin-installation-store.test-support.ts";

type Backend = "sqlite" | "postgres";

async function fixture(t: TestContext, backend: Backend) {
  const f = await extensionFixture(t, backend);
  await f.seed();
  const base = extensionTurnInput();
  await f.prepare({
    ...base,
    commit: {
      ...base.turn.run,
      tenantId: base.turn.tenantId,
      idempotency: base.turn.idempotency,
    },
  });
  const actor = {
    tenantId: scope.tenantId,
    spaceId: scope.spaceId,
    actorId: base.binding.actorId,
    principalId: "plugin-task-payer",
  };
  const profile = {
    tenantId: scope.tenantId,
    spaceId: scope.spaceId,
    profileId: "plugin-task-profile",
  };
  const installs = f.first.parent.pluginInstallationStore();
  await installs.migrate();
  const recipe = installationRecipe("plugin-task-install", {
    scope: profile,
    actor,
    pluginId: scope.pluginId,
  });
  const installed = await installs.recordInstalledPackage(recipe);
  const enabled = await installs.commitSelection(
    selectionRecipe(installed.selection, "plugin-task-enable", { actor }),
  );
  await f.first.store.migrateCredits();
  await f.first.store.migratePluginAdmissions();
  const creditScope = {
    tenantId: actor.tenantId,
    principalId: actor.principalId,
    poolId: "plugin-task-fixture-credits",
  };
  // Explicit test funding/quote, never a production balance or price policy.
  const credits = f.first.parent.pluginCreditStore();
  await credits.grant({
    scope: creditScope,
    grantId: "plugin-task-fixture-funding",
    credits: "100",
  });
  const admission = parsePluginTaskAdmission({
    schemaVersion: "crewon.plugin-task-admission.v1",
    ...profile,
    pluginId: recipe.package.pluginId,
    publisherId: recipe.package.publisherId,
    version: recipe.package.version,
    packageDigest: recipe.package.packageDigest,
    selectionRevision: enabled.selection.revision,
    principalId: actor.principalId,
    actorId: actor.actorId,
    contributionId: "workbench",
    action: "image.generate",
    authorityEpoch: "fixture-current-epoch",
    runId: base.binding.runId,
    threadId: base.binding.threadId,
    extensionBindingDigest: base.binding.bindingDigest,
    requestDigest: base.receipt.requestDigest,
    idempotencyKey: base.receipt.idempotencyKey,
  });
  const creditAdmission = createExtensionCreditAdmission(
    {
      binding: base.binding,
      receipt: base.receipt,
      principalId: actor.principalId,
      poolId: creditScope.poolId,
      priceRevision: 1,
      quotedCredits: "30",
    },
    extensionStoreDigester,
  );
  const input: CommitExtensionTurnInput = {
    ...base,
    pluginAdmission: admission,
    creditAdmission,
  };
  const counts = async () =>
    Object.fromEntries(
      await Promise.all(
        [
          "messages",
          "model_history_items",
          "run_snapshots",
          "extension_run_bindings",
          "plugin_task_admissions",
          "extension_credit_admissions",
          "plugin_credit_reservations",
          "outbox",
          "work_items",
        ].map(async (table) => [table, await f.count(table)]),
      ),
    );
  return {
    ...f,
    actor,
    profile,
    installs,
    enabled,
    recipe,
    creditScope,
    credits,
    input,
    counts,
  };
}

for (const backend of ["sqlite", "postgres"] as const) {
  describe(
    `${backend} installed plugin task admission`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    () => {
      test("commits real Turn, immutable plugin provenance and personal credit hold exactly once across connections", async (t) => {
        const f = await fixture(t, backend);
        const before = await f.counts();
        const results = await Promise.all([
          f.first.store.commitExtensionTurn(f.input),
          f.second.store.commitExtensionTurn(f.input),
        ]);
        assert.deepEqual(results.map((r) => r.run.disposition).sort(), [
          "committed",
          "replayed",
        ]);
        assert.deepEqual(
          await f.first.store.loadPluginTaskAdmission(f.input.binding),
          f.input.pluginAdmission,
        );
        const after = await f.counts();
        for (const key of Object.keys(after))
          assert.equal(after[key], before[key]! + 1, key);
        assert.equal(
          (await f.credits.getAccount(f.creditScope))?.reservedCredits,
          "30",
        );
        const reopened = await f.open();
        assert.deepEqual(
          await reopened.store.loadPluginTaskAdmission(f.input.binding),
          f.input.pluginAdmission,
        );
        await f.installs.commitSelection(
          selectionRecipe(f.enabled.selection, "plugin-task-uninstall", {
            actor: f.actor,
            state: "uninstalled",
          }),
        );
        const replay = await reopened.store.commitExtensionTurn(f.input);
        assert.equal(replay.run.disposition, "replayed");
        assert.deepEqual(
          await reopened.store.loadPluginTaskAdmission(f.input.binding),
          f.input.pluginAdmission,
        );
        assert.deepEqual(await f.counts(), after);
      });

      for (const [name, patch] of Object.entries({
        revision: { selectionRevision: 1 },
        digest: { packageDigest: `sha256:${"b".repeat(64)}` },
        publisher: { publisherId: "other.publisher" },
        version: { version: "2.0.0" },
        profile: { profileId: "another-profile" },
      }))
        test(`rejects stale or foreign ${name} before Run and credit writes`, async (t) => {
          const f = await fixture(t, backend);
          const before = await f.counts();
          await assert.rejects(
            f.first.store.commitExtensionTurn({
              ...f.input,
              pluginAdmission: { ...f.input.pluginAdmission!, ...patch },
            }),
            /plugin_task_admission_conflict/u,
          );
          assert.deepEqual(await f.counts(), before);
          assert.equal(
            (await f.credits.getAccount(f.creditScope))?.reservedCredits,
            "0",
          );
        });

      test("rejects disabled selection and missing or foreign payer quote without a free fallback", async (t) => {
        const f = await fixture(t, backend);
        const before = await f.counts();
        await assert.rejects(
          f.first.store.commitExtensionTurn({
            ...f.input,
            creditAdmission: undefined,
          }),
          /plugin_task_credit_admission_required/u,
        );
        await assert.rejects(
          f.first.store.commitExtensionTurn({
            ...f.input,
            pluginAdmission: {
              ...f.input.pluginAdmission!,
              principalId: "other-payer",
            },
          }),
          /plugin_task_credit_admission_required/u,
        );
        await f.installs.commitSelection(
          selectionRecipe(f.enabled.selection, "plugin-task-disable", {
            actor: f.actor,
            state: "disabled",
          }),
        );
        await assert.rejects(
          f.first.store.commitExtensionTurn(f.input),
          /plugin_task_admission_conflict/u,
        );
        assert.deepEqual(await f.counts(), before);
      });

      test("plugin provenance failure rolls back Run, input, history, credit hold and all receipts", async (t) => {
        const f = await fixture(t, backend);
        const before = await f.counts();
        if (backend === "sqlite")
          await f.sql(
            "CREATE TRIGGER fail_plugin_task BEFORE INSERT ON plugin_task_admissions BEGIN SELECT RAISE(ABORT,'fixture_plugin_task_failure'); END;",
          );
        else
          await f.sql(`CREATE FUNCTION ${f.prefix}fail_plugin_task() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_plugin_task_failure'; END $$;
        CREATE TRIGGER fail_plugin_task BEFORE INSERT ON ${f.prefix}plugin_task_admissions FOR EACH ROW EXECUTE FUNCTION ${f.prefix}fail_plugin_task();`);
        await assert.rejects(
          f.first.store.commitExtensionTurn(f.input),
          /fixture_plugin_task_failure/u,
        );
        assert.deepEqual(await f.counts(), before);
        assert.equal(
          (await f.credits.getAccount(f.creditScope))?.reservedCredits,
          "0",
        );
        assert.equal(
          await f.first.store.loadExtensionTurnReceipt({
            ...scope,
            receipt: f.input.receipt,
          }),
          null,
        );
      });

      test("rejects accessor, hidden and symbol pin fields before cloning or invoking getters", async (t) => {
        const f = await fixture(t, backend);
        const before = await f.counts();
        let getters = 0;
        const accessor = Object.defineProperty(
          { ...f.input.pluginAdmission },
          "publisherId",
          {
            enumerable: true,
            get() {
              getters++;
              return f.input.pluginAdmission!.publisherId;
            },
          },
        );
        const hidden = Object.defineProperty(
          { ...f.input.pluginAdmission },
          "extra",
          { value: "invalid" },
        );
        const symbol = {
          ...f.input.pluginAdmission,
          [Symbol("extra")]: "invalid",
        };
        for (const pluginAdmission of [accessor, hidden, symbol])
          await assert.rejects(
            f.first.store.commitExtensionTurn({
              ...f.input,
              pluginAdmission,
            } as CommitExtensionTurnInput),
          );
        const outer = Object.defineProperty({ ...f.input }, "pluginAdmission", {
          enumerable: true,
          get() {
            getters++;
            return f.input.pluginAdmission;
          },
        });
        await assert.rejects(
          f.first.store.commitExtensionTurn(outer),
          /plugin_task_admission_record_invalid/u,
        );
        assert.equal(getters, 0);
        assert.deepEqual(await f.counts(), before);
      });

      test("rejects provenance that differs from the captured task fields", async (t) => {
        const f = await fixture(t, backend);
        const replacementBase = extensionTurnInput(f.input.binding.runId, {
          actorId: "replacement-actor",
        });
        const replacement = {
          ...replacementBase,
          receipt: {
            ...replacementBase.receipt,
            actorId: replacementBase.binding.actorId,
          },
        };
        // Same Run ID and valid Turn fields still must match the immutable pin.
        validateExtensionTurnCommit(replacement);
        const replacementCredit = createExtensionCreditAdmission(
          {
            binding: replacement.binding,
            receipt: replacement.receipt,
            principalId: f.actor.principalId,
            poolId: f.creditScope.poolId,
            priceRevision: 1,
            quotedCredits: "30",
          },
          extensionStoreDigester,
        );
        let bindingReads = 0;
        let receiptReads = 0;
        let creditReads = 0;
        const changing = Object.defineProperties(
          { ...f.input, turn: replacement.turn },
          {
            binding: {
              enumerable: true,
              get() {
                return ++bindingReads <= 2
                  ? f.input.binding
                  : replacement.binding;
              },
            },
            receipt: {
              enumerable: true,
              get() {
                return ++receiptReads === 1
                  ? f.input.receipt
                  : replacement.receipt;
              },
            },
            creditAdmission: {
              enumerable: true,
              get() {
                return ++creditReads === 1
                  ? f.input.creditAdmission
                  : replacementCredit;
              },
            },
          },
        );
        const before = await f.counts();
        await assert.rejects(
          f.first.store.commitExtensionTurn(changing),
          /plugin_task_admission_binding_mismatch/u,
        );
        assert.deepEqual(await f.counts(), before);
        assert.equal(
          (await f.credits.getAccount(f.creditScope))?.reservedCredits,
          "0",
        );
      });

      test("refuses replay with changed full pin and preserves immutable provenance", async (t) => {
        const f = await fixture(t, backend);
        await f.first.store.commitExtensionTurn(f.input);
        const before = await f.counts();
        await assert.rejects(
          f.second.store.commitExtensionTurn({
            ...f.input,
            pluginAdmission: {
              ...f.input.pluginAdmission!,
              authorityEpoch: "other-epoch",
            },
          }),
          /plugin_task_admission_conflict/u,
        );
        await assert.rejects(
          f.sql(
            `UPDATE ${f.prefix}plugin_task_admissions SET admission_json=admission_json`,
          ),
          /plugin_task_admission_immutable/u,
        );
        await assert.rejects(
          f.sql(`DELETE FROM ${f.prefix}plugin_task_admissions`),
          /plugin_task_admission_immutable/u,
        );
        assert.deepEqual(await f.counts(), before);
        assert.equal(
          await f.first.store.loadPluginTaskAdmission({
            ...f.input.binding,
            spaceId: "another-space",
          }),
          null,
        );
      });
    },
  );
}

for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend} legacy extension migration does not create installed task tables`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await extensionFixture(t, backend);
      await f.seed();
      await assert.rejects(f.count("plugin_task_admissions"));
      await assert.rejects(f.first.store.migratePluginAdmissions());
      await assert.rejects(f.count("plugin_task_admissions"));
      assert.equal(await f.count("extension_run_bindings"), 0);
    },
  );

test(
  "PostgreSQL actual Run transaction holds selection row through commit while disable waits",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, "postgres");
    const gate = new Client({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
    });
    await gate.connect();
    const name = `plugin_task_gate_${randomUUID().replaceAll("-", "")}`;
    await gate.query("BEGIN");
    await gate.query("SELECT pg_advisory_xact_lock(hashtext($1))", [name]);
    await f.sql(`CREATE FUNCTION ${f.prefix}pause_plugin_task() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtext('${name}')); RETURN NEW; END $$;
    CREATE TRIGGER pause_plugin_task BEFORE INSERT ON ${f.prefix}plugin_task_admissions FOR EACH ROW EXECUTE FUNCTION ${f.prefix}pause_plugin_task();`);
    const run = f.first.store.commitExtensionTurn(f.input);
    const observer = new Client({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
    });
    await observer.connect();
    void run.catch(() => {});
    async function waitForLock(fragment: string) {
      for (let attempt = 0; attempt < 250; attempt++) {
        const result = await observer.query(
          "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1 AND pid<>pg_backend_pid()",
          [`%${fragment}%`],
        );
        if (result.rows.length > 0) return;
        await delay(20);
      }
      throw new Error(`fixture_lock_not_observed:${fragment}`);
    }
    try {
      await waitForLock(`INSERT INTO ${f.prefix}plugin_task_admissions`);
      const disable = f.installs.commitSelection(
        selectionRecipe(f.enabled.selection, "plugin-task-racing-disable", {
          actor: f.actor,
          state: "disabled",
        }),
      );
      void disable.catch(() => {});
      await waitForLock(`UPDATE ${f.prefix}plugin_profile_selections`);
      await gate.query("COMMIT");
      assert.equal((await run).run.disposition, "committed");
      assert.equal((await disable).selection.state, "disabled");
      assert.deepEqual(
        await f.first.store.loadPluginTaskAdmission(f.input.binding),
        f.input.pluginAdmission,
      );
    } finally {
      await gate.query("ROLLBACK").catch(() => {});
      await gate.end();
      await observer.end();
      await run.catch(() => {});
    }
  },
);
