import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertInstalledPluginReleaseCliInput,
  loadInstalledPluginReleaseCliInput,
} from "./plugins/installed-plugin-release-cli-input.ts";
import { INSTALLED_PLUGIN_WORKER_CONFIG_ENV } from "./plugins/installed-plugin-worker-config.ts";
import {
  installedReleaseFixture,
  releaseActor as actor,
} from "./installed-plugin-release-loader.test-support.ts";

const explicitOperator = Object.freeze({
  CREWON_RELEASE_PRINCIPAL_ID: actor.principalId,
  CREWON_RELEASE_ACTOR_ID: actor.actorId,
  CREWON_TENANT_ID: actor.tenantId,
  CREWON_SPACE_ID: actor.spaceId,
});
const missingPath = "/explicit-unavailable-plugin-release/config.json";

test("omitting installed publication keeps the original release operator and legacy path untouched", async () => {
  assert.equal(
    await loadInstalledPluginReleaseCliInput({
      environment: { CREWON_EXTENSIONS_ENABLED: "1" },
      actor,
      defaultAgentVersionId: "existing-default",
    }),
    null,
  );
  assert.throws(
    () => assertInstalledPluginReleaseCliInput({ authority: {}, release: {} }),
    /installed_plugin_release_cli_input_unverified/u,
  );
});

test("publication opt-in never evaluates an environment accessor", async () => {
  let calls = 0;
  const environment = Object.defineProperty(
    {},
    INSTALLED_PLUGIN_WORKER_CONFIG_ENV,
    {
      get() {
        calls++;
        return missingPath;
      },
    },
  );
  await assert.rejects(
    loadInstalledPluginReleaseCliInput({
      environment,
      actor,
      defaultAgentVersionId: "existing-default",
    }),
    /installed_plugin_release_environment_invalid/u,
  );
  assert.equal(calls, 0);
});

for (const name of Object.keys(explicitOperator)) {
  test(`new publication requires an explicit matching operator field: ${name}`, async () => {
    for (const invalid of [
      undefined,
      "",
      " different ",
      "another-operator",
      "invalid\noperator",
    ]) {
      await assert.rejects(
        loadInstalledPluginReleaseCliInput({
          environment: {
            ...explicitOperator,
            [name]: invalid,
            [INSTALLED_PLUGIN_WORKER_CONFIG_ENV]: missingPath,
          },
          actor,
          defaultAgentVersionId: "existing-default",
        }),
        /installed_plugin_release_operator_required/u,
      );
    }
  });
}

test("defined empty configuration is rejected instead of silently taking the old release path", async () => {
  await assert.rejects(
    loadInstalledPluginReleaseCliInput({
      environment: {
        ...explicitOperator,
        [INSTALLED_PLUGIN_WORKER_CONFIG_ENV]: "",
      },
      actor,
      defaultAgentVersionId: "existing-default",
    }),
    /installed_plugin_worker_configuration_invalid/u,
  );
});

test("legacy host, runtime and recovery cannot share an installed publication invocation", async () => {
  for (const name of [
    "CREWON_EXTENSION_RUNTIME_BINDINGS_PATH",
    "CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH",
    "CREWON_EXTENSION_HOST_PORT",
    "CREWON_EXTENSION_HOST_TOKEN",
    "CREWON_EXTENSION_HOST_DEADLINE_MS",
    "CREWON_EXTENSION_EXECUTION_MODE",
    "CREWON_EXTENSION_RECOVERY_ATTEMPT_ID",
    "CREWON_EXTENSION_RECOVERY_PROVIDER_JSON",
  ]) {
    await assert.rejects(
      loadInstalledPluginReleaseCliInput({
        environment: {
          ...explicitOperator,
          [INSTALLED_PLUGIN_WORKER_CONFIG_ENV]: missingPath,
          [name]: "",
        },
        actor,
        defaultAgentVersionId: "existing-default",
      }),
      /installed_plugin_release_legacy_runtime_conflict/u,
    );
  }
  await assert.rejects(
    loadInstalledPluginReleaseCliInput({
      environment: {
        ...explicitOperator,
        [INSTALLED_PLUGIN_WORKER_CONFIG_ENV]: missingPath,
        CREWON_EXTENSIONS_ENABLED: "1",
      },
      actor,
      defaultAgentVersionId: "existing-default",
    }),
    /installed_plugin_release_legacy_runtime_conflict/u,
  );
});

test("invalid legacy flags and accessor fields are rejected before reading an installed package", async () => {
  for (const flag of ["", "true", " 0 "]) {
    await assert.rejects(
      loadInstalledPluginReleaseCliInput({
        environment: {
          ...explicitOperator,
          [INSTALLED_PLUGIN_WORKER_CONFIG_ENV]: missingPath,
          CREWON_EXTENSIONS_ENABLED: flag,
        },
        actor,
        defaultAgentVersionId: "existing-default",
      }),
      /installed_plugin_release_environment_invalid/u,
    );
  }
  let calls = 0;
  const environment = Object.defineProperty(
    { ...explicitOperator, [INSTALLED_PLUGIN_WORKER_CONFIG_ENV]: missingPath },
    "CREWON_EXTENSION_HOST_TOKEN",
    {
      get() {
        calls++;
        return "untrusted";
      },
    },
  );
  await assert.rejects(
    loadInstalledPluginReleaseCliInput({
      environment,
      actor,
      defaultAgentVersionId: "existing-default",
    }),
    /installed_plugin_release_environment_invalid/u,
  );
  assert.equal(calls, 0);
});

test("cancellation before private configuration capture cannot start package or storage work", async () => {
  const controller = new AbortController();
  const reason = new Error("operator-cancelled-publication");
  controller.abort(reason);
  await assert.rejects(
    loadInstalledPluginReleaseCliInput({
      environment: {
        ...explicitOperator,
        [INSTALLED_PLUGIN_WORKER_CONFIG_ENV]: missingPath,
      },
      actor,
      defaultAgentVersionId: "existing-default",
      signal: controller.signal,
    }),
    (error) => error === reason,
  );
});

test("a private release document cannot change the operator tenant, space or default Agent", async (t) => {
  const fixture = await installedReleaseFixture(t);
  const directory = await mkdtemp(join(tmpdir(), "crewon-release-cli-input-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const documentPath = join(directory, "release.json"),
    configPath = join(directory, "config.json");
  await writeFile(documentPath, JSON.stringify(fixture.document), {
    mode: 0o600,
  });
  const endpoint = {
    url: "https://unreachable.fixture.example/authority",
    serviceTokenEnvironmentVariable: "CLI_INPUT_TEST_SERVICE_TOKEN",
  };
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: "crewon.installed-plugin-worker.v1",
      installRoot: fixture.installRoot,
      releaseDocumentPath: documentPath,
      actorAuthority: endpoint,
      policyAuthority: endpoint,
      profileAuthority: endpoint,
      packageAuthority: endpoint,
      networkAuthority: null,
      historicalScope: null,
      timeoutMs: 1,
    }),
    { mode: 0o600 },
  );
  const environment = {
    ...explicitOperator,
    [INSTALLED_PLUGIN_WORKER_CONFIG_ENV]: configPath,
    CLI_INPUT_TEST_SERVICE_TOKEN: "explicit-metadata-test-service-token-0001",
  };
  for (const request of [
    { actor, defaultAgentVersionId: "different-default" },
    {
      actor: { ...actor, tenantId: "different-tenant" },
      defaultAgentVersionId: fixture.document.defaultAgentVersionId,
    },
    {
      actor: { ...actor, spaceId: "different-space" },
      defaultAgentVersionId: fixture.document.defaultAgentVersionId,
    },
  ]) {
    await assert.rejects(
      loadInstalledPluginReleaseCliInput({
        ...request,
        environment: {
          ...environment,
          CREWON_TENANT_ID: request.actor.tenantId,
          CREWON_SPACE_ID: request.actor.spaceId,
        },
      }),
      /installed_plugin_release_bootstrap_mismatch/u,
    );
  }
  assert.equal(
    await fixture.store.loadAgentVersion({
      tenantId: actor.tenantId,
      agentVersionId: fixture.baseVersion.agentVersionId,
    }),
    null,
  );
  assert.equal(
    await fixture.store.loadActiveAgentVersionRelease({
      tenantId: actor.tenantId,
    }),
    null,
  );
});
