import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PluginUiCommittedTaskAuthority } from "@crewon/application";
import {
  assertPluginTaskAdmission,
  createExtensionRunBinding,
  extensionCanonicalJson,
  parsePluginQueryTaskAdmission,
  parsePluginTaskAdmissionPin,
  assertPluginQueryTaskAdmission,
  effectivePluginQueryTaskAdmission,
} from "@crewon/domain";
import {
  pluginQueryFixture,
  actor,
  scope,
} from "./plugin-query-task.test-support.ts";
import {
  selectionRecipe,
  installationRecipe,
} from "./plugin-installation-store.test-support.ts";
import { extensionStoreDigester } from "./extension-store-records.ts";
for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: query freezes original package/config/target/operation with separate current invocation and no generation quote`,
    options,
    async (t) => {
      const f = await pluginQueryFixture(t, backend);
      const accepted = await f
        .create(undefined, undefined, f.host)
        .createQueryTaskFromPlugin(actor, f.command(), f.queryPin);
      assert.equal(accepted.creditAdmission, undefined);
      assert.equal(f.quoteCalls(), 1);
      assert.deepEqual(accepted.binding.target, f.generation.binding.target);
      assert.equal(
        accepted.binding.configurationDigest,
        f.generation.binding.configurationDigest,
      );
      assert.deepEqual(accepted.binding.source, {
        runId: f.generation.binding.runId,
        bindingDigest: f.generation.binding.bindingDigest,
        operationId: f.operationId,
      });
      const query = await f.first.store.loadPluginQueryTaskAdmission(
        accepted.binding,
      );
      assert.ok(query);
      assert.deepEqual(query.source, f.sourceAdmission);
      assert.equal(query.action, "image.query");
      assert.equal(
        await f.first.store.loadPluginTaskAdmission(accepted.binding),
        null,
      );
      assert.equal(await f.count("plugin_task_admissions"), 1);
      assert.equal(await f.count("plugin_query_task_admissions"), 1);
      assert.equal(await f.count("extension_credit_admissions"), 1);
      assert.equal(
        (await f.credits.getAccount(f.creditScope))?.reservedCredits,
        "10",
      );
      const reopened = await f.open();
      const replay = await f
        .create(reopened.store, reopened.parent, f.host)
        .createQueryTaskFromPlugin(actor, f.command(), f.queryPin);
      assert.equal(replay.run.disposition, "replayed");
      assert.deepEqual(replay.binding, accepted.binding);
      assert.equal(await f.count("run_snapshots"), 2);
      assert.equal(f.quoteCalls(), 1);
      const effective = effectivePluginQueryTaskAdmission(query);
      assert.equal(effective.packageDigest, f.pin.packageDigest);
      assert.throws(
        () =>
          assertPluginTaskAdmission(
            {
              admission: effective,
              binding: accepted.binding,
              receipt: {
                actorId: query.actorId,
                idempotencyKey: query.idempotencyKey,
                requestDigest: query.requestDigest,
              },
            },
            extensionStoreDigester,
          ),
        /binding_mismatch/u,
      );
    },
  );
  test(
    `${backend}: upgraded current package may query original package without selecting old package for generation`,
    options,
    async (t) => {
      const f = await pluginQueryFixture(t, backend);
      const upgrade = await f.installations.recordInstalledPackage(
        installationRecipe("query-upgrade", {
          scope: f.profile,
          actor,
          pluginId: scope.pluginId,
          version: "0.2.0",
          packageDigest: extensionStoreDigester.sha256("query-upgrade-package"),
          expectedSelectionRevision: f.enabled.selection.revision,
        }),
      );
      const selected = await f.installations.commitSelection(
        selectionRecipe(upgrade.selection, "query-select-upgrade", {
          actor,
          packageDigest: upgrade.package.packageDigest,
        }),
      );
      const currentPin = parsePluginTaskAdmissionPin({
        ...f.queryPin,
        packageDigest: upgrade.package.packageDigest,
        version: upgrade.package.version,
        selectionRevision: selected.selection.revision,
      });
      const accepted = await f
        .create(undefined, undefined, f.host)
        .createQueryTaskFromPlugin(actor, f.command(), currentPin);
      const query = await f.first.store.loadPluginQueryTaskAdmission(
        accepted.binding,
      );
      assert.ok(query);
      assert.equal(query.packageDigest, upgrade.package.packageDigest);
      assert.equal(query.source.packageDigest, f.pin.packageDigest);
      assert.equal(
        effectivePluginQueryTaskAdmission(query).packageDigest,
        f.pin.packageDigest,
      );
      assert.equal(
        (
          await f.installations.loadSelection({
            scope: f.profile,
            pluginId: scope.pluginId,
          })
        )?.selectedPackageDigest,
        upgrade.package.packageDigest,
      );
      const before = await f.count("run_snapshots");
      await assert.rejects(
        f
          .create(undefined, undefined, f.host)
          .createQueryTaskFromPlugin(actor, f.command("stale"), f.queryPin),
      );
      assert.equal(await f.count("run_snapshots"), before);
    },
  );
  test(
    `${backend}: wrong source, operation, owner, unavailable host and denied read leave no query writes`,
    options,
    async (t) => {
      const f = await pluginQueryFixture(t, backend);
      const before = await f.count("run_snapshots");
      await assert.rejects(
        f.create().createQueryTaskFromPlugin(actor, f.command(), f.queryPin),
      );
      for (const intent of [
        { ...f.command().intent, sourceRunId: "missing" },
        { ...f.command().intent, operationId: randomUUID() },
      ])
        await assert.rejects(
          f
            .create(undefined, undefined, f.host)
            .createQueryTaskFromPlugin(
              actor,
              { ...f.command(), intent },
              f.queryPin,
            ),
        );
      await assert.rejects(
        f
          .create(undefined, undefined, f.host)
          .createQueryTaskFromPlugin(
            { ...actor, principalId: "other" },
            f.command(),
            f.queryPin,
          ),
      );
      f.state.denied = "run:read";
      await assert.rejects(
        f
          .create(undefined, undefined, f.host)
          .createQueryTaskFromPlugin(actor, f.command(), f.queryPin),
      );
      assert.equal(await f.count("run_snapshots"), before);
      assert.equal(await f.count("plugin_query_task_admissions"), 0);
      assert.equal(f.quoteCalls(), 1);
    },
  );
  test(
    `${backend}: query provenance strict capture and target tamper remain fail closed`,
    options,
    async (t) => {
      const f = await pluginQueryFixture(t, backend);
      const accepted = await f
        .create(undefined, undefined, f.host)
        .createQueryTaskFromPlugin(actor, f.command(), f.queryPin);
      const query = await f.first.store.loadPluginQueryTaskAdmission(
        accepted.binding,
      );
      assert.ok(query);
      let getter = 0;
      assert.throws(() =>
        parsePluginQueryTaskAdmission(
          Object.defineProperty({ ...query }, "source", {
            enumerable: true,
            get() {
              getter++;
              return query.source;
            },
          }),
        ),
      );
      assert.equal(getter, 0);
      assert.throws(() =>
        parsePluginQueryTaskAdmission({ ...query, actor: "forged" }),
      );
      assert.throws(() =>
        parsePluginQueryTaskAdmission({ ...query, operationId: "not-uuid" }),
      );
      for (const key of [
        "agentVersionId",
        "agentVersionContentDigest",
        "materializationDigest",
        "authorityId",
        "runtimeGeneration",
        "policySnapshotId",
        "workspaceBindingId",
      ] as const) {
        const changed = createExtensionRunBinding(
          {
            ...accepted.binding,
            target: {
              ...accepted.binding.target,
              [key]: key.includes("Digest")
                ? extensionStoreDigester.sha256("other")
                : "other",
            },
          },
          extensionStoreDigester,
        );
        assert.throws(() =>
          assertPluginQueryTaskAdmission(
            {
              admission: {
                ...query,
                extensionBindingDigest: changed.bindingDigest,
              },
              binding: changed,
              sourceBinding: f.generation.binding,
              receipt: {
                actorId: query.actorId,
                idempotencyKey: query.idempotencyKey,
                requestDigest: query.requestDigest,
              },
            },
            extensionStoreDigester,
          ),
        );
      }
      assert.equal(
        extensionCanonicalJson(f.generation.binding),
        extensionCanonicalJson(
          await f.first.store.loadExtensionRunBinding(f.generation.binding),
        ),
      );
    },
  );
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: concurrent exact query acceptance on two connections commits once and rejects changed operation replay`,
    options,
    async (t) => {
      const f = await pluginQueryFixture(t, backend),
        a = f.create(undefined, undefined, f.host),
        b = f.create(f.second.store, f.second.parent, f.host);
      const results = await Promise.all([
        a.createQueryTaskFromPlugin(actor, f.command(), f.queryPin),
        b.createQueryTaskFromPlugin(actor, f.command(), f.queryPin),
      ]);
      assert.deepEqual(results.map((r) => r.run.disposition).sort(), [
        "committed",
        "replayed",
      ]);
      assert.equal(results[0]!.binding.runId, results[1]!.binding.runId);
      assert.equal(await f.count("run_snapshots"), 2);
      assert.equal(await f.count("plugin_query_task_admissions"), 1);
      assert.equal(await f.count("extension_credit_admissions"), 1);
      const other = randomUUID();
      await f.operations.reserveExternalOperation({
        tenantId: actor.tenantId,
        runId: f.generation.binding.runId,
        bindingDigest: f.generation.binding.bindingDigest,
        operationId: other,
        executionId: "other-operation",
        idempotencyKey: "other-operation",
        actionDigest: extensionStoreDigester.sha256("action"),
        requestDigest: extensionStoreDigester.sha256("request"),
        correlationId: other,
        createdAt: "2026-09-30T00:00:00.000Z",
      });
      await assert.rejects(
        a.createQueryTaskFromPlugin(
          actor,
          {
            ...f.command(),
            intent: { ...f.command().intent, operationId: other },
          },
          f.queryPin,
        ),
      );
      assert.equal(await f.count("plugin_query_task_admissions"), 1);
      assert.equal(f.quoteCalls(), 1);
    },
  );
  test(
    `${backend}: accepted query cannot become a generation source and replay still rechecks query thread permission`,
    options,
    async (t) => {
      const f = await pluginQueryFixture(t, backend),
        service = f.create(undefined, undefined, f.host),
        accepted = await service.createQueryTaskFromPlugin(
          actor,
          f.command(),
          f.queryPin,
        );
      await assert.rejects(
        service.createQueryTaskFromPlugin(
          actor,
          {
            ...f.command("chain"),
            intent: {
              ...f.command().intent,
              sourceRunId: accepted.binding.runId,
            },
          },
          f.queryPin,
        ),
      );
      f.state.denied = "thread:message:append";
      await assert.rejects(
        service.createQueryTaskFromPlugin(actor, f.command(), f.queryPin),
      );
      assert.equal(await f.count("plugin_query_task_admissions"), 1);
      assert.equal(f.quoteCalls(), 1);
    },
  );
  test(
    `${backend}: a separately authorized current actor queries the original owner without impersonating that owner`,
    options,
    async (t) => {
      const f = await pluginQueryFixture(t, backend),
        currentActor = {
          ...actor,
          actorId: "query-actor",
          principalId: "query-principal",
        },
        pin = parsePluginTaskAdmissionPin({ ...f.queryPin, ...currentActor }),
        accepted = await f
          .create(undefined, undefined, f.host)
          .createQueryTaskFromPlugin(currentActor, f.command(), pin),
        query = await f.first.store.loadPluginQueryTaskAdmission(
          accepted.binding,
        );
      assert.ok(query);
      assert.equal(query.actorId, currentActor.actorId);
      assert.equal(query.principalId, currentActor.principalId);
      assert.equal(query.source.actorId, actor.actorId);
      assert.equal(query.source.principalId, actor.principalId);
      assert.equal(accepted.binding.actorId, currentActor.actorId);
      assert.equal(f.quoteCalls(), 1);
      assert.equal(accepted.creditAdmission, undefined);
    },
  );
  test(
    `${backend}: query captures mutable command and current pin before readiness await`,
    options,
    async (t) => {
      const f = await pluginQueryFixture(t, backend);
      let enter!: () => void, resume!: () => void;
      const entered = new Promise<void>((done) => (enter = done)),
        gate = new Promise<void>((done) => (resume = done));
      const host = {
        ...f.host,
        async evaluate(input: Parameters<typeof f.host.evaluate>[0]) {
          enter();
          await gate;
          return f.host.evaluate(input);
        },
      };
      const command = structuredClone(f.command()),
        pin = { ...f.queryPin },
        acceptedPromise = f
          .create(undefined, undefined, host)
          .createQueryTaskFromPlugin(actor, command, pin);
      await entered;
      command.intent.operationId = randomUUID();
      command.intent.sourceRunId = "changed";
      pin.packageDigest = extensionStoreDigester.sha256("changed");
      resume();
      const accepted = await acceptedPromise,
        query = await f.first.store.loadPluginQueryTaskAdmission(
          accepted.binding,
        );
      assert.equal(query?.operationId, f.operationId);
      assert.equal(query?.source.runId, f.generation.binding.runId);
      assert.equal(query?.packageDigest, f.queryPin.packageDigest);
      assert.equal(f.quoteCalls(), 1);
    },
  );
  test(
    `${backend}: source receipt owner, configuration and complete target cannot be supplied by current metadata`,
    options,
    async (t) => {
      const f = await pluginQueryFixture(t, backend);
      const before = await f.count("run_snapshots");
      const host = {
        ...f.host,
        async evaluate(input: Parameters<typeof f.host.evaluate>[0]) {
          return {
            outcome: "ready" as const,
            target: {
              ...input.expectedTarget,
              materializationDigest: extensionStoreDigester.sha256("current"),
            },
          };
        },
      };
      await assert.rejects(
        f
          .create(undefined, undefined, host)
          .createQueryTaskFromPlugin(actor, f.command(), f.queryPin),
      );
      const tamper = new Proxy(f.first.store, {
        get(target, key, receiver) {
          if (key === "loadExtensionTurnReceipt")
            return async (
              input: Parameters<
                typeof f.first.store.loadExtensionTurnReceipt
              >[0],
            ) => {
              const saved = await target.loadExtensionTurnReceipt(input);
              return saved?.binding.runId === f.generation.binding.runId
                ? {
                    ...saved,
                    run: {
                      ...saved.run,
                      state: {
                        ...saved.run.state,
                        createdByActorId: "wrong-source-owner",
                      },
                    },
                  }
                : saved;
            };
          const value = Reflect.get(target, key, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await assert.rejects(
        f
          .create(tamper, undefined, f.host)
          .createQueryTaskFromPlugin(actor, f.command(), f.queryPin),
      );
      assert.equal(await f.count("run_snapshots"), before);
      assert.equal(await f.count("plugin_query_task_admissions"), 0);
    },
  );
  test(
    `${backend}: persisted query provenance is immutable and probe returns it without generation fallback`,
    options,
    async (t) => {
      const f = await pluginQueryFixture(t, backend),
        accepted = await f
          .create(undefined, undefined, f.host)
          .createQueryTaskFromPlugin(actor, f.command(), f.queryPin),
        probe = f.first.parent.pluginTaskAdmissionProbe();
      assert.equal(await probe.loadPluginTaskAdmission(accepted.binding), null);
      assert.deepEqual(
        await probe.loadPluginQueryTaskAdmission(accepted.binding),
        await f.first.store.loadPluginQueryTaskAdmission(accepted.binding),
      );
      await assert.rejects(
        f.sql(
          `UPDATE ${f.prefix}plugin_query_task_admissions SET source_run_id='forged'`,
        ),
      );
      await assert.rejects(
        f.sql(`DELETE FROM ${f.prefix}plugin_query_task_admissions`),
      );
      assert.equal(await f.count("plugin_query_task_admissions"), 1);
    },
  );
}
