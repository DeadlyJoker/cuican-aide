import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { SqliteRunStore } from "@crewon/store";
import {
  installedProcessActor,
  installedProcessCompletion,
  installedProcessScope,
  installedWorkerProcessFixture,
} from "./installed-plugin-worker-process.test-support.ts";
import {
  deliveredInstalledProcessPackage,
  installedProcessBusinessRows,
  installedProcessTables,
  prepareInstalledWorkerRelease,
} from "./installed-plugin-worker-release.test-support.ts";

const packageDirectories = [
  deliveredInstalledProcessPackage("1.0.0"),
  deliveredInstalledProcessPackage("2.0.0"),
];
const packagesMissing = packageDirectories.some(
  (directory) => !existsSync(directory),
);

test("formal Worker without installed opt-in preserves release startup and does not create plugin schemas", async (t) => {
  const fixture = await installedWorkerProcessFixture(t);
  const release = fixture.start("release");
  assert.equal(
    (await installedProcessCompletion(release)).code,
    0,
    release.stderr(),
  );
  const worker = fixture.start("worker");
  assert.equal(
    (await installedProcessCompletion(worker)).code,
    0,
    worker.stderr(),
  );
  assert.deepEqual(JSON.parse(worker.stdout()), { kind: "idle" });
  assert.deepEqual(
    installedProcessTables(fixture.databasePath).filter(
      (table) => table.startsWith("plugin_") || table.startsWith("extension_"),
    ),
    [],
  );
  assert.equal(fixture.authorityRequests.length, 0);
  assert.equal(fixture.modelRequests.length, 0);
});

test("formal Worker rejects a defined empty installed config before creating storage or model resources", async (t) => {
  const fixture = await installedWorkerProcessFixture(t);
  const worker = fixture.start("worker", {
    CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH: "",
    CREWON_MODEL_ADAPTER: "invalid-model-must-not-be-created",
  });
  assert.notEqual((await installedProcessCompletion(worker)).code, 0);
  assert.match(
    worker.stderr(),
    /installed_plugin_worker_configuration_invalid/u,
  );
  assert.equal(existsSync(fixture.databasePath), false);
  assert.equal(fixture.authorityRequests.length, 0);
  assert.equal(fixture.modelRequests.length, 0);
});

for (const invalid of [
  "unknown field",
  "insecure authority",
  "missing authority token",
] as const) {
  test(`formal Worker rejects ${invalid} in its strict installed configuration before Store open`, async (t) => {
    const fixture = await installedWorkerProcessFixture(t);
    const configuration = fixture.configuration();
    const value =
      invalid === "unknown field"
        ? { ...configuration, actorId: "caller-must-not-grant-identity" }
        : invalid === "insecure authority"
          ? {
              ...configuration,
              actorAuthority: {
                ...configuration.actorAuthority,
                url: "http://127.0.0.1:1/actor",
              },
            }
          : configuration;
    await writeFile(fixture.configPath, JSON.stringify(value), { mode: 0o600 });
    const worker = fixture.start("worker", {
      CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH: fixture.configPath,
      CREWON_MODEL_ADAPTER: "invalid-model-must-not-be-created",
      ...(invalid === "missing authority token"
        ? { INSTALLED_PROCESS_AUTHORITY_TOKEN: undefined }
        : {}),
    });
    assert.notEqual((await installedProcessCompletion(worker)).code, 0);
    assert.match(
      worker.stderr(),
      /installed_plugin_worker_configuration_invalid/u,
    );
    assert.equal(existsSync(fixture.databasePath), false);
    assert.equal(fixture.authorityRequests.length, 0);
    assert.equal(fixture.modelRequests.length, 0);
  });
}

test(
  "formal Worker verifies two real installed Krea versions and the complete activated release without starting business or providers",
  {
    skip: packagesMissing
      ? "actual delivered Krea v1/v2 packages are required"
      : false,
  },
  async (t) => {
    const fixture = await installedWorkerProcessFixture(t);
    const originalRelease = fixture.start("release");
    assert.equal(
      (await installedProcessCompletion(originalRelease)).code,
      0,
      originalRelease.stderr(),
    );
    const { document, plan } = await prepareInstalledWorkerRelease(
      fixture,
      packageDirectories,
    );
    const filesBefore = await readFile(fixture.releaseDocumentPath);
    const worker = fixture.start("worker", {
      CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH: fixture.configPath,
    });
    assert.equal(
      (await installedProcessCompletion(worker)).code,
      0,
      worker.stderr(),
    );
    assert.deepEqual(JSON.parse(worker.stdout()), { kind: "idle" });
    assert.deepEqual(await readFile(fixture.releaseDocumentPath), filesBefore);
    assert.ok(fixture.authorityRequests.length >= 2);
    assert.ok(
      fixture.authorityRequests.every(
        ({ path, body }) => path === "/package" && body.purpose === "read",
      ),
    );
    assert.deepEqual(
      new Set(
        fixture.authorityRequests.map(
          ({ body }) =>
            (body.identity as { packageDigest: string }).packageDigest,
        ),
      ),
      new Set(
        document.entries.map((entry) => entry.packageIdentity.packageDigest),
      ),
    );
    const store = new SqliteRunStore(fixture.databasePath);
    try {
      const active = await store.loadActiveAgentVersionRelease({
        tenantId: installedProcessActor.tenantId,
      });
      assert.equal(active?.bundle.releaseId, plan.bundle.releaseId);
      for (const entry of document.entries) {
        const deployment = await store.loadAgentVersionDeployment({
          tenantId: installedProcessActor.tenantId,
          agentVersionId: entry.version.agentVersionId,
        });
        assert.equal(
          deployment?.contentDigest,
          entry.target.agentVersionContentDigest,
        );
        assert.equal(
          deployment?.materializationDigest,
          entry.target.materializationDigest,
        );
        assert.equal(deployment?.authorityId, entry.target.authorityId);
        assert.deepEqual(entry.scope, installedProcessScope);
      }
    } finally {
      await store.close();
    }
    assert.equal(fixture.modelRequests.length, 0);
    assert.ok(
      Object.values(installedProcessBusinessRows(fixture.databasePath)).every(
        (count) => count === 0,
      ),
    );
    assert.ok(
      !installedProcessTables(fixture.databasePath).includes(
        "plugin_credit_accounts",
      ),
      "startup must not initialize or fund a wallet",
    );
  },
);

test(
  "formal Worker denies installed metadata read through the real HTTPS package authority before touching the published Store",
  {
    skip: packagesMissing
      ? "actual delivered Krea packages are required"
      : false,
  },
  async (t) => {
    const fixture = await installedWorkerProcessFixture(t);
    const release = fixture.start("release");
    assert.equal(
      (await installedProcessCompletion(release)).code,
      0,
      release.stderr(),
    );
    await prepareInstalledWorkerRelease(fixture, [packageDirectories[0]!]);
    const databaseBefore = await readFile(fixture.databasePath);
    fixture.denyPackages();
    const worker = fixture.start("worker", {
      CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH: fixture.configPath,
    });
    assert.notEqual((await installedProcessCompletion(worker)).code, 0);
    assert.equal(fixture.authorityRequests.length, 1);
    assert.equal(fixture.authorityRequests[0]!.body.purpose, "read");
    assert.deepEqual(await readFile(fixture.databasePath), databaseBefore);
    assert.equal(fixture.modelRequests.length, 0);
  },
);

test(
  "formal Worker timeout closes the physical HTTPS authority body before failed startup terminates",
  {
    skip: packagesMissing
      ? "actual delivered Krea packages are required"
      : false,
  },
  async (t) => {
    const fixture = await installedWorkerProcessFixture(t);
    const release = fixture.start("release");
    assert.equal(
      (await installedProcessCompletion(release)).code,
      0,
      release.stderr(),
    );
    await prepareInstalledWorkerRelease(fixture, [packageDirectories[0]!]);
    const untouchedDatabase = join(fixture.directory, "never-opened.sqlite");
    await writeFile(
      fixture.configPath,
      JSON.stringify(fixture.configuration(1000)),
      { mode: 0o600 },
    );
    const hold = fixture.holdPackageResponse();
    const worker = fixture.start("worker", {
      CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH: fixture.configPath,
      CREWON_CONTROL_DB_PATH: untouchedDatabase,
    });
    await Promise.race([
      hold.started,
      worker.completion.then(() => {
        throw new Error(`authority hold never started: ${worker.stderr()}`);
      }),
    ]);
    const result = await installedProcessCompletion(worker);
    await hold.closed;
    assert.notEqual(result.code, 0);
    assert.equal(worker.finished(), true);
    assert.equal(existsSync(untouchedDatabase), false);
    assert.equal(fixture.modelRequests.length, 0);
  },
);
