import {
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareDesktopInstalledPluginRuntime } from "./desktopInstalledPluginRuntime.ts";
import {
  loadDesktopInstalledPluginRuntimeConfiguration,
  parseDesktopInstalledPluginRuntimeConfiguration,
} from "./desktopInstalledPluginRuntimeConfiguration.ts";
import { desktopInstalledPluginRuntimeFixture } from "./desktopInstalledPluginRuntime.test-support.ts";

const fixtures: Awaited<
  ReturnType<typeof desktopInstalledPluginRuntimeFixture>
>[] = [];
async function fixture() {
  const f = await desktopInstalledPluginRuntimeFixture();
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  delete (globalThis as { __nativePluginMustNotImport?: boolean })
    .__nativePluginMustNotImport;
  for (const f of fixtures.splice(0))
    rmSync(f.directory, { recursive: true, force: true });
});

describe("Native complete installed release input ownership", () => {
  it("preserves default Control and gives only release/Worker the captured authority refs and private Worker peer", async () => {
    const f = await fixture();
    const before = readdirSync(f.dataDirectory).sort();
    const owner = f.prepare();
    expect(owner.token).toMatch(/^[a-f0-9]{64}$/u);
    expect(owner.release.CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH).toBe(
      f.workerPath,
    );
    expect(owner.release.CREWON_INSTALLED_PLUGIN_PEER_TOKEN).toBeUndefined();
    expect(owner.worker.CREWON_INSTALLED_PLUGIN_PEER_PORT).toBe("0");
    expect(owner.worker.CREWON_INSTALLED_PLUGIN_PEER_TOKEN).toBe(owner.token);
    const { NATIVE_INSTALLED_AUTHORITY_TOKEN: _token, ...control } =
      f.input.sharedEnvironment;
    expect(owner.control).toEqual(control);
    expect(owner.control.CREWON_CONTROL_SESSION_TOKEN).toBe(
      f.input.sharedEnvironment.CREWON_CONTROL_SESSION_TOKEN,
    );
    expect(owner.control.CREWON_AGENT_VERSION_ID).toBe(
      f.release.defaultAgentVersionId,
    );
    expect(owner.control.CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH).toBe(
      f.input.sharedEnvironment.CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH,
    );
    expect(
      Object.keys(owner.control).some((name) =>
        name.startsWith("CREWON_INSTALLED_PLUGIN_"),
      ),
    ).toBe(false);
    expect(owner.expectedCatalogEntries).toEqual([
      {
        identity: {
          ...f.release.entries[0]!.packageIdentity,
          manifestDigest: f.release.entries[0]!.configuration.manifestDigest,
          implementationDigest:
            f.release.entries[0]!.configuration.implementationDigest,
        },
        configuration: f.release.entries[0]!.configuration,
        configuredTarget: f.release.entries[0]!.target,
      },
    ]);
    expect(
      (globalThis as { __nativePluginMustNotImport?: boolean })
        .__nativePluginMustNotImport,
    ).toBeUndefined();
    expect(JSON.stringify(owner)).not.toContain(
      f.input.sharedEnvironment.NATIVE_INSTALLED_AUTHORITY_TOKEN,
    );
    owner.assertCurrent();
    await owner.close();
    await owner.close();
    expect(readdirSync(f.dataDirectory).sort()).toEqual(before);
    expect(() => owner.token).toThrow("withdrawn");
    for (const key of ["release", "worker", "control"] as const)
      expect(() => owner[key]).toThrow("withdrawn");
  });
  it("cold-loads from installed bytes after the original approved source goes offline", async () => {
    const f = await fixture();
    rmSync(f.source.directory, { recursive: true });
    const first = f.prepare();
    first.assertCurrent();
    await first.close();
    const fresh = f.prepare();
    fresh.assertCurrent();
    expect(fresh.expectedCatalogEntries[0]!.identity.packageDigest).toBe(
      f.source.packageDigest,
    );
    await fresh.close();
  });
  it.each([
    "configuration",
    "worker",
    "release",
    "approval",
    "profile",
    "bootstrap",
    "descriptor",
    "artifact",
  ])(
    "withdraws exact captured inputs after %s storage changes",
    async (kind) => {
      const f = await fixture();
      const owner = f.prepare();
      const path = {
        configuration: f.configurationPath,
        worker: f.workerPath,
        release: f.releasePath,
        approval: f.approvalPath,
        profile: join(f.dataDirectory, "plugin-profile.json"),
        bootstrap: f.bootstrap.bootstrapPath,
        descriptor: join(f.installedDirectory, "crewon.plugin.json"),
        artifact: join(f.installedDirectory, "node.mjs"),
      }[kind]!;
      writeFileSync(`${path}.replacement`, readFileSync(path), { mode: 0o600 });
      renameSync(`${path}.replacement`, path);
      expect(() => owner.assertCurrent()).toThrow();
      expect(() => owner.worker).toThrow();
      await owner.close();
    },
  );
  it("rejects cloned Native config/bootstrap authority and a different actual dataDirectory", async () => {
    const f = await fixture();
    const configuration = loadDesktopInstalledPluginRuntimeConfiguration(
      f.dataDirectory,
    );
    if (!configuration.enabled) throw new Error("not enabled");
    const parsed = parseDesktopInstalledPluginRuntimeConfiguration(
      f.configuration,
    );
    if (!parsed.enabled) throw new Error("not enabled");
    expect(() =>
      prepareDesktopInstalledPluginRuntime({
        ...f.input,
        configuration: parsed,
      }),
    ).toThrow("configuration_unissued");
    expect(() =>
      prepareDesktopInstalledPluginRuntime({
        ...f.input,
        configuration,
        bootstrap: { ...f.bootstrap },
      }),
    ).toThrow("unissued");
    expect(() =>
      prepareDesktopInstalledPluginRuntime({
        ...f.input,
        configuration,
        dataDirectory: f.directory,
      }),
    ).toThrow("configuration_unissued");
  });
  it.each([
    "CREWON_EXTENSIONS_ENABLED",
    "CREWON_EXTENSION_HOST_ORIGIN",
    "CREWON_INSTALLED_PLUGIN_TASK_CONFIG_PATH",
    "CREWON_INSTALLED_PLUGIN_PEER_TOKEN",
  ])("refuses mixed or ambient execution configuration: %s", async (name) => {
    const f = await fixture();
    Object.assign(f.input.sharedEnvironment, { [name]: "ambient" });
    expect(() => f.prepare()).toThrow("legacy_composition");
  });
  it.each([
    "CREWON_CONTROL_SESSION_TOKEN",
    "CREWON_MODEL_API_KEY",
    "CREWON_RELEASE_PRINCIPAL_ID",
    "PATH",
    "HOME",
    "NODE_OPTIONS",
    "ELECTRON_RUN_AS_NODE",
  ])(
    "refuses authority-token aliasing of preserved runtime fields: %s",
    async (name) => {
      const f = await fixture();
      f.workerConfiguration.actorAuthority.serviceTokenEnvironmentVariable =
        name;
      f.writeInputs();
      expect(() => f.prepare()).toThrow("authority_reference");
    },
  );
  it("refuses conflicting authority snapshots, wrong SQLite path and changed actual provider", async () => {
    const f = await fixture();
    f.input.workerEnvironment.NATIVE_INSTALLED_AUTHORITY_TOKEN =
      "different-native-authority-token-".repeat(2);
    expect(() => f.prepare()).toThrow("authority_token_conflict");
    f.input.workerEnvironment.NATIVE_INSTALLED_AUTHORITY_TOKEN =
      f.input.sharedEnvironment.NATIVE_INSTALLED_AUTHORITY_TOKEN;
    f.input.workerEnvironment.CREWON_CONTROL_DB_PATH = join(
      f.directory,
      "wrong.sqlite",
    );
    expect(() => f.prepare()).toThrow("native_environment");
    f.input.workerEnvironment.CREWON_CONTROL_DB_PATH =
      f.input.sharedEnvironment.CREWON_CONTROL_DB_PATH;
    const owner = f.prepare();
    f.provider.modelId = "new-provider-model";
    expect(() => owner.assertCurrent()).toThrow("provider_changed");
    await owner.close();
  });
  it.each([
    "scope",
    "package",
    "default",
    "model",
    "endpoint",
    "shared-bindings",
    "extension-bindings",
  ])("refuses a release crossing the Native boundary: %s", async (kind) => {
    const f = await fixture();
    const entry = f.release.entries[0]!;
    if (kind === "scope")
      entry.scope = { ...entry.scope, profileId: "another-profile" };
    if (kind === "package")
      entry.packageIdentity.packageDigest = `sha256:${"b".repeat(64)}`;
    if (kind === "default") f.release.defaultAgentVersionId = "another-default";
    if (kind === "model")
      entry.modelSource.version = {
        ...entry.modelSource.version,
        model: { ...entry.modelSource.version.model, modelId: "another-model" },
      };
    if (kind === "endpoint")
      entry.modelSource.runtimeBinding.provider.endpoint =
        "https://other.example/v1/responses";
    if (kind === "shared-bindings")
      entry.modelSource.runtimeBinding.toolRuntimeMode = "shared";
    if (kind === "extension-bindings")
      Object.assign(entry.modelSource.runtimeBinding, {
        extensionConfigPath: "/unexpected/config.json",
      });
    f.writeInputs();
    expect(() => f.prepare()).toThrow();
  });
  it("abort withdraws synchronously and no later environment remains available", async () => {
    const f = await fixture();
    const owner = f.prepare();
    f.controller.abort(new Error("native-stop"));
    expect(() => owner.assertCurrent()).toThrow("withdrawn");
    expect(() => owner.control).toThrow("withdrawn");
    await owner.close();
    expect(() => f.prepare()).toThrow("native-stop");
  });
});
