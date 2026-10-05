import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type test from "node:test";
import { verifyLocalPluginPackage } from "@crewon/plugin-host";
import { extensionManifestFixture } from "../../../packages/domain/src/extension-manifest.test-support.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
export async function conversationPackage(
  t: test.TestContext,
  options: {
    beforeCleanup?: () => Promise<void>;
    associationProtocol?: "1";
  } = {},
) {
  const source = await productionSourceFixture(t, options);
  const raw = await source.source("conversation", {
    pluginId: "test.conversation",
    uiOnly: true,
    requires: [
      "crewon.creative-projects",
      "crewon.project-conversations",
      ...(options.associationProtocol === "1"
        ? ["crewon.project-conversation-association"]
        : []),
      "crewon.execution",
    ].map((service) => ({ service, apiVersion: "1", optional: true })),
  });
  const business = Buffer.from(
    JSON.stringify({
      ...extensionManifestFixture(raw.pluginId),
      version: raw.version,
    }),
  );
  const node = Buffer.from(
    `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(source.marker)},'node-import\\n');export default {apiVersion:'crewon.plugin-host.v1',pluginId:'test.conversation',setup(){return {dispose(){}};}};`,
  );
  const descriptor = {
    ...raw.descriptor,
    entrypoints: { node: "node.mjs", ui: raw.descriptor.entrypoints.ui },
    businessManifestPath: "business.json",
    files: [
      ...raw.descriptor.files,
      ...[
        ["node.mjs", node],
        ["business.json", business],
      ].map(([path, bytes]) => ({
        path: path as string,
        byteLength: (bytes as Buffer).length,
        sha256: createHash("sha256")
          .update(bytes as Buffer)
          .digest("hex"),
      })),
    ],
  };
  await writeFile(join(raw.directory, "node.mjs"), node);
  await writeFile(join(raw.directory, "business.json"), business);
  await writeFile(
    join(raw.directory, "crewon.plugin.json"),
    JSON.stringify(descriptor),
  );
  const verified = await verifyLocalPluginPackage({ directory: raw.directory });
  return {
    source,
    pkg: { ...raw, descriptor, packageDigest: verified.packageDigest },
    publications: [
      {
        pluginId: raw.pluginId,
        packageDigest: verified.packageDigest,
        contributionId: "workbench",
      },
    ],
  };
}
