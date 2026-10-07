import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { compileAgentVersion } from "@crewon/agent-version";
import { nativeMediaFixture } from "./plugins/native-project-media-runtime.test-support.ts";
import {
  baseSource,
  digester,
} from "./installed-plugin-agent-runtime-factory.test-support.ts";
import { prepareNativeInstalledPluginCandidates } from "./plugins/installed-plugin-native-candidates.ts";
import { prepareNativeInstalledPluginRelease } from "./plugins/installed-plugin-native-preparation.ts";
import { loadInstalledPluginReleaseCliInput } from "./plugins/installed-plugin-release-cli-input.ts";

/** Real Main files, installed graphs, package/configuration records and release
 * loaders. The named model is never invoked; this is startup acceptance only. */
async function fixture(
  t: TestContext,
  version: "v1" | "v2",
  reviewMismatch?: "graph" | "manifest",
) {
  const media = await nativeMediaFixture(t, {
    ...(reviewMismatch ? { reviewMismatch } : {}),
  });
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches++;
    throw new Error("media_preparation_must_not_call_provider");
  });
  const directory = join(media.f.dataDirectory, `media-preparation-${version}`);
  await mkdir(directory, { mode: 0o700 });
  const workerPath = join(directory, "worker.json"),
    inputPath = join(directory, "preparation.json"),
    documentPath = join(directory, "release.json"),
    actor = media.manifest.actor;
  const environment = {
    ...media.environment,
    CREWON_CONTROL_DB_PATH: join(media.f.dataDirectory, "control.sqlite"),
    CREWON_RELEASE_PRINCIPAL_ID: actor.principalId,
    CREWON_RELEASE_ACTOR_ID: actor.actorId,
    CREWON_TENANT_ID: actor.tenantId,
    CREWON_SPACE_ID: actor.spaceId,
    CREWON_MODEL_ADAPTER: "responses",
    CREWON_MODEL_ID: "named-media-startup-model",
    CREWON_RESPONSES_ENDPOINT: "https://named-model.example/v1/responses",
    CREWON_RESPONSES_MAX_OUTPUT_TOKENS: "1000",
    CREWON_MODEL_CREDENTIAL_REQUIRED: "0",
    CREWON_AGENT_VERSION_ID: "native-media-startup-default",
    CREWON_AUTHORITY_ID: "native-media-startup-authority",
    CREWON_INSTALLED_PLUGIN_NATIVE_PREPARATION_PATH: inputPath,
    CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH: workerPath,
  };
  const bootstrapVersion = compileAgentVersion(
    {
      ...baseSource(),
      agentVersionId: environment.CREWON_AGENT_VERSION_ID,
      model: {
        ...baseSource().model,
        adapterName: "direct-responses",
        adapterVersion: "1",
        modelId: environment.CREWON_MODEL_ID,
      },
    },
    digester,
  );
  await writeFile(
    workerPath,
    JSON.stringify({
      schemaVersion: "crewon.installed-plugin-native-worker.v1",
      installRoot: media.main.authority.installRoot,
      nativeAuthorityPath: media.main.path,
      releaseDocumentPath: documentPath,
      historicalScope: null,
      timeoutMs: 1000,
    }),
    { mode: 0o600 },
  );
  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: `crewon.installed-plugin-native-preparation.${version}`,
      actor,
      scope: media.f.scope,
      approvedPackages: [media.f.identity],
      plugins: [
        { pluginId: media.f.identity.pluginId, approvalRequirement: "none" },
      ],
      workerConfigurationPath: workerPath,
    }),
    { mode: 0o600 },
  );
  const counts = () => {
    const db = new DatabaseSync(environment.CREWON_CONTROL_DB_PATH, {
      readOnly: true,
    });
    try {
      return ["run_snapshots", "work_items"].map(
        (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,
      );
    } finally {
      db.close();
    }
  };
  return {
    media,
    documentPath,
    counts,
    fetches: () => fetches,
    input: {
      inputPath,
      environment,
      actor,
      bootstrapVersion,
      defaultAgentVersionId: bootstrapVersion.agentVersionId,
    },
  };
}

for (const version of ["v1", "v2"] as const)
  test(`Native ${version} release preparation and CLI await approved media graphs without submitting tasks`, async (t) => {
    const f = await fixture(t, version);
    const before = f.counts();
    const prepared =
      version === "v2"
        ? await prepareNativeInstalledPluginCandidates(f.input)
        : await prepareNativeInstalledPluginRelease(f.input);
    assert.equal(prepared.document!.entries.length, 1);
    assert.equal(
      prepared.document!.entries[0]!.packageIdentity.packageDigest,
      f.media.f.identity.packageDigest,
    );
    const cli = await loadInstalledPluginReleaseCliInput(f.input);
    assert.ok(cli);
    try {
      assert.deepEqual(
        cli.authority.installedPluginExecution.projectMedia!.reviews.map(
          (r) => r.workflow.workflowId,
        ),
        ["krea2-reference-four-view", "flux2-three-reference-storyboard"],
      );
      assert.deepEqual(f.counts(), before);
      assert.equal(f.fetches(), 0);
    } finally {
      await cli.release.close();
      await cli.authority.close();
    }
  });

for (const reviewMismatch of ["graph", "manifest"] as const)
  test(`Native candidate preparation rejects ${reviewMismatch} drift before publishing a release`, async (t) => {
    const f = await fixture(t, "v2", reviewMismatch);
    const before = f.counts();
    await assert.rejects(() => prepareNativeInstalledPluginCandidates(f.input));
    await assert.rejects(() => readFile(f.documentPath), { code: "ENOENT" });
    assert.deepEqual(f.counts(), before);
    assert.equal(f.fetches(), 0);
  });
