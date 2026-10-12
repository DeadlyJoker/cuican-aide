import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  stat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  symlink,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifyLocalPluginPackage } from "@crewon/plugin-host/package-snapshot";

const root = fileURLToPath(new URL("../", import.meta.url));
const repository = resolve(root, "../..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

test("packed tool installs outside the workspace and checks the original host package identity without importing code", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "crewon-plugin-tools-distribution-"),
  );
  try {
    assert.equal(directory.startsWith(repository), false);
    execFileSync(pnpm, ["pack", "--pack-destination", directory, "--json"], {
      cwd: root,
      timeout: 60000,
      stdio: "pipe",
    });
    const tarball = (await readdir(directory)).find((name) =>
      name.endsWith(".tgz"),
    );
    assert.ok(tarball);
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: "independent-plugin-check",
        private: true,
        type: "module",
        devDependencies: { "@crewon/plugin-tools": `file:./${tarball}` },
      }),
    );
    execFileSync(
      pnpm,
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--config.minimumReleaseAge=0",
        "--registry=https://registry.npmjs.org",
      ],
      { cwd: directory, timeout: 60000, stdio: "pipe" },
    );
    const installed = join(directory, "node_modules/@crewon/plugin-tools");
    const manifest = JSON.parse(
      await readFile(join(installed, "package.json"), "utf8"),
    );
    assert.deepEqual(manifest.dependencies ?? {}, {});
    assert.deepEqual(manifest.peerDependencies ?? {}, {});
    assert.deepEqual(manifest.bin, { "crewon-plugin": "./dist/cli.mjs" });
    assert.equal((await readdir(installed)).includes("src"), false);
    assert.equal((await readdir(installed)).includes("scripts"), false);
    assert.deepEqual(await readdir(join(directory, "node_modules/@crewon")), [
      "plugin-tools",
    ]);
    const command = (args) =>
      spawnSync(pnpm, ["exec", "crewon-plugin", ...args], {
        cwd: directory,
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, NODE_PATH: "" },
      });
    const source = join(directory, "candidate");
    await mkdir(source);
    const marker = join(directory, "code-was-imported");
    const nodeBytes = Buffer.from(
      `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'bad');throw Error('must never execute');`,
    );
    const descriptor = {
      schemaVersion: "crewon.plugin-package.v1",
      hostApi: "crewon.plugin-host.v1",
      pluginId: "example.check",
      publisherId: "example.publisher",
      version: "1.0.0",
      title: "Check fixture",
      description: "Standalone integrity check",
      entrypoints: { node: "node.mjs", ui: null },
      businessManifestPath: null,
      requires: [
        { service: "example.source", apiVersion: "1", optional: true },
      ],
      provides: [{ service: "example.echo", apiVersion: "1" }],
      contributions: [],
      files: [
        {
          path: "node.mjs",
          byteLength: nodeBytes.length,
          sha256: createHash("sha256").update(nodeBytes).digest("hex"),
        },
      ],
    };
    const descriptorPath = join(source, "crewon.plugin.json");
    await writeFile(descriptorPath, JSON.stringify(descriptor));
    await writeFile(join(source, "node.mjs"), nodeBytes);
    const original = await verifyLocalPluginPackage({ directory: source });
    const success = command(["check", source]);
    assert.equal(success.status, 0, success.stderr);
    assert.equal(success.stderr, "");
    const report = JSON.parse(success.stdout);
    assert.equal(report.schemaVersion, "crewon.plugin-package-check.v1");
    assert.equal(report.packageDigest, original.packageDigest);
    assert.equal(report.fileCount, original.fileCount);
    assert.equal(report.totalBytes, original.totalBytes);
    assert.equal(report.authorization, "notEvaluated");
    assert.equal(report.services, "notResolved");
    assert.deepEqual(report.requires, descriptor.requires);
    assert.deepEqual(report.provides, descriptor.provides);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    assert.deepEqual(await readFile(join(source, "node.mjs")), nodeBytes);
    const rejected = (code) => {
      const result = command(["check", source]);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(result.stdout, "");
      assert.deepEqual(JSON.parse(result.stderr), {
        schemaVersion: "crewon.plugin-package-check.v1",
        outcome: "rejected",
        code,
      });
      assert.equal(result.stderr.includes(directory), false);
    };
    await writeFile(
      join(source, "node.mjs"),
      Buffer.alloc(nodeBytes.length, 65),
    );
    rejected("plugin_package_file_digest_mismatch");
    await writeFile(join(source, "node.mjs"), nodeBytes);
    await writeFile(
      join(source, "undeclared.txt"),
      "private unlisted contents",
    );
    rejected("plugin_package_file_undeclared");
    await rm(join(source, "undeclared.txt"));
    await rm(join(source, "node.mjs"));
    rejected("plugin_package_artifact_missing");
    await writeFile(join(directory, "outside.mjs"), nodeBytes);
    await symlink(join(directory, "outside.mjs"), join(source, "node.mjs"));
    rejected("plugin_package_file_type_invalid");
    await rm(join(source, "node.mjs"));
    await link(join(directory, "outside.mjs"), join(source, "node.mjs"));
    rejected("plugin_package_file_type_invalid");
    await rm(join(source, "node.mjs"));
    await writeFile(join(source, "node.mjs"), nodeBytes);
    await writeFile(
      descriptorPath,
      JSON.stringify({ ...descriptor, hostApi: "crewon.plugin-host.v999" }),
    );
    assert.equal(command(["check", source]).status, 1);
    await writeFile(descriptorPath, JSON.stringify(descriptor));
    const help = command(["--help"]);
    assert.equal(help.status, 0);
    assert.match(
      help.stdout,
      /Does not install, import, authorize or resolve services/,
    );
    for (const args of [
      [],
      ["install", source],
      ["check", source, "--enable"],
    ]) {
      const result = command(args);
      assert.equal(result.status, 2);
      assert.equal(
        JSON.parse(result.stderr).code,
        "plugin_check_arguments_invalid",
      );
    }
    const missing = command([
      "check",
      join(directory, "secret-path-not-found"),
    ]);
    assert.equal(missing.status, 1);
    assert.equal(missing.stderr.includes("secret-path"), false);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("init from the packed tool builds a standalone SDK plugin, refuses existing targets and completes durable upgrade, rollback, withdrawal and cold recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-plugin-template-"));
  const installRoot = join(directory, "installed");
  try {
    const artifacts = join(directory, "artifacts");
    await mkdir(artifacts);
    execFileSync(pnpm, ["pack", "--pack-destination", artifacts, "--json"], {
      cwd: root,
      timeout: 60000,
      stdio: "pipe",
    });
    execFileSync(pnpm, ["pack", "--pack-destination", artifacts, "--json"], {
      cwd: join(repository, "packages/plugin-sdk"),
      timeout: 60000,
      stdio: "pipe",
    });
    const tarballs = await readdir(artifacts);
    const tools = tarballs.find((name) =>
      name.startsWith("crewon-plugin-tools-"),
    );
    const sdk = tarballs.find((name) => name.startsWith("crewon-plugin-sdk-"));
    assert.ok(tools && sdk);
    const developer = join(directory, "developer");
    await mkdir(developer);
    await writeFile(
      join(developer, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        devDependencies: {
          "@crewon/plugin-tools": `file:${join(artifacts, tools)}`,
        },
      }),
    );
    execFileSync(
      pnpm,
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--config.minimumReleaseAge=0",
        "--registry=https://registry.npmjs.org",
      ],
      { cwd: developer, timeout: 60000, stdio: "pipe" },
    );
    const init = (target) =>
      spawnSync(pnpm, ["exec", "crewon-plugin", "init", target], {
        cwd: developer,
        encoding: "utf8",
        timeout: 10000,
      });
    const source = join(directory, "plugin");
    const created = init(source);
    assert.equal(created.status, 0, created.stderr);
    assert.equal(
      JSON.parse(created.stdout).schemaVersion,
      "crewon.plugin-scaffold.v1",
    );
    const original = await readFile(join(source, "src/node.ts"));
    const refused = init(source);
    assert.equal(refused.status, 1);
    assert.equal(
      JSON.parse(refused.stderr).code,
      "plugin_scaffold_target_exists",
    );
    assert.deepEqual(await readFile(join(source, "src/node.ts")), original);
    const existingEmpty = join(directory, "empty-user-directory");
    await mkdir(existingEmpty);
    assert.equal(init(existingEmpty).status, 1);
    assert.deepEqual(await readdir(existingEmpty), []);
    const alias = join(directory, "directory-link");
    await symlink(existingEmpty, alias, "dir");
    assert.equal(init(alias).status, 1);
    assert.deepEqual(await readdir(existingEmpty), []);
    const packagePath = join(source, "package.json");
    const manifest = JSON.parse(await readFile(packagePath, "utf8"));
    assert.equal(
      Object.hasOwn(manifest.devDependencies, "@crewon/plugin-sdk"),
      false,
    );
    // Follow the README command: a generated, unpublished registry dependency must not
    // force an SDK registry lookup before pnpm can add the distributed local tarball.
    execFileSync(
      pnpm,
      [
        "add",
        "-D",
        join(artifacts, sdk),
        "--offline",
        "--ignore-scripts",
        "--config.minimumReleaseAge=0",
        "--registry=https://registry.npmjs.org",
      ],
      { cwd: source, timeout: 60000, stdio: "pipe" },
    );
    const installedManifest = JSON.parse(await readFile(packagePath, "utf8"));
    assert.ok(
      installedManifest.devDependencies["@crewon/plugin-sdk"].startsWith(
        "file:",
      ),
    );
    execFileSync(
      pnpm,
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--config.minimumReleaseAge=0",
        "--registry=https://registry.npmjs.org",
      ],
      { cwd: source, timeout: 60000, stdio: "pipe" },
    );
    execFileSync(pnpm, ["build"], {
      cwd: source,
      timeout: 60000,
      stdio: "pipe",
    });
    const candidate = join(source, "dist/1.0.0");
    if (process.platform !== "win32")
      assert.equal((await stat(candidate)).mode & 0o777, 0o700);
    const check = spawnSync(
      pnpm,
      ["exec", "crewon-plugin", "check", candidate],
      { cwd: developer, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(check.status, 0, check.stderr);
    const report = JSON.parse(check.stdout);
    const metadataPath = join(source, "src/metadata.ts");
    await writeFile(
      metadataPath,
      (await readFile(metadataPath, "utf8")).replace(
        'version: "1.0.0"',
        'version: "2.0.0"',
      ),
    );
    const entryPath = join(source, "src/node.ts");
    await writeFile(
      entryPath,
      (await readFile(entryPath, "utf8")).replace(
        "return text;",
        "return metadata.version + ':' + text;",
      ),
    );
    execFileSync(pnpm, ["build"], {
      cwd: source,
      timeout: 60000,
      stdio: "pipe",
    });
    const second = await verifyLocalPluginPackage({
      directory: join(source, "dist/2.0.0"),
    });
    const { exerciseInstalledTemplateLifecycle } = await import(
      "./installed-template-lifecycle.mjs"
    );
    await exerciseInstalledTemplateLifecycle({
      directory,
      installRoot,
      packages: [
        { directory: candidate, packageDigest: report.packageDigest },
        second,
      ],
      removeAuthoring: async () => {
        await rm(source, { recursive: true, force: true });
        await rm(developer, { recursive: true, force: true });
        await rm(artifacts, { recursive: true, force: true });
      },
    });
  } finally {
    await makeWritable(directory);
    await rm(directory, { recursive: true, force: true });
  }
});

async function makeWritable(directory) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory()) await makeWritable(join(directory, entry.name));
}
