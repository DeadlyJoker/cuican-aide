import assert from "node:assert/strict";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { CreativeProjectApplicationService } from "@crewon/application";
import type { PluginTaskAdmission } from "@crewon/domain";
import {
  captureDesktopNativePluginPolicy,
  createDesktopNativePluginAuthority,
} from "../../../crewon-ui/electron/desktopNativePluginAuthority.ts";
import { composeDesktopLocalPluginProjectApproval } from "../../../crewon-ui/electron/desktopLocalPluginProjectApproval.ts";
import {
  executionSetupFixture,
  fixtureHash,
} from "../../../crewon-ui/electron/desktopLocalPluginExecutionSetup.test-support.ts";
import {
  assertDesktopPluginBootstrapIssued,
  parseDesktopPluginApproval,
} from "../../../crewon-ui/electron/desktopPluginBootstrap.ts";
import { loadInstalledPluginAuthorityConfig } from "./installed-plugin-authority-config.ts";
import { createInstalledPluginWorkerAuthority } from "./installed-plugin-worker-authority.ts";
import { prepareInstalledPluginProjectMediaInputStores } from "./installed-plugin-project-media-input-tools.ts";

// Genuine Main bootstrap/policy/authority producers and SQLite; named workflow digests.
// The installed metadata-only Node entry throws if imported. No model/Run/provider readiness is claimed.
async function fixture(t: TestContext, stages = true) {
  const f = await executionSetupFixture({
    version: "23.0.0",
    contract: "assets",
    projectContext: true,
  });
  const workers: ReturnType<typeof createInstalledPluginWorkerAuthority>[] = [];
  let main: ReturnType<typeof createDesktopNativePluginAuthority> | undefined;
  t.after(async () => {
    for (const worker of workers) await worker.close();
    main?.close();
    await f.cleanup();
  });
  const old = composeDesktopLocalPluginProjectApproval({
    approval: parseDesktopPluginApproval(f.approval),
    descriptor: f.installed.descriptor,
    packageDigest: f.identity.packageDigest,
  });
  assert.ok("projects" in old);
  const publication = {
    pluginId: f.identity.pluginId,
    packageDigest: f.identity.packageDigest,
    contributionId: "workbench",
  };
  const declaration = {
    version: "crewon.desktop-project-media-inputs.v1",
    purposes: ["read", "write"],
    reviews: [
      {
        targetIdentity: f.entry.identity,
        workflow: {
          workflowId: "krea2-reference-four-view",
          workflowDigest: fixtureHash("named-reviewed-T10-workflow"),
          output: {
            kind: "image",
            nodeId: "129",
            dimensions: "workflow-native",
          },
        },
      },
    ],
    referenceIdentities: [
      {
        pluginId: f.identity.pluginId,
        pluginVersion: f.identity.version,
        manifestDigest: f.configuration.manifestDigest,
        implementationDigest: f.configuration.implementationDigest,
      },
    ],
  };
  await f.stop();
  writeFileSync(
    f.approvalPath,
    JSON.stringify({
      ...old,
      schemaVersion: "crewon.desktop-plugin-approval.v3",
      projects: {
        ...old.projects,
        version: "crewon.desktop-project-execution.v1",
        mediaInputs: declaration,
        ...(stages
          ? {
              mediaInputStages: {
                version: "crewon.project-media-input-stages.v1",
                publications: [publication],
              },
            }
          : {}),
      },
    }),
    { mode: 0o600 },
  );
  await f.start();
  const setup = f.create();
  const preview = await setup.preview({
    bootstrap: f.bootstrap,
    pluginId: f.identity.pluginId,
  });
  const claim = setup.claimPreview({
    previewId: preview.previewId,
    approveExecution: true,
  });
  await f.stop();
  await setup.commitPolicyWhileStopped(claim);
  await f.start();
  const manifest = assertDesktopPluginBootstrapIssued(f.bootstrap);
  assert.equal(manifest.schemaVersion, "crewon.desktop-plugin-bootstrap.v3");
  const policy = captureDesktopNativePluginPolicy(f.dataDirectory, f.bootstrap);
  assert.ok(policy);
  main = createDesktopNativePluginAuthority({
    dataDirectory: f.dataDirectory,
    bootstrap: f.bootstrap,
    policy,
  });
  const path = join(f.dataDirectory, "media-input-worker.json");
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: "crewon.installed-plugin-native-worker.v1",
      installRoot: main.authority.installRoot,
      nativeAuthorityPath: main.path,
      releaseDocumentPath: join(f.dataDirectory, "not-imported-release.json"),
      historicalScope: null,
      timeoutMs: 1000,
    }),
    { mode: 0o600 },
  );
  const open = () => {
    const worker = createInstalledPluginWorkerAuthority(
      loadInstalledPluginAuthorityConfig(path, {}),
    );
    workers.push(worker);
    return worker;
  };
  const worker = open();
  const config = worker.installedPluginExecution.projectMediaInputs;
  await f.store.extensionStore().migratePluginAdmissions();
  await prepareInstalledPluginProjectMediaInputStores({
    store: f.store,
    config,
  });
  const inputs = config?.createInputs({ store: f.store });
  const actor = manifest.actor;
  const query = {
    projectId: "not-created-project",
    mediaInputId: "not-created-input",
    inputRevision: null,
  };
  return { f, worker, config, inputs, actor, query, open, publication };
}

test("Main exact stage opt-in reaches Native metadata tools; old conversation/asset approvals infer none", async (t) => {
  const off = await fixture(t, false);
  assert.equal(off.config, undefined);
  assert.ok(off.worker.installedPluginExecution.projectTools);
  assert.ok(off.worker.installedPluginExecution.projectAssetTools);
  const on = await fixture(t);
  assert.ok(on.inputs);
  const dependencies = {
    store: on.f.store.creativeProjectStore(),
    authorization: { authorize: async () => ({ outcome: "allow" as const }) },
    clock: { now: () => new Date().toISOString() },
    ids: { nextId: () => "native-media-project" },
    digester: { sha256: fixtureHash },
  };
  const project = await new CreativeProjectApplicationService(
    dependencies,
  ).createProject(on.actor, {
    title: "同一个项目",
    briefText: "素材准备接力",
    idempotencyKey: "native-media-create",
  });
  const query = { ...on.query, projectId: project.project.projectId };
  assert.equal(await on.inputs.loadInput(on.actor, query), null);
  await on.worker.close();
  await assert.rejects(async () => on.inputs!.loadInput(on.actor, query));
  const reopened = on
    .open()
    .installedPluginExecution.projectMediaInputs!.createInputs({
      store: on.f.store,
    });
  assert.equal(await reopened.loadInput(on.actor, query), null);
  assert.equal(
    (
      await on.f.store
        .creativeProjectStore()
        .loadProject({
          owner: {
            tenantId: on.actor.tenantId,
            spaceId: on.actor.spaceId,
            principalId: on.actor.principalId,
          },
          projectId: query.projectId,
        })
    )?.title,
    "同一个项目",
  );
});

test("Native stage service scopes actor, profile, package and contribution without granting generation", async (t) => {
  const f = await fixture(t);
  assert.ok(f.config);
  const admission = {
    ...f.actor,
    ...f.f.scope,
    ...f.f.identity,
    contributionId: "workbench",
    action: "project.execute",
  } as PluginTaskAdmission;
  await f.config.authorizeService(admission, new AbortController().signal);
  for (const key of [
    "principalId",
    "actorId",
    "tenantId",
    "spaceId",
    "profileId",
    "pluginId",
    "publisherId",
    "version",
    "packageDigest",
    "contributionId",
    "action",
  ] as const)
    await assert.rejects(async () =>
      f.config!.authorizeService(
        { ...admission, [key]: "foreign" },
        new AbortController().signal,
      ),
    );
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(async () =>
    f.config!.authorizeService(admission, cancelled.signal),
  );
  assert.equal(f.worker.installedPluginExecution.projectMedia, undefined);
});

test("Native input service denies foreign users; writes refuse an unapproved target", async (t) => {
  const f = await fixture(t);
  assert.ok(f.inputs);
  await assert.rejects(async () =>
    f.inputs!.loadInput({ ...f.actor, actorId: "foreign" }, f.query),
  );
  await assert.rejects(async () =>
    f.inputs!.saveInput(f.actor, {
      projectId: f.query.projectId,
      mediaInputId: null,
      expectedInputRevision: 0,
      item: { kind: "character-reference", assetId: "unadopted-character" },
      briefRevision: 1,
      script: null,
      workflowId: "krea2-reference-four-view",
      prompt: "Prepare only",
      references: {
        character: {
          projectId: f.query.projectId,
          assetId: "unadopted-character",
          kind: "character",
          expectedAssetRevision: 1,
          contentRevision: 1,
          referenceRevision: 1,
        },
      },
      target: {
        pluginId: "crewon.short-drama",
        profileId: f.f.scope.profileId,
        configurationRevision: 1,
      },
      idempotencyKey: "native-save-missing-reference",
    }),
  );
});

test("replacing Main approval bytes revokes already-issued Native metadata reads and service grants", async (t) => {
  const f = await fixture(t);
  assert.ok(f.inputs);
  const bytes = readFileSync(f.f.approvalPath);
  renameSync(f.f.approvalPath, f.f.approvalPath + ".old");
  writeFileSync(f.f.approvalPath, bytes, { mode: 0o600 });
  await assert.rejects(async () => f.inputs!.loadInput(f.actor, f.query));
  assert.throws(() => f.config!.createInputs({ store: f.f.store }));
});
