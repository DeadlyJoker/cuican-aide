import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { installLocalPluginPackage } from "./local-plugin-package-installer.ts";
import { PluginNodeHost, type PluginNodeLease } from "./plugin-node-host.ts";

test("an independent TypeScript plugin built against the packed public SDK installs and runs without host source", async () => {
  const repository = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const external = await mkdtemp(join(tmpdir(), "crewon-independent-plugin-"));
  const installRoot = await mkdtemp(
    join(tmpdir(), "crewon-independent-installed-"),
  );
  const require = createRequire(import.meta.url);
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const records: string[] = [];
  let host: PluginNodeHost | undefined;
  let lease: PluginNodeLease | undefined;
  try {
    const packed = execFileSync(
      pnpm,
      ["pack", "--pack-destination", external, "--json"],
      {
        cwd: join(repository, "packages/plugin-sdk"),
        encoding: "utf8",
        timeout: 60000,
      },
    );
    const tarball = (await readdir(external)).find((name) =>
      name.endsWith(".tgz"),
    );
    assert.ok(tarball, packed);
    await writeFile(
      join(external, "package.json"),
      JSON.stringify({
        name: "independent-plugin",
        private: true,
        type: "module",
        dependencies: { "@crewon/plugin-sdk": `file:./${tarball}` },
      }),
    );
    execFileSync(pnpm, ["install", "--offline", "--ignore-scripts"], {
      cwd: external,
      encoding: "utf8",
      timeout: 60000,
    });
    await mkdir(join(external, "src"));
    await writeFile(
      join(external, "src/entry.ts"),
      `
import { definePlugin } from '@crewon/plugin-sdk/node';
export default definePlugin({
  apiVersion: 'crewon.plugin-host.v1', pluginId: 'example.independent',
  setup(ctx) {
    const log = ctx.services.get<{write(text: string): void}>('host.log', '1');
    ctx.onDispose(() => log.write('cleanup'));
    ctx.services.provide('independent.result', '1', {read: () => 'compiled outside the host'});
    log.write('setup');
    return {dispose: () => log.write('dispose')};
  }
});
`,
    );
    await writeFile(
      join(external, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: false,
          types: [],
          noEmit: true,
        },
        files: ["src/entry.ts"],
      }),
    );
    execFileSync(
      process.execPath,
      [
        require.resolve("typescript/bin/tsc"),
        "-p",
        join(external, "tsconfig.json"),
      ],
      { cwd: external, encoding: "utf8", timeout: 60000 },
    );
    const artifact = join(external, "package");
    await mkdir(artifact);
    const bundled = await build({
      absWorkingDir: external,
      entryPoints: ["src/entry.ts"],
      outfile: join(artifact, "entry.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      metafile: true,
      write: true,
    });
    for (const source of Object.keys(bundled.metafile!.inputs)) {
      const path = relative(external, resolve(external, source));
      assert.ok(
        !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`),
        source,
      );
    }
    for (const output of Object.values(bundled.metafile!.outputs))
      assert.deepEqual(output.imports, []);
    const bytes = await readFile(join(artifact, "entry.mjs"));
    await writeFile(
      join(artifact, "crewon.plugin.json"),
      JSON.stringify({
        schemaVersion: "crewon.plugin-package.v1",
        hostApi: "crewon.plugin-host.v1",
        pluginId: "example.independent",
        version: "1.0.0",
        title: "Independent plugin",
        description: "Real distribution fixture",
        publisherId: "example",
        entrypoints: { node: "entry.mjs", ui: null },
        businessManifestPath: null,
        requires: [{ service: "host.log", apiVersion: "1", optional: false }],
        provides: [{ service: "independent.result", apiVersion: "1" }],
        contributions: [],
        files: [
          {
            path: "entry.mjs",
            byteLength: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
      }),
    );
    const installed = await installLocalPluginPackage({
      directory: artifact,
      installRoot,
      authorization: async () => ({ outcome: "allow" }),
    });
    assert.equal(installed.outcome, "installed");
    // Remove the complete development repository/dependencies before the host loads the artifact.
    await rm(external, { recursive: true, force: true });
    host = new PluginNodeHost({
      services: [
        {
          service: "host.log",
          apiVersion: "1",
          value: {
            write(text: string) {
              records.push(text);
            },
          },
        },
      ],
    });
    const identity = await host.activate({
      installRoot,
      expectedPluginId: installed.descriptor.pluginId,
      expectedPackageDigest: installed.packageDigest,
      authorizeActivation: () => "allow",
    });
    lease = host.acquire({
      pluginId: identity.pluginId,
      packageDigest: identity.packageDigest,
      purpose: "newOperation",
      authorizeBorrow: () => "allow",
    });
    assert.equal(
      lease.getService<{ read(): string }>("independent.result", "1").read(),
      "compiled outside the host",
    );
    host.deactivate(identity.pluginId);
    assert.throws(
      () =>
        host!.acquire({
          pluginId: identity.pluginId,
          packageDigest: identity.packageDigest,
          purpose: "newOperation",
          authorizeBorrow: () => "allow",
        }),
      { code: "plugin_instance_unavailable" },
    );
    assert.deepEqual(records, ["setup"]);
    lease.release();
    await host.close();
    host = undefined;
    assert.deepEqual(records, ["setup", "dispose", "cleanup"]);
  } finally {
    try {
      lease?.release();
      if (host) await host.close();
    } finally {
      try {
        await rm(external, { recursive: true, force: true });
      } finally {
        await removeOwnedInstallation(installRoot);
      }
    }
  }
});

async function removeOwnedInstallation(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory())
      await removeOwnedInstallation(join(directory, entry.name));
  await rm(directory, { recursive: true, force: true });
}
