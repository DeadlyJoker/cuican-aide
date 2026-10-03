import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { parseAgentVersionAsset } from "@crewon/agent-version";
import {
  ThreadApplicationService,
  TurnApplicationService,
  type AuthorizationPort,
} from "@crewon/application";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import { Pool } from "pg";
import { professionalProviderFixture } from "./installed-plugin-ui-business-execution.provider.test-support.ts";
import { prepareInstalledProcessTasks } from "./installed-plugin-worker-admission.test-support.ts";
import {
  installedProcessActor as actor,
  installedProcessCompletion,
  installedWorkerProcessFixture,
} from "./installed-plugin-worker-process.test-support.ts";
import {
  installedProcessBusinessRows,
  installedProcessTables,
} from "./installed-plugin-worker-release.test-support.ts";
import {
  installedReleaseProcessPackagesMissing,
  installedReleaseProcessPublicationRows,
  prepareInstalledReleaseProcessInput,
} from "./installed-plugin-release-process.test-support.ts";
import { installedPluginReleaseDigester as digester } from "./plugins/installed-plugin-release-document.ts";
import { resolveRuntimeBootstrapRoute } from "./runtime-bootstrap-defaults.ts";

const actualPackageOptions = {
  timeout: 60_000,
  skip: installedReleaseProcessPackagesMissing
    ? "actual outside-built professional-report v1/v2 packages are required"
    : false,
};

test("release CLI without installed opt-in preserves the original main and initializes no plugin schema", async (t) => {
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
  assert.equal(release.finished(), true);
  assert.equal(worker.finished(), true);
});

test("release CLI rejects a defined empty installed config before model allocation or Store open", async (t) => {
  const fixture = await installedWorkerProcessFixture(t);
  const release = fixture.start("release", {
    CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH: "",
    CREWON_MODEL_ADAPTER: "invalid-model-must-not-be-created",
  });
  assert.notEqual((await installedProcessCompletion(release)).code, 0);
  assert.match(
    release.stderr(),
    /installed_plugin_worker_configuration_invalid/u,
  );
  assert.equal(existsSync(fixture.databasePath), false);
  assert.equal(fixture.authorityRequests.length, 0);
  assert.equal(fixture.modelRequests.length, 0);
  assert.equal(release.finished(), true);
});

for (const malformed of [
  "unknown field",
  "insecure authority",
  "missing authority token",
] as const) {
  test(`release CLI rejects ${malformed} before opening Store or model`, async (t) => {
    const fixture = await installedWorkerProcessFixture(t);
    const configuration = fixture.configuration();
    await writeFile(
      fixture.configPath,
      JSON.stringify(
        malformed === "unknown field"
          ? { ...configuration, actorId: "caller-must-not-grant-permission" }
          : malformed === "insecure authority"
            ? {
                ...configuration,
                actorAuthority: {
                  ...configuration.actorAuthority,
                  url: "http://127.0.0.1:1/actor",
                },
              }
            : configuration,
      ),
      { mode: 0o600 },
    );
    const release = fixture.start("release", {
      CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH: fixture.configPath,
      CREWON_MODEL_ADAPTER: "invalid-model-must-not-be-created",
      ...(malformed === "missing authority token"
        ? { INSTALLED_PROCESS_AUTHORITY_TOKEN: undefined }
        : {}),
    });
    assert.notEqual((await installedProcessCompletion(release)).code, 0);
    assert.match(
      release.stderr(),
      /installed_plugin_worker_configuration_invalid/u,
    );
    assert.equal(existsSync(fixture.databasePath), false);
    assert.equal(fixture.authorityRequests.length, 0);
    assert.equal(fixture.modelRequests.length, 0);
  });
}

for (const field of [
  "CREWON_RELEASE_PRINCIPAL_ID",
  "CREWON_RELEASE_ACTOR_ID",
  "CREWON_TENANT_ID",
  "CREWON_SPACE_ID",
] as const) {
  test(`installed release CLI requires explicit ${field} before reading the deployment or Store`, async (t) => {
    const fixture = await installedWorkerProcessFixture(t);
    const release = fixture.start("release", {
      [field]: undefined,
      CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH: fixture.configPath,
      CREWON_MODEL_ADAPTER: "invalid-model-must-not-be-created",
    });
    assert.notEqual((await installedProcessCompletion(release)).code, 0);
    assert.match(
      release.stderr(),
      /installed_plugin_release_operator_required/u,
    );
    assert.equal(existsSync(fixture.databasePath), false);
    assert.equal(fixture.authorityRequests.length, 0);
    assert.equal(fixture.modelRequests.length, 0);
  });
}

test(
  "actual HTTPS package-read refusal leaves zero CLI publications and the preinstalled Store unchanged",
  actualPackageOptions,
  async (t) => {
    const fixture = await installedWorkerProcessFixture(t);
    await prepareInstalledReleaseProcessInput(fixture);
    const before = await readFile(fixture.databasePath);
    const beforeRows = installedReleaseProcessPublicationRows(
      fixture.databasePath,
    );
    fixture.denyPackages();
    const release = fixture.start("release");
    assert.notEqual((await installedProcessCompletion(release)).code, 0);
    assert.ok(fixture.authorityRequests.length >= 1);
    assert.ok(
      fixture.authorityRequests.every(
        ({ path, body }) => path === "/package" && body.purpose === "read",
      ),
    );
    assert.deepEqual(
      installedReleaseProcessPublicationRows(fixture.databasePath),
      beforeRows,
    );
    assert.deepEqual(await readFile(fixture.databasePath), before);
    assert.equal(fixture.modelRequests.length, 0);
    assert.equal(release.finished(), true);
  },
);

test(
  "actual CLI first publishes one complete default/source/derived bundle, replays it, and main verifies it without business allocation",
  actualPackageOptions,
  async (t) => {
    const fixture = await installedWorkerProcessFixture(t);
    const { document, plan, bindingsPath } =
      await prepareInstalledReleaseProcessInput(fixture);
    const originalInputs = await Promise.all([
      readFile(fixture.releaseDocumentPath),
      readFile(bindingsPath),
    ]);
    const first = fixture.start("release");
    assert.equal(
      (await installedProcessCompletion(first)).code,
      0,
      first.stderr(),
    );
    const firstResult = JSON.parse(first.stdout()) as {
      releaseId: string;
      activationId: string;
      disposition: string;
      agentVersionIds: string[];
    };
    assert.equal(firstResult.releaseId, plan.bundle.releaseId);
    assert.equal(firstResult.disposition, "activated");
    assert.deepEqual(
      new Set(firstResult.agentVersionIds),
      new Set(plan.deployments.map((entry) => entry.agentVersionId)),
    );
    const publications = installedReleaseProcessPublicationRows(
      fixture.databasePath,
    );
    assert.deepEqual(publications, {
      agent_versions: 4,
      agent_version_deployments: 4,
      agent_version_release_bundles: 1,
      agent_version_release_activations: 1,
      active_agent_version_releases: 1,
    });
    const replay = fixture.start("release");
    assert.equal(
      (await installedProcessCompletion(replay)).code,
      0,
      replay.stderr(),
    );
    const repeated = JSON.parse(replay.stdout()) as typeof firstResult;
    assert.equal(repeated.releaseId, firstResult.releaseId);
    assert.equal(repeated.activationId, firstResult.activationId);
    assert.equal(repeated.disposition, "replayed");
    assert.deepEqual(
      installedReleaseProcessPublicationRows(fixture.databasePath),
      publications,
    );
    const worker = fixture.start("worker", {
      CREWON_CONTROL_SECURITY_MODE: "production",
    });
    assert.equal(
      (await installedProcessCompletion(worker)).code,
      0,
      worker.stderr(),
    );
    assert.deepEqual(JSON.parse(worker.stdout()), { kind: "idle" });
    assert.deepEqual(
      await Promise.all([
        readFile(fixture.releaseDocumentPath),
        readFile(bindingsPath),
      ]),
      originalInputs,
    );
    const store = new SqliteRunStore(fixture.databasePath);
    try {
      const active = await store.loadActiveAgentVersionRelease({
        tenantId: actor.tenantId,
      });
      assert.deepEqual(active?.bundle, plan.bundle);
      assert.deepEqual(active?.activation.operator, {
        principalId: actor.principalId,
        actorId: actor.actorId,
        spaceId: actor.spaceId,
      });
      assert.equal(active?.activation.previousReleaseId, null);
      for (const version of plan.versions) {
        const asset = await store.loadAgentVersion({
          tenantId: actor.tenantId,
          agentVersionId: version.agentVersionId,
        });
        assert.ok(
          asset,
          "the CLI itself must publish every source and derived asset",
        );
        assert.deepEqual(parseAgentVersionAsset(asset, digester), version);
      }
      for (const entry of document.entries) {
        const source = await store.loadAgentVersionDeployment({
          tenantId: actor.tenantId,
          agentVersionId: entry.modelSource.version.agentVersionId,
        });
        assert.ok(source);
        const { deployedAt: _sourceTime, ...sourceCandidate } = source;
        assert.deepEqual(sourceCandidate, entry.modelSource.deployment);
        const derived = await store.loadAgentVersionDeployment({
          tenantId: actor.tenantId,
          agentVersionId: entry.version.agentVersionId,
        });
        assert.equal(
          derived?.contentDigest,
          entry.target.agentVersionContentDigest,
        );
        assert.equal(
          derived?.materializationDigest,
          entry.target.materializationDigest,
        );
        assert.equal(derived?.authorityId, entry.target.authorityId);
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
    );
    assert.equal(
      first.finished() && replay.finished() && worker.finished(),
      true,
    );
  },
);

test(
  "a source binding missing from the explicit manifest cannot cause a prerequisite publication or partial activation",
  actualPackageOptions,
  async (t) => {
    const fixture = await installedWorkerProcessFixture(t);
    const { bindingsPath } = await prepareInstalledReleaseProcessInput(fixture);
    await writeFile(
      bindingsPath,
      JSON.stringify({
        schemaVersion: "crewon.agent-version-runtime-bindings.v0",
        bindings: [],
      }),
      { mode: 0o600 },
    );
    const before = installedReleaseProcessPublicationRows(fixture.databasePath);
    const release = fixture.start("release");
    assert.notEqual((await installedProcessCompletion(release)).code, 0);
    assert.match(
      release.stderr(),
      /installed_plugin_release_publication_(source_deployment_missing|input_conflict)/u,
    );
    assert.deepEqual(
      installedReleaseProcessPublicationRows(fixture.databasePath),
      before,
    );
    assert.equal(fixture.modelRequests.length, 0);
  },
);

test(
  "an explicit source binding with another materialization cannot be rebased by the publication CLI",
  actualPackageOptions,
  async (t) => {
    const fixture = await installedWorkerProcessFixture(t);
    const { document, bindingsPath } =
      await prepareInstalledReleaseProcessInput(fixture);
    const original = document.entries[0]!.modelSource.runtimeBinding;
    assert.equal(original.provider.kind, "directResponses");
    const conflicting = {
      ...original,
      provider: {
        ...original.provider,
        endpoint: `${fixture.endpoint}/different-materialization`,
      },
    };
    await writeFile(
      bindingsPath,
      JSON.stringify({
        schemaVersion: "crewon.agent-version-runtime-bindings.v0",
        bindings: [conflicting],
      }),
      { mode: 0o600 },
    );
    const before = installedReleaseProcessPublicationRows(fixture.databasePath);
    const release = fixture.start("release");
    assert.notEqual((await installedProcessCompletion(release)).code, 0);
    assert.match(
      release.stderr(),
      /installed_plugin_release_.*(mismatch|conflict)/u,
    );
    assert.deepEqual(
      installedReleaseProcessPublicationRows(fixture.databasePath),
      before,
    );
    assert.equal(fixture.modelRequests.length, 0);
  },
);

test(
  "actual release CLI and production main execute pinned old/current supplier packages and the unchanged default Agent",
  actualPackageOptions,
  async (t) => {
    const provider = await professionalProviderFixture(t);
    const fixture = await installedWorkerProcessFixture(t);
    const { document, plan } = await prepareInstalledReleaseProcessInput(
      fixture,
      {
        organization: "Actual release process fixture company",
        providerBaseUrl: `${provider.baseUrl}/`,
      },
    );
    const release = fixture.start("release");
    assert.equal(
      (await installedProcessCompletion(release)).code,
      0,
      release.stderr(),
    );
    const { admitted, original, quotes } = await prepareInstalledProcessTasks(
      fixture,
      document,
    );
    assert.equal(
      quotes,
      2,
      "named test admission alone supplies funds and quotes, never CLI or main",
    );
    const before = installedProcessBusinessRows(fixture.databasePath);
    const publications = installedReleaseProcessPublicationRows(
      fixture.databasePath,
    );
    for (const runId of [
      ...admitted.map((task) => task.binding.runId),
      original.runState.runId,
    ]) {
      const worker = fixture.start("worker", {
        CREWON_CONTROL_SECURITY_MODE: "production",
      });
      assert.equal(
        (await installedProcessCompletion(worker)).code,
        0,
        worker.stderr(),
      );
      assert.deepEqual(JSON.parse(worker.stdout()), {
        kind: "completed",
        runId,
      });
      assert.equal(worker.finished(), true);
    }
    assert.deepEqual(
      installedProcessBusinessRows(fixture.databasePath),
      before,
    );
    assert.deepEqual(
      installedReleaseProcessPublicationRows(fixture.databasePath),
      publications,
    );
    assert.deepEqual(
      provider
        .requests()
        .filter((request) => request.method === "POST")
        .map((request) => JSON.parse(request.body!).pluginVersion),
      ["1.0.0", "2.0.0"],
    );
    assert.equal(fixture.modelRequests.length, 5);
    const ordinary = fixture.modelRequests.filter(
      (request) =>
        !(request.tools as { name: string }[]).some(
          (tool) => tool.name === "example_professional__generate",
        ),
    );
    assert.equal(ordinary.length, 1);
    assert.deepEqual(
      new Set(
        (ordinary[0]!.tools as { name: string }[]).map((tool) => tool.name),
      ),
      new Set(["get_goal", "create_goal", "update_plan"]),
    );
    const store = new SqliteRunStore(fixture.databasePath);
    try {
      assert.deepEqual(
        (
          await store.loadActiveAgentVersionRelease({
            tenantId: actor.tenantId,
          })
        )?.bundle,
        plan.bundle,
      );
      for (const [index, accepted] of admitted.entries()) {
        assert.equal(
          (await store.loadRunInSpace(accepted.binding))?.status,
          "completed",
        );
        const binding = await store
          .extensionStore()
          .loadExtensionRunBinding(accepted.binding);
        assert.deepEqual(binding?.target, document.entries[index]!.target);
        const admission = await store
          .extensionStore()
          .loadPluginTaskAdmission(accepted.binding);
        assert.equal(
          admission?.packageDigest,
          document.entries[index]!.packageIdentity.packageDigest,
        );
        assert.equal(admission?.version, index === 0 ? "1.0.0" : "2.0.0");
        assert.equal(admission?.principalId, actor.principalId);
        const messages = await store.listMessages(accepted.binding, 0, 100);
        assert.match(
          JSON.stringify(messages.at(-1)?.content),
          new RegExp(
            `answer:professional:${index + 1}\\.0\\.0:Actual release process fixture company`,
            "u",
          ),
        );
      }
      assert.equal(
        (
          await store.loadRunInSpace({
            tenantId: actor.tenantId,
            spaceId: actor.spaceId,
            runId: original.runState.runId,
          })
        )?.status,
        "completed",
      );
    } finally {
      await store.close();
    }
  },
);

test(
  "release CLI timeout joins the actual HTTPS response before child close and leaves no Agent publication",
  actualPackageOptions,
  async (t) => {
    const fixture = await installedWorkerProcessFixture(t);
    await prepareInstalledReleaseProcessInput(fixture);
    await writeFile(
      fixture.configPath,
      JSON.stringify(fixture.configuration(1000)),
      { mode: 0o600 },
    );
    const pending = fixture.holdPackageResponse();
    const release = fixture.start("release");
    await Promise.race([
      pending.started,
      release.completion.then(() =>
        assert.fail(
          `release exited before the held authority request: ${release.stderr()}`,
        ),
      ),
    ]);
    await pending.closed;
    assert.notEqual((await installedProcessCompletion(release)).code, 0);
    assert.ok(
      Object.values(
        installedReleaseProcessPublicationRows(fixture.databasePath),
      ).every((count) => count === 0),
    );
    assert.equal(fixture.modelRequests.length, 0);
    assert.equal(release.finished(), true);
  },
);

test(
  "actual PostgreSQL release CLI publishes and replays the same full installed bundle, then main executes the original default Run",
  {
    timeout: 60_000,
    skip:
      installedReleaseProcessPackagesMissing ||
      !process.env.CREWON_TEST_POSTGRES_URL
        ? "actual professional-report packages and CREWON_TEST_POSTGRES_URL are required"
        : false,
  },
  async (t) => {
    const fixture = await installedWorkerProcessFixture(t);
    const connectionString = process.env.CREWON_TEST_POSTGRES_URL!;
    const schema = `release_process_${randomUUID().replaceAll("-", "")}`;
    const database = new Pool({ connectionString, max: 1 });
    t.after(async () => {
      try {
        await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await database.end();
      }
    });
    fixture.environment.CREWON_CONTROL_DATABASE_URL = connectionString;
    fixture.environment.CREWON_CONTROL_DATABASE_SCHEMA = schema;
    const prepared = await PostgresDomainStore.open({
      connectionString,
      schema,
    });
    const { plan, document } = await prepareInstalledReleaseProcessInput(
      fixture,
      undefined,
      { store: prepared },
    );
    assert.equal(
      existsSync(fixture.databasePath),
      false,
      "the actual PostgreSQL setup cannot silently use SQLite",
    );
    const first = fixture.start("release");
    assert.equal(
      (await installedProcessCompletion(first)).code,
      0,
      first.stderr(),
    );
    const published = JSON.parse(first.stdout()) as {
      releaseId: string;
      disposition: string;
      activationId: string;
    };
    assert.equal(published.releaseId, plan.bundle.releaseId);
    assert.equal(published.disposition, "activated");
    const replay = fixture.start("release");
    assert.equal(
      (await installedProcessCompletion(replay)).code,
      0,
      replay.stderr(),
    );
    assert.deepEqual(JSON.parse(replay.stdout()), {
      ...JSON.parse(first.stdout()),
      disposition: "replayed",
    });
    for (const [table, count] of [
      ["agent_versions", 4],
      ["agent_version_deployments", 4],
      ["agent_version_release_bundles", 1],
      ["agent_version_release_activations", 1],
      ["active_agent_version_releases", 1],
    ] as const) {
      assert.equal(
        (
          await database.query(
            `SELECT COUNT(*)::integer AS count FROM "${schema}".${table}`,
          )
        ).rows[0]!.count,
        count,
      );
    }
    const metadata = fixture.start("worker", {
      CREWON_CONTROL_SECURITY_MODE: "production",
    });
    assert.equal(
      (await installedProcessCompletion(metadata)).code,
      0,
      metadata.stderr(),
    );
    assert.deepEqual(JSON.parse(metadata.stdout()), { kind: "idle" });
    assert.equal(fixture.modelRequests.length, 0);
    const store = await PostgresDomainStore.open({ connectionString, schema });
    let runId: string;
    try {
      assert.deepEqual(
        (
          await store.loadActiveAgentVersionRelease({
            tenantId: actor.tenantId,
          })
        )?.bundle,
        plan.bundle,
      );
      for (const version of plan.versions) {
        const asset = await store.loadAgentVersion({
          tenantId: actor.tenantId,
          agentVersionId: version.agentVersionId,
        });
        assert.ok(asset);
        assert.deepEqual(parseAgentVersionAsset(asset, digester), version);
      }
      for (const entry of document.entries) {
        const actual = await store.loadAgentVersionDeployment({
          tenantId: actor.tenantId,
          agentVersionId: entry.version.agentVersionId,
        });
        assert.equal(
          actual?.contentDigest,
          entry.target.agentVersionContentDigest,
        );
        assert.equal(
          actual?.materializationDigest,
          entry.target.materializationDigest,
        );
      }
      // Explicit test authority creates one ordinary Run. It supplies no installed task quote or funding.
      const dependencies = {
        store,
        authorization: {
          async authorize(
            input: Parameters<AuthorizationPort["authorize"]>[0],
          ) {
            assert.deepEqual(input.actor, actor);
            return { outcome: "allow" as const };
          },
        },
        clock: { now: () => new Date().toISOString() },
        ids: { nextId: () => randomUUID() },
        digester,
      };
      const thread = await new ThreadApplicationService(
        dependencies,
      ).createThread(actor, {
        kind: "thread.create",
        idempotencyKey: "release-process-postgres-default-thread",
        title: null,
      });
      const turn = await new TurnApplicationService(dependencies).startTurn(
        actor,
        {
          kind: "turn.start",
          idempotencyKey: "release-process-postgres-default-turn",
          threadId: thread.state.threadId,
          expectedThreadRevision: thread.state.revision,
          content: "Use the unchanged default Agent.",
          requestedAgentVersionId: null,
          executionIntent: "none",
          route: resolveRuntimeBootstrapRoute(fixture.environment),
        },
      );
      runId = turn.runState.runId;
    } finally {
      await store.close();
    }
    const worker = fixture.start("worker", {
      CREWON_CONTROL_SECURITY_MODE: "production",
    });
    assert.equal(
      (await installedProcessCompletion(worker)).code,
      0,
      worker.stderr(),
    );
    assert.deepEqual(JSON.parse(worker.stdout()), { kind: "completed", runId });
    assert.equal(fixture.modelRequests.length, 1);
    assert.deepEqual(
      new Set(
        (fixture.modelRequests[0]!.tools as { name: string }[]).map(
          (tool) => tool.name,
        ),
      ),
      new Set(["get_goal", "create_goal", "update_plan"]),
    );
    assert.equal(existsSync(fixture.databasePath), false);
    assert.equal(
      first.finished() &&
        replay.finished() &&
        metadata.finished() &&
        worker.finished(),
      true,
    );
  },
);
