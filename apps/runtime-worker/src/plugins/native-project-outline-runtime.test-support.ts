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
import { prepareInstalledPluginProjectOutlineStores } from "./installed-plugin-project-outline-tools.ts";

/** Main configuration and actual parent SQLite only; this fixture does not execute a package or model. */
export async function nativeOutlineFixture(
  t: TestContext,
  enabled = true,
  options: Readonly<{
    inactiveOutlinePublication?: "append" | "replace";
    approvalPaddingBytes?: number;
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
  const outlinePublications =
    options.inactiveOutlinePublication === "replace"
      ? [inactivePublication]
      : [
          publication,
          ...(options.inactiveOutlinePublication === "append"
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
        ...(options.inactiveOutlinePublication ? [inactive] : []),
      ],
      publications: [
        {
          pluginId: f.identity.pluginId,
          publisherId: f.identity.publisherId,
          packageDigest: f.identity.packageDigest,
          publicAssets: ["ui.mjs"],
        },
        ...(options.inactiveOutlinePublication
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
            ...(options.inactiveOutlinePublication
              ? [inactivePublication]
              : []),
          ],
        },
        conversations: { publications: [publication] },
      },
      ...(enabled
        ? {
            projectOutlineTools: {
              version: "crewon.project-outline-tools.v2",
              publications: outlinePublications,
            },
          }
        : {}),
    }),
    { mode: 0o600 },
  );
  if (options.approvalPaddingBytes)
    writeFileSync(
      f.approvalPath,
      readFileSync(f.approvalPath, "utf8") +
        " ".repeat(options.approvalPaddingBytes),
    );
  const bootstrap = await prepareDesktopPluginBootstrap({
    dataDirectory: f.directory,
    actor: nativeActor,
    sessionEntropy: nativeDigest("outline-tools-native-bootstrap"),
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
  const path = join(f.directory, "outline-native-worker.json");
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: "crewon.installed-plugin-native-worker.v1",
      installRoot: main.authority.installRoot,
      nativeAuthorityPath: main.path,
      releaseDocumentPath: join(f.directory, "no-outline-package-loaded.json"),
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
  const config = worker.installedPluginExecution.projectOutlineTools;
  await f.store.extensionStore().migratePluginAdmissions();
  await prepareInstalledPluginProjectOutlineStores({
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
