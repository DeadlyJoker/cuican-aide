import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  NATIVE_INSTALLED_PLUGIN_PREPARATION_RESULT_SCHEMA,
  type NativeInstalledPluginPreparationStatus,
} from "@crewon/contracts/plugins";
import {
  prepareAutomaticDesktopInstalledPluginRuntime,
  type AutomaticDesktopInstalledPluginRuntime,
} from "./desktopAutomaticInstalledPluginRuntime.ts";
import {
  DESKTOP_AUTOMATIC_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
  loadDesktopInstalledPluginRuntimeConfiguration,
  type EnabledDesktopAutomaticInstalledPluginRuntimeConfiguration,
} from "./desktopInstalledPluginRuntimeConfiguration.ts";
import { desktopInstalledPluginRuntimeFixture } from "./desktopInstalledPluginRuntime.test-support.ts";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";
const PREPARATION_PATH = "CREWON_INSTALLED_PLUGIN_NATIVE_PREPARATION_PATH";
export type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture() {
  const original = await desktopInstalledPluginRuntimeFixture();
  const {
    actorAuthority,
    policyAuthority,
    profileAuthority,
    packageAuthority,
    networkAuthority,
    timeoutMs,
  } = original.workerConfiguration;
  const value = {
    schemaVersion: DESKTOP_AUTOMATIC_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
    enabled: true,
    providerBinding: original.configuration.providerBinding,
    plugins: [
      {
        pluginId: original.source.pluginId,
        approvalRequirement: "none" as const,
      },
    ],
    workerAuthorities: {
      actorAuthority,
      policyAuthority,
      profileAuthority,
      packageAuthority,
      networkAuthority,
      timeoutMs,
    },
  };
  const owners = new Set<AutomaticDesktopInstalledPluginRuntime>();
  function write(input: unknown = value) {
    writeFileSync(original.configurationPath, JSON.stringify(input), {
      mode: 0o600,
    });
  }
  write();
  function configuration(): EnabledDesktopAutomaticInstalledPluginRuntimeConfiguration {
    const loaded = loadDesktopInstalledPluginRuntimeConfiguration(
      original.dataDirectory,
    );
    if (
      !loaded.enabled ||
      loaded.schemaVersion !== DESKTOP_AUTOMATIC_INSTALLED_PLUGIN_RUNTIME_SCHEMA
    )
      throw new Error("fixture automatic configuration");
    return loaded;
  }
  function prepare(config = configuration()) {
    const owner = prepareAutomaticDesktopInstalledPluginRuntime({
      ...original.input,
      configuration: config,
    });
    owners.add(owner);
    return owner;
  }
  function paths(owner: AutomaticDesktopInstalledPluginRuntime) {
    const preparationPath = owner.preparationEnvironment[PREPARATION_PATH];
    if (!preparationPath) throw new Error("fixture preparation path");
    const directory = dirname(preparationPath);
    return {
      directory,
      preparationPath,
      workerPath: join(directory, "worker.json"),
      releasePath: join(directory, "release.json"),
      resultPath: join(directory, "preparation-result.json"),
    };
  }
  function read(path: string) {
    return JSON.parse(readFileSync(path, "utf8"));
  }
  function output(
    owner: AutomaticDesktopInstalledPluginRuntime,
    document: unknown = original.release,
  ) {
    const result = paths(owner);
    writeFileSync(result.releasePath, JSON.stringify(document), {
      flag: "wx",
      mode: 0o600,
    });
    writeResult(owner);
    return result;
  }
  function statuses(): NativeInstalledPluginPreparationStatus[] {
    return value.plugins.map(
      ({
        pluginId,
        approvalRequirement,
      }): NativeInstalledPluginPreparationStatus => {
        const entry = original.release.entries.find(
          (entry) => entry.packageIdentity.pluginId === pluginId,
        );
        return entry
          ? {
              pluginId,
              state: "prepared",
              packageIdentity: entry.packageIdentity,
              configuration: {
                revision: entry.configuration.revision,
                contentDigest: entry.configuration.contentDigest,
              },
              approvalRequirement,
              target: {
                ...entry.target,
                executionAuthority: "crewonKernel" as const,
              },
            }
          : { pluginId, state: "blocked", reasonCode: "notApproved" };
      },
    );
  }
  function writeResult(
    owner: AutomaticDesktopInstalledPluginRuntime,
    plugins: unknown = statuses(),
    overrides: Record<string, unknown> = {},
  ) {
    const p = paths(owner);
    writeFileSync(
      p.resultPath,
      JSON.stringify({
        schemaVersion: NATIVE_INSTALLED_PLUGIN_PREPARATION_RESULT_SCHEMA,
        actor: DESKTOP_RUNTIME_OWNER,
        scope: original.bootstrap.scope,
        defaultAgentVersionId: original.release.defaultAgentVersionId,
        plugins,
        ...overrides,
      }),
      { flag: "wx", mode: 0o600 },
    );
    return p;
  }
  async function close() {
    await Promise.allSettled([...owners].map((owner) => owner.close()));
    await original.bootstrap.cleanup();
    rmSync(original.directory, { recursive: true, force: true });
  }
  return {
    ...original,
    operatorConfiguration: original.configuration,
    value,
    write,
    configuration,
    prepare,
    paths,
    read,
    output,
    statuses,
    writeResult,
    close,
  };
}
export async function withFixture(run: (value: Fixture) => Promise<void>) {
  const value = await fixture();
  try {
    await run(value);
  } finally {
    await value.close();
  }
}
export function directories(value: Fixture) {
  return readdirSync(value.dataDirectory).filter((name) =>
    name.startsWith(".installed-plugin-preparation-"),
  );
}
