import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { verifyLocalPluginPackage } from "@crewon/plugin-host";
import {
  PLUGIN_PACKAGE_HOST_API,
  PLUGIN_PACKAGE_SCHEMA_VERSION,
  type PluginPackageDescriptor,
} from "@crewon/contracts/plugins";
import type { ProductionPluginInstallationConfiguration } from "./production-plugin-installation-environment.ts";

export async function productionSourceFixture(
  t: TestContext,
  options: Readonly<{ beforeCleanup?: () => Promise<void> }> = {},
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "crewon-approved-source-")),
  );
  await chmod(root, 0o700);
  t.after(async () => {
    await options.beforeCleanup?.();
    await writableDirectories(root);
    await rm(root, { recursive: true, force: true });
  });
  const installRoot = join(root, "installed");
  await mkdir(installRoot, { mode: 0o700 });
  const marker = join(root, "module-executed");
  async function source(
    sourceId = "report-v1",
    options: Partial<
      Pick<
        PluginPackageDescriptor,
        "pluginId" | "publisherId" | "version" | "title" | "description"
      >
    > & {
      validNode?: boolean;
      requiredService?: string;
      requires?: PluginPackageDescriptor["requires"];
      uiOnly?: boolean;
    } = {},
  ) {
    const directory = join(root, sourceId);
    await mkdir(directory, { mode: 0o700 });
    const { validNode, requiredService, requires, uiOnly, ...metadata } =
      options;
    const bytes = Buffer.from(
      validNode
        ? `import {appendFileSync} from 'node:fs';const log=(value)=>appendFileSync(${JSON.stringify(marker)},${JSON.stringify(sourceId)}+':'+value+'\\n');log('load');export default {apiVersion:'crewon.plugin-host.v1',pluginId:${JSON.stringify(options.pluginId ?? "test.report")},setup(){log('setup');return {dispose(){log('dispose');}};}};`
        : uiOnly
          ? "export default {apiVersion:'crewon.plugin-ui.v1',mount(){return {update(){},dispose(){}};}};"
          : `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');export default {};`,
    );
    const entry = uiOnly ? "ui.mjs" : "node.mjs";
    const descriptor: PluginPackageDescriptor = {
      schemaVersion: PLUGIN_PACKAGE_SCHEMA_VERSION,
      hostApi: PLUGIN_PACKAGE_HOST_API,
      pluginId: "test.report",
      publisherId: "test.publisher",
      version: "1.0.0",
      title: "Approved report",
      description: "Actual prebuilt fixture bytes; no real provider or price.",
      entrypoints: {
        node: uiOnly ? null : entry,
        ui: uiOnly ? { path: entry, mode: "trustedModule" } : null,
      },
      businessManifestPath: null,
      requires:
        requires ??
        (requiredService
          ? [{ service: requiredService, apiVersion: "1", optional: false }]
          : []),
      provides: [],
      contributions: uiOnly
        ? [
            {
              id: "workbench",
              kind: "module",
              slot: "main.content",
              title: "UI-only fixture",
            },
          ]
        : [],
      files: [
        {
          path: entry,
          byteLength: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ],
      ...metadata,
    };
    await writeFile(join(directory, entry), bytes);
    await writeFile(
      join(directory, "crewon.plugin.json"),
      JSON.stringify(descriptor),
    );
    const verified = await verifyLocalPluginPackage({ directory });
    return {
      sourceId,
      directory,
      pluginId: descriptor.pluginId,
      publisherId: descriptor.publisherId,
      version: descriptor.version,
      packageDigest: verified.packageDigest,
      descriptor,
    };
  }
  function configuration(
    sources: readonly Awaited<ReturnType<typeof source>>[],
  ): ProductionPluginInstallationConfiguration {
    return {
      installRoot,
      sources: sources.map(({ descriptor: _descriptor, ...source }) => source),
      profileAuthority: {
        url: "https://authority.example/profile",
        serviceToken: "p".repeat(32),
      },
      policyAuthority: {
        url: "https://authority.example/policy",
        serviceToken: "s".repeat(32),
      },
      timeoutMs: 2000,
    };
  }
  return { root, installRoot, marker, source, configuration };
}

async function writableDirectories(path: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) return;
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true }))
    if (entry.isDirectory() && !entry.isSymbolicLink())
      await writableDirectories(join(path, entry.name));
}
