import assert from "node:assert/strict";
import { chmod, cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { SqliteRunStore } from "@crewon/store";
import { verifyLocalPluginPackage } from "@crewon/plugin-host";
import { createHash } from "node:crypto";
import { parseDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import { createDesktopPluginSourceRegistry } from "./desktop-plugin-source-registry.ts";
import { createProductionPluginSourceRegistry } from "./production-plugin-source-registry.ts";
import {
  createDesktopPluginRuntime,
  type DesktopPluginRuntime,
} from "./desktop-plugin-runtime.ts";
import {
  managementActor,
  managementFixture,
  managementScope,
  postgresOptions,
} from "./production-plugin-installation-runtime.test-support.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";

type SourceFixture = Awaited<ReturnType<typeof productionSourceFixture>>;
type Source = Awaited<ReturnType<SourceFixture["source"]>>;
function desktopIdentity() {
  return new StandaloneIdentity({
    actor: managementActor,
    sessionToken: "s".repeat(32),
    csrfToken: "c".repeat(32),
    allowedOrigins: ["crewon://desktop"],
  });
}
function desktopConfiguration(f: SourceFixture, sources: readonly Source[]) {
  return parseDesktopPluginConfiguration({
    schemaVersion: "crewon.desktop-plugin-bootstrap.v1",
    actor: managementActor,
    scope: managementScope,
    authorityEpoch: "native-approved-source-availability-epoch-01",
    installRoot: f.installRoot,
    sources: f.configuration(sources).sources,
    publications: [],
  });
}
async function breakSource(
  directory: string,
  fault: "missing" | "corrupt" | "unsafe",
) {
  if (fault === "missing") await rm(directory, { recursive: true });
  else if (fault === "corrupt")
    await writeFile(join(directory, "node.mjs"), "changed provider code");
  else await chmod(directory, 0o755);
}

for (const kind of ["desktop", "production"] as const) {
  test(`${kind} only lists real available bytes and explicitly rediscovers restored delivery without changing approved identity`, async (t) => {
    const f = await productionSourceFixture(t);
    const a = await f.source("a-source");
    const z = await f.source("z-source", { version: "2.0.0" });
    const backup = join(f.root, "backup");
    await cp(a.directory, backup, { recursive: true });
    await rm(a.directory, { recursive: true });
    const registry =
      kind === "desktop"
        ? await createDesktopPluginSourceRegistry(
            desktopConfiguration(f, [a, z]),
          )
        : await createProductionPluginSourceRegistry(f.configuration([a, z]));
    assert.deepEqual(
      registry.list().map((source) => source.sourceId),
      [z.sourceId],
    );
    assert.equal(
      registry.authorizeCandidate({
        descriptor: a.descriptor,
        packageDigest: a.packageDigest,
      }),
      "allow",
    );
    await assert.rejects(registry.resolveSource(a.sourceId));
    assert.equal(
      registry.authorizeCandidate({
        descriptor: { ...a.descriptor, version: "9.0.0" },
        packageDigest: a.packageDigest,
      }),
      "deny",
    );
    await cp(backup, a.directory, { recursive: true });
    assert.deepEqual(
      registry.list().map((source) => source.sourceId),
      [z.sourceId],
    );
    assert.equal(await registry.resolveSource(a.sourceId), a.directory);
    assert.deepEqual(
      registry.list().map((source) => source.sourceId),
      [a.sourceId, z.sourceId],
    );
    assert.equal(registry.list()[0]!.title, a.descriptor.title);
    assert.ok(!JSON.stringify(registry.list()).includes(f.root));
    await chmod(a.directory, 0o755);
    await assert.rejects(
      registry.resolveSource(a.sourceId),
      /private_directory_required/u,
    );
    assert.deepEqual(
      registry.list().map((source) => source.sourceId),
      [z.sourceId],
    );
    await assert.rejects(readFile(f.marker), { code: "ENOENT" });
    const overlap = { ...a, directory: join(f.installRoot, "missing-source") };
    await assert.rejects(
      kind === "desktop"
        ? createDesktopPluginSourceRegistry(desktopConfiguration(f, [overlap]))
        : createProductionPluginSourceRegistry(f.configuration([overlap])),
      /directory_conflict/u,
    );
  });
}

test("SQLite UI reads actual installed assets after source removal; approval withdrawal rejects mounting while management stays available", async (t) => {
  const runtimes: DesktopPluginRuntime[] = [];
  let store: SqliteRunStore | undefined;
  const f = await productionSourceFixture(t, {
    beforeCleanup: async () => {
      for (const runtime of runtimes) await runtime.close();
      await store?.close();
    },
  });
  const pkg = await f.source("independent-ui", { uiOnly: true });
  const bytes = await readFile(join(pkg.directory, "ui.mjs"));
  const configuration = parseDesktopPluginConfiguration({
    ...desktopConfiguration(f, [pkg]),
    publications: [
      {
        pluginId: pkg.pluginId,
        publisherId: pkg.publisherId,
        packageDigest: pkg.packageDigest,
        publicAssets: ["ui.mjs"],
      },
    ],
  });
  store = new SqliteRunStore(join(f.root, "independent-ui.sqlite"));
  const open = async (approved = configuration) => {
    const runtime = await createDesktopPluginRuntime(
      { configuration: approved },
      {
        store: store!,
        identity: desktopIdentity(),
        clock: { now: () => "2026-10-03T04:00:00.000Z" },
        digester: {
          sha256: (value) =>
            `sha256:${createHash("sha256").update(value).digest("hex")}`,
        },
      },
    );
    runtimes.push(runtime);
    return runtime;
  };
  const first = await open();
  await first.installation.install(managementActor, {
    sourceId: pkg.sourceId,
    expectedPluginId: pkg.pluginId,
    expectedPackageDigest: pkg.packageDigest,
    expectedSelectionRevision: null,
    idempotencyKey: "ui-install",
  });
  await first.installation.select(managementActor, {
    pluginId: pkg.pluginId,
    state: "enabled",
    selectedPackageDigest: pkg.packageDigest,
    expectedSelectionRevision: 1,
    idempotencyKey: "ui-enable",
  });
  await first.close();
  await rm(pkg.directory, { recursive: true });
  const second = await open();
  assert.deepEqual(
    (
      await second.sources.listSources(managementActor, {
        afterSourceId: null,
        limit: 50,
      })
    ).sources,
    [],
  );
  const command = {
    pluginId: pkg.pluginId,
    contributionId: "workbench",
    expectedSelectionRevision: 2,
    expectedPackageDigest: pkg.packageDigest,
  };
  const lease = await second.ui.openMount(managementActor, command);
  assert.equal(lease.packageDigest, pkg.packageDigest);
  const asset = await second.ui.readAsset(managementActor, {
    mountRef: lease.mountRef,
    path: "ui.mjs",
  });
  assert.deepEqual(Buffer.from(asset.bytes), bytes);
  await assert.rejects(
    second.ui.invoke(managementActor, {
      mountRef: lease.mountRef,
      action: "image.generate",
      input: {},
    }),
    /plugin_ui_authorization_denied/u,
  );
  await second.close();
  const withdrawn = await open(desktopConfiguration(f, []));
  assert.equal(
    (
      await withdrawn.installation.getSelection(managementActor, {
        pluginId: pkg.pluginId,
      })
    )?.state,
    "enabled",
  );
  await assert.rejects(
    withdrawn.ui.openMount(managementActor, command),
    /plugin_ui_authorization_denied/u,
  );
  assert.equal(
    (
      await withdrawn.installation.select(managementActor, {
        pluginId: pkg.pluginId,
        state: "disabled",
        selectedPackageDigest: pkg.packageDigest,
        expectedSelectionRevision: 2,
        idempotencyKey: "ui-withdraw",
      })
    ).projection.outcome,
    "applied",
  );
  await assert.rejects(readFile(f.marker), { code: "ENOENT" });
});

for (const fault of ["missing", "corrupt", "unsafe"] as const) {
  test(`SQLite immutable installed copy remains manageable and loadable after delivery becomes ${fault}; withdrawn approval still rejects it`, async (t) => {
    const runtimes: DesktopPluginRuntime[] = [];
    let store: SqliteRunStore | undefined;
    const f = await productionSourceFixture(t, {
      beforeCleanup: async () => {
        for (const runtime of runtimes) await runtime.close();
        await store?.close();
      },
    });
    const pkg = await f.source("independent-source", { validNode: true });
    const configuration = desktopConfiguration(f, [pkg]);
    store = new SqliteRunStore(join(f.root, "independent.sqlite"));
    const dependencies = {
      store,
      identity: desktopIdentity(),
      clock: { now: () => "2026-10-03T04:00:00.000Z" },
      digester: {
        sha256: (value: string) =>
          `sha256:${createHash("sha256").update(value).digest("hex")}`,
      },
    };
    const open = async (approved = configuration) => {
      const runtime = await createDesktopPluginRuntime(
        { configuration: approved },
        dependencies,
      );
      runtimes.push(runtime);
      return runtime;
    };
    const select = (
      runtime: DesktopPluginRuntime,
      revision: number,
      state: "enabled" | "disabled" | "uninstalled" = "enabled",
    ) =>
      runtime.installation.select(managementActor, {
        pluginId: pkg.pluginId,
        state,
        selectedPackageDigest:
          state === "uninstalled" ? null : pkg.packageDigest,
        expectedSelectionRevision: revision,
        idempotencyKey: `${fault}-${state}-${revision}`,
      });
    const first = await open();
    await first.installation.install(managementActor, {
      sourceId: pkg.sourceId,
      expectedPluginId: pkg.pluginId,
      expectedPackageDigest: pkg.packageDigest,
      expectedSelectionRevision: null,
      idempotencyKey: "initial-install",
    });
    assert.equal((await select(first, 1)).projection.outcome, "applied");
    await first.close();
    const initialEvents = await readFile(f.marker, "utf8");
    await breakSource(pkg.directory, fault);
    const second = await open();
    assert.deepEqual(
      (
        await second.sources.listSources(managementActor, {
          afterSourceId: null,
          limit: 50,
        })
      ).sources,
      [],
    );
    const saved = await second.installation.getSelection(managementActor, {
      pluginId: pkg.pluginId,
    });
    assert.equal(saved?.state, "enabled");
    assert.equal(saved?.selectedPackageDigest, pkg.packageDigest);
    assert.equal(await readFile(f.marker, "utf8"), initialEvents);
    assert.equal((await select(second, 1)).mutation.disposition, "replayed");
    assert.equal(await readFile(f.marker, "utf8"), initialEvents);
    await assert.rejects(
      second.installation.install(managementActor, {
        sourceId: pkg.sourceId,
        expectedPluginId: pkg.pluginId,
        expectedPackageDigest: pkg.packageDigest,
        expectedSelectionRevision: 2,
        idempotencyKey: "unavailable-install",
      }),
    );
    const installed = await verifyLocalPluginPackage({
      directory: join(f.installRoot, "packages", pkg.packageDigest.slice(7)),
    });
    assert.equal(installed.packageDigest, pkg.packageDigest);
    assert.equal((await select(second, 2)).projection.outcome, "applied");
    assert.equal(
      (await select(second, 3, "disabled")).projection.outcome,
      "applied",
    );
    await second.close();
    const afterEnabled = await readFile(f.marker, "utf8");
    assert.equal((afterEnabled.match(/:setup/gu) ?? []).length, 2);
    const withdrawn = await open(desktopConfiguration(f, []));
    assert.equal(
      (
        await withdrawn.installation.getSelection(managementActor, {
          pluginId: pkg.pluginId,
        })
      )?.revision,
      4,
    );
    await assert.rejects(select(withdrawn, 4));
    assert.equal(await readFile(f.marker, "utf8"), afterEnabled);
    assert.equal(
      (await select(withdrawn, 4, "uninstalled")).projection.outcome,
      "applied",
    );
  });

  test(
    `Postgres actual business installed copy survives ${fault} source delivery and cold replay; approval removal denies reactivation`,
    postgresOptions,
    async (t) => {
      const f = await managementFixture(t);
      const pkg = await f.source("1.0.0", { business: true });
      const first = await f.open();
      await f.install(first, pkg);
      assert.equal(
        (await f.select(first, pkg, 1, "enabled", "initial-enable")).projection
          .outcome,
        "applied",
      );
      await first.close();
      await breakSource(pkg.directory, fault);
      const second = await f.open();
      assert.deepEqual(
        (
          await second.service.listSources(managementActor, {
            afterSourceId: null,
            limit: 50,
          })
        ).sources,
        [],
      );
      const saved = await second.service.getSelection(managementActor, {
        pluginId: pkg.pluginId,
      });
      assert.equal(saved?.selectedPackageDigest, pkg.packageDigest);
      assert.equal(saved?.state, "enabled");
      const replay = await f.select(
        second,
        pkg,
        1,
        "enabled",
        "initial-enable",
      );
      assert.equal(replay.mutation.disposition, "replayed");
      assert.equal(replay.projection.outcome, "unchanged");
      assert.equal((await f.events()).length, 2);
      await assert.rejects(f.install(second, pkg, 2, "unavailable-install"));
      const installed = await verifyLocalPluginPackage({
        directory: join(f.installRoot, "packages", pkg.packageDigest.slice(7)),
      });
      assert.equal(installed.packageDigest, pkg.packageDigest);
      assert.equal(
        (await f.select(second, pkg, 2)).projection.outcome,
        "applied",
      );
      assert.equal(
        (await f.select(second, pkg, 3, "disabled")).projection.outcome,
        "applied",
      );
      await second.close();
      const beforeRevocation = await f.events();
      assert.equal(
        beforeRevocation.filter((event) => event.startsWith("setup:")).length,
        2,
      );
      const withdrawn = await f.open({ approvedSources: [] });
      assert.equal(
        (
          await withdrawn.service.getSelection(managementActor, {
            pluginId: pkg.pluginId,
          })
        )?.revision,
        4,
      );
      await assert.rejects(f.select(withdrawn, pkg, 4));
      assert.deepEqual(await f.events(), beforeRevocation);
      assert.equal(
        (await f.select(withdrawn, pkg, 4, "uninstalled")).projection.outcome,
        "applied",
      );
    },
  );
}
