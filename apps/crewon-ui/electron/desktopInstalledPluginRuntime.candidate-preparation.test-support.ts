import assert from "node:assert/strict";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseNativeInstalledPluginPreparationResult } from "@crewon/contracts/plugins";
import type {
  ExtensionConfiguration,
  PluginProfileScope,
} from "@crewon/domain";
import {
  readInstalledPluginReleaseDocument,
  type InstalledPluginReleaseEntry,
  type InstalledPluginReleaseIdentity,
} from "../../runtime-worker/src/plugins/installed-plugin-release-document.ts";
import { DESKTOP_RUNTIME_OWNER as actor } from "./desktopExtensionRuntime.ts";
import { automaticPreparationDirectories } from "./desktopInstalledPluginRuntime.automatic.process.test-support.ts";
import type {
  DesktopInstalledPluginPreparationSelection,
  DesktopInstalledPluginWorkerAuthorities,
} from "./desktopInstalledPluginRuntimeConfiguration.ts";

/** Candidate tests deliberately use a named IO authority. Preserve the old
 * no-network automatic snapshot while checking this captured deployment exactly. */
export async function candidatePreparationSnapshot(
  input: Readonly<{
    dataDirectory: string;
    scope: PluginProfileScope;
    approvedPackages: readonly InstalledPluginReleaseIdentity[];
    plugins: readonly DesktopInstalledPluginPreparationSelection[];
    configurations: readonly ExtensionConfiguration[];
    workerAuthorities: DesktopInstalledPluginWorkerAuthorities;
  }>,
) {
  const directories = await automaticPreparationDirectories(
    input.dataDirectory,
  );
  assert.equal(directories.length, 1);
  const directory = join(input.dataDirectory, directories[0]!);
  const metadata = await lstat(directory);
  assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink());
  assert.equal(metadata.uid, process.getuid?.());
  assert.equal(metadata.mode & 0o777, 0o700);
  const names = (await readdir(directory)).sort();
  assert.deepEqual(names, [
    "preparation-result.json",
    "preparation.json",
    "release.json",
    "worker.json",
  ]);
  const files = await Promise.all(
    names.map(async (name) => {
      const path = join(directory, name),
        stat = await lstat(path);
      assert.ok(stat.isFile() && !stat.isSymbolicLink());
      assert.equal(stat.uid, metadata.uid);
      assert.equal(stat.nlink, 1);
      assert.equal(stat.mode & 0o777, 0o600);
      return { name, ino: stat.ino, bytes: await readFile(path) };
    }),
  );
  const value = (name: string): unknown =>
    JSON.parse(
      files.find((file) => file.name === name)!.bytes.toString("utf8"),
    );
  assert.deepEqual(value("worker.json"), {
    schemaVersion: "crewon.installed-plugin-worker.v1",
    installRoot: join(input.dataDirectory, "plugins"),
    releaseDocumentPath: join(directory, "release.json"),
    ...input.workerAuthorities,
    historicalScope: null,
  });
  assert.deepEqual(value("preparation.json"), {
    schemaVersion: "crewon.installed-plugin-native-preparation.v2",
    actor,
    scope: input.scope,
    approvedPackages: input.approvedPackages,
    plugins: input.plugins,
    workerConfigurationPath: join(directory, "worker.json"),
  });
  const result = parseNativeInstalledPluginPreparationResult(
    value("preparation-result.json"),
  );
  assert.deepEqual(result.actor, actor);
  assert.deepEqual(result.scope, input.scope);
  assert.deepEqual(
    result.plugins.map(({ pluginId }) => pluginId),
    input.plugins.map(({ pluginId }) => pluginId),
  );
  const document = readInstalledPluginReleaseDocument(
    join(directory, "release.json"),
  );
  assert.equal(document.defaultAgentVersionId, result.defaultAgentVersionId);
  assert.equal(document.tenantId, input.scope.tenantId);
  assert.equal(document.entries.length, input.plugins.length);
  for (const status of result.plugins) {
    assert.equal(status.state, "prepared");
    if (status.state !== "prepared")
      throw new Error("candidate_preparation_unexpected_blocked");
    const entry: InstalledPluginReleaseEntry | undefined =
      document.entries.find(
        ({ packageIdentity }) => packageIdentity.pluginId === status.pluginId,
      );
    assert.ok(entry);
    assert.deepEqual(entry.scope, input.scope);
    assert.deepEqual(
      entry.packageIdentity,
      input.approvedPackages.find(
        ({ pluginId }) => pluginId === status.pluginId,
      ),
    );
    assert.deepEqual(
      entry.configuration,
      input.configurations.find(({ pluginId }) => pluginId === status.pluginId),
    );
    assert.equal(
      entry.approvalRequirement,
      input.plugins.find(({ pluginId }) => pluginId === status.pluginId)!
        .approvalRequirement,
    );
    assert.deepEqual(status.packageIdentity, entry.packageIdentity);
    assert.deepEqual(status.configuration, {
      revision: entry.configuration.revision,
      contentDigest: entry.configuration.contentDigest,
    });
    assert.equal(status.approvalRequirement, entry.approvalRequirement);
    assert.deepEqual(status.target, entry.target);
  }
  return { directory, ino: metadata.ino, files, document, result };
}
