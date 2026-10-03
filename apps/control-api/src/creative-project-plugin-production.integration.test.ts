import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import type { CreativeProjectAuthorizationPort } from "@crewon/application";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { InstalledPluginPeerClient } from "./installed-plugin-peer-client.ts";
import { createProductionPostgresControlApi } from "./production-composition.ts";
import { parseProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import { parseProductionPluginInstallationConfiguration } from "./production-plugin-installation-environment.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import {
  pluginRouteActor,
  pluginRouteScope,
} from "./plugin-control-route.test-support.ts";
import {
  assertPluginProjectHistory,
  projectPluginDisabledScans,
  projectPluginHarness,
  projectPluginHttpsAuthorities,
  savePluginProjectHistory,
} from "./creative-project-plugin.integration.test-support.ts";

type ProductionRuntime = Awaited<
  ReturnType<typeof createProductionPostgresControlApi>
>;
const postgresOptions = {
  skip: !process.env.CREWON_TEST_POSTGRES_URL,
  timeout: 60000,
};
async function postgresFixture(t: TestContext) {
  const schema = `creative_plugin_${randomUUID().replaceAll("-", "")}`;
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL!;
  const observer = new Pool({ connectionString, max: 1 });
  const runtimes = new Set<ProductionRuntime>();
  const source = await productionSourceFixture(t, {
    beforeCleanup: async () => {
      try {
        for (const runtime of runtimes) await runtime.app.close();
        await observer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await observer.end();
      }
    },
  });
  const authority = await projectPluginHttpsAuthorities(t);
  // Production factories capture default fetch; this is an actual HTTPS transport with fixture CA trust.
  t.mock.method(globalThis, "fetch", authority.fetch);
  return { schema, connectionString, observer, runtimes, source, authority };
}

test(
  "production installed UI-only metadata plugin uses real HTTP identity/profile/PDP and the original PostgreSQL owner, restores history and replays without an execution peer",
  postgresOptions,
  async (t) => {
    const f = await postgresFixture(t);
    const pkg = await f.source.source("short-drama", {
      pluginId: "test.production-short-drama",
      uiOnly: true,
      requiredService: "crewon.creative-projects",
    });
    const replacement = await f.source.source("replacement", {
      pluginId: pkg.pluginId,
      version: "2.0.0",
      uiOnly: true,
      requiredService: "crewon.creative-projects",
    });
    const unknown = await f.source.source("unknown", {
      pluginId: "test.production-unknown",
      uiOnly: true,
      requiredService: "other.metadata",
    });
    const ui = parseProductionPluginUiConfiguration({
      installRoot: f.source.installRoot,
      profileAuthority: f.authority.profileAuthority,
      policyAuthority: f.authority.policyAuthority,
      timeoutMs: 2000,
      publications: [pkg, replacement, unknown].map((source) => ({
        pluginId: source.pluginId,
        publisherId: source.publisherId,
        packageDigest: source.packageDigest,
        publicAssets: ["ui.mjs"],
      })),
    });
    const installation = parseProductionPluginInstallationConfiguration({
      ...f.source.configuration([pkg, replacement, unknown]),
      profileAuthority: f.authority.profileAuthority,
      policyAuthority: f.authority.policyAuthority,
    });
    let projectDenied = false;
    let legacyCalls = 0;
    let peerPreparations = 0;
    t.mock.method(InstalledPluginPeerClient.prototype, "prepare", async () => {
      peerPreparations++;
      throw new Error("metadata_must_not_prepare_execution_peer");
    });
    const projectAuthorizations: Parameters<
      CreativeProjectAuthorizationPort["authorize"]
    >[0][] = [];
    const authorization: CreativeProjectAuthorizationPort = {
      authorize: async (input) => {
        projectAuthorizations.push(input);
        assert.equal(input.resource.tenantId, input.actor.tenantId);
        assert.equal(input.resource.spaceId, input.actor.spaceId);
        return projectDenied
          ? { outcome: "deny", reasonCode: "test_metadata_policy_revoked" }
          : { outcome: "allow" };
      },
    };
    const open = async () => {
      const runtime = await createProductionPostgresControlApi({
        connectionString: f.connectionString,
        schema: f.schema,
        maxPoolSize: 3,
        statementTimeoutMs: 5000,
        identity: f.authority.identity,
        authorization: {
          authorize: async () => {
            legacyCalls++;
            return { outcome: "deny", reasonCode: "legacy_policy_denied" };
          },
        },
        artifactStore: new InMemoryArtifactStore(),
        artifactEncryptionKeyId: "fixture-key",
        ...projectPluginDisabledScans,
        pluginInstallation: { configuration: installation },
        pluginUi: { configuration: ui },
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
      f.runtimes.add(runtime);
      return runtime;
    };
    let runtime = await open();
    const h = projectPluginHarness(() => runtime.app, f.authority.headers);
    await h.install(pkg);
    let lease = await h.enable(pkg);
    const bytes = await h.request(
      "GET",
      `/api/v1/plugins/ui/mounts/${lease.mountRef}/assets/ui.mjs`,
    );
    assert.equal(bytes.statusCode, 200, bytes.body);
    assert.equal(
      bytes.body,
      await readFile(join(pkg.directory, "ui.mjs"), "utf8"),
    );
    const saved = await savePluginProjectHistory(h, lease);
    await assertPluginProjectHistory(h, lease, saved);
    assert.equal(legacyCalls, 0);
    const actionUrl = () =>
      `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`;
    const getProject = {
      action: "crewon.creative-projects.v1.getProject",
      input: { projectId: saved.project.projectId },
    };
    const unknownAction = await h.request("POST", actionUrl(), {
      action: "crewon.creative-projects.v1.unknownAction",
      input: {},
    });
    assert.equal(unknownAction.statusCode, 400, unknownAction.body);
    assert.equal(
      unknownAction.json().error.code,
      "plugin_creative_project_action_invalid",
    );
    // The original HTTP owner pins its first real profile response across subsequent authority reads.
    f.authority.state.profileReplies = [
      pluginRouteScope.profileId,
      "changed-during-original-http-request",
    ];
    const profileChanged = await h.request("POST", actionUrl(), {
      action: "crewon.creative-projects.v1.renameProject",
      input: {
        projectId: saved.project.projectId,
        request: {
          title: "变更中的profile不保存",
          expectedProjectRevision: saved.project.revision,
        },
        idempotencyKey: "profile-changed-rename",
      },
    });
    assert.equal(profileChanged.statusCode, 403, profileChanged.body);
    assert.equal(
      profileChanged.json().error.code,
      "installed_plugin_request_authority_unavailable",
    );
    assert.equal(f.authority.state.profileReplies.length, 0);
    f.authority.state.deny = true;
    const deniedByPdp = await h.request("POST", actionUrl(), {
      action: "crewon.creative-projects.v1.renameProject",
      input: {
        projectId: saved.project.projectId,
        request: {
          title: "PDP撤权不保存",
          expectedProjectRevision: saved.project.revision,
        },
        idempotencyKey: "pdp-revoked-rename",
      },
    });
    assert.equal(deniedByPdp.statusCode, 403, deniedByPdp.body);
    f.authority.state.deny = false;
    projectDenied = true;
    const deniedByProject = await h.request("POST", actionUrl(), getProject);
    assert.equal(deniedByProject.statusCode, 403, deniedByProject.body);
    projectDenied = false;
    f.authority.state.foreignProfile = true;
    const foreignProfile = await h.request("POST", actionUrl(), getProject);
    assert.notEqual(foreignProfile.statusCode, 200, foreignProfile.body);
    assert.ok(!foreignProfile.body.includes(saved.project.title));
    f.authority.state.foreignProfile = false;
    f.authority.state.revokedToken = true;
    const revokedIdentity = await h.request("POST", actionUrl(), getProject);
    assert.equal(revokedIdentity.statusCode, 401, revokedIdentity.body);
    f.authority.state.revokedToken = false;
    for (const [index, outsider] of [
      {
        ...pluginRouteActor,
        principalId: "other-project-principal",
        actorId: "other-project-actor",
      },
      { ...pluginRouteActor, spaceId: "other-project-space" },
    ].entries()) {
      f.authority.state.actor = outsider;
      f.authority.state.profileId = `other-project-profile-${index}`;
      const stolenLease = await h.request("POST", actionUrl(), getProject);
      assert.equal(stolenLease.statusCode, 404, stolenLease.body);
      await h.install(pkg, `other-${index}`);
      const otherLease = await h.enable(pkg, `other-${index}`);
      const foreignProject = await h.request(
        "POST",
        `/api/v1/plugins/ui/mounts/${otherLease.mountRef}/actions`,
        getProject,
      );
      assert.equal(foreignProject.statusCode, 404, foreignProject.body);
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
    f.authority.state.actor = { ...pluginRouteActor };
    f.authority.state.profileId = pluginRouteScope.profileId;
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
    const installedReplacement = await h.request(
      "POST",
      "/api/v1/plugins/installations",
      {
        sourceId: replacement.sourceId,
        expectedPluginId: replacement.pluginId,
        expectedPackageDigest: replacement.packageDigest,
        expectedSelectionRevision: 2,
      },
      "replacement-disabled",
    );
    assert.equal(
      installedReplacement.statusCode,
      200,
      installedReplacement.body,
    );
    const replaceSelection = installedReplacement.json().selection;
    const unapproved = await h.request(
      "PUT",
      `/api/v1/plugins/selections/${pkg.pluginId}`,
      {
        state: "enabled",
        selectedPackageDigest: replacement.packageDigest,
        expectedSelectionRevision: replaceSelection.revision,
      },
      "unapproved-replacement",
    );
    assert.equal(unapproved.statusCode, 409, unapproved.body);
    assert.equal(unapproved.json().error.code, "plugin_dependency_unavailable");
    // Restore the approved selection before closing; no failed replacement may become active on recovery.
    const approved = await h.request(
      "PUT",
      `/api/v1/plugins/selections/${pkg.pluginId}`,
      {
        state: "enabled",
        selectedPackageDigest: pkg.packageDigest,
        expectedSelectionRevision: replaceSelection.revision,
      },
      "approved-original",
    );
    assert.equal(approved.statusCode, 200, approved.body);
    const selectionRevision = approved.json().mutation.selection.revision;
    await runtime.app.close();
    f.runtimes.delete(runtime);
    runtime = await open();
    lease = await h.mount(pkg, selectionRevision);
    await assertPluginProjectHistory(h, lease, saved);
    const stored = await f.observer.query<{
      owner_principal_id: string;
      record_json: Record<string, unknown>;
    }>(
      `SELECT owner_principal_id,record_json FROM "${f.schema}".creative_projects WHERE project_id=$1`,
      [saved.project.projectId],
    );
    assert.equal(
      stored.rows[0]!.owner_principal_id,
      pluginRouteActor.principalId,
    );
    assert.equal(
      stored.rows[0]!.record_json.createdByActorId,
      pluginRouteActor.actorId,
    );
    for (const [table, expected] of [
      ["creative_projects", "1"],
      ["creative_project_briefs", "2"],
      ["creative_concept_revisions", "2"],
      ["run_snapshots", "0"],
      ["threads", "0"],
      ["messages", "0"],
      ["outbox", "0"],
    ]) {
      const count = await f.observer.query<{ n: string }>(
        `SELECT count(*) AS n FROM "${f.schema}".${table}`,
      );
      assert.equal(count.rows[0]!.n, expected, table);
    }
    const paid = await f.observer.query<{ n: string }>(
      "SELECT count(*) AS n FROM information_schema.tables WHERE table_schema=$1 AND table_name IN ('plugin_credit_entries','extension_credit_admissions','external_operations')",
      [f.schema],
    );
    assert.equal(paid.rows[0]!.n, "0");
    assert.equal(peerPreparations, 0);
    assert.equal(legacyCalls, 0);
    assert.ok(
      projectAuthorizations.some(
        (input) => input.action === "creativeProject:create",
      ),
    );
    assert.ok(
      projectAuthorizations.some(
        (input) => input.action === "creativeProject:write",
      ),
    );
    assert.ok(
      f.authority.state.requests.filter((entry) => entry.path === "/verify")
        .length > 50,
    );
    assert.ok(
      f.authority.state.requests.some(
        (entry) =>
          entry.path === "/policy" &&
          entry.body.action === "pluginUi:invoke" &&
          (entry.body.resource as Record<string, unknown>).packageDigest ===
            pkg.packageDigest,
      ),
    );
    await assert.rejects(readFile(f.source.marker), { code: "ENOENT" });
  },
);

test(
  "production defaults keep old UI-only modules but metadata requires explicit Host publication and a matching contribution",
  postgresOptions,
  async (t) => {
    const f = await postgresFixture(t);
    const legacy = await f.source.source("legacy", {
      pluginId: "test.production-legacy",
      uiOnly: true,
    });
    const pkg = await f.source.source("metadata", {
      pluginId: "test.production-metadata",
      uiOnly: true,
      requiredService: "crewon.creative-projects",
    });
    const ui = parseProductionPluginUiConfiguration({
      installRoot: f.source.installRoot,
      profileAuthority: f.authority.profileAuthority,
      policyAuthority: f.authority.policyAuthority,
      timeoutMs: 2000,
      publications: [legacy, pkg].map((source) => ({
        pluginId: source.pluginId,
        publisherId: source.publisherId,
        packageDigest: source.packageDigest,
        publicAssets: ["ui.mjs"],
      })),
    });
    const installation = parseProductionPluginInstallationConfiguration({
      ...f.source.configuration([legacy, pkg]),
      profileAuthority: f.authority.profileAuthority,
      policyAuthority: f.authority.policyAuthority,
    });
    const open = async (contributionId?: string) => {
      const runtime = await createProductionPostgresControlApi({
        connectionString: f.connectionString,
        schema: f.schema,
        maxPoolSize: 3,
        identity: f.authority.identity,
        authorization: {
          authorize: async () => ({
            outcome: "deny",
            reasonCode: "legacy_denied",
          }),
        },
        artifactStore: new InMemoryArtifactStore(),
        artifactEncryptionKeyId: "fixture-key",
        ...projectPluginDisabledScans,
        pluginInstallation: { configuration: installation },
        pluginUi: { configuration: ui },
        ...(contributionId === undefined
          ? {}
          : {
              creativeProjects: {
                authorization: {
                  authorize: async () => ({ outcome: "allow" as const }),
                },
                pluginUi: {
                  publications: [
                    {
                      pluginId: pkg.pluginId,
                      packageDigest: pkg.packageDigest,
                      contributionId,
                    },
                  ],
                },
              },
            }),
      });
      f.runtimes.add(runtime);
      return runtime;
    };
    let runtime = await open();
    const h = projectPluginHarness(() => runtime.app, f.authority.headers);
    await h.install(legacy);
    const lease = await h.enable(legacy);
    const unavailable = await h.request(
      "POST",
      `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
      {
        action: "crewon.creative-projects.v1.listProjects",
        input: { query: {} },
      },
    );
    assert.equal(unavailable.statusCode, 409, unavailable.body);
    assert.equal(
      unavailable.json().error.code,
      "plugin_ui_actions_unavailable",
    );
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
    const defaultInstall = await h.request(
      "POST",
      "/api/v1/plugins/installations",
      {
        sourceId: pkg.sourceId,
        expectedPluginId: pkg.pluginId,
        expectedPackageDigest: pkg.packageDigest,
        expectedSelectionRevision: null,
      },
      "default-required-service",
    );
    assert.equal(defaultInstall.statusCode, 200, defaultInstall.body);
    const defaultEnable = await h.request(
      "PUT",
      `/api/v1/plugins/selections/${pkg.pluginId}`,
      {
        state: "enabled",
        selectedPackageDigest: pkg.packageDigest,
        expectedSelectionRevision: 1,
      },
      "default-enable-metadata",
    );
    assert.equal(defaultEnable.statusCode, 409, defaultEnable.body);
    assert.equal(
      defaultEnable.json().error.code,
      "plugin_ui_only_services_unsupported",
    );
    await runtime.app.close();
    f.runtimes.delete(runtime);
    runtime = await open("not-workbench");
    const mismatched = await h.request(
      "PUT",
      `/api/v1/plugins/selections/${pkg.pluginId}`,
      {
        state: "enabled",
        selectedPackageDigest: pkg.packageDigest,
        expectedSelectionRevision: 1,
      },
      "contribution-mismatch",
    );
    assert.equal(mismatched.statusCode, 409, mismatched.body);
    assert.equal(mismatched.json().error.code, "plugin_dependency_unavailable");
    assert.deepEqual(
      (await h.request("GET", "/api/v1/plugins/ui/catalog"))
        .json()
        .plugins.map(
          (entry: { descriptor: { pluginId: string } }) =>
            entry.descriptor.pluginId,
        ),
      [legacy.pluginId],
    );
  },
);
