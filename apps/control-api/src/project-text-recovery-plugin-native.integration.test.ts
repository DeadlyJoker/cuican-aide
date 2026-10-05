import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import type { ActorContext } from "@crewon/application";
import type { OpenPluginUiMountResponse } from "@crewon/contracts";
import { parseProjectTextUiActionResponse } from "@crewon/contracts/project-texts-ui";
import { parseDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import { composeDesktopProjectStartup } from "./desktop-project-startup.ts";
import { createStandaloneControlApiWithPlugins } from "./standalone-composition.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import {
  projectPluginDisabledScans,
  projectPluginHarness,
} from "./creative-project-plugin.integration.test-support.ts";
import {
  exerciseColdTextRecovery,
  textRecoveryAcknowledgementLoss,
} from "./project-text-recovery-plugin.integration.test-support.ts";

const actor: ActorContext = {
  tenantId: "recovery-tenant",
  spaceId: "recovery-space",
  actorId: "recovery-actor",
  principalId: "recovery-principal",
};
const headers = {
  "authorization": `Bearer ${"s".repeat(32)}`,
  "origin": "crewon://desktop",
  "x-csrf-token": "c".repeat(32),
};
test(
  "Native installed cold text recovery survives real COMMIT/ACK loss, retains original key and rejects foreign actor/package without a Run",
  { timeout: 30000 },
  async (t) => {
    const runtimes = new Set<
      Awaited<ReturnType<typeof createStandaloneControlApiWithPlugins>>
    >();
    const source = await productionSourceFixture(t, {
      beforeCleanup: async () => {
        for (const runtime of runtimes) await runtime.app.close();
      },
    });
    const loss = textRecoveryAcknowledgementLoss(t);
    const requirements = [
      "crewon.creative-projects",
      "crewon.project-texts",
      "crewon.project-text-recovery",
    ].map((service) => ({ service, apiVersion: "1", optional: false }));
    const pkg = await source.source("recovery-source", {
      pluginId: "test.text-recovery",
      uiOnly: true,
      requires: requirements,
    });
    const other = await source.source("recovery-other", {
      pluginId: "test.other-text-recovery",
      uiOnly: true,
      requires: requirements,
    });
    const publications = [pkg, other].map((p) => ({
      pluginId: p.pluginId,
      packageDigest: p.packageDigest,
      contributionId: "workbench",
    }));
    const configuration = (currentActor: ActorContext) =>
      parseDesktopPluginConfiguration({
        schemaVersion: "crewon.desktop-plugin-bootstrap.v2",
        actor: currentActor,
        scope: {
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          profileId: "recovery-profile",
        },
        authorityEpoch: "text-recovery-native-current-private-epoch-01",
        installRoot: source.installRoot,
        sources: [pkg, other].map(({ descriptor: _descriptor, ...p }) => p),
        publications: [pkg, other].map((p) => ({
          pluginId: p.pluginId,
          publisherId: p.publisherId,
          packageDigest: p.packageDigest,
          publicAssets: ["ui.mjs"],
        })),
        projects: {
          version: "crewon.desktop-project-history.v1",
          pluginUi: { publications },
          textArtifacts: { version: "crewon.project-text.v1" },
          textUi: { publications },
          textRecovery: { publications },
        },
      });
    const databasePath = join(source.root, "recovery.sqlite");
    const open = async (currentActor = actor) => {
      const config = configuration(currentActor);
      const runtime = await createStandaloneControlApiWithPlugins({
        databasePath,
        actor: currentActor,
        defaultAgentVersionId: "no-model-deployed",
        sessionToken: "s".repeat(32),
        csrfToken: "c".repeat(32),
        allowedOrigins: ["crewon://desktop"],
        artifactStore: new InMemoryArtifactStore(),
        artifactEncryptionKeyId: "fixture-key",
        ...projectPluginDisabledScans,
        desktopPlugins: config,
        ...composeDesktopProjectStartup({
          configuration: config,
          actor: currentActor,
        }),
      });
      runtimes.add(runtime);
      return runtime;
    };
    let runtime = await open();
    const h = projectPluginHarness(() => runtime.app, headers);
    await h.install(pkg);
    let lease = await h.enable(pkg);
    await h.install(other);
    const otherLease = await h.enable(other);
    const close = async () => {
      await runtime.app.close();
      runtimes.delete(runtime);
    };
    const reopen = async (currentActor = actor) => {
      await close();
      runtime = await open(currentActor);
      lease = await h.mount(pkg, 2);
    };
    const result = await exerciseColdTextRecovery({
      h,
      lease: () => lease,
      loss,
      reopen,
      assertOtherActorDenied: async (projectId, intentId, expectedRevision) => {
        const freshOther = await h.mount(other, 2);
        const path = `/api/v1/plugins/ui/mounts/${freshOther.mountRef}/actions`;
        const hidden = await h.request("POST", path, {
          action: "crewon.project-text-recovery.v1.getPending",
          input: { projectId },
        });
        assert.equal(hidden.statusCode, 200, hidden.body);
        assert.equal(hidden.json().output.intent, null);
        const stolen = await h.request("POST", path, {
          action: "crewon.project-text-recovery.v1.acknowledge",
          input: { projectId, intentId, expectedRevision },
        });
        assert.ok([404, 409].includes(stolen.statusCode), stolen.body);
        await reopen({ ...actor, actorId: "different-actor-same-principal" });
        const samePrincipal = await h.invoke(
          lease,
          "crewon.creative-projects.v1.getProject",
          { projectId },
        );
        assert.equal(samePrincipal.project.projectId, projectId);
        const foreign = await h.request(
          "POST",
          `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
          {
            action: "crewon.project-text-recovery.v1.getPending",
            input: { projectId },
          },
        );
        assert.equal(foreign.statusCode, 200, foreign.body);
        assert.equal(foreign.json().output.intent, null);
        const ack = await h.request(
          "POST",
          `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
          {
            action: "crewon.project-text-recovery.v1.acknowledge",
            input: { projectId, intentId, expectedRevision },
          },
        );
        assert.ok([404, 409].includes(ack.statusCode), ack.body);
        await reopen();
      },
    });
    const observer = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(
        (
          observer
            .prepare("SELECT count(*) n FROM project_text_mutation_receipts")
            .get() as any
        ).n,
        4,
      );
      for (const table of [
        "runs",
        "external_operations",
        "extension_run_bindings",
        "plugin_task_credit_admissions",
        "plugin_task_unmetered_admissions",
        "project_generation_links",
      ]) {
        if (
          observer
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            )
            .get(table)
        )
          assert.equal(
            (observer.prepare(`SELECT count(*) n FROM ${table}`).get() as any)
              .n,
            0,
          );
      }
    } finally {
      observer.close();
    }
    const csrfDenied = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
      headers: { ...headers, "x-csrf-token": "not-the-session-token" },
      payload: {
        action: "crewon.project-text-recovery.v1.getPending",
        input: { projectId: result.projectId },
      },
    });
    assert.equal(csrfDenied.statusCode, 403, csrfDenied.body);
    assert.equal(existsSync(source.marker), false);
    const disabled = await h.request(
      "PUT",
      `/api/v1/plugins/selections/${pkg.pluginId}`,
      {
        expectedSelectionRevision: 2,
        state: "disabled",
        selectedPackageDigest: pkg.packageDigest,
      },
      "disable-recovery",
    );
    assert.equal(disabled.statusCode, 200, disabled.body);
    const revoked = await h.request(
      "POST",
      `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
      {
        action: "crewon.project-text-recovery.v1.getPending",
        input: { projectId: result.projectId },
      },
    );
    assert.ok([403, 409].includes(revoked.statusCode), revoked.body);
    assert.ok(otherLease.mountRef.length > 0);
    t.diagnostic(
      "real original four text COMMITs; lost HTTP acknowledgement; reopened actual SQLite; same-key replay; foreign actor and package cannot read/ACK original intent; no Node/Run/funding/provider",
    );
  },
);

test("older installed text UI still commits without opting into or migrating the recovery journal", async (t) => {
  let runtime:
    | Awaited<ReturnType<typeof createStandaloneControlApiWithPlugins>>
    | undefined;
  const source = await productionSourceFixture(t, {
    beforeCleanup: async () => {
      await runtime?.app.close();
    },
  });
  const pkg = await source.source("older-texts", {
    pluginId: "test.older-texts",
    uiOnly: true,
    requires: [
      { service: "crewon.creative-projects", apiVersion: "1", optional: false },
      { service: "crewon.project-texts", apiVersion: "1", optional: false },
    ],
  });
  const publication = {
    pluginId: pkg.pluginId,
    packageDigest: pkg.packageDigest,
    contributionId: "workbench",
  };
  const configuration = parseDesktopPluginConfiguration({
    schemaVersion: "crewon.desktop-plugin-bootstrap.v2",
    actor,
    scope: {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      profileId: "older-profile",
    },
    authorityEpoch: "older-text-native-current-private-epoch-01",
    installRoot: source.installRoot,
    sources: [(({ descriptor: _descriptor, ...p }) => p)(pkg)],
    publications: [
      {
        pluginId: pkg.pluginId,
        publisherId: pkg.publisherId,
        packageDigest: pkg.packageDigest,
        publicAssets: ["ui.mjs"],
      },
    ],
    projects: {
      version: "crewon.desktop-project-history.v1",
      pluginUi: { publications: [publication] },
      textArtifacts: { version: "crewon.project-text.v1" },
      textUi: { publications: [publication] },
    },
  });
  const databasePath = join(source.root, "older.sqlite");
  runtime = await createStandaloneControlApiWithPlugins({
    databasePath,
    actor,
    defaultAgentVersionId: "no-model-deployed",
    sessionToken: "s".repeat(32),
    csrfToken: "c".repeat(32),
    allowedOrigins: ["crewon://desktop"],
    artifactStore: new InMemoryArtifactStore(),
    artifactEncryptionKeyId: "fixture-key",
    ...projectPluginDisabledScans,
    desktopPlugins: configuration,
    ...composeDesktopProjectStartup({ configuration, actor }),
  });
  const h = projectPluginHarness(() => runtime!.app, headers);
  await h.install(pkg);
  const lease = await h.enable(pkg);
  const projectId = (
    await h.invoke(lease, "crewon.creative-projects.v1.createProject", {
      request: { title: "旧手动项目", briefText: "保留未批准恢复服务的行为" },
      idempotencyKey: "older-project",
    })
  ).project.projectId;
  const request = {
    action: "crewon.project-texts.v1.saveOutlineCandidate" as const,
    input: {
      projectId,
      idempotencyKey: "older-outline",
      request: {
        expectedArtifactRevision: 0,
        briefRevision: 1,
        content: {
          title: "大纲",
          logline: "线索",
          synopsis: "原请求",
          episodes: [{ episodeId: "ep-1", title: "第一集", summary: "线索" }],
        },
      },
    },
  };
  const response = await h.request(
    "POST",
    `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
    request,
  );
  assert.equal(response.statusCode, 200, response.body);
  const parsed = parseProjectTextUiActionResponse(
    request,
    response.json().output,
  );
  assert.ok("disposition" in parsed);
  assert.equal(parsed.disposition, "committed");
  const unavailable = await h.request(
    "POST",
    `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
    {
      action: "crewon.project-text-recovery.v1.getPending",
      input: { projectId },
    },
  );
  assert.equal(unavailable.statusCode, 409, unavailable.body);
  const observer = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(
      observer
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='project_text_ui_intents'",
        )
        .get(),
      undefined,
    );
    assert.equal(
      (
        observer
          .prepare("SELECT count(*) n FROM project_text_mutation_receipts")
          .get() as any
      ).n,
      1,
    );
  } finally {
    observer.close();
  }
  assert.equal(existsSync(source.marker), false);
});
