import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import type { PluginUiPackageContext } from "@crewon/application";
import {
  parsePluginUiLease,
  type PluginPackageDescriptor,
} from "@crewon/contracts/plugins";
import { installLocalPluginPackage } from "./local-plugin-package-installer.ts";
import { LocalPluginUiPackageReader } from "./plugin-ui-package-reader.ts";

export const UI_PUBLIC_FILES = [
  "ui/main.mjs",
  "ui/chunk.mjs",
  "ui/style.css",
  "assets/photo.png",
  "assets/font.woff2",
];

/** Real prebuilt files and the real installer; publication decisions are explicit test policies. */
export async function uiReaderFixture(
  t: TestContext,
  options: Readonly<{
    mode?: "trustedModule" | "isolatedWeb";
    largeAsset?: boolean;
    noModule?: boolean;
    nodeOnly?: boolean;
  }> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "crewon-plugin-ui-reader-"));
  await chmod(root, 0o700);
  t.after(async () => {
    await writableTree(root);
    await rm(root, { recursive: true, force: true });
  });
  const source = join(root, "source");
  const installRoot = join(root, "installed");
  await mkdir(source, { mode: 0o700 });
  await mkdir(installRoot, { mode: 0o700 });
  const marker = join(root, "node-executed.log");
  const files = new Map([
    [
      "ui/main.mjs",
      Buffer.from(
        "import {value} from './chunk.mjs';export default {apiVersion:'crewon.plugin-ui.v1',pluginId:'example.ui',mount(root){root.textContent=value;return {update(){},dispose(){root.textContent='';}};}};",
      ),
    ],
    ["ui/chunk.mjs", Buffer.from("export const value='independent UI chunk';")],
    [
      "ui/style.css",
      Buffer.from(
        ".example-ui-module{color:var(--text);padding:var(--space-2)}",
      ),
    ],
    ["assets/photo.png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
    ["assets/font.woff2", Buffer.from("fixture-font-bytes")],
    ["ui/state.json", Buffer.from('{"publicOnlyIfExplicitlyApproved":true}')],
    ["assets/custom.bin", Buffer.from([0, 255, 40, 21])],
    [
      "private/server.mjs",
      Buffer.from(
        `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');export default {};`,
      ),
    ],
    ["private/business.json", Buffer.from('{"privateMetadata":true}')],
  ]);
  if (options.largeAsset)
    files.set("assets/large.bin", Buffer.alloc(33 * 1024 * 1024, 7));
  if (options.mode === "isolatedWeb")
    files.set(
      "ui/main.html",
      Buffer.from("<!doctype html><title>Isolated fixture</title>"),
    );
  const descriptor: PluginPackageDescriptor = {
    schemaVersion: "crewon.plugin-package.v1",
    hostApi: "crewon.plugin-host.v1",
    pluginId: "example.ui",
    version: "1.0.0",
    publisherId: "example.publisher",
    title: "Independent UI fixture",
    description:
      "Actual local bytes; no HTTP, generation or production authorization.",
    entrypoints: {
      node: "private/server.mjs",
      ui: options.nodeOnly
        ? null
        : {
            path:
              options.mode === "isolatedWeb" ? "ui/main.html" : "ui/main.mjs",
            mode: options.mode ?? "trustedModule",
          },
    },
    businessManifestPath: "private/business.json",
    requires: [],
    provides: [],
    contributions: options.nodeOnly
      ? []
      : options.noModule
        ? [
            {
              id: "preferences",
              kind: "settings",
              slot: "settings.section",
              title: "Preferences",
            },
          ]
        : [
            {
              id: "workbench",
              kind: "module",
              slot: "main.content",
              title: "Workbench",
            },
          ],
    files: [...files].map(([path, bytes]) => ({
      path,
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  };
  for (const [path, bytes] of files) {
    await mkdir(dirname(join(source, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(source, path), bytes);
  }
  await writeFile(
    join(source, "crewon.plugin.json"),
    JSON.stringify(descriptor),
  );
  const installed = await installLocalPluginPackage({
    directory: source,
    installRoot,
    authorization: async () => ({ outcome: "allow" }),
    ...(options.largeAsset ? { limits: { fileBytes: 40 * 1024 * 1024 } } : {}),
  });
  const scope = Object.freeze({
    tenantId: "tenant",
    spaceId: "space",
    profileId: "profile",
  });
  const actor = Object.freeze({
    tenantId: scope.tenantId,
    spaceId: scope.spaceId,
    principalId: "principal",
    actorId: "actor",
  });
  const at = "2026-10-02T00:00:00.000Z";
  const pkg = Object.freeze({
    schemaVersion: "crewon.installed-plugin-package.v1" as const,
    ...scope,
    pluginId: descriptor.pluginId,
    version: descriptor.version,
    publisherId: descriptor.publisherId,
    packageDigest: installed.packageDigest,
    installedAt: at,
    installedByPrincipalId: actor.principalId,
    installedByActorId: actor.actorId,
  });
  const selection = Object.freeze({
    schemaVersion: "crewon.plugin-selection.v1" as const,
    ...scope,
    pluginId: pkg.pluginId,
    publisherId: pkg.publisherId,
    revision: 2,
    state: "enabled" as const,
    selectedPackageDigest: pkg.packageDigest,
    updatedAt: at,
    updatedByPrincipalId: actor.principalId,
    updatedByActorId: actor.actorId,
  });
  const context: PluginUiPackageContext = Object.freeze({
    actor,
    scope,
    selection,
    package: pkg,
  });
  const policy = {
    calls: 0,
    assets: [...UI_PUBLIC_FILES],
    hook: null as
      | ((
          input: PluginUiPackageContext &
            Readonly<{ descriptor: PluginPackageDescriptor }>,
        ) => void | Promise<void>)
      | null,
    result: undefined as unknown,
  };
  const reader = new LocalPluginUiPackageReader({
    profile: scope,
    installRoot,
    authorizePublication: async (input) => {
      policy.calls += 1;
      await policy.hook?.(input);
      return policy.result === undefined
        ? policy.assets
        : (policy.result as readonly string[]);
    },
  });
  const lease = (publicAssets: readonly string[] = policy.assets) =>
    parsePluginUiLease({
      schemaVersion: "crewon.plugin-ui-lease.v1",
      mountRef: "test_ui_mount_0123456789abcdefghijklmnop",
      expiresAt: "2026-10-02T23:59:59.999Z",
      selectionRevision: selection.revision,
      packageDigest: pkg.packageDigest,
      descriptor: installed.descriptor,
      contributionId: "workbench",
      publicAssets,
    });
  return {
    root,
    source,
    installRoot,
    target: installed.directory,
    marker,
    files,
    descriptor: installed.descriptor,
    context,
    policy,
    reader,
    lease,
  };
}

async function writableTree(path: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) return;
  await chmod(path, 0o700);
  for (const entry of await readdir(path))
    await writableTree(join(path, entry));
}
