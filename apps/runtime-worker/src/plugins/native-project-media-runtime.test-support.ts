import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { extensionCanonicalJson } from "@crewon/domain";
import type { TestContext } from "node:test";
import { captureLocalPluginPackage } from "@crewon/plugin-host/package-snapshot";
import { captureDesktopLocalShortDramaMediaInputs } from "../../../crewon-ui/electron/desktopLocalShortDramaMediaInputs.ts";
import { composeDesktopLocalPluginProjectApproval } from "../../../crewon-ui/electron/desktopLocalPluginProjectApproval.ts";
import { executionSetupFixture } from "../../../crewon-ui/electron/desktopLocalPluginExecutionSetup.test-support.ts";
import {
  assertDesktopPluginBootstrapIssued,
  parseDesktopPluginApproval,
} from "../../../crewon-ui/electron/desktopPluginBootstrap.ts";
import {
  captureDesktopNativePluginPolicy,
  createDesktopNativePluginAuthority,
} from "../../../crewon-ui/electron/desktopNativePluginAuthority.ts";
import { loadInstalledPluginAuthorityConfig } from "./installed-plugin-authority-config.ts";
import {
  prepareInstalledPluginWorkerAuthority,
  type InstalledPluginWorkerAuthority,
} from "./installed-plugin-worker-authority.ts";
import { prepareInstalledPluginProjectMediaInputStores } from "./installed-plugin-project-media-input-tools.ts";
import { prepareInstalledPluginProjectMedia } from "./installed-plugin-project-media-composition.ts";

/** Original Main approval/file producers and an installed metadata-only media contract fixture. Its Node entry throws if imported. */
export async function nativeMediaFixture(
  t: TestContext,
  options: {
    generation?: boolean;
    assetV2?: boolean;
    mediaResultPurposes?: readonly ("read" | "publish")[];
    resultSchemaOwner?: "control" | "worker";
    reviewMismatch?: "graph" | "manifest";
  } = {},
) {
  const workflows = [
    { workflowId: "krea2-reference-four-view", nodeId: "129" },
    { workflowId: "flux2-three-reference-storyboard", nodeId: "17" },
  ].map(({ workflowId, nodeId }) => {
    const bytes = readFileSync(
      fileURLToPath(
        new URL(
          `../../test-fixtures/native-media-v1/${workflowId}.api.json`,
          import.meta.url,
        ),
      ),
    );
    const graph = JSON.parse(bytes.toString("utf8"));
    assert.equal(graph[nodeId]?.class_type, "SaveImage");
    return {
      bytes,
      declaration: {
        workflowId,
        file: `workflows/${workflowId}.api.json`,
        workflowDigest: `sha256:${createHash("sha256").update(extensionCanonicalJson(graph)).digest("hex")}`,
        output: { kind: "image", nodeId, dimensions: "workflow-native" },
      },
    };
  });
  const f = await executionSetupFixture({
    version: "26.0.0",
    contract: "assets",
    projectContext: true,
    requirements: [
      {
        service: "crewon.project-media-inputs",
        apiVersion: "1",
        optional: true,
      },
      {
        service: "crewon.project-media-input-tools",
        apiVersion: "1",
        optional: true,
      },
    ],
    packageDataFiles: [
      ...workflows.map((workflow) => ({
        path: workflow.declaration.file,
        bytes: workflow.bytes,
      })),
      {
        path: "media-input-profile.json",
        bytes: Buffer.from(
          JSON.stringify({
            schemaVersion: "crewon.short-drama-media-input-profile.v1",
            pluginId: "crewon.short-drama",
            workflows: workflows.map((workflow) => workflow.declaration),
          }),
        ),
      },
    ],
  });
  const workers: InstalledPluginWorkerAuthority[] = [];
  const materialOwners: { close(): Promise<void> }[] = [];
  let main: ReturnType<typeof createDesktopNativePluginAuthority> | undefined;
  t.after(async () => {
    for (const m of materialOwners.slice().reverse()) await m.close();
    for (const w of workers.slice().reverse()) await w.close();
    main?.close();
    await f.cleanup();
  });
  const old = composeDesktopLocalPluginProjectApproval({
    approval: parseDesktopPluginApproval(f.approval),
    descriptor: f.installed.descriptor,
    packageDigest: f.identity.packageDigest,
  });
  assert.ok("projects" in old);
  const snapshot = await captureLocalPluginPackage(
    { directory: f.installed.directory },
    true,
  );
  const mediaInputs = captureDesktopLocalShortDramaMediaInputs(
    snapshot,
    f.configuration,
  );
  assert.ok(mediaInputs);
  const publication = {
    pluginId: f.identity.pluginId,
    packageDigest: f.identity.packageDigest,
    contributionId: "workbench",
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
        mediaInputs,
        mediaInputStages: {
          version: "crewon.project-media-input-stages.v1",
          publications: [publication],
        },
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
  // Named independent execution opt-in; metadata Settings approval above is intentionally unchanged.
  const approval = JSON.parse(readFileSync(f.approvalPath, "utf8"));
  if (options.generation !== false)
    approval.projects.mediaGenerations = {
      version: "crewon.desktop-project-media-generations.v1",
      publications: [publication],
    };
  if (options.assetV2) {
    approval.projects.assetUi = { publications: [publication] };
    approval.projects.assetV2 = {
      version: "crewon.desktop-project-assets.v2",
      publications: [publication],
    };
    approval.projects.mediaResults = {
      version: "crewon.desktop-project-media-results.v1",
      purposes: options.mediaResultPurposes ?? ["read"],
      publications: [publication],
    };
  }
  if (options.reviewMismatch === "graph")
    approval.projects.mediaInputs.reviews[0].workflow.workflowDigest = `sha256:${"0".repeat(64)}`;
  if (options.reviewMismatch === "manifest")
    approval.projects.mediaInputs.reviews[0].targetIdentity.manifestDigest = `sha256:${"0".repeat(64)}`;
  writeFileSync(f.approvalPath, JSON.stringify(approval), { mode: 0o600 });
  await f.start();
  const manifest = assertDesktopPluginBootstrapIssued(f.bootstrap);
  const policy = captureDesktopNativePluginPolicy(f.dataDirectory, f.bootstrap);
  assert.ok(policy);
  main = createDesktopNativePluginAuthority({
    dataDirectory: f.dataDirectory,
    bootstrap: f.bootstrap,
    policy,
  });
  const path = join(f.dataDirectory, "media-worker.json");
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: "crewon.installed-plugin-native-worker.v1",
      installRoot: main.authority.installRoot,
      nativeAuthorityPath: main.path,
      releaseDocumentPath: join(f.dataDirectory, "not-requested-release.json"),
      historicalScope: null,
      timeoutMs: 1000,
    }),
    { mode: 0o600 },
  );
  const keyPath = join(f.dataDirectory, "named-artifact.key");
  writeFileSync(keyPath, Buffer.alloc(32, 61), { mode: 0o600 });
  const environment = {
    CREWON_ARTIFACT_ROOT: join(f.dataDirectory, "artifacts"),
    CREWON_ARTIFACT_ENCRYPTION_KEY_PATH: keyPath,
    CREWON_ARTIFACT_ENCRYPTION_KEY_ID: "named-test-master-key",
  };
  const config = loadInstalledPluginAuthorityConfig(path, {});
  const open = async (
    env: Readonly<Record<string, string | undefined>> = environment,
  ) => {
    const w = await prepareInstalledPluginWorkerAuthority(config, env);
    workers.push(w);
    return w;
  };
  const prepare = async (w: InstalledPluginWorkerAuthority) => {
    await f.store.extensionStore().migratePluginAdmissions();
    await prepareInstalledPluginProjectMediaInputStores({
      store: f.store,
      config: w.installedPluginExecution.projectMediaInputs,
    });
    // Reopening an existing Control-owned schema remains supported. Cold-start
    // tests instead exercise the real Worker-before-Control startup order.
    if (options.assetV2 && options.resultSchemaOwner !== "worker") {
      await f.store
        .projectAssetStore()
        .projectMaterialPreparationStore()
        .migrate();
      await f.store.extensionStore().migrateProjectMediaGenerations();
      const operations = f.store.externalOperationStore();
      await operations.migrate();
      await operations.migrateProjectMediaOperations();
      await f.store.extensionStore().projectMediaResults().migrate();
    }
    assert.ok(w.installedPluginExecution.projectMedia);
    const owner = await prepareInstalledPluginProjectMedia({
      store: f.store,
      extensions: f.store.extensionStore(),
      config: w.installedPluginExecution.projectMedia,
      signal: new AbortController().signal,
    });
    materialOwners.push(owner);
    return owner;
  };
  return { f, manifest, config, environment, open, prepare, publication, main };
}
