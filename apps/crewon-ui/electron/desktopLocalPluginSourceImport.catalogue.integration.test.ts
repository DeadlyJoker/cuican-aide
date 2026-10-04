import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteRunStore } from "@crewon/store";
import { installLocalPluginPackage } from "../../../packages/plugin-host/src/local-plugin-package-installer.ts";
import { verifyLocalPluginPackage } from "../../../packages/plugin-host/src/local-plugin-package-verifier.ts";
import { parseDesktopPluginConfiguration } from "../../control-api/src/desktop-plugin-configuration.ts";
import { createDesktopPluginSourceRegistry } from "../../control-api/src/desktop-plugin-source-registry.ts";
import { createDesktopPluginRuntime } from "../../control-api/src/desktop-plugin-runtime.ts";
import { StandaloneIdentity } from "../../control-api/src/standalone-adapters.ts";
import { prepareDesktopPluginBootstrap } from "./desktopPluginBootstrap.ts";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";
import {
  desktopLocalPluginSourceImportFixture,
  sourceConfirmation,
} from "./desktopLocalPluginSourceImport.test-support.ts";
import {
  ensurePrivateDirectory,
  pinParents,
  protectOwnedPluginImportSource,
} from "./desktopLocalPluginSourceImportFiles.ts";

const observations = vi.hoisted(() => ({
  directoryOpens: [] as number[],
  chmods: [] as { dev: number; ino: number; uid: number; mode: number }[],
  replaceOnOpen: null as string | null,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      if (typeof args[1] === "number" && args[1] & fs.constants.O_DIRECTORY) {
        observations.directoryOpens.push(args[1]);
        if (String(args[0]) === observations.replaceOnOpen) {
          observations.replaceOnOpen = null;
          // macOS requires write permission on a moved directory. This is
          // fault setup on the test-owned copy, never the developer directory.
          fs.chmodSync(String(args[0]), 0o700);
          fs.renameSync(String(args[0]), String(args[0]) + ".retired");
          fs.chmodSync(String(args[0]) + ".retired", 0o555);
          fs.mkdirSync(String(args[0]), { mode: 0o555 });
        }
      }
      return fs.openSync(...args);
    },
    fchmodSync: (fd: number, mode: number) => {
      const before = fs.fstatSync(fd);
      observations.chmods.push({
        dev: before.dev,
        ino: before.ino,
        uid: before.uid,
        mode,
      });
      fs.fchmodSync(fd, mode);
    },
  };
});

const fixtures: ReturnType<typeof desktopLocalPluginSourceImportFixture>[] = [];
function fixture() {
  const result = desktopLocalPluginSourceImportFixture();
  // A valid standalone package with deliberately non-executing Node/UI marker
  // code. The unrelated malformed file is retained as ordinary package bytes.
  result.writeDescriptor({ ...result.descriptor, businessManifestPath: null });
  fixtures.push(result);
  return result;
}
afterEach(async () => {
  observations.replaceOnOpen = null;
  observations.directoryOpens = [];
  observations.chmods = [];
  for (const f of fixtures.splice(0)) await f.cleanup();
});

function developerSnapshot(f: ReturnType<typeof fixture>) {
  return ["", "crewon.plugin.json", ...f.files.keys()].map((path) => {
    const filename = join(f.source, path);
    const stat = lstatSync(filename);
    return {
      path,
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      bytes: stat.isFile() ? readFileSync(filename).toString("base64") : null,
    };
  });
}
async function bootstrapConfiguration(f: ReturnType<typeof fixture>) {
  const bootstrap = await prepareDesktopPluginBootstrap({
    dataDirectory: f.dataDirectory,
    actor: DESKTOP_RUNTIME_OWNER,
    sessionEntropy: "named-native-import-catalogue-session-" + "s".repeat(32),
  });
  expect(bootstrap).not.toBeNull();
  const configuration = parseDesktopPluginConfiguration(
    JSON.parse(readFileSync(bootstrap!.bootstrapPath, "utf8")),
  );
  return { bootstrap: bootstrap!, configuration };
}

describe("Native imported source reaches the original Control catalogue", () => {
  it("lists and resolves the approved private copy, then installs it disabled through the original SQLite service", async () => {
    const f = fixture();
    const before = developerSnapshot(f);
    const owner = f.create();
    const preview = await owner.previewDirectory(f.source);
    const confirmed = await owner.confirmPreview(sourceConfirmation(preview));
    const { bootstrap, configuration } = await bootstrapConfiguration(f);
    const source = configuration.sources.find(
      (entry) => entry.sourceId === confirmed.sourceId,
    )!;
    let runtime:
      | Awaited<ReturnType<typeof createDesktopPluginRuntime>>
      | undefined;
    const store = new SqliteRunStore(join(f.dataDirectory, "catalogue.sqlite"));
    try {
      const registry = await createDesktopPluginSourceRegistry(configuration);
      expect(registry.list()).toEqual([
        {
          sourceId: confirmed.sourceId,
          pluginId: preview.pluginId,
          publisherId: preview.publisherId,
          version: preview.version,
          packageDigest: preview.packageDigest,
          title: preview.title,
          description: preview.description,
        },
      ]);
      expect(await registry.resolveSource(confirmed.sourceId)).toBe(
        source.directory,
      );
      expect(lstatSync(source.directory).mode & 0o7777).toBe(0o500);
      expect(lstatSync(f.source).mode & 0o7777).toBe(0o755);
      expect(observations.chmods).toEqual([
        {
          dev: lstatSync(source.directory).dev,
          ino: lstatSync(source.directory).ino,
          uid: process.getuid!(),
          mode: 0o500,
        },
      ]);
      expect(
        observations.directoryOpens.some(
          (flags) =>
            (flags & constants.O_DIRECTORY) !== 0 &&
            (flags & constants.O_NOFOLLOW) !== 0,
        ),
      ).toBe(true);
      runtime = await createDesktopPluginRuntime(
        { configuration },
        {
          store,
          identity: new StandaloneIdentity({
            actor: DESKTOP_RUNTIME_OWNER,
            sessionToken: "s".repeat(32),
            csrfToken: "c".repeat(32),
            allowedOrigins: ["crewon://desktop"],
          }),
          clock: { now: () => "2026-10-04T08:00:00.000Z" },
          digester: {
            sha256: (value) =>
              `sha256:${createHash("sha256").update(value).digest("hex")}`,
          },
        },
      );
      const catalogue = await runtime.sources.listSources(
        DESKTOP_RUNTIME_OWNER,
        {
          afterSourceId: null,
          limit: 50,
        },
      );
      expect(catalogue.sources.map((entry) => entry.sourceId)).toEqual([
        confirmed.sourceId,
      ]);
      const installed = await runtime.installation.install(
        DESKTOP_RUNTIME_OWNER,
        {
          sourceId: confirmed.sourceId,
          expectedPluginId: preview.pluginId,
          expectedPackageDigest: preview.packageDigest,
          expectedSelectionRevision: null,
          idempotencyKey: "named-native-import-catalogue-install",
        },
      );
      expect(installed.selection.state).toBe("disabled");
      expect(installed.selection.revision).toBe(1);
      const actual = await verifyLocalPluginPackage({
        directory: join(
          configuration.installRoot,
          "packages",
          preview.packageDigest.slice(7),
        ),
      });
      expect(actual.packageDigest).toBe(preview.packageDigest);
      expect(actual.directory).not.toBe(source.directory);
      expect(lstatSync(source.directory).mode & 0o7777).toBe(0o500);
      expect(developerSnapshot(f)).toEqual(before);
      expect(existsSync(f.marker)).toBe(false);
    } finally {
      await runtime?.close();
      await store.close();
      await bootstrap.cleanup();
    }
  });

  it("reuses an existing unapproved original-installer 0555 copy, then makes the exact root catalogue-private", async () => {
    const f = fixture();
    const before = developerSnapshot(f);
    const sourceRoot = join(f.dataDirectory, "plugin-import-sources");
    ensurePrivateDirectory(sourceRoot);
    const copied = await installLocalPluginPackage({
      directory: f.source,
      installRoot: sourceRoot,
      authorization: async () => ({ outcome: "allow" }),
    });
    const originalInode = lstatSync(copied.directory).ino;
    expect(lstatSync(copied.directory).mode & 0o7777).toBe(0o555);
    expect(existsSync(f.approvalPath)).toBe(false);
    const owner = f.create();
    const preview = await owner.previewDirectory(f.source);
    const confirmed = await owner.confirmPreview(sourceConfirmation(preview));
    const { bootstrap, configuration } = await bootstrapConfiguration(f);
    try {
      const registry = await createDesktopPluginSourceRegistry(configuration);
      expect(registry.list().map((entry) => entry.sourceId)).toEqual([
        confirmed.sourceId,
      ]);
      expect(await registry.resolveSource(confirmed.sourceId)).toBe(
        copied.directory,
      );
      expect(lstatSync(copied.directory).ino).toBe(originalInode);
      expect(lstatSync(copied.directory).mode & 0o7777).toBe(0o500);
      expect(developerSnapshot(f)).toEqual(before);
      expect(existsSync(f.marker)).toBe(false);
    } finally {
      await bootstrap.cleanup();
    }
  });

  it("a failed precommit copy remains unapproved and a new exact human confirmation can reuse it", async () => {
    const f = fixture();
    const before = developerSnapshot(f);
    const failed = f.create({
      beforeApprovalCommit: async () => {
        throw new Error("named_precommit_failed");
      },
    });
    const first = await failed.previewDirectory(f.source);
    await expect(
      failed.confirmPreview(sourceConfirmation(first)),
    ).rejects.toThrow("named_precommit_failed");
    expect(existsSync(f.approvalPath)).toBe(false);
    const copiedDirectory = join(
      f.dataDirectory,
      "plugin-import-sources",
      "packages",
      first.packageDigest.slice(7),
    );
    const originalInode = lstatSync(copiedDirectory).ino;
    const retry = f.create();
    const preview = await retry.previewDirectory(f.source);
    const confirmed = await retry.confirmPreview(sourceConfirmation(preview));
    const { bootstrap, configuration } = await bootstrapConfiguration(f);
    try {
      const registry = await createDesktopPluginSourceRegistry(configuration);
      expect(await registry.resolveSource(confirmed.sourceId)).toBe(
        copiedDirectory,
      );
      expect(registry.list().map((entry) => entry.sourceId)).toEqual([
        confirmed.sourceId,
      ]);
      expect(lstatSync(copiedDirectory).ino).toBe(originalInode);
      expect(lstatSync(copiedDirectory).mode & 0o7777).toBe(0o500);
      expect(developerSnapshot(f)).toEqual(before);
      expect(existsSync(f.marker)).toBe(false);
    } finally {
      await bootstrap.cleanup();
    }
  });

  it("rejects a copied-root replacement between lstat and open without chmodding either inode", async () => {
    const f = fixture();
    const sourceRoot = join(f.dataDirectory, "plugin-import-sources");
    ensurePrivateDirectory(sourceRoot);
    const copied = await installLocalPluginPackage({
      directory: f.source,
      installRoot: sourceRoot,
      authorization: async () => ({ outcome: "allow" }),
    });
    observations.replaceOnOpen = copied.directory;
    expect(() =>
      protectOwnedPluginImportSource({
        sourceRoot,
        directory: copied.directory,
        packageDigest: copied.packageDigest,
        sourceRootPins: pinParents(sourceRoot),
      }),
    ).toThrow("source_copy_changed");
    expect(observations.chmods).toEqual([]);
    expect(lstatSync(copied.directory).mode & 0o7777).toBe(0o555);
    expect(lstatSync(copied.directory + ".retired").mode & 0o7777).toBe(0o555);
    expect(lstatSync(f.source).mode & 0o7777).toBe(0o755);
  });

  it("rejects a symlink leaf or an unbound human path before any chmod", async () => {
    const f = fixture();
    const sourceRoot = join(f.dataDirectory, "plugin-import-sources");
    ensurePrivateDirectory(sourceRoot);
    const copied = await installLocalPluginPackage({
      directory: f.source,
      installRoot: sourceRoot,
      authorization: async () => ({ outcome: "allow" }),
    });
    const sourceRootPins = pinParents(sourceRoot);
    expect(() =>
      protectOwnedPluginImportSource({
        sourceRoot,
        directory: f.source,
        packageDigest: copied.packageDigest,
        sourceRootPins,
      }),
    ).toThrow("source_copy_path");
    chmodSync(copied.directory, 0o700);
    renameSync(copied.directory, copied.directory + ".retired");
    chmodSync(copied.directory + ".retired", 0o555);
    symlinkSync(f.source, copied.directory, "dir");
    expect(() =>
      protectOwnedPluginImportSource({
        sourceRoot,
        directory: copied.directory,
        packageDigest: copied.packageDigest,
        sourceRootPins,
      }),
    ).toThrow("source_copy_directory");
    expect(observations.chmods).toEqual([]);
    expect(lstatSync(f.source).mode & 0o7777).toBe(0o755);
  });
});
