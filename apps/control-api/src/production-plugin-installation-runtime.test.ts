import assert from "node:assert/strict";
import test from "node:test";
import { access, chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApplicationError } from "@crewon/application";
import {
  deferred,
  managementActor,
  managementFixture,
  managementScope,
  postgresOptions,
  until,
} from "./production-plugin-installation-runtime.test-support.ts";

test(
  "production management: actual approved source → install/enable/upgrade/disable/uninstall preserves history and idempotency",
  postgresOptions,
  async (t) => {
    const f = await managementFixture(t);
    const a = await f.source();
    const b = await f.source("2.0.0");
    const runtime = await f.open();
    const catalog = await runtime.service.listSources(managementActor, {
      afterSourceId: null,
      limit: 1,
    });
    assert.equal(catalog.sources[0]?.sourceId, a.sourceId);
    assert.equal(catalog.next, a.sourceId);
    assert.ok(!JSON.stringify(catalog).includes(f.root));
    assert.deepEqual(await f.ownerPids(), []);
    const installed = await f.install(runtime, a, null, "install-a");
    assert.equal(installed.selection.state, "disabled");
    assert.deepEqual(await f.events(), []);
    const enabled = await f.select(runtime, a, 1, "enabled", "enable-a");
    assert.equal(enabled.projection.outcome, "applied");
    assert.deepEqual(await f.events(), ["setup:test.management:1.0.0"]);
    const replay = await f.select(runtime, a, 1, "enabled", "enable-a");
    assert.equal(replay.mutation.disposition, "replayed");
    assert.equal((await f.events()).length, 1);
    const second = await f.install(runtime, b, 2, "install-b");
    assert.equal(second.selection.selectedPackageDigest, a.packageDigest);
    const upgrade = await f.select(runtime, b, 2);
    assert.equal(upgrade.mutation.selection.revision, 3);
    assert.equal(upgrade.projection.outcome, "applied");
    await until(async () =>
      (await f.events()).includes("cleanup:test.management:1.0.0"),
    );
    await access(
      join(f.installRoot, "packages", a.packageDigest.slice(7), "node.mjs"),
    );
    const disabled = await f.select(runtime, b, 3, "disabled");
    assert.equal(disabled.projection.outcome, "applied");
    const reenabled = await f.select(runtime, b, 4);
    assert.equal(reenabled.projection.outcome, "applied");
    const removed = await f.select(runtime, b, 5, "uninstalled");
    assert.equal(removed.mutation.selection.revision, 6);
    assert.equal(removed.mutation.selection.selectedPackageDigest, null);
    assert.equal(removed.projection.outcome, "applied");
    const history = await runtime.service.listPackages(managementActor, {
      pluginId: a.pluginId,
      afterPackageDigest: null,
      limit: 50,
    });
    assert.equal(history.packages.length, 2);
    await runtime.close();
    assert.deepEqual(await f.ownerPids(), []);
    assert.equal(
      (await f.events()).filter((item) => item.startsWith("setup:")).length,
      3,
    );
    assert.equal(
      (await f.events()).filter((item) => item.startsWith("cleanup:")).length,
      3,
    );
  },
);

test(
  "production management: cold read does not reactivate; explicit enable restores exact selected B with only its requested selection receipt",
  postgresOptions,
  async (t) => {
    const f = await managementFixture(t);
    const a = await f.source();
    const b = await f.source("2.0.0");
    const first = await f.open();
    await f.install(first, a);
    await f.install(first, b, 1);
    await f.select(first, b, 1, "enabled", "cold-enable-b");
    await first.close();
    const count = await f.observer.query(
      `SELECT count(*)::int AS count FROM "${f.schema}".plugin_installation_receipts`,
    );
    const second = await f.open();
    const selected = await second.service.getSelection(managementActor, {
      pluginId: b.pluginId,
    });
    assert.equal(selected?.selectedPackageDigest, b.packageDigest);
    assert.equal(selected?.revision, 2);
    assert.deepEqual(
      (
        await f.observer.query(
          `SELECT count(*)::int AS count FROM "${f.schema}".plugin_installation_receipts`,
        )
      ).rows,
      count.rows,
    );
    assert.equal(
      (await f.events()).filter((item) => item.startsWith("setup:")).length,
      1,
    );
    assert.equal(
      (await f.select(second, b, 1, "enabled", "cold-enable-b")).mutation
        .disposition,
      "replayed",
    );
    assert.equal(
      (await f.events()).filter((item) => item.startsWith("setup:")).length,
      1,
    );
    assert.equal((await f.select(second, b, 2)).projection.outcome, "applied");
    assert.deepEqual(
      (await f.events()).filter((item) => item.startsWith("setup:")),
      ["setup:test.management:2.0.0", "setup:test.management:2.0.0"],
    );
    assert.equal(
      (
        await f.observer.query(
          `SELECT count(*)::int AS count FROM "${f.schema}".plugin_installation_receipts`,
        )
      ).rows[0]?.count,
      count.rows[0]!.count + 1,
    );
  },
);

test(
  "production management: post-COMMIT epoch revocation leaves exact durable enabled receipt pending and cleans actual candidate",
  postgresOptions,
  async (t) => {
    const f = await managementFixture(t);
    const a = await f.source();
    const runtime = await f.open();
    await f.install(runtime, a);
    let changed = false;
    f.state.beforePolicy = async ({ action }) => {
      if (action === "pluginInstallation:select" && !changed) {
        const raw = await f.selection(a.pluginId);
        const record =
          typeof raw === "string"
            ? JSON.parse(raw)
            : (raw as { revision: number } | undefined);
        if (record?.revision === 2) {
          changed = true;
          f.state.epoch = "management_epoch_2";
        }
      }
    };
    const result = await f.select(
      runtime,
      a,
      1,
      "enabled",
      "revoked-after-commit",
    );
    assert.ok(changed);
    assert.equal(result.mutation.disposition, "committed");
    assert.equal(result.projection.outcome, "pending");
    await until(async () =>
      (await f.events()).includes("cleanup:test.management:1.0.0"),
    );
    const replay = await f.select(
      runtime,
      a,
      1,
      "enabled",
      "revoked-after-commit",
    );
    assert.equal(replay.mutation.disposition, "replayed");
    assert.equal(
      (await f.events()).filter((item) => item.startsWith("setup:")).length,
      1,
    );
    f.state.beforePolicy = null;
    const fresh = await f.select(runtime, a, 2);
    assert.equal(fresh.projection.outcome, "applied");
    assert.equal(fresh.mutation.selection.revision, 3);
  },
);

test(
  "production management: profile changes during final policy await cannot publish the committed old profile",
  postgresOptions,
  async (t) => {
    const f = await managementFixture(t);
    const a = await f.source();
    const runtime = await f.open();
    await f.install(runtime, a);
    let changed = false;
    let afterCommitCalls = 0;
    f.state.beforePolicy = async ({ action }) => {
      const raw = await f.selection(a.pluginId);
      const selected =
        typeof raw === "string"
          ? JSON.parse(raw)
          : (raw as { revision: number } | undefined);
      if (
        action === "pluginInstallation:select" &&
        selected?.revision === 2 &&
        ++afterCommitCalls === 2
      ) {
        changed = true;
        f.state.scope = { ...managementScope, profileId: "profile-revoked" };
      }
    };
    const result = await f.select(runtime, a, 1);
    assert.ok(changed);
    assert.equal(result.projection.outcome, "pending");
    await until(async () =>
      (await f.events()).includes("cleanup:test.management:1.0.0"),
    );
    assert.equal(
      result.mutation.selection.profileId,
      managementScope.profileId,
    );
    f.state.beforePolicy = null;
    f.state.scope = managementScope;
  },
);

test(
  "production management: mandatory missing host services refuse actual Node setup; optional business ports do not invent execution/price",
  postgresOptions,
  async (t) => {
    const f = await managementFixture(t);
    const required = await f.source("1.0.0", {
      pluginId: "test.required",
      requires: [{ service: "crewon.tasks", apiVersion: "2", optional: false }],
    });
    const business = await f.source("1.0.0", {
      pluginId: "test.business",
      business: true,
      requires: [
        { service: "crewon.execution", apiVersion: "1", optional: true },
      ],
    });
    const runtime = await f.open();
    await f.install(runtime, required);
    await assert.rejects(
      f.select(runtime, required, 1),
      /plugin_host_unavailable|dependency|service/u,
    );
    assert.equal(
      (
        await runtime.service.getSelection(managementActor, {
          pluginId: required.pluginId,
        })
      )?.state,
      "disabled",
    );
    assert.ok(
      !(await f.events()).some((item) => item.includes("test.required")),
    );
    await f.install(runtime, business);
    assert.equal(
      (await f.select(runtime, business, 1)).projection.outcome,
      "applied",
    );
    assert.deepEqual(
      (await f.events()).filter((item) => item.startsWith("setup:")),
      ["setup:test.business:1.0.0"],
    );
    assert.equal("createTask" in runtime.service, false);
    assert.ok(
      f.state.policyCalls.every(
        (item) =>
          Object.keys(item).sort().join(",") === "action,actor,resource",
      ),
    );
  },
);

test(
  "production management: cold required service graph recovers actual provider before consumer",
  postgresOptions,
  async (t) => {
    const f = await managementFixture(t);
    const provider = await f.source("1.0.0", {
      pluginId: "z.provider",
      provides: [{ service: "test.shared", apiVersion: "1" }],
    });
    const consumer = await f.source("1.0.0", {
      pluginId: "a.consumer",
      requires: [{ service: "test.shared", apiVersion: "1", optional: false }],
    });
    const first = await f.open();
    await f.install(first, consumer);
    await f.install(first, provider);
    await f.select(first, provider, 1);
    await f.select(first, consumer, 1);
    await first.close();
    const second = await f.open();
    const selected = await second.service.getSelection(managementActor, {
      pluginId: consumer.pluginId,
    });
    assert.equal(selected?.state, "enabled");
    assert.equal(
      (await f.select(second, consumer, 2)).projection.outcome,
      "applied",
    );
    assert.deepEqual(
      (await f.events()).filter((item) => item.startsWith("setup:")),
      [
        "setup:z.provider:1.0.0",
        "setup:a.consumer:1.0.0",
        "setup:z.provider:1.0.0",
        "setup:a.consumer:1.0.0",
      ],
    );
  },
);

test(
  "production management: logical close joins actual authority work before releasing the profile lock; close is idempotent",
  postgresOptions,
  async (t) => {
    const f = await managementFixture(t);
    const a = await f.source();
    const runtime = await f.open();
    await f.install(runtime, a);
    const entered = deferred();
    const release = deferred();
    let intercepted = false;
    f.state.beforePolicy = async () => {
      if (intercepted) return;
      intercepted = true;
      entered.resolve();
      await release.promise;
    };
    const call = runtime.service.getSelection(managementActor, {
      pluginId: a.pluginId,
    });
    const rejected = assert.rejects(call);
    await entered.promise;
    let completed = false;
    const close = runtime.close();
    try {
      assert.equal(runtime.close(), close);
      void close.then(() => {
        completed = true;
      });
      await rejected;
      assert.equal(completed, false);
      assert.equal((await f.ownerPids()).length, 1);
      assert.ok(
        await f.ledger.loadSelection({
          scope: managementScope,
          pluginId: a.pluginId,
        }),
      );
    } finally {
      release.resolve();
    }
    await close;
    assert.deepEqual(await f.ownerPids(), []);
    assert.throws(
      () =>
        runtime.service.getSelection(managementActor, { pluginId: a.pluginId }),
      /closed/u,
    );
  },
);

test(
  "production management: cold broken dependency graph remains readable and withdrawable, then explicit provider/consumer repair works",
  postgresOptions,
  async (t) => {
    const f = await managementFixture(t);
    const provider = await f.source("1.0.0", {
      pluginId: "z.provider",
      provides: [{ service: "test.shared", apiVersion: "1" }],
    });
    const consumer = await f.source("1.0.0", {
      pluginId: "a.consumer",
      requires: [{ service: "test.shared", apiVersion: "1", optional: false }],
    });
    const first = await f.open();
    await f.install(first, consumer);
    await f.install(first, provider);
    await f.select(first, provider, 1);
    await f.select(first, consumer, 1);
    await f.select(first, provider, 2, "disabled");
    await first.close();
    const second = await f.open();
    const before = f.state.policyCalls.length;
    const selected = await second.service.getSelection(managementActor, {
      pluginId: consumer.pluginId,
    });
    assert.equal(selected?.state, "enabled");
    assert.ok(
      f.state.policyCalls
        .slice(before)
        .every((item) => item.action === "pluginInstallation:read"),
    );
    await assert.rejects(
      f.select(second, consumer, 2),
      /plugin_dependency_unavailable/u,
    );
    assert.equal(
      (await f.select(second, consumer, 2, "disabled")).projection.outcome,
      "applied",
    );
    assert.equal(
      (await f.select(second, consumer, 3, "uninstalled")).projection.outcome,
      "applied",
    );
    assert.equal(
      (await f.select(second, provider, 3)).projection.outcome,
      "applied",
    );
    const installed = await f.install(second, consumer, 4);
    assert.equal(installed.selection.revision, 5);
    assert.equal(
      (await f.select(second, consumer, 5)).projection.outcome,
      "applied",
    );
  },
);

test(
  "production management: removing old approval never blocks metadata reads or disable/uninstall, and re-enable is denied",
  postgresOptions,
  async (t) => {
    const f = await managementFixture(t);
    const a = await f.source();
    const first = await f.open();
    await f.install(first, a);
    await f.select(first, a, 1);
    await first.close();
    const second = await f.open({ approvedSources: [] });
    assert.equal(
      (
        await second.service.getSelection(managementActor, {
          pluginId: a.pluginId,
        })
      )?.state,
      "enabled",
    );
    await assert.rejects(
      f.select(second, a, 2),
      /unapproved|activation_denied/u,
    );
    assert.equal(
      (await f.select(second, a, 2, "disabled")).projection.outcome,
      "applied",
    );
    assert.equal(
      (await f.select(second, a, 3, "uninstalled")).projection.outcome,
      "applied",
    );
    assert.equal(
      (await f.events()).filter((item) => item.startsWith("setup:")).length,
      1,
    );
  },
);

test(
  "production management: actual PG owner loss withdraws accepting Node and never lets a stale stamp reactivate it",
  postgresOptions,
  async (t) => {
    const f = await managementFixture(t);
    const a = await f.source();
    const runtime = await f.open();
    await f.install(runtime, a);
    await f.select(runtime, a, 1);
    const [pid] = await f.ownerPids();
    assert.ok(pid);
    await f.observer.query("SELECT pg_terminate_backend($1)", [pid]);
    await until(async () =>
      (await f.events()).includes("cleanup:test.management:1.0.0"),
    );
    await assert.rejects(
      runtime.service.getSelection(managementActor, { pluginId: a.pluginId }),
      /unavailable/u,
    );
    assert.equal(
      (await f.events()).filter((item) => item.startsWith("setup:")).length,
      1,
    );
  },
);

test(
  "production management: cleanup failure remains a real close failure and missing epochs never create a permissive grant",
  postgresOptions,
  async (t) => {
    const f = await managementFixture(t);
    const a = await f.source("1.0.0", { cleanupFails: true });
    const runtime = await f.open();
    f.state.reply = () => ({ outcome: "allow" });
    await assert.rejects(
      runtime.service.listSources(managementActor, {
        afterSourceId: null,
        limit: 50,
      }),
      /plugin_security_fields_invalid/u,
    );
    assert.deepEqual(await f.ownerPids(), []);
    f.state.reply = null;
    await f.install(runtime, a);
    f.state.deny.add("pluginInstallation:select");
    await assert.rejects(
      f.select(runtime, a, 1),
      (error: unknown) =>
        error instanceof ApplicationError && error.category === "authorization",
    );
    assert.deepEqual(await f.events(), []);
    f.state.deny.clear();
    await f.select(runtime, a, 1);
    const closing = runtime.close();
    assert.equal(runtime.close(), closing);
    await assert.rejects(closing, /cleanup_failed/u);
    assert.deepEqual(await f.events(), [
      "setup:test.management:1.0.0",
      "cleanup:test.management:1.0.0",
    ]);
  },
);

test(
  "production management: corrupted installed bytes cannot trap management read or withdrawal, and enable never imports them",
  postgresOptions,
  async (t) => {
    const f = await managementFixture(t);
    const a = await f.source();
    const first = await f.open();
    await f.install(first, a);
    await f.select(first, a, 1);
    await first.close();
    const path = join(
      f.installRoot,
      "packages",
      a.packageDigest.slice(7),
      "node.mjs",
    );
    await chmod(path, 0o600);
    await writeFile(path, "throw new Error('corrupt module must not import');");
    const second = await f.open();
    assert.equal(
      (
        await second.service.getSelection(managementActor, {
          pluginId: a.pluginId,
        })
      )?.state,
      "enabled",
    );
    await assert.rejects(f.select(second, a, 2));
    assert.equal(
      (await f.select(second, a, 2, "disabled")).projection.outcome,
      "applied",
    );
    assert.equal(
      (await f.select(second, a, 3, "uninstalled")).projection.outcome,
      "applied",
    );
    assert.equal(
      (await f.events()).filter((item) => item.startsWith("setup:")).length,
      1,
    );
  },
);
