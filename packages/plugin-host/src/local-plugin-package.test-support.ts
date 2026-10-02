import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import {
  PLUGIN_PACKAGE_DESCRIPTOR_PATH,
  PLUGIN_PACKAGE_HOST_API,
  PLUGIN_PACKAGE_SCHEMA_VERSION,
  type PluginPackageDescriptor,
} from "@crewon/contracts/plugins";
import type { PluginPackageInstallationAuthorization } from "./local-plugin-package-types.ts";

export const allowInstallation: PluginPackageInstallationAuthorization =
  async () => ({ outcome: "allow" });

export async function packageFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "crewon-local-plugin-"));
  await chmod(root, 0o700);
  t.after(async () => {
    await writableDirectories(root);
    await rm(root, { recursive: true, force: true });
  });
  const source = join(root, "source");
  const installRoot = join(root, "installed");
  await mkdir(source, { mode: 0o700 });
  await mkdir(installRoot, { mode: 0o700 });
  const marker = join(root, "executed.log");
  const files = new Map([
    [
      "dist/entry.mjs",
      Buffer.from(
        `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');export default {};`,
      ),
    ],
    ["assets/input.json", Buffer.from('{"fixture":true}')],
  ]);
  const descriptor: PluginPackageDescriptor = {
    schemaVersion: PLUGIN_PACKAGE_SCHEMA_VERSION,
    hostApi: PLUGIN_PACKAGE_HOST_API,
    pluginId: "example.fixture",
    version: "1.0.0",
    title: "Local fixture",
    description:
      "Prebuilt bytes only; no business pricing or production provider.",
    publisherId: "example.publisher",
    entrypoints: { node: "dist/entry.mjs", ui: null },
    businessManifestPath: null,
    requires: [],
    provides: [],
    contributions: [],
    files: [...files].map(([path, content]) => ({
      path,
      byteLength: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    })),
  };
  for (const [path, content] of files) {
    await mkdir(dirname(join(source, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(source, path), content);
  }
  const descriptorBytes = Buffer.from(JSON.stringify(descriptor, null, 2));
  await writeFile(
    join(source, PLUGIN_PACKAGE_DESCRIPTOR_PATH),
    descriptorBytes,
  );
  return {
    root,
    source,
    installRoot,
    marker,
    files,
    descriptor,
    descriptorBytes,
    async target(digest: string) {
      return join(await realpath(installRoot), "packages", digest.slice(7));
    },
    async rewriteDescriptor(value: unknown) {
      await writeFile(
        join(source, PLUGIN_PACKAGE_DESCRIPTOR_PATH),
        JSON.stringify(value),
      );
    },
  };
}

/** Cleanup only our fixture; never follow a package link to its target. */
async function writableDirectories(path: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) return;
  await chmod(path, 0o700);
  for (const entry of await readdir(path))
    await writableDirectories(join(path, entry));
}

export async function directoryNames(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function assertCandidateBytes(
  fixture: Awaited<ReturnType<typeof packageFixture>>,
  directory: string,
): Promise<void> {
  assert.deepEqual(
    await readFile(join(directory, PLUGIN_PACKAGE_DESCRIPTOR_PATH)),
    fixture.descriptorBytes,
  );
  for (const [path, content] of fixture.files)
    assert.deepEqual(await readFile(join(directory, path)), content);
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
