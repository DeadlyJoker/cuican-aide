import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ActorContext,
  PluginInstallationStore,
} from "@crewon/application";
import type { PluginProfileScope } from "@crewon/domain";
import {
  installationRecipe,
  selectionRecipe,
} from "../../store/src/plugin-installation-store.test-support.ts";
import { installLocalPluginPackage } from "./local-plugin-package-installer.ts";

export const lifecycleProviderId = "example.lifecycle-provider";
export const sharedLifecycleService = "fixture.shared-lifecycle";

/** A separately installed provider, consumed through the actual coordinated graph. */
export async function installLifecycleProvider(
  input: Readonly<{
    root: string;
    installRoot: string;
    ledger: PluginInstallationStore;
    actor: ActorContext;
    profile: PluginProfileScope;
  }>,
) {
  const directory = join(input.root, "provider");
  await mkdir(directory, { mode: 0o700 });
  const bytes = Buffer.from(`export default {
    apiVersion:'crewon.plugin-host.v1',pluginId:'${lifecycleProviderId}',
    setup(ctx){ctx.services.provide('${sharedLifecycleService}','1',ctx.services.get('fixture.lifecycle','1'))}
  };`);
  await writeFile(join(directory, "entry.mjs"), bytes);
  await writeFile(
    join(directory, "crewon.plugin.json"),
    JSON.stringify({
      schemaVersion: "crewon.plugin-package.v1",
      hostApi: "crewon.plugin-host.v1",
      pluginId: lifecycleProviderId,
      version: "1.0.0",
      title: "Shared lifecycle provider",
      description: "Actual installed provider fixture",
      publisherId: "example.fixture",
      entrypoints: { node: "entry.mjs", ui: null },
      businessManifestPath: null,
      requires: [
        { service: "fixture.lifecycle", apiVersion: "1", optional: false },
      ],
      provides: [{ service: sharedLifecycleService, apiVersion: "1" }],
      contributions: [],
      files: [
        {
          path: "entry.mjs",
          byteLength: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ],
    }),
  );
  const installed = await installLocalPluginPackage({
    directory,
    installRoot: input.installRoot,
    authorization: async () => ({ outcome: "allow" }),
  });
  const saved = await input.ledger.recordInstalledPackage(
    installationRecipe("provider-install", {
      actor: input.actor,
      scope: input.profile,
      pluginId: lifecycleProviderId,
      version: installed.descriptor.version,
      publisherId: installed.descriptor.publisherId,
      packageDigest: installed.packageDigest,
    }),
  );
  const enabled = await input.ledger.commitSelection(
    selectionRecipe(saved.selection, "provider-enable", { actor: input.actor }),
  );
  await rm(directory, { recursive: true, force: true });
  return { installed, selection: enabled.selection };
}
