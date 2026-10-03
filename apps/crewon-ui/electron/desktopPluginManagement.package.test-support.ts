import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyLocalPluginPackage } from "../../../packages/plugin-host/src/local-plugin-package-verifier.ts";
import type { PluginPackageDescriptor } from "@crewon/contracts/plugins";

/** Actual independent package bytes whose mandatory tasks capability is absent in management mode. */
export async function missingTasksPackage(root: string) {
  const directory = join(root, "missing-tasks-package");
  const marker = join(root, "missing-tasks-node-loaded");
  await mkdir(directory, { mode: 0o700 });
  const bytes = Buffer.from(
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'loaded');export default {apiVersion:'crewon.plugin-host.v1',pluginId:'test.native-tasks',setup(){return {dispose(){}}}};`,
  );
  const descriptor: PluginPackageDescriptor = {
    schemaVersion: "crewon.plugin-package.v1",
    hostApi: "crewon.plugin-host.v1",
    pluginId: "test.native-tasks",
    publisherId: "test.publisher",
    version: "1.0.0",
    title: "Mandatory tasks negative fixture",
    description:
      "Actual package: management mode must refuse its absent tasks service before loading Node code.",
    entrypoints: { node: "node.mjs", ui: null },
    businessManifestPath: null,
    requires: [{ service: "crewon.tasks", apiVersion: "2", optional: false }],
    provides: [],
    contributions: [],
    files: [
      {
        path: "node.mjs",
        byteLength: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  };
  await writeFile(join(directory, "node.mjs"), bytes);
  await writeFile(
    join(directory, "crewon.plugin.json"),
    JSON.stringify(descriptor),
  );
  const verified = await verifyLocalPluginPackage({ directory });
  return {
    marker,
    source: {
      sourceId: "native-missing-tasks",
      directory,
      pluginId: descriptor.pluginId,
      publisherId: descriptor.publisherId,
      version: descriptor.version,
      packageDigest: verified.packageDigest,
    },
  };
}
