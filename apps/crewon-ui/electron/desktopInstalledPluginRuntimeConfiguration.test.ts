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
import {
  assertDesktopInstalledPluginRuntimeConfiguration,
  DESKTOP_INSTALLED_PLUGIN_RUNTIME_FILE,
  DESKTOP_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
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
