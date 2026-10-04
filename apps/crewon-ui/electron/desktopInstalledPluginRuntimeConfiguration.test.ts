import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopPluginBootstrapFixture } from "./desktopPluginBootstrap.test-support.ts";
import { prepareDesktopPluginBootstrap } from "./desktopPluginBootstrap.ts";
import {
  assertDesktopInstalledPluginRuntimeConfiguration,
  createAutomaticDesktopInstalledPluginRuntimeFiles,
  desktopInstalledPluginActivationAuthority,
  desktopInstalledPluginTaskExecutionSettings,
  DESKTOP_ACTIVATABLE_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
  DESKTOP_AUTOMATIC_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
  DESKTOP_INSTALLED_PLUGIN_RUNTIME_FILE,
  DESKTOP_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
  DESKTOP_TASK_ENABLED_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
  isAutomaticDesktopInstalledPluginRuntimeConfiguration,
  loadDesktopInstalledPluginRuntimeConfiguration,
  parseDesktopInstalledPluginRuntimeConfiguration,
} from "./desktopInstalledPluginRuntimeConfiguration.ts";

const observed = vi.hoisted(() => ({
  paths: [] as string[],
  buffers: [] as number[],
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    lstatSync: ((...args: Parameters<typeof fs.lstatSync>) => {
      observed.paths.push(String(args[0]));
      return fs.lstatSync(...args);
    }) as typeof fs.lstatSync,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      observed.paths.push(String(args[0]));
      return fs.openSync(...args);
    },
    readSync: ((...args: Parameters<typeof fs.readSync>) => {
      observed.buffers.push(args[1].byteLength);
      return fs.readSync(...args);
    }) as typeof fs.readSync,
  };
});
const directories: string[] = [];
function fixture() {
  const f = desktopPluginBootstrapFixture();
  directories.push(f.directory);
  const path = join(f.dataDirectory, DESKTOP_INSTALLED_PLUGIN_RUNTIME_FILE);
  const value = {
    schemaVersion: DESKTOP_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
    enabled: true,
    workerConfigurationPath: join(f.dataDirectory, "worker.json"),
    providerBinding: {
      providerId: "native-provider",
      endpoint: "https://model.example/v1",
      responsesEndpoint: "https://model.example/v1/responses",
      modelId: "native-model",
      credentialRequired: true,
    },
  };
  function write(input: unknown = value) {
    writeFileSync(path, JSON.stringify(input), { mode: 0o600 });
  }
  observed.paths = [];
  observed.buffers = [];
  return { ...f, path, value, write };
}

function v4Fixture(f: ReturnType<typeof fixture>) {
  const authority = (role: string) => ({
    url: `https://authority.example/${role}`,
    serviceTokenEnvironmentVariable: `NATIVE_${role.toUpperCase()}_TOKEN`,
  });
  return {
    schemaVersion: DESKTOP_TASK_ENABLED_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
    enabled: true,
    providerBinding: { ...f.value.providerBinding },
    plugins: [{ pluginId: "example.worker", approvalRequirement: "none" }],
    workerAuthorities: {
      actorAuthority: authority("actor"),
      policyAuthority: authority("policy"),
      profileAuthority: authority("profile"),
      packageAuthority: authority("worker_package"),
      networkAuthority: null,
      timeoutMs: 20000,
    },
    activationAuthority: authority("activation"),
    taskExecution: {
      uiPublications: [
        {
          pluginId: f.source.pluginId,
          packageDigest: f.source.packageDigest,
          contributionId: "studio",
        },
      ],
      taskPolicyAuthority: authority("tasks"),
      uiPolicyAuthority: authority("ui"),
      packageAuthority: authority("packages"),
      quoteAuthority: authority("quotes"),
      timeoutMs: 20000,
      maximumPackages: 32,
    },
  };
}
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
  observed.paths = [];
  observed.buffers = [];
});

describe("fixed private Native installed runtime configuration", () => {
  it("absent opt-in reads only the fixed file and creates or scans nothing", () => {
    const f = fixture();
    expect(
      loadDesktopInstalledPluginRuntimeConfiguration(f.dataDirectory),
    ).toEqual({
      schemaVersion: DESKTOP_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
      enabled: false,
    });
    expect(observed.paths).toEqual([f.path]);
    expect(readdirSync(f.dataDirectory)).toEqual([]);
  });
  it("issues only a real private file snapshot with a deeply frozen provider binding", () => {
    const f = fixture();
    f.write();
    const config = loadDesktopInstalledPluginRuntimeConfiguration(
      f.dataDirectory,
    );
    expect(config).toEqual(f.value);
    expect(Object.isFrozen(config)).toBe(true);
    if (!config.enabled) throw new Error("not enabled");
    expect(Object.isFrozen(config.providerBinding)).toBe(true);
    expect(observed.buffers.every((size) => size === 128 * 1024 + 1)).toBe(
      true,
    );
    expect(() =>
      assertDesktopInstalledPluginRuntimeConfiguration(config, f.dataDirectory),
    ).not.toThrow();
    const copy = parseDesktopInstalledPluginRuntimeConfiguration(f.value);
    if (!copy.enabled) throw new Error("not enabled");
    expect(() =>
      assertDesktopInstalledPluginRuntimeConfiguration(copy, f.dataDirectory),
    ).toThrow("configuration_unissued");
  });
  it.each([
    "symlink",
    "hardlink",
    "mode",
    "public-directory",
    "oversize",
    "utf8",
    "fifo-shape",
  ])("refuses unsafe file storage: %s", (kind) => {
    const f = fixture();
    f.write();
    if (kind === "symlink") {
      renameSync(f.path, `${f.path}.target`);
      symlinkSync(`${f.path}.target`, f.path);
    }
    if (kind === "hardlink") linkSync(f.path, `${f.path}.alias`);
    if (kind === "mode") chmodSync(f.path, 0o644);
    if (kind === "public-directory") chmodSync(f.dataDirectory, 0o755);
    if (kind === "oversize") writeFileSync(f.path, "x".repeat(128 * 1024 + 1));
    if (kind === "utf8") writeFileSync(f.path, Buffer.from([0xff]));
    if (kind === "fifo-shape") {
      rmSync(f.path);
      mkdirSync(f.path);
    }
    expect(() =>
      loadDesktopInstalledPluginRuntimeConfiguration(f.dataDirectory),
    ).toThrow();
  });
  it("refuses symlink ancestors and invalidates a moved parent even with the same original file inode", () => {
    const f = fixture();
    f.write();
    const alias = join(f.directory, "alias");
    symlinkSync(f.dataDirectory, alias);
    expect(() =>
      loadDesktopInstalledPluginRuntimeConfiguration(alias),
    ).toThrow();
    const config = loadDesktopInstalledPluginRuntimeConfiguration(
      f.dataDirectory,
    );
    if (!config.enabled) throw new Error("not enabled");
    const before = lstatSync(f.path).ino;
    const previous = `${f.dataDirectory}-old`;
    renameSync(f.dataDirectory, previous);
    mkdirSync(f.dataDirectory, { mode: 0o700 });
    renameSync(join(previous, DESKTOP_INSTALLED_PLUGIN_RUNTIME_FILE), f.path);
    expect(lstatSync(f.path).ino).toBe(before);
    expect(() =>
      assertDesktopInstalledPluginRuntimeConfiguration(config, f.dataDirectory),
    ).toThrow("directory_changed");
  });
  it("invalidates exact inode replacement and in-place content changes", () => {
    const f = fixture();
    f.write();
    const config = loadDesktopInstalledPluginRuntimeConfiguration(
      f.dataDirectory,
    );
    if (!config.enabled) throw new Error("not enabled");
    writeFileSync(`${f.path}.replacement`, JSON.stringify(f.value), {
      mode: 0o600,
    });
    renameSync(`${f.path}.replacement`, f.path);
    expect(() =>
      assertDesktopInstalledPluginRuntimeConfiguration(config, f.dataDirectory),
    ).toThrow("file_changed");
    const fresh = loadDesktopInstalledPluginRuntimeConfiguration(
      f.dataDirectory,
    );
    if (!fresh.enabled) throw new Error("not enabled");
    f.write({
      ...f.value,
      providerBinding: { ...f.value.providerBinding, modelId: "changed" },
    });
    expect(() =>
      assertDesktopInstalledPluginRuntimeConfiguration(fresh, f.dataDirectory),
    ).toThrow("file_changed");
  });
  it.each([
    { enabled: false, workerConfigurationPath: "/extra" },
    { enabled: "true" },
    { schemaVersion: "future" },
    { workerConfigurationPath: "relative" },
    { workerConfigurationPath: "/private/../worker.json" },
    { walletId: "manager-payer" },
    { providerBinding: { apiKey: "must-not-be-written" } },
  ])("refuses unknown or ambiguous DTO fields: %j", (override) => {
    const f = fixture();
    expect(() =>
      parseDesktopInstalledPluginRuntimeConfiguration({
        ...f.value,
        ...override,
      }),
    ).toThrow();
  });
  it("does not invoke caller getters and accepts only the exact disabled shape", () => {
    const f = fixture();
    let calls = 0;
    const getter = {
      ...f.value,
      get providerBinding() {
        calls++;
        return f.value.providerBinding;
      },
    };
    expect(() =>
      parseDesktopInstalledPluginRuntimeConfiguration(getter),
    ).toThrow();
    expect(calls).toBe(0);
    f.write({
      schemaVersion: DESKTOP_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
      enabled: false,
    });
    expect(
      loadDesktopInstalledPluginRuntimeConfiguration(f.dataDirectory).enabled,
    ).toBe(false);
  });
});

describe("explicit Native v4 independent task settings", () => {
  it("parses the exact v4 opt-in and deeply freezes settings without issuing a runtime", () => {
    const f = fixture();
    const value = v4Fixture(f);
    const config = parseDesktopInstalledPluginRuntimeConfiguration(value);
    expect(config).toEqual(value);
    if (
      !config.enabled ||
      config.schemaVersion !==
        DESKTOP_TASK_ENABLED_INSTALLED_PLUGIN_RUNTIME_SCHEMA
    )
      throw new Error("fixture v4");
    expect(isAutomaticDesktopInstalledPluginRuntimeConfiguration(config)).toBe(
      true,
    );
    expect(Object.isFrozen(config.taskExecution)).toBe(true);
    expect(Object.isFrozen(config.taskExecution.uiPublications[0])).toBe(true);
    expect(Object.isFrozen(config.taskExecution.quoteAuthority)).toBe(true);
    value.taskExecution.quoteAuthority.url = "https://changed.example/quotes";
    expect(config.taskExecution.quoteAuthority.url).toBe(
      "https://authority.example/quotes",
    );
    expect(() => desktopInstalledPluginTaskExecutionSettings(config)).toThrow(
      "configuration_unissued",
    );
    expect(() => desktopInstalledPluginActivationAuthority(config)).toThrow(
      "configuration_unissued",
    );
    expect(
      parseDesktopInstalledPluginRuntimeConfiguration({
        schemaVersion: DESKTOP_TASK_ENABLED_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
        enabled: false,
      }),
    ).toEqual({
      schemaVersion: DESKTOP_TASK_ENABLED_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
      enabled: false,
    });
  });

  it("requires independent task role declarations and rejects grant, secret and disabled extras", () => {
    const f = fixture();
    const value = v4Fixture(f);
    for (const field of ["activationAuthority", "taskExecution"] as const) {
      const missing: Record<string, unknown> = { ...value };
      delete missing[field];
      expect(() =>
        parseDesktopInstalledPluginRuntimeConfiguration(missing),
      ).toThrow();
    }
    for (const field of Object.keys(value.taskExecution)) {
      const taskExecution: Record<string, unknown> = { ...value.taskExecution };
      delete taskExecution[field];
      expect(() =>
        parseDesktopInstalledPluginRuntimeConfiguration({
          ...value,
          taskExecution,
        }),
      ).toThrow();
    }
    for (const taskExecution of [
      { ...value.taskExecution, credits: "100" },
      {
        ...value.taskExecution,
        quoteAuthority: {
          ...value.taskExecution.quoteAuthority,
          serviceToken: "secret",
        },
      },
      {
        ...value.taskExecution,
        taskPolicyAuthority: value.activationAuthority,
        quoteAuthority: undefined,
      },
      {
        ...value.taskExecution,
        uiPolicyAuthority: {
          ...value.taskExecution.uiPolicyAuthority,
          url: "http://authority.example/ui",
        },
      },
      {
        ...value.taskExecution,
        packageAuthority: {
          ...value.taskExecution.packageAuthority,
          serviceTokenEnvironmentVariable: "CREWON_CONTROL_SESSION_TOKEN",
        },
      },
    ])
      expect(() =>
        parseDesktopInstalledPluginRuntimeConfiguration({
          ...value,
          taskExecution,
        }),
      ).toThrow();
    expect(() =>
      parseDesktopInstalledPluginRuntimeConfiguration({
        schemaVersion: DESKTOP_TASK_ENABLED_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
        enabled: false,
        taskExecution: value.taskExecution,
      }),
    ).toThrow();
    let reads = 0;
    const getter = { ...value.taskExecution };
    Object.defineProperty(getter, "quoteAuthority", {
      enumerable: true,
      get() {
        reads++;
        return value.taskExecution.quoteAuthority;
      },
    });
    expect(() =>
      parseDesktopInstalledPluginRuntimeConfiguration({
        ...value,
        taskExecution: getter,
      }),
    ).toThrow();
    expect(reads).toBe(0);
  });

  it.each(["v1", "v2", "v3"] as const)(
    "keeps genuine %s owners free of independent task authority",
    (version) => {
      const f = fixture();
      const v4 = v4Fixture(f);
      const { taskExecution, activationAuthority, ...automatic } = v4;
      const value =
        version === "v1"
          ? f.value
          : {
              ...automatic,
              schemaVersion:
                version === "v2"
                  ? DESKTOP_AUTOMATIC_INSTALLED_PLUGIN_RUNTIME_SCHEMA
                  : DESKTOP_ACTIVATABLE_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
              ...(version === "v3" ? { activationAuthority } : {}),
            };
      f.write(value);
      const config = loadDesktopInstalledPluginRuntimeConfiguration(
        f.dataDirectory,
      );
      if (!config.enabled) throw new Error("fixture enabled");
      expect(config).toEqual(value);
      expect(desktopInstalledPluginTaskExecutionSettings(config)).toBeNull();
      expect(desktopInstalledPluginActivationAuthority(config)).toEqual(
        version === "v3" ? activationAuthority : null,
      );
      expect(() =>
        parseDesktopInstalledPluginRuntimeConfiguration({
          ...value,
          taskExecution,
        }),
      ).toThrow();
    },
  );

  it("carries only genuine v4 file settings and activation to its private derived v1, including a UI-only approved package", async () => {
    const f = fixture();
    f.writeApproval();
    const bootstrap = await prepareDesktopPluginBootstrap(f.input);
    if (!bootstrap) throw new Error("fixture bootstrap");
    const value = v4Fixture(f);
    f.write(value);
    const config = loadDesktopInstalledPluginRuntimeConfiguration(
      f.dataDirectory,
    );
    if (
      !config.enabled ||
      !isAutomaticDesktopInstalledPluginRuntimeConfiguration(config)
    )
      throw new Error("fixture automatic");
    const files = createAutomaticDesktopInstalledPluginRuntimeFiles({
      configuration: config,
      dataDirectory: f.dataDirectory,
      bootstrap,
    });
    try {
      const settings = desktopInstalledPluginTaskExecutionSettings(config);
      expect(settings).toEqual(value.taskExecution);
      expect(
        desktopInstalledPluginTaskExecutionSettings(files.configuration),
      ).toBe(settings);
      expect(
        desktopInstalledPluginActivationAuthority(files.configuration),
      ).toEqual(value.activationAuthority);
      expect(files.configuration.schemaVersion).toBe(
        DESKTOP_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
      );
      expect(f.read(files.preparationPath).plugins).toEqual(value.plugins);
      expect(f.read(files.preparationPath).approvedPackages[0].pluginId).toBe(
        f.source.pluginId,
      );
      expect(
        value.plugins.some((entry) => entry.pluginId === f.source.pluginId),
      ).toBe(false);
      expect(f.read(files.workerPath)).not.toHaveProperty("taskExecution");
      expect(f.read(files.workerPath)).not.toHaveProperty(
        "activationAuthority",
      );
      expect(() =>
        desktopInstalledPluginTaskExecutionSettings({ ...config }),
      ).toThrow("configuration_unissued");
      expect(() =>
        desktopInstalledPluginTaskExecutionSettings({ ...files.configuration }),
      ).toThrow("configuration_unissued");
      files.withdraw();
      expect(() =>
        desktopInstalledPluginTaskExecutionSettings(files.configuration),
      ).toThrow("withdrawn");
      expect(() =>
        desktopInstalledPluginActivationAuthority(files.configuration),
      ).toThrow("withdrawn");
      expect(desktopInstalledPluginTaskExecutionSettings(config)).toBe(
        settings,
      );
    } finally {
      files.close();
      await bootstrap.cleanup();
    }
  });

  it.each(["plugin", "digest", "public-assets"] as const)(
    "rejects UI publication outside actual bootstrap %s approval before allocating inputs",
    async (kind) => {
      const f = fixture();
      f.writeApproval(
        kind === "public-assets"
          ? { ...f.approval, publications: [] }
          : f.approval,
      );
      const bootstrap = await prepareDesktopPluginBootstrap(f.input);
      if (!bootstrap) throw new Error("fixture bootstrap");
      const value = v4Fixture(f);
      if (kind === "plugin")
        value.taskExecution.uiPublications[0]!.pluginId = "example.foreign";
      if (kind === "digest")
        value.taskExecution.uiPublications[0]!.packageDigest = `sha256:${"b".repeat(64)}`;
      f.write(value);
      const config = loadDesktopInstalledPluginRuntimeConfiguration(
        f.dataDirectory,
      );
      if (
        !config.enabled ||
        !isAutomaticDesktopInstalledPluginRuntimeConfiguration(config)
      )
        throw new Error("fixture automatic");
      try {
        expect(() =>
          createAutomaticDesktopInstalledPluginRuntimeFiles({
            configuration: config,
            dataDirectory: f.dataDirectory,
            bootstrap,
          }),
        ).toThrow("task_publication");
        expect(
          readdirSync(f.dataDirectory).filter((name) =>
            name.startsWith(".installed-plugin-preparation-"),
          ),
        ).toEqual([]);
      } finally {
        await bootstrap.cleanup();
      }
    },
  );

  it("invalidates fixed file inode replacement for both the original and derived settings", async () => {
    const f = fixture();
    f.writeApproval();
    const bootstrap = await prepareDesktopPluginBootstrap(f.input);
    if (!bootstrap) throw new Error("fixture bootstrap");
    f.write(v4Fixture(f));
    const config = loadDesktopInstalledPluginRuntimeConfiguration(
      f.dataDirectory,
    );
    if (
      !config.enabled ||
      !isAutomaticDesktopInstalledPluginRuntimeConfiguration(config)
    )
      throw new Error("fixture automatic");
    const files = createAutomaticDesktopInstalledPluginRuntimeFiles({
      configuration: config,
      dataDirectory: f.dataDirectory,
      bootstrap,
    });
    try {
      writeFileSync(`${f.path}.replacement`, JSON.stringify(v4Fixture(f)), {
        mode: 0o600,
      });
      renameSync(`${f.path}.replacement`, f.path);
      expect(() => desktopInstalledPluginTaskExecutionSettings(config)).toThrow(
        "file_changed",
      );
      expect(() =>
        desktopInstalledPluginTaskExecutionSettings(files.configuration),
      ).toThrow("file_changed");
      expect(() =>
        desktopInstalledPluginActivationAuthority(files.configuration),
      ).toThrow("file_changed");
    } finally {
      files.close();
      await bootstrap.cleanup();
    }
  });
});
