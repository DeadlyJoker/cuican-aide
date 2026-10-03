import {
  chmodSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  prepareAutomaticDesktopInstalledPluginRuntime,
  type AutomaticDesktopInstalledPluginRuntime,
} from "./desktopAutomaticInstalledPluginRuntime.ts";
import {
  DESKTOP_AUTOMATIC_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
  DESKTOP_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
  loadDesktopInstalledPluginRuntimeConfiguration,
  parseDesktopInstalledPluginRuntimeConfiguration,
  type EnabledDesktopAutomaticInstalledPluginRuntimeConfiguration,
} from "./desktopInstalledPluginRuntimeConfiguration.ts";
import { desktopInstalledPluginRuntimeFixture } from "./desktopInstalledPluginRuntime.test-support.ts";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";

const PREPARATION_PATH = "CREWON_INSTALLED_PLUGIN_NATIVE_PREPARATION_PATH";
type Fixture = Awaited<ReturnType<typeof fixture>>;
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
    return result;
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
    close,
  };
}
async function withFixture(run: (value: Fixture) => Promise<void>) {
  const value = await fixture();
  try {
    await run(value);
  } finally {
    await value.close();
  }
}
function directories(value: Fixture) {
  return readdirSync(value.dataDirectory).filter((name) =>
    name.startsWith(".installed-plugin-preparation-"),
  );
}

describe("fixed Native v2 automatic preparation", () => {
  it("preserves v1 and accepts exact disabled v2 without introducing active fields", async () => {
    await withFixture(async (f) => {
      const v1 = parseDesktopInstalledPluginRuntimeConfiguration(
        f.operatorConfiguration,
      );
      expect(v1.schemaVersion).toBe(DESKTOP_INSTALLED_PLUGIN_RUNTIME_SCHEMA);
      expect(
        parseDesktopInstalledPluginRuntimeConfiguration({
          schemaVersion: DESKTOP_AUTOMATIC_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
          enabled: false,
        }),
      ).toEqual({
        schemaVersion: DESKTOP_AUTOMATIC_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
        enabled: false,
      });
      expect(directories(f)).toEqual([]);
      f.write({
        schemaVersion: DESKTOP_AUTOMATIC_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
        enabled: false,
      });
      expect(
        loadDesktopInstalledPluginRuntimeConfiguration(f.dataDirectory),
      ).toEqual({
        schemaVersion: DESKTOP_AUTOMATIC_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
        enabled: false,
      });
      expect(directories(f)).toEqual([]);
    });
  });
  it("captures a real v2 file and writes private fixed preparation/worker inputs without release output or secrets", async () => {
    await withFixture(async (f) => {
      const owner = f.prepare();
      const p = f.paths(owner);
      expect(dirname(p.directory)).toBe(f.dataDirectory);
      expect(lstatSync(p.directory).mode & 0o777).toBe(0o700);
      expect(readdirSync(p.directory)).toEqual([
        "preparation.json",
        "worker.json",
      ]);
      for (const file of [p.preparationPath, p.workerPath]) {
        expect(lstatSync(file)).toMatchObject({
          uid: process.getuid?.(),
          nlink: 1,
        });
        expect(lstatSync(file).mode & 0o777).toBe(0o600);
      }
      const { sourceId: _id, directory: _source, ...identity } = f.source;
      expect(f.read(p.preparationPath)).toEqual({
        schemaVersion: "crewon.installed-plugin-native-preparation.v1",
        actor: DESKTOP_RUNTIME_OWNER,
        scope: f.bootstrap.scope,
        approvedPackages: [identity],
        plugins: f.value.plugins,
        workerConfigurationPath: p.workerPath,
      });
      expect(f.read(p.workerPath)).toEqual({
        ...f.workerConfiguration,
        releaseDocumentPath: p.releasePath,
      });
      for (const file of [p.preparationPath, p.workerPath]) {
        const bytes = readFileSync(file, "utf8");
        expect(bytes).not.toContain(f.provider.apiKey);
        expect(bytes).not.toContain(
          f.input.sharedEnvironment.NATIVE_INSTALLED_AUTHORITY_TOKEN,
        );
        expect(bytes).not.toContain(
          f.input.sharedEnvironment.CREWON_CONTROL_SESSION_TOKEN,
        );
      }
      expect(
        owner.preparationEnvironment
          .CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH,
      ).toBeUndefined();
      expect(
        owner.preparationEnvironment.CREWON_INSTALLED_PLUGIN_PEER_TOKEN,
      ).toBeUndefined();
      expect(
        owner.preparationEnvironment.NATIVE_INSTALLED_AUTHORITY_TOKEN,
      ).toBe(f.input.sharedEnvironment.NATIVE_INSTALLED_AUTHORITY_TOKEN);
      expect(JSON.stringify(owner)).not.toContain(f.provider.apiKey);
      expect(
        (globalThis as unknown as Record<string, unknown>)
          .__nativePluginMustNotImport,
      ).toBeUndefined();
    });
  });
  it("uses the original issued v1 runtime only after validating a physically generated complete output", async () => {
    await withFixture(async (f) => {
      const owner = f.prepare();
      const p = f.output(owner);
      // Synthetic compiled assets test the Native ownership boundary only, never publication/readiness.
      const runtime = owner.complete();
      expect(owner.complete()).toBe(runtime);
      expect(
        runtime.release.CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH,
      ).toBe(p.workerPath);
      expect(runtime.release[PREPARATION_PATH]).toBeUndefined();
      expect(runtime.worker[PREPARATION_PATH]).toBeUndefined();
      expect(runtime.expectedCatalogEntries).toHaveLength(1);
      expect(
        Object.keys(runtime.control).some((name) =>
          name.startsWith("CREWON_INSTALLED_PLUGIN_"),
        ),
      ).toBe(false);
      expect(runtime.control.NATIVE_INSTALLED_AUTHORITY_TOKEN).toBeUndefined();
      await runtime.close();
      expect(readdirSync(p.directory)).toEqual([
        "preparation.json",
        "release.json",
        "worker.json",
      ]);
      await owner.close();
      expect(directories(f)).toEqual([]);
      expect(readFileSync(f.configurationPath, "utf8")).toContain(
        DESKTOP_AUTOMATIC_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
      );
    });
  });
  it("freezes environment/path values before preparation and preserves exact provider validation", async () => {
    await withFixture(async (f) => {
      const originalToken =
        f.input.sharedEnvironment.NATIVE_INSTALLED_AUTHORITY_TOKEN;
      const owner = f.prepare();
      f.input.sharedEnvironment.NATIVE_INSTALLED_AUTHORITY_TOKEN =
        "changed-token-value-".repeat(2);
      f.input.workerEnvironment.NATIVE_INSTALLED_AUTHORITY_TOKEN =
        "changed-token-value-".repeat(2);
      expect(
        owner.preparationEnvironment.NATIVE_INSTALLED_AUTHORITY_TOKEN,
      ).toBe(originalToken);
      f.output(owner);
      expect(owner.complete().release.NATIVE_INSTALLED_AUTHORITY_TOKEN).toBe(
        originalToken,
      );
      f.provider.modelId = "changed-model";
      expect(() => owner.assertCurrent()).toThrow();
    });
  });
  it("accepts an explicit credential-free provider using the actual null slot and flag", async () => {
    await withFixture(async (f) => {
      const config = {
        ...f.value,
        providerBinding: {
          ...f.value.providerBinding,
          credentialRequired: false,
        },
      };
      f.write(config);
      const owner = prepareAutomaticDesktopInstalledPluginRuntime({
        ...f.input,
        provider: { ...f.provider, apiKey: null },
        sharedEnvironment: {
          ...f.input.sharedEnvironment,
          CREWON_MODEL_API_KEY: "",
          CREWON_MODEL_CREDENTIAL_REQUIRED: "0",
        },
        workerEnvironment: {
          ...f.input.workerEnvironment,
          CREWON_MODEL_API_KEY: "",
          CREWON_MODEL_CREDENTIAL_REQUIRED: "0",
        },
        configuration: f.configuration(),
      });
      try {
        expect(
          owner.preparationEnvironment.CREWON_MODEL_CREDENTIAL_REQUIRED,
        ).toBe("0");
      } finally {
        await owner.close();
      }
    });
  });
  it.each(["config-copy", "bootstrap-copy", "unapproved", "wrong-data-root"])(
    "does not issue paths from %s",
    async (kind) => {
      await withFixture(async (f) => {
        const parsed = parseDesktopInstalledPluginRuntimeConfiguration(f.value);
        if (
          !parsed.enabled ||
          parsed.schemaVersion !==
            DESKTOP_AUTOMATIC_INSTALLED_PLUGIN_RUNTIME_SCHEMA
        )
          throw new Error("fixture type");
        if (kind === "unapproved")
          f.write({
            ...f.value,
            plugins: [
              { pluginId: "other.plugin", approvalRequirement: "none" },
            ],
          });
        expect(() =>
          prepareAutomaticDesktopInstalledPluginRuntime({
            ...f.input,
            configuration: kind === "config-copy" ? parsed : f.configuration(),
            bootstrap:
              kind === "bootstrap-copy" ? { ...f.bootstrap } : f.bootstrap,
            dataDirectory:
              kind === "wrong-data-root" ? f.directory : f.dataDirectory,
          }),
        ).toThrow();
        expect(directories(f)).toEqual([]);
      });
    },
  );
  it.each(["missing", "wrong-approval", "extra-plugin", "default-drift"])(
    "refuses generated %s and withdraws further work",
    async (kind) => {
      await withFixture(async (f) => {
        const owner = f.prepare();
        if (kind === "wrong-approval")
          f.output(owner, {
            ...f.release,
            entries: [
              { ...f.release.entries[0], approvalRequirement: "perAction" },
            ],
          });
        if (kind === "extra-plugin")
          f.output(owner, {
            ...f.release,
            entries: [...f.release.entries, ...f.release.entries],
          });
        if (kind === "default-drift")
          f.output(owner, {
            ...f.release,
            defaultAgentVersionId: "another-default",
          });
        expect(() => owner.complete()).toThrow();
        expect(() => owner.preparationEnvironment).toThrow("withdrawn");
      });
    },
  );
  it.each(["preparation", "worker", "fixed-config", "release"])(
    "rejects actual %s file drift",
    async (kind) => {
      await withFixture(async (f) => {
        const owner = f.prepare();
        const p = f.output(owner);
        if (kind === "release") owner.complete();
        const path =
          kind === "preparation"
            ? p.preparationPath
            : kind === "worker"
              ? p.workerPath
              : kind === "fixed-config"
                ? f.configurationPath
                : p.releasePath;
        writeFileSync(path, readFileSync(path, "utf8") + " ");
        expect(() => owner.assertCurrent()).toThrow("file_changed");
      });
    },
  );
  it("synchronously withdraws on abort and retains private inputs until explicit physical-owner close", async () => {
    await withFixture(async (f) => {
      const owner = f.prepare();
      const p = f.paths(owner);
      f.controller.abort();
      expect(() => owner.complete()).toThrow("withdrawn");
      expect(() => owner.preparationEnvironment).toThrow("withdrawn");
      expect(readdirSync(p.directory)).toEqual([
        "preparation.json",
        "worker.json",
      ]);
      await owner.close();
      await owner.close();
      expect(directories(f)).toEqual([]);
    });
  });
  it("does not remove a replaced preparation directory during cleanup", async () => {
    await withFixture(async (f) => {
      const owner = f.prepare();
      const p = f.paths(owner);
      renameSync(p.directory, `${p.directory}-original`);
      expect(() => owner.assertCurrent()).toThrow();
      await expect(owner.close()).rejects.toThrow();
      expect(
        readFileSync(
          join(`${p.directory}-original`, "preparation.json"),
          "utf8",
        ),
      ).toContain("native-preparation");
      renameSync(`${p.directory}-original`, p.directory);
      await owner.close();
      expect(directories(f)).toEqual([]);
    });
  });
  it("retains its inputs when the actual private parent loses its mode", async () => {
    await withFixture(async (f) => {
      const owner = f.prepare();
      const p = f.paths(owner);
      chmodSync(f.dataDirectory, 0o755);
      expect(() => owner.assertCurrent()).toThrow("data_directory");
      await expect(owner.close()).rejects.toThrow("data_directory");
      expect(readFileSync(p.preparationPath, "utf8")).toContain(
        "native-preparation",
      );
      chmodSync(f.dataDirectory, 0o700);
      await owner.close();
      expect(directories(f)).toEqual([]);
    });
  });
  it.each([
    "plugins-empty",
    "plugins-duplicate",
    "plugins-sparse",
    "approval",
    "unknown",
    "http",
    "token-alias",
    "credentials-url",
  ])("strictly rejects v2 %s", async (kind) => {
    await withFixture(async (f) => {
      const input = structuredClone(f.value);
      if (kind === "plugins-empty") input.plugins = [];
      if (kind === "plugins-duplicate") input.plugins.push(input.plugins[0]!);
      if (kind === "plugins-sparse") input.plugins.length = 2;
      const endpoint = { ...input.workerAuthorities.actorAuthority };
      if (kind === "http") endpoint.url = "http://authority.example/check";
      if (kind === "credentials-url")
        endpoint.url = "https://secret@authority.example/check";
      if (kind === "token-alias")
        endpoint.serviceTokenEnvironmentVariable = "CREWON_MODEL_API_KEY";
      input.workerAuthorities.actorAuthority = endpoint;
      const invalid =
        kind === "approval"
          ? {
              ...input,
              plugins: [
                {
                  pluginId: f.source.pluginId,
                  approvalRequirement: "automatic",
                },
              ],
            }
          : kind === "unknown"
            ? { ...input, quote: "implicit-price" }
            : input;
      expect(() =>
        parseDesktopInstalledPluginRuntimeConfiguration(invalid),
      ).toThrow();
    });
  });
  it("rejects accessors without invoking them and deeply freezes valid selections/authorities", async () => {
    await withFixture(async (f) => {
      const getter = vi.fn(() => f.value.plugins[0]);
      const plugins = Object.defineProperty([f.value.plugins[0]], "0", {
        enumerable: true,
        get: getter,
      });
      expect(() =>
        parseDesktopInstalledPluginRuntimeConfiguration({
          ...f.value,
          plugins,
        }),
      ).toThrow();
      expect(getter).not.toHaveBeenCalled();
      const loaded = f.configuration();
      expect(Object.isFrozen(loaded.plugins)).toBe(true);
      expect(Object.isFrozen(loaded.plugins[0])).toBe(true);
      expect(Object.isFrozen(loaded.workerAuthorities)).toBe(true);
      expect(Object.isFrozen(loaded.workerAuthorities.actorAuthority)).toBe(
        true,
      );
    });
  });
});
