import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { ProjectFoundationApplicationService } from "@crewon/application";
import {
  assertDesktopPluginBootstrapIssued,
  prepareDesktopPluginBootstrap,
  type DesktopPluginBootstrap,
} from "../../../crewon-ui/electron/desktopPluginBootstrap.ts";
import {
  captureDesktopNativePluginPolicy,
  createDesktopNativePluginAuthority,
} from "../../../crewon-ui/electron/desktopNativePluginAuthority.ts";
import {
  nativeActor,
  nativeAuthorityFixture,
  nativeDigest,
} from "../installed-plugin-native-authority.test-support.ts";
import { loadInstalledPluginAuthorityConfig } from "./installed-plugin-authority-config.ts";
import { createInstalledPluginWorkerAuthority } from "./installed-plugin-worker-authority.ts";
import { prepareInstalledPluginProjectFoundationStores } from "./installed-plugin-project-foundation-tools.ts";

/** Main configuration and actual parent SQLite only; this fixture does not execute a package or model. */
export async function nativeFoundationFixture(
  t: TestContext,
  enabled = true,
  options: Readonly<{
    inactiveFoundationPublication?: "append" | "replace";
  }> = {},
) {
  const workers: ReturnType<typeof createInstalledPluginWorkerAuthority>[] = [];
  const mains: ReturnType<typeof createDesktopNativePluginAuthority>[] = [];
  const bootstraps: DesktopPluginBootstrap[] = [];
  t.after(async () => {
    for (const worker of workers) await worker.close();
    for (const main of mains) main.close();
    for (const bootstrap of bootstraps) await bootstrap.cleanup();
  });
  const f = await nativeAuthorityFixture(t);
  await f.authority.close();
  await f.bootstrap.cleanup();
  const publication = {
    pluginId: f.identity.pluginId,
    packageDigest: f.identity.packageDigest,
    contributionId: "workbench",
  };
  const previous = JSON.parse(readFileSync(f.approvalPath, "utf8"));
  const inactive = {
    ...f.identity,
    version: "99.0.0",
    packageDigest: nativeDigest("approved-but-not-activated"),
    sourceId: "inactive-source",
    directory: join(f.directory, "inactive-source"),
  };
  const inactivePublication = {
    pluginId: inactive.pluginId,
    packageDigest: inactive.packageDigest,
    contributionId: "workbench",
  };
  const foundationPublications =
    options.inactiveFoundationPublication === "replace"
      ? [inactivePublication]
      : [
          publication,
          ...(options.inactiveFoundationPublication === "append"
            ? [inactivePublication]
            : []),
        ];
  writeFileSync(
    f.approvalPath,
    JSON.stringify({
      ...previous,
      schemaVersion: "crewon.desktop-plugin-approval.v3",
      sources: [
        ...previous.sources,
        ...(options.inactiveFoundationPublication ? [inactive] : []),
      ],
      publications: [
        {
          pluginId: f.identity.pluginId,
          publisherId: f.identity.publisherId,
          packageDigest: f.identity.packageDigest,
          publicAssets: ["ui.mjs"],
        },
        ...(options.inactiveFoundationPublication
          ? [
              {
                pluginId: inactive.pluginId,
                publisherId: inactive.publisherId,
                packageDigest: inactive.packageDigest,
                publicAssets: ["ui.mjs"],
              },
            ]
          : []),
      ],
      projects: {
        version: "crewon.desktop-project-execution.v1",
        pluginUi: {
          publications: [
            publication,
            ...(options.inactiveFoundationPublication
              ? [inactivePublication]
              : []),
          ],
        },
        conversations: { publications: [publication] },
      },
      ...(enabled
        ? {
            projectFoundationTools: {
              version: "crewon.project-foundation-tools.v1",
              publications: foundationPublications,
            },
          }
        : {}),
    }),
    { mode: 0o600 },
  );
  const bootstrap = await prepareDesktopPluginBootstrap({
    dataDirectory: f.directory,
    actor: nativeActor,
    sessionEntropy: nativeDigest("foundation-tools-native-bootstrap"),
  });
  assert.ok(bootstrap);
  bootstraps.push(bootstrap);
  const manifest = assertDesktopPluginBootstrapIssued(bootstrap);
  assert.equal(manifest.schemaVersion, "crewon.desktop-plugin-bootstrap.v3");
  const policy = captureDesktopNativePluginPolicy(f.directory, bootstrap);
  assert.ok(policy);
  const main = createDesktopNativePluginAuthority({
    dataDirectory: f.directory,
    bootstrap,
    policy,
  });
  mains.push(main);
  const path = join(f.directory, "foundation-native-worker.json");
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: "crewon.installed-plugin-native-worker.v1",
      installRoot: main.authority.installRoot,
      nativeAuthorityPath: main.path,
      releaseDocumentPath: join(
        f.directory,
        "no-foundation-package-loaded.json",
      ),
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
  const config = worker.installedPluginExecution.projectFoundationTools;
  await f.store.extensionStore().migratePluginAdmissions();
  await prepareInstalledPluginProjectFoundationStores({
    store: f.store,
    config,
  });
  // Seed through the real Application/Store. This explicit test policy is separate from Node's read/write-only policy.
  const createProject = async () =>
    new ProjectFoundationApplicationService({
      projects: f.store.creativeProjectStore(),
      store: f.store.projectFoundationStore(),
      sourcePreparation: {
        loadPrepared: async () => {
          throw new Error("source_adoption_not_in_this_test");
        },
      },
      authorization: { authorize: async () => ({ outcome: "allow" }) },
      clock: { now: () => new Date().toISOString() },
      ids: { nextId: () => "native-foundation-project" },
      digester: { sha256: nativeDigest },
    }).createProject(nativeActor, {
      origin: "creative",
      title: "夜航",
      briefText: "从同一个项目和会话继续创作。",
      parameters: {
        genre: "悬疑",
        episodeMode: "series",
        episodeCount: 3,
        episodeDurationSeconds: null,
        aspectRatio: "9:16",
        visualStyle: null,
        needsCharacters: true,
        needsArt: true,
        adaptation: null,
      },
      creativeStartMode: "confirm-plan",
      sourceUpload: null,
      idempotencyKey: "native-foundation-test-create",
    });
  return { f, worker, config, open, publication, createProject };
}
