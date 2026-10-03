import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmod,
  cp,
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
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { verifyLocalPluginPackage } from "../../../packages/plugin-host/src/local-plugin-package-verifier.ts";
import {
  DESKTOP_PLUGIN_APPROVAL_FILE,
  DESKTOP_PLUGIN_APPROVAL_SCHEMA,
} from "./desktopPluginBootstrap.ts";
import { missingTasksPackage } from "./desktopPluginManagement.package.test-support.ts";

const packageDirectory = process.env.CREWON_TEST_SHORT_DRAMA_PLUGIN_V1_DIR;
const runtimeDirectory =
  process.env.CREWON_TEST_DESKTOP_PLUGIN_RUNTIME_DIRECTORY ?? null;

it.runIf(Boolean(packageDirectory))(
  "actual file-mode Electron component chain installs an approved independent UI package via its Native Control/SQLite, restarts the same local profile and revokes withdrawn assets without a model",
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "crewon-native-installed-management-")),
    );
    let child: ChildProcess | null = null;
    try {
      const dataDirectory = join(directory, "data");
      await mkdir(dataDirectory, { mode: 0o700 });
      await mkdir(join(directory, "electron-user-data"), { mode: 0o700 });
      const original = await verifyLocalPluginPackage({
        directory: await realpath(packageDirectory!),
      });
      const approvedSourceDirectory = join(
        directory,
        "approved-short-drama-source",
      );
      await cp(await realpath(packageDirectory!), approvedSourceDirectory, {
        recursive: true,
      });
      await chmod(approvedSourceDirectory, 0o700);
      const verified = await verifyLocalPluginPackage({
        directory: approvedSourceDirectory,
      });
      expect(verified.packageDigest).toBe(original.packageDigest);
      expect(verified.descriptor.pluginId).toBe("crewon.short-drama");
      expect(verified.descriptor.entrypoints.node).toBeNull();
      const source = {
        sourceId: "native-short-drama-v1",
        directory: approvedSourceDirectory,
        pluginId: verified.descriptor.pluginId,
        publisherId: verified.descriptor.publisherId,
        version: verified.descriptor.version,
        packageDigest: verified.packageDigest,
      };
      const missingTasks = await missingTasksPackage(directory);
      const publicAssets = verified.descriptor.files
        .map((file) => file.path)
        .filter((path) => /\.(?:mjs|js|css|png|jpg|svg|woff2?)$/u.test(path));
      const approvalPath = join(dataDirectory, DESKTOP_PLUGIN_APPROVAL_FILE);
      await writeFile(
        approvalPath,
        JSON.stringify({
          schemaVersion: DESKTOP_PLUGIN_APPROVAL_SCHEMA,
          sources: [missingTasks.source, source],
          publications: [
            {
              pluginId: source.pluginId,
              publisherId: source.publisherId,
              packageDigest: source.packageDigest,
              publicAssets,
            },
          ],
        }),
        { mode: 0o600 },
      );
      await chmod(approvalPath, 0o600);
      const repositoryRoot = resolve("../..");
      // Only the test harness and unchanged public preload/renderer components are bundled.
      // No SDK, example package or production runtime is rebuilt here.
      const bundle = (
        entry: string,
        outfile: string,
        platform: "node" | "browser",
      ) =>
        build({
          entryPoints: [resolve(entry)],
          outfile: join(directory, outfile),
          platform,
          format: outfile.endsWith(".cjs") ? "cjs" : "esm",
          bundle: true,
          packages: "bundle",
          external: platform === "node" ? ["electron"] : [],
          logLevel: "silent",
        });
      await bundle(
        "electron/desktopPluginManagement.native.test-support.ts",
        "main.mjs",
        "node",
      );
      await bundle("electron/preload.ts", "preload.cjs", "node");
      await bundle(
        "electron/runtimeLogWriter.ts",
        "runtimeLogWriter.mjs",
        "node",
      );
      await bundle(
        "src/test-support/desktopPluginManagement.renderer.test-support.tsx",
        "renderer.mjs",
        "browser",
      );
      const csp =
        /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u.exec(
          await readFile(resolve("index.html"), "utf8"),
        )![1];
      await writeFile(
        join(directory, "index.html"),
        `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script type="module" src="renderer.mjs"></script>`,
      );
      await writeFile(
        join(directory, "config.json"),
        JSON.stringify({
          dataDirectory,
          repositoryRoot,
          runtimeDirectory,
          document: join(directory, "index.html"),
          preload: join(directory, "preload.cjs"),
          missingTasksMarker: missingTasks.marker,
          ownedChildrenPath: join(directory, "owned-children.json"),
        }),
      );
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(
        createRequire(import.meta.url)("electron"),
        [join(directory, "main.mjs"), join(directory, "config.json")],
        {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout!.on("data", (bytes) => {
        output += bytes;
      });
      child.stderr!.on("data", (bytes) => {
        output += bytes;
      });
      const code = await new Promise<number | null>((accept, reject) => {
        const timer = setTimeout(() => {
          child?.kill("SIGKILL");
          reject(new Error(`native_plugin_management_timeout:\n${output}`));
        }, 90000);
        child!.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child!.once("exit", (exitCode) => {
          clearTimeout(timer);
          accept(exitCode);
        });
      });
      if (code !== 0) console.error("Actual Native fixture output:", output);
      expect(code, output).toBe(0);
      const proof = JSON.parse(
        /CREWON_NATIVE_MANAGEMENT_PROOF:(.+)/u.exec(output)![1],
      );
      expect(proof).toMatchObject({
        electron: "43.4.1",
        live: 200,
        ready: 503,
        initialDisabled: true,
        actualUiMounted: true,
        oldAssetRevoked: true,
        coldScopeStable: true,
        disabledWithdrawsModule: true,
        noProvider: true,
        usage: { bindings: 0, requests: 0, operations: 0, reservedBytes: 0 },
      });
      expect(proof.taskDenied.status).toBeGreaterThanOrEqual(400);
      expect(proof.missingTasks).toMatchObject({
        status: 409,
        code: "plugin_dependency_unavailable",
        state: "disabled",
        nodeLoaded: false,
      });
      expect(Object.values(proof.executionRows)).toEqual(
        expect.arrayContaining([0]),
      );
      expect(
        Object.values(proof.executionRows).every((count) => count === 0),
      ).toBe(true);
      expect(proof.installBodyFields).toEqual([
        "expectedPackageDigest",
        "expectedPluginId",
        "expectedSelectionRevision",
        "sourceId",
      ]);
      console.log(
        "Actual Native installed-management component proof:",
        JSON.stringify(proof),
      );
      if (process.env.CREWON_NATIVE_MANAGEMENT_PROOF_PATH)
        await writeFile(
          process.env.CREWON_NATIVE_MANAGEMENT_PROOF_PATH,
          JSON.stringify(proof, null, 2) + "\n",
        );
    } finally {
      try {
        const pids: number[] = JSON.parse(
          await readFile(join(directory, "owned-children.json"), "utf8"),
        );
        for (const pid of pids) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise((done) => child!.once("exit", done));
      }
      await removeOwnedFixture(directory);
    }
  },
  110000,
);

/** Installed package directories are intentionally read-only; only this fixture's tree is removed. */
async function removeOwnedFixture(directory: string) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("owned_fixture_directory_invalid");
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory() && !entry.isSymbolicLink())
      await makeWritable(join(directory, entry.name));
  await rm(directory, { recursive: true, force: true });
}
async function makeWritable(directory: string) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory() && !entry.isSymbolicLink())
      await makeWritable(join(directory, entry.name));
}
