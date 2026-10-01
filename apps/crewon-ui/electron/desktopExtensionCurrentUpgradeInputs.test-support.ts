import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  commitExtensionRecoveryCapsule,
  extensionRecoveryDirectory,
  putExtensionRecoveryFile,
} from "@crewon/agent-version/extension-recovery";
import { extensionCanonicalJson } from "@crewon/domain";
import {
  createDesktopExtensionHistoricalFixture,
  historicalFixtureDigest as hash,
} from "./desktopExtensionHistoricalInputs.test-support.ts";
import {
  DESKTOP_EXTENSION_CONFIGURATION_FILE,
  DESKTOP_RUNTIME_OWNER,
  desktopExtensionRuntimeEnvironments,
} from "./desktopExtensionRuntime.ts";

/** Nonexecuted bundle metadata plus actual immutable capsule/SQLite material IO. */
export async function createDesktopExtensionCurrentUpgradeFixture(input: {
  dataRoot: string;
  original?: boolean;
}) {
  let value = await createDesktopExtensionHistoricalFixture({
    dataRoot: input.dataRoot,
    complete: input.original !== true,
  });
  let runtimeBindingsPath = join(value.directory, "plugin-bindings.json");
  let agentVersionAssetsPath = join(value.directory, "plugin-assets.json");
  if (input.original) {
    const operator = join(input.dataRoot, "operator");
    mkdirSync(operator);
    const snapshotPath = join(operator, "snapshot.json");
    const snapshotBytes = readFileSync(
      join(value.directory, "snapshot-00.json"),
    );
    writeFileSync(snapshotPath, snapshotBytes);
    const bindings = structuredClone(
      value.documents.get("plugin-bindings.json"),
    ) as {
      schemaVersion: string;
      bindings: { extensionConfigPath: string }[];
    };
    bindings.bindings[0]!.extensionConfigPath = snapshotPath;
    const bindingsBytes = Buffer.from(`${JSON.stringify(bindings)}\n`);
    const assetsBytes = readFileSync(agentVersionAssetsPath);
    runtimeBindingsPath = join(operator, "bindings.json");
    agentVersionAssetsPath = join(operator, "assets.json");
    writeFileSync(runtimeBindingsPath, bindingsBytes);
    writeFileSync(agentVersionAssetsPath, assetsBytes);
    const originalInputIdentityDigest = hash(
      extensionCanonicalJson({
        schemaVersion: "crewon.extension-recovery-source.v0",
        bindings: hash(bindingsBytes.toString("utf8")),
        assets: hash(assetsBytes.toString("utf8")),
        snapshots: [hash(snapshotBytes.toString("utf8"))],
      }),
    );
    const selection = {
      dataRoot: input.dataRoot,
      capsuleId: hash(
        extensionCanonicalJson({
          schemaVersion: "crewon.extension-recovery-selection.v0",
          implementationDigest: value.manifest.implementationDigest,
          buildIdentityDigest: value.manifest.buildIdentityDigest,
          owner: value.manifest.owner,
          originalInputIdentityDigest,
        }),
      ),
    };
    const directory = await extensionRecoveryDirectory({
      selection,
      create: true,
    });
    bindings.bindings[0]!.extensionConfigPath = join(
      directory,
      "snapshot-00.json",
    );
    value.documents.set("plugin-bindings.json", bindings);
    const files = [];
    for (const [file, document] of value.documents)
      files.push(
        await putExtensionRecoveryFile({
          selection,
          file,
          bytes: Buffer.from(`${JSON.stringify(document)}\n`),
        }),
      );
    const manifest = {
      ...value.manifest,
      capsuleId: selection.capsuleId,
      files,
    };
    await commitExtensionRecoveryCapsule({ selection, manifest });
    value = { ...value, selection, directory, manifest };
  }
  const currentBuildDirectory = join(
    input.dataRoot,
    "nonexecuted-installed-unit-bundles",
  );
  mkdirSync(currentBuildDirectory);
  const files = [
    "control-api.mjs",
    "runtime-worker.mjs",
    "runtime-release.mjs",
    "provider-model-catalog.mjs",
    "provider-settings-coordinator.mjs",
    "device-gateway.mjs",
    "local-workspace-checks-mcp.mjs",
  ];
  const bundles = files.sort().map((file) => {
    const bytes = `export const unit = ${JSON.stringify(file)};\n`;
    writeFileSync(join(currentBuildDirectory, file), bytes);
    return { file, digest: hash(bytes) };
  });
  writeFileSync(
    join(currentBuildDirectory, "extension-build-identity.json"),
    JSON.stringify({
      schemaVersion: "crewon.extension-build-identity.v1",
      historicalWorkItemScope: "crewon.extension-work-item-scope.v1",
      implementationDigest: hash("unit-current-source-build-port"),
      bundles,
    }),
  );
  const configuration = {
    schemaVersion: "crewon.desktop-extension-runtime.v0" as const,
    enabled: true as const,
    runtimeBindingsPath,
    agentVersionAssetsPath,
  };
  const configurationPath = join(
    input.dataRoot,
    DESKTOP_EXTENSION_CONFIGURATION_FILE,
  );
  writeFileSync(configurationPath, JSON.stringify(configuration));
  const sharedEnvironment = {
    CREWON_CONTROL_SECURITY_MODE: "standalone",
    CREWON_CONTROL_DB_PATH: value.databasePath,
    CREWON_AGENT_VERSION_ID: "current-default",
    CREWON_RESPONSES_ENDPOINT: "https://current-provider.example/v1/responses",
    CREWON_MODEL_API_KEY: "unit-current-active-key",
    CREWON_CONTROL_SESSION_TOKEN: "unit-current-session",
    CREWON_RELEASE_PRINCIPAL_ID: DESKTOP_RUNTIME_OWNER.principalId,
    CREWON_RELEASE_ACTOR_ID: DESKTOP_RUNTIME_OWNER.actorId,
  };
  const environments = desktopExtensionRuntimeEnvironments({
    configuration,
    sharedEnvironment,
    workerEnvironment: sharedEnvironment,
    retainedBuild: { dataRoot: input.dataRoot },
  });
  return {
    ...value,
    currentBuildDirectory,
    configuration,
    configurationPath,
    environments,
  };
}

/** A second nonexecuted unit publication exercises ambiguous exact original input proof. */
export async function duplicateDesktopExtensionCurrentUpgradeCandidate(
  value: Awaited<
    ReturnType<typeof createDesktopExtensionCurrentUpgradeFixture>
  >,
) {
  const originalInputIdentityDigest = hash(
    extensionCanonicalJson({
      schemaVersion: "crewon.extension-recovery-source.v0",
      bindings: hash(
        readFileSync(value.configuration.runtimeBindingsPath, "utf8"),
      ),
      assets: hash(
        readFileSync(value.configuration.agentVersionAssetsPath, "utf8"),
      ),
      snapshots: [
        hash(
          readFileSync(
            join(value.selection.dataRoot, "operator", "snapshot.json"),
            "utf8",
          ),
        ),
      ],
    }),
  );
  const implementationDigest = hash("second-old-unit-source-build-port");
  const selection = {
    dataRoot: value.selection.dataRoot,
    capsuleId: hash(
      extensionCanonicalJson({
        schemaVersion: "crewon.extension-recovery-selection.v0",
        implementationDigest,
        buildIdentityDigest: value.manifest.buildIdentityDigest,
        owner: value.manifest.owner,
        originalInputIdentityDigest,
      }),
    ),
  };
  const directory = await extensionRecoveryDirectory({
    selection,
    create: true,
  });
  const files = [];
  for (const [file, original] of value.documents) {
    const document = structuredClone(original);
    if (file === "plugin-bindings.json")
      (
        document as { bindings: { extensionConfigPath: string }[] }
      ).bindings[0]!.extensionConfigPath = join(directory, "snapshot-00.json");
    files.push(
      await putExtensionRecoveryFile({
        selection,
        file,
        bytes: Buffer.from(`${JSON.stringify(document)}\n`),
      }),
    );
  }
  await commitExtensionRecoveryCapsule({
    selection,
    manifest: {
      ...value.manifest,
      implementationDigest,
      capsuleId: selection.capsuleId,
      files,
    },
  });
}
