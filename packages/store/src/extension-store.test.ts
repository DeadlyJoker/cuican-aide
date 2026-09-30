import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  activation,
  configuration,
  digest,
  extensionFixture,
  receipt,
  runInput,
  scope,
  target,
  timestamp,
} from "./extension-store.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const skip =
    backend === "postgres" &&
    process.env.CREWON_TEST_POSTGRES_URL === undefined;
  test(
    `${backend} extensions: revision CAS serializes independent configuration writers`,
    { skip },
    async (t) => {
      const { first, second } = await extensionFixture(t, backend);
      const input = {
        configuration: configuration(),
        expectedRevision: 0,
        receipt: receipt("config"),
      };
      const duplicate = await Promise.all([
        first.store.saveExtensionConfiguration(input),
        second.store.saveExtensionConfiguration(input),
      ]);
      assert.deepEqual(duplicate.map((r) => r.disposition).sort(), [
        "created",
        "replayed",
      ]);
      const revisions = await Promise.allSettled(
        [first, second].map(({ store }, i) =>
          store.saveExtensionConfiguration({
            configuration: configuration({
              revision: 2,
              parameters: { serviceUrl: `https://service-${i}.example/` },
            }),
            expectedRevision: 1,
            receipt: receipt(`config-2-${i}`),
          }),
        ),
      );
      assert.equal(revisions.filter((r) => r.status === "fulfilled").length, 1);
      assert.match(
        String(
          (
            revisions.find(
              (r) => r.status === "rejected",
            ) as PromiseRejectedResult
          ).reason,
        ),
        /configuration_revision_conflict/u,
      );
      assert.deepEqual(
        await first.store.loadExtensionConfiguration({ ...scope, revision: 1 }),
        input.configuration,
      );
      assert.equal(
        (await first.store.loadLatestExtensionConfiguration(scope))?.revision,
        2,
      );
    },
  );

  test(
    `${backend} extensions: scoped mutation receipts preserve original values and reject payload changes`,
    { skip },
    async (t) => {
      const { first } = await extensionFixture(t, backend);
      const input = {
        configuration: configuration(),
        expectedRevision: 0,
        receipt: receipt("config"),
      };
      await first.store.saveExtensionConfiguration(input);
      const retried = await first.store.saveExtensionConfiguration({
        ...input,
        configuration: configuration({ createdAt: "2026-09-30T00:00:01.000Z" }),
      });
      assert.equal(retried.configuration.createdAt, timestamp);
      await assert.rejects(
        first.store.saveExtensionConfiguration({
          ...input,
          configuration: configuration({ parameters: {} }),
        }),
        /idempotency_conflict/u,
      );
      await assert.rejects(
        first.store.saveExtensionConfiguration({
          ...input,
          receipt: { ...input.receipt, requestDigest: digest },
        }),
        /idempotency_conflict/u,
      );
      await assert.rejects(
        first.store.saveExtensionConfiguration({
          ...input,
          receipt: { ...input.receipt, actorId: "actor-2" },
        }),
        /authority_mismatch/u,
      );
      for (const patch of [
        { tenantId: "tenant-2" },
        { spaceId: "space-2" },
        { pluginId: "other.plugin" },
      ]) {
        assert.equal(
          await first.store.loadLatestExtensionConfiguration({
            ...scope,
            ...patch,
          }),
          null,
        );
        assert.equal(
          await first.store.loadExtensionActivation({ ...scope, ...patch }),
          null,
        );
      }
    },
  );

  test(
    `${backend} extensions: activation requires a deployed immutable target and serializes concurrent switches`,
    { skip },
    async (t) => {
      const { first, second, seed } = await extensionFixture(t, backend);
      await first.store.saveExtensionConfiguration({
        configuration: configuration(),
        expectedRevision: 0,
        receipt: receipt("config-1"),
      });
      await assert.rejects(
        first.store.saveExtensionActivation({
          activation: activation(),
          expectedRevision: 0,
          receipt: receipt("no-target"),
        }),
        /not_deployed/u,
      );
      await seed();
      const input = {
        activation: activation(undefined, { revision: 2, state: "disabled" }),
        expectedRevision: 1,
        receipt: receipt("disable"),
      };
      const result = await Promise.all([
        first.store.saveExtensionActivation(input),
        second.store.saveExtensionActivation(input),
      ]);
      assert.deepEqual(result.map((r) => r.disposition).sort(), [
        "replayed",
        "updated",
      ]);
      await assert.rejects(
        first.store.saveExtensionActivation({
          ...input,
          activation: { ...input.activation, state: "revoked" },
        }),
        /idempotency_conflict/u,
      );
      await assert.rejects(
        first.store.saveExtensionActivation({
          ...input,
          receipt: receipt("stale"),
        }),
        /activation_revision_conflict/u,
      );
      for (const patch of [
        { materializationDigest: digest },
        { policySnapshotId: "other-policy" },
        { authorityId: "other-authority" },
      ])
        await assert.rejects(
          first.store.saveExtensionActivation({
            activation: activation(undefined, {
              revision: 3,
              target: { ...target, ...patch },
            }),
            expectedRevision: 2,
            receipt: receipt(`drift-${Object.keys(patch)[0]}`),
          }),
          /not_deployed/u,
        );
      assert.equal(
        (await first.store.loadExtensionActivation(scope))?.state,
        "disabled",
      );
    },
  );

  test(
    `${backend} extensions: Run, binding, queue and idempotency receipt commit once and survive reopening`,
    { skip },
    async (t) => {
      const f = await extensionFixture(t, backend);
      await f.seed();
      const input = await f.prepare();
      const results = await Promise.all([
        f.first.store.commitExtensionRun(input),
        f.second.store.commitExtensionRun(input),
      ]);
      assert.deepEqual(results.map((r) => r.run.disposition).sort(), [
        "committed",
        "replayed",
      ]);
      const reopened = await f.open();
      assert.deepEqual(
        await reopened.store.loadExtensionRunBinding(input.binding),
        input.binding,
      );
      assert.equal(
        (await reopened.parent.loadRun(input.binding))?.agentVersionId,
        target.agentVersionId,
      );
      for (const table of [
        "run_snapshots",
        "run_events",
        "outbox",
        "work_items",
        "extension_run_bindings",
      ])
        assert.equal(await f.count(table), 1, table);
      assert.equal(await f.count("extension_mutation_receipts"), 3);
      for (const patch of [
        { tenantId: "other" },
        { spaceId: "other" },
        { runId: "other" },
      ])
        assert.equal(
          await reopened.store.loadExtensionRunBinding({
            ...input.binding,
            ...patch,
          }),
          null,
        );
    },
  );

  test(
    `${backend} extensions: a binding insert failure rolls back Run, outbox, queue and retry receipt`,
    { skip },
    async (t) => {
      const f = await extensionFixture(t, backend);
      await f.seed();
      const input = await f.prepare();
      await f.failBindings(true);
      await assert.rejects(
        f.first.store.commitExtensionRun(input),
        /test_binding_failure/u,
      );
      for (const table of [
        "run_snapshots",
        "run_events",
        "outbox",
        "work_items",
        "extension_run_bindings",
      ])
        assert.equal(await f.count(table), 0, table);
      assert.equal(
        await f.first.store.loadExtensionRunReceipt({
          ...scope,
          receipt: input.receipt,
        }),
        null,
      );
      await f.failBindings(false);
      assert.equal(
        (await f.second.store.commitExtensionRun(input)).run.disposition,
        "committed",
      );
    },
  );

  test(
    `${backend} extensions: retries keep their Run after configuration switch, disable or revocation`,
    { skip },
    async (t) => {
      const f = await extensionFixture(t, backend);
      await f.seed();
      const input = await f.prepare();
      await f.first.store.commitExtensionRun(input);
      const next = configuration({
        revision: 2,
        parameters: { serviceUrl: "https://new.example/" },
      });
      await f.first.store.saveExtensionConfiguration({
        configuration: next,
        expectedRevision: 1,
        receipt: receipt("config-2"),
      });
      for (const [i, state] of (
        ["enabled", "disabled", "revoked"] as const
      ).entries()) {
        await f.first.store.saveExtensionActivation({
          activation: activation(next, { revision: i + 2, state }),
          expectedRevision: i + 1,
          receipt: receipt(`switch-${state}`),
        });
        const replay = await f.second.store.loadExtensionRunReceipt({
          ...scope,
          receipt: input.receipt,
        });
        assert.equal(replay?.run.disposition, "replayed");
        assert.deepEqual(replay?.binding, input.binding);
        assert.deepEqual(
          (await f.second.store.commitExtensionRun(input)).binding,
          input.binding,
        );
      }
      await assert.rejects(
        f.first.store.loadExtensionRunReceipt({
          ...scope,
          receipt: { ...input.receipt, requestDigest: digest },
        }),
        /idempotency_conflict/u,
      );
      assert.equal(
        await f.first.store.loadExtensionRunReceipt({
          ...scope,
          receipt: { ...input.receipt, actorId: "actor-2" },
        }),
        null,
      );
      assert.equal(await f.count("run_snapshots"), 1);
    },
  );

  test(
    `${backend} extensions: new generation requires the currently enabled configuration`,
    { skip },
    async (t) => {
      const f = await extensionFixture(t, backend);
      await f.seed();
      const input = await f.prepare();
      const next = configuration({ revision: 2 });
      await f.first.store.saveExtensionConfiguration({
        configuration: next,
        expectedRevision: 1,
        receipt: receipt("config-2"),
      });
      await f.first.store.saveExtensionActivation({
        activation: activation(next, { revision: 2 }),
        expectedRevision: 1,
        receipt: receipt("activate-2"),
      });
      await assert.rejects(
        f.first.store.commitExtensionRun(input),
        /activation_revision_conflict/u,
      );
      await assert.rejects(
        f.first.store.commitExtensionRun({
          ...input,
          expectedActivationRevision: 2,
        }),
        /generation_disabled/u,
      );
      const current = runInput("run-1", {
        configurationRevision: 2,
        configurationDigest: next.contentDigest,
      });
      await f.first.store.saveExtensionActivation({
        activation: activation(next, { revision: 3, state: "disabled" }),
        expectedRevision: 2,
        receipt: receipt("disable"),
      });
      await assert.rejects(
        f.first.store.commitExtensionRun({
          ...current,
          expectedActivationRevision: 3,
        }),
        /generation_disabled/u,
      );
      await f.first.store.saveExtensionActivation({
        activation: activation(next, { revision: 4 }),
        expectedRevision: 3,
        receipt: receipt("enable"),
      });
      assert.equal(
        (
          await f.first.store.commitExtensionRun({
            ...current,
            expectedActivationRevision: 4,
          })
        ).binding.configurationRevision,
        2,
      );
    },
  );

  test(
    `${backend} extensions: mismatched Run route and missing configuration fail before dispatch`,
    { skip },
    async (t) => {
      const f = await extensionFixture(t, backend);
      await f.seed();
      const input = await f.prepare();
      const event = input.commit.events[0]!;
      assert.equal(event.type, "run.created");
      if (event.type !== "run.created") assert.fail();
      await assert.rejects(
        f.first.store.commitExtensionRun({
          ...input,
          commit: {
            ...input.commit,
            events: [
              {
                ...event,
                data: { ...event.data, agentVersionId: "other-agent" },
              },
            ],
          },
        }),
        /authority_mismatch/u,
      );
      await assert.rejects(
        f.first.store.commitExtensionRun(
          runInput("run-1", { configurationDigest: digest }),
        ),
        /configuration_not_found/u,
      );
      await f.sql(`DELETE FROM ${f.prefix}agent_version_deployments`);
      await assert.rejects(
        f.first.store.commitExtensionRun(input),
        /not_deployed/u,
      );
      assert.equal(await f.count("run_snapshots"), 0);
      assert.equal(await f.count("work_items"), 0);
    },
  );

  test(
    `${backend} extensions: disabled plugin permits only a bound original-operation query, revoked denies admission`,
    { skip },
    async (t) => {
      const f = await extensionFixture(t, backend);
      await f.seed();
      const original = await f.prepare();
      await f.first.store.commitExtensionRun(original);
      const operationId = randomUUID();
      const source = {
        runId: original.binding.runId,
        operationId,
        bindingDigest: original.binding.bindingDigest,
      };
      await f.operations.reserveExternalOperation({
        tenantId: scope.tenantId,
        runId: source.runId,
        bindingDigest: source.bindingDigest,
        operationId,
        executionId: "execution-1",
        idempotencyKey: "dispatch-1",
        actionDigest: digest,
        requestDigest: digest,
        correlationId: operationId,
        createdAt: timestamp,
      });
      const next = configuration({ revision: 2 });
      await f.first.store.saveExtensionConfiguration({
        configuration: next,
        expectedRevision: 1,
        receipt: receipt("config-2"),
      });
      await f.first.store.saveExtensionActivation({
        activation: activation(next, {
          revision: 2,
          state: "disabled",
          target: null,
        }),
        expectedRevision: 1,
        receipt: receipt("disable"),
      });
      const query = await f.prepare(runInput("query-1", { source }));
      for (const badSource of [
        { ...source, operationId: randomUUID() },
        { ...source, bindingDigest: digest },
        { ...source, runId: "foreign-run" },
      ])
        await assert.rejects(
          f.first.store.commitExtensionRun({
            ...runInput("query-1", { source: badSource }),
            expectedActivationRevision: 2,
          }),
          /query_source_not_found/u,
        );
      await assert.rejects(
        f.first.store.commitExtensionRun({
          ...runInput("query-1", {
            source,
            configurationRevision: 2,
            configurationDigest: next.contentDigest,
          }),
          expectedActivationRevision: 2,
        }),
        /query_source_not_found/u,
      );
      const admitted = await f.first.store.commitExtensionRun({
        ...query,
        expectedActivationRevision: 2,
      });
      assert.equal(admitted.binding.configurationRevision, 1);
      assert.deepEqual(admitted.binding.source, source);
      await f.first.store.saveExtensionActivation({
        activation: activation(next, {
          revision: 3,
          state: "revoked",
          target: null,
        }),
        expectedRevision: 2,
        receipt: receipt("revoke"),
      });
      const forbidden = await f.prepare(runInput("query-2", { source }));
      await assert.rejects(
        f.first.store.commitExtensionRun({
          ...forbidden,
          expectedActivationRevision: 3,
        }),
        /access_revoked/u,
      );
      assert.equal(await f.first.parent.loadRun(forbidden.binding), null);
    },
  );

  test(
    `${backend} extensions: ordinary Run creation does not acquire a plugin binding`,
    { skip },
    async (t) => {
      const f = await extensionFixture(t, backend);
      const input = await f.prepare();
      await f.first.parent.commitRun(input.commit);
      assert.equal(
        await f.first.store.loadExtensionRunBinding(input.binding),
        null,
      );
      assert.equal(await f.count("extension_run_bindings"), 0);
    },
  );

  test(
    `${backend} extensions: migration is repeatable and refuses a newer persisted version`,
    { skip },
    async (t) => {
      const f = await extensionFixture(t, backend);
      await f.first.store.migrate();
      await f.sql(
        `UPDATE ${f.prefix}extension_schema_version SET version = 99`,
      );
      await assert.rejects(
        f.first.store.migrate(),
        /schema_version_unsupported/u,
      );
      assert.equal(await f.count("extension_schema_version"), 1);
    },
  );
}
