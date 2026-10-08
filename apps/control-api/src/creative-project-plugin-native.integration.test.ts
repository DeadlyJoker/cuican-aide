import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type {
  ActorContext,
  CreativeProjectAuthorizationPort,
} from "@crewon/application";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { SqliteRunStore } from "@crewon/store";
import { parseDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import { createStandaloneControlApiWithPlugins } from "./standalone-composition.ts";
import { prepareCreativeProjects } from "./creative-project-composition.ts";
import { createCreativeProjectPluginUiRuntime } from "./creative-project-plugin-ui-composition.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import {
  assertPluginProjectHistory,
  projectPluginDisabledScans,
  projectPluginHarness,
  savePluginProjectHistory,
} from "./creative-project-plugin.integration.test-support.ts";

const actor: ActorContext = Object.freeze({
  principalId: "native-project-principal",
  actorId: "native-project-actor",
  tenantId: "native-project-tenant",
  spaceId: "native-project-space",
});
const headers = Object.freeze({
  "authorization": `Bearer ${"s".repeat(32)}`,
  "origin": "crewon://desktop",
  "x-csrf-token": "c".repeat(32),
});
const allowed: CreativeProjectAuthorizationPort = {
  authorize: async () => ({ outcome: "allow" }),
};
type NativeRuntime = Awaited<
  ReturnType<typeof createStandaloneControlApiWithPlugins>
>;
type Sources = readonly Awaited<
  ReturnType<Awaited<ReturnType<typeof productionSourceFixture>>["source"]>
>[];
function desktopConfiguration(
  installRoot: string,
  sources: Sources,
  owner = actor,
) {
  return parseDesktopPluginConfiguration({
    schemaVersion: "crewon.desktop-plugin-bootstrap.v1",
    actor: owner,
    scope: {
      tenantId: owner.tenantId,
      spaceId: owner.spaceId,
      profileId: `profile-${owner.actorId}-${owner.spaceId}`,
    },
    authorityEpoch: "native-project-approved-fixture-epoch-01",
    installRoot,
    sources: sources.map(({ descriptor: _descriptor, ...source }) => source),
    publications: sources.map((pkg) => ({
      pluginId: pkg.pluginId,
      publisherId: pkg.publisherId,
      packageDigest: pkg.packageDigest,
      publicAssets: ["ui.mjs"],
    })),
  });
}
function baseConfig(databasePath: string, owner = actor) {
  return {
    databasePath,
    actor: owner,
    defaultAgentVersionId: "unavailable-real-model",
    sessionToken: "s".repeat(32),
    csrfToken: "c".repeat(32),
    allowedOrigins: ["crewon://desktop"],
    artifactStore: new InMemoryArtifactStore(),
    artifactEncryptionKeyId: "fixture-key",
    ...projectPluginDisabledScans,
  };
}

test(
  "native installed UI-only metadata plugin saves all inputs and immutable history, replays after restart, and isolates owners and spaces without Runs or credits",
  { timeout: 30000 },
  async (t) => {
    const runtimes = new Set<NativeRuntime>();
    const f = await productionSourceFixture(t, {
      beforeCleanup: async () => {
        for (const runtime of runtimes) await runtime.app.close();
      },
    });
    const pkg = await f.source("short-drama", {
      pluginId: "test.short-drama",
      uiOnly: true,
      requiredService: "crewon.creative-projects",
    });
    const path = join(f.root, "native-project.sqlite");
    let revoked = false;
    const authorizations: Parameters<
      CreativeProjectAuthorizationPort["authorize"]
    >[0][] = [];
    const authorization: CreativeProjectAuthorizationPort = {
      authorize: async (input) => {
        authorizations.push(input);
        return revoked
          ? { outcome: "deny", reasonCode: "native_project_policy_revoked" }
          : { outcome: "allow" };
      },
    };
    const open = async (owner = actor) => {
      const runtime = await createStandaloneControlApiWithPlugins({
        ...baseConfig(path, owner),
        desktopPlugins: desktopConfiguration(f.installRoot, [pkg], owner),
        creativeProjects: {
          authorization,
          pluginUi: {
            publications: [
              {
                pluginId: pkg.pluginId,
                packageDigest: pkg.packageDigest,
                contributionId: "workbench",
              },
            ],
          },
        },
      });
      runtimes.add(runtime);
      return runtime;
    };
    let runtime = await open();
    const h = projectPluginHarness(() => runtime.app, headers);
    await h.install(pkg);
    let lease = await h.enable(pkg);
    const asset = await h.request(
      "GET",
      `/api/v1/plugins/ui/mounts/${lease.mountRef}/assets/ui.mjs`,
    );
    assert.equal(asset.statusCode, 200, asset.body);
    assert.equal(
      asset.body,
      await readFile(join(pkg.directory, "ui.mjs"), "utf8"),
    );
    const saved = await savePluginProjectHistory(h, lease);
    const unknownAction = await h.request(
      "POST",
      `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
      { action: "crewon.creative-projects.v1.unknownAction", input: {} },
    );
    assert.equal(unknownAction.statusCode, 409, unknownAction.body);
    assert.equal(
      unknownAction.json().error.code,
      "plugin_ui_actions_unavailable",
    );
    await assertPluginProjectHistory(h, lease, saved);
    const leaked = JSON.stringify(saved);
    for (const forbidden of [
      "ownerPrincipalId",
      "tenantId",
      "spaceId",
      "actorId",
      "principalId",
    ])
      assert.ok(!leaked.includes(forbidden));
    revoked = true;
    const denied = await h.request(
      "POST",
      `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
      {
        action: "crewon.creative-projects.v1.renameProject",
        input: {
          projectId: saved.project.projectId,
          request: {
            title: "拒绝后不保存",
            expectedProjectRevision: saved.project.revision,
          },
          idempotencyKey: "revoked-rename",
        },
      },
    );
    assert.equal(denied.statusCode, 403, denied.body);
    revoked = false;
    await runtime.app.close();
    runtimes.delete(runtime);
    runtime = await open();
    lease = await h.mount(pkg, 2);
    await assertPluginProjectHistory(h, lease, saved);
    // A current exact package grant never turns a different project owner or space into the original owner.
    for (const outsider of [
      { ...actor, principalId: "other-principal", actorId: "other-actor" },
      { ...actor, spaceId: "other-space" },
    ]) {
      await runtime.app.close();
      runtimes.delete(runtime);
      runtime = await open(outsider);
      await h.install(pkg);
      const otherLease = await h.enable(pkg);
      const foreign = await h.request(
        "POST",
        `/api/v1/plugins/ui/mounts/${otherLease.mountRef}/actions`,
        {
          action: "crewon.creative-projects.v1.getProject",
          input: { projectId: saved.project.projectId },
        },
      );
      assert.equal(foreign.statusCode, 404, foreign.body);
      assert.deepEqual(
        (
          await h.invoke(
            otherLease,
            "crewon.creative-projects.v1.listProjects",
            { query: {} },
          )
        ).projects,
        [],
      );
    }
    await runtime.app.close();
    runtimes.delete(runtime);
    runtime = await open();
    lease = await h.mount(pkg, 2);
    await assertPluginProjectHistory(h, lease, saved);
    assert.ok(
      authorizations.some((input) => input.action === "creativeProject:create"),
    );
    assert.ok(
      authorizations.some((input) => input.action === "creativeProject:write"),
    );
    assert.ok(
      authorizations.some((input) => input.action === "creativeProject:read"),
    );
    const database = new DatabaseSync(path);
    try {
      assert.equal(
        database.prepare("SELECT count(*) AS n FROM creative_projects").get()!
          .n,
        1,
      );
      for (const table of ["run_snapshots", "threads", "messages", "outbox"])
        assert.equal(
          database.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,
          0,
        );
      assert.equal(
        database
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE name IN ('plugin_credit_entries','extension_credit_admissions','external_operations')",
          )
          .get()!.n,
        0,
      );
      assert.equal(
        database
          .prepare("SELECT count(*) AS n FROM creative_project_briefs")
          .get()!.n,
        2,
      );
      assert.equal(
        database
          .prepare("SELECT count(*) AS n FROM creative_concept_revisions")
          .get()!.n,
        2,
      );
    } finally {
      database.close();
    }
    await assert.rejects(readFile(f.marker), { code: "ENOENT" });
  },
);

test(
  "native defaults preserve old UI-only installation but reject required metadata, unknown services, unapproved digest and contribution",
  { timeout: 30000 },
  async (t) => {
    let runtime: NativeRuntime | undefined;
    const f = await productionSourceFixture(t, {
      beforeCleanup: async () => {
        await runtime?.app.close();
      },
    });
    const legacy = await f.source("legacy", {
      pluginId: "test.legacy-ui",
      uiOnly: true,
    });
    const metadata = await f.source("metadata", {
      pluginId: "test.metadata-ui",
      uiOnly: true,
      requiredService: "crewon.creative-projects",
    });
    const replacement = await f.source("replacement", {
      pluginId: "test.metadata-ui",
      version: "2.0.0",
      uiOnly: true,
      requiredService: "crewon.creative-projects",
    });
    const unknown = await f.source("unknown", {
      pluginId: "test.unknown-ui",
      uiOnly: true,
      requiredService: "other.metadata",
    });
    const path = join(f.root, "native-default.sqlite");
    const config = desktopConfiguration(f.installRoot, [
      legacy,
      metadata,
      replacement,
      unknown,
    ]);
    runtime = await createStandaloneControlApiWithPlugins({
      ...baseConfig(path),
      desktopPlugins: config,
    });
    const h = projectPluginHarness(() => runtime!.app, headers);
    await h.install(legacy);
    const legacyLease = await h.enable(legacy);
    const unavailable = await h.request(
      "POST",
      `/api/v1/plugins/ui/mounts/${legacyLease.mountRef}/actions`,
      {
        action: "crewon.creative-projects.v1.listProjects",
        input: { query: {} },
      },
    );
    assert.equal(unavailable.statusCode, 403, unavailable.body);
    const defaultInstall = await h.request(
      "POST",
      "/api/v1/plugins/installations",
      {
        sourceId: metadata.sourceId,
        expectedPluginId: metadata.pluginId,
        expectedPackageDigest: metadata.packageDigest,
        expectedSelectionRevision: null,
      },
      "default-required-service",
    );
    assert.equal(defaultInstall.statusCode, 200, defaultInstall.body);
    const defaultEnable = await h.request(
      "PUT",
      `/api/v1/plugins/selections/${metadata.pluginId}`,
      {
        state: "enabled",
        selectedPackageDigest: metadata.packageDigest,
        expectedSelectionRevision: 1,
      },
      "default-enable-metadata",
    );
    assert.equal(defaultEnable.statusCode, 409, defaultEnable.body);
    // Native's captured Host dispatcher recognizes this protocol; without an
    // approved project owner it remains unavailable. Unknown services below
    // still fail declaration validation as unsupported.
    assert.equal(
      defaultEnable.json().error.code,
      "plugin_dependency_unavailable",
    );
    await runtime.app.close();
    runtime = await createStandaloneControlApiWithPlugins({
      ...baseConfig(path),
      desktopPlugins: config,
      creativeProjects: {
        authorization: allowed,
        pluginUi: {
          publications: [
            {
              pluginId: metadata.pluginId,
              packageDigest: metadata.packageDigest,
              contributionId: "not-workbench",
            },
          ],
        },
      },
    });
    const unsupported = await h.request(
      "POST",
      "/api/v1/plugins/installations",
      {
        sourceId: unknown.sourceId,
        expectedPluginId: unknown.pluginId,
        expectedPackageDigest: unknown.packageDigest,
        expectedSelectionRevision: null,
      },
      "unknown-service",
    );
    assert.equal(unsupported.statusCode, 200, unsupported.body);
    const unsupportedEnable = await h.request(
      "PUT",
      `/api/v1/plugins/selections/${unknown.pluginId}`,
      {
        state: "enabled",
        selectedPackageDigest: unknown.packageDigest,
        expectedSelectionRevision: 1,
      },
      "unknown-service-enable",
    );
    assert.equal(unsupportedEnable.statusCode, 409, unsupportedEnable.body);
    assert.equal(
      unsupportedEnable.json().error.code,
      "plugin_ui_only_services_unsupported",
    );
    const mismatch = await h.request(
      "PUT",
      `/api/v1/plugins/selections/${metadata.pluginId}`,
      {
        state: "enabled",
        selectedPackageDigest: metadata.packageDigest,
        expectedSelectionRevision: 1,
      },
      "unapproved-contribution",
    );
    assert.equal(mismatch.statusCode, 409, mismatch.body);
    assert.equal(mismatch.json().error.code, "plugin_dependency_unavailable");
    const otherDigest = await h.request(
      "POST",
      "/api/v1/plugins/installations",
      {
        sourceId: replacement.sourceId,
        expectedPluginId: replacement.pluginId,
        expectedPackageDigest: replacement.packageDigest,
        expectedSelectionRevision: 1,
      },
      "replacement-installed",
    );
    assert.equal(otherDigest.statusCode, 200, otherDigest.body);
    const digestMismatch = await h.request(
      "PUT",
      `/api/v1/plugins/selections/${replacement.pluginId}`,
      {
        state: "enabled",
        selectedPackageDigest: replacement.packageDigest,
        expectedSelectionRevision: otherDigest.json().selection.revision,
      },
      "unapproved-digest",
    );
    assert.equal(digestMismatch.statusCode, 409, digestMismatch.body);
    assert.equal(
      digestMismatch.json().error.code,
      "plugin_dependency_unavailable",
    );
    await assert.rejects(readFile(f.marker), { code: "ENOENT" });
  },
);

test("actual SQLite metadata owner availability withdraws synchronously on close and binds verified digest and contribution", async (t) => {
  let store: SqliteRunStore | undefined;
  const f = await productionSourceFixture(t, {
    beforeCleanup: async () => {
      store?.close();
    },
  });
  const pkg = await f.source("availability", {
    pluginId: "test.availability",
    uiOnly: true,
    requiredService: "crewon.creative-projects",
  });
  store = new SqliteRunStore(join(f.root, "availability.sqlite"));
  const prepared = await prepareCreativeProjects(store, {
    authorization: allowed,
  });
  assert.ok(prepared);
  const runtime = createCreativeProjectPluginUiRuntime({
    projects: prepared.service,
    configuration: {
      publications: [
        {
          pluginId: pkg.pluginId,
          packageDigest: pkg.packageDigest,
          contributionId: "workbench",
        },
      ],
    },
    authorization: { authorize: async () => {} },
  });
  const input = {
    scope: {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      profileId: "availability-profile",
    },
    candidate: { descriptor: pkg.descriptor, packageDigest: pkg.packageDigest },
    requirement: pkg.descriptor.requires[0]!,
  };
  assert.equal(runtime.hostUiServices.isAvailable(input), true);
  assert.equal(
    runtime.hostUiServices.isAvailable({
      ...input,
      candidate: {
        ...input.candidate,
        packageDigest: `sha256:${"f".repeat(64)}`,
      },
    }),
    false,
  );
  assert.equal(
    runtime.hostUiServices.isAvailable({
      ...input,
      candidate: {
        ...input.candidate,
        descriptor: {
          ...pkg.descriptor,
          contributions: [
            { ...pkg.descriptor.contributions[0]!, id: "another-contribution" },
          ],
        },
      },
    }),
    false,
  );
  assert.equal(
    runtime.hostUiServices.isAvailable({
      ...input,
      requirement: { ...input.requirement, service: "other.metadata" },
    }),
    false,
  );
  const closed = runtime.close();
  assert.equal(runtime.hostUiServices.isAvailable(input), false);
  await closed;
});
