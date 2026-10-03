import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
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
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { verifyLocalPluginPackage } from "../../../packages/plugin-host/src/local-plugin-package-verifier.ts";
import {
  DESKTOP_PLUGIN_APPROVAL_FILE,
  DESKTOP_PLUGIN_APPROVAL_SCHEMA,
} from "./desktopPluginBootstrap.ts";
import { trackDesktopTestChildren } from "./desktopPluginTestChildren.test-support.ts";

const packageDirectory = process.env.CREWON_TEST_SHORT_DRAMA_PLUGIN_V1_DIR;
it.runIf(Boolean(packageDirectory))(
  "formal file App uses its genuine Native local session to show the original account/settings, installs an independent UI package and restores it after the approved source goes offline",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "crewon-formal-installed-app-")),
    );
    const userData = join(root, "electron-user-data");
    const dataDirectory = join(userData, "control-runtime-v1");
    const evidenceDirectory = process.env.CREWON_NATIVE_APP_EVIDENCE_DIRECTORY
      ? resolve(process.env.CREWON_NATIVE_APP_EVIDENCE_DIRECTORY)
      : join(root, "evidence");
    try {
      await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
      await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
      const sourceRoot = join(root, "source-root");
      await mkdir(join(sourceRoot, "apps"), { recursive: true, mode: 0o700 });
      // The formal Main's supported repositoryRoot chooses the same actual Control source/dependencies.
      // No .crewon environment file, real user profile, remote account or model credential is imported.
      await symlink(
        resolve("../control-api"),
        join(sourceRoot, "apps", "control-api"),
        "dir",
      );
      await symlink(
        resolve("../../node_modules"),
        join(sourceRoot, "node_modules"),
        "dir",
      );
      const approvedDirectory = join(root, "approved-short-drama-source");
      const original = await verifyLocalPluginPackage({
        directory: await realpath(packageDirectory!),
      });
      await cp(await realpath(packageDirectory!), approvedDirectory, {
        recursive: true,
      });
      await chmod(approvedDirectory, 0o700);
      const verified = await verifyLocalPluginPackage({
        directory: approvedDirectory,
      });
      expect(verified.packageDigest).toBe(original.packageDigest);
      const source = {
        sourceId: "formal-short-drama-v1",
        directory: approvedDirectory,
        pluginId: verified.descriptor.pluginId,
        publisherId: verified.descriptor.publisherId,
        version: verified.descriptor.version,
        packageDigest: verified.packageDigest,
      };
      await writeFile(
        join(dataDirectory, DESKTOP_PLUGIN_APPROVAL_FILE),
        JSON.stringify({
          schemaVersion: DESKTOP_PLUGIN_APPROVAL_SCHEMA,
          sources: [source],
          publications: [
            {
              pluginId: source.pluginId,
              publisherId: source.publisherId,
              packageDigest: source.packageDigest,
              publicAssets: verified.descriptor.files.map((file) => file.path),
            },
          ],
        }),
        { mode: 0o600 },
      );
      await writeFile(
        join(dataDirectory, "provider-credentials.json"),
        JSON.stringify({
          schemaVersion: "crewon.provider-credentials.v1",
          activeProviderId: null,
          bindings: [],
        }),
        { mode: 0o600 },
      );
      const main = resolve("dist-electron/main.mjs");
      const document = resolve("dist/index.html");
      const mainDigest = digest(await readFile(main));
      const documentDigest = digest(await readFile(document));
      await build({
        entryPoints: [
          resolve("electron/desktopPluginApp.native.test-support.ts"),
        ],
        outfile: join(root, "launcher.mjs"),
        platform: "node",
        format: "esm",
        bundle: true,
        target: "node24",
        external: ["electron"],
        logLevel: "silent",
      });
      const run = async (phase: "install" | "restore") => {
        const configuration = join(root, phase + ".json");
        await writeFile(
          configuration,
          JSON.stringify({
            main: pathToFileURL(main).href,
            userData,
            phase,
            screenshotDirectory: evidenceDirectory,
          }),
        );
        const env = { ...process.env };
        for (const name of Object.keys(env))
          if (
            name.startsWith("CREWON_") ||
            name === "ELECTRON_RUN_AS_NODE" ||
            name === "AICUICAN_API_KEY"
          )
            delete env[name];
        env.CREWON_REPOSITORY_ROOT = sourceRoot;
        let child: ChildProcess | null = null;
        let children: ReturnType<typeof trackDesktopTestChildren> | null = null;
        let output = "";
        try {
          child = spawn(
            createRequire(import.meta.url)("electron"),
            [join(root, "launcher.mjs"), configuration],
            { env, stdio: ["ignore", "pipe", "pipe"] },
          );
          children = trackDesktopTestChildren(child);
          child.stdout!.on("data", (bytes) => {
            output += bytes;
          });
          child.stderr!.on("data", (bytes) => {
            output += bytes;
          });
          const code = await new Promise<number | null>((accept, reject) => {
            const timer = setTimeout(() => {
              child?.kill("SIGKILL");
              reject(new Error("formal_app_process_timeout:" + output));
            }, 65_000);
            child!.once("error", (error) => {
              clearTimeout(timer);
              reject(error);
            });
            child!.once("exit", (code) => {
              clearTimeout(timer);
              accept(code);
            });
          });
          expect(code, output).toBe(0);
          const match = /CREWON_FORMAL_APP_PROOF:(.+)/u.exec(output);
          expect(match, output).not.toBeNull();
          return JSON.parse(match![1]);
        } finally {
          if (child && child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
            await new Promise((done) => child!.once("exit", done));
          }
          if (children)
            expect(
              await children.close(),
              "formal App shutdown must not leave physical runtime children",
            ).toEqual([]);
        }
      };
      const installed = await run("install");
      await rename(approvedDirectory, approvedDirectory + "-offline");
      const restored = await run("restore");
      expect(restored.scope).toEqual(installed.scope);
      for (const proof of [installed, restored])
        expect(proof).toMatchObject({
          electron: "43.4.1",
          live: 200,
          ready: 503,
          signedOutAccount: true,
          enterpriseLoginAvailable: true,
          returnedToLocalManagement: true,
          originalSettings: true,
          actualInstalledUi: true,
          noProvider: true,
          onlinePosts: 0,
        });
      expect(digest(await readFile(main))).toBe(mainDigest);
      expect(digest(await readFile(document))).toBe(documentDigest);
      const database = new DatabaseSync(join(dataDirectory, "control.sqlite"), {
        readOnly: true,
      });
      const executionRows: Record<string, number> = {};
      try {
        const tables = database
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as { name: string }[];
        for (const { name } of tables)
          if (
            /^(?:run_|agent_version|active_agent_version)|credit|quote|charge/u.test(
              name,
            )
          )
            executionRows[name] = database
              .prepare(
                `SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`,
              )
              .get()!.n as number;
        expect(executionRows.run_snapshots).toBe(0);
        expect(executionRows.agent_versions).toBe(0);
        expect(Object.values(executionRows).every((count) => count === 0)).toBe(
          true,
        );
      } finally {
        database.close();
      }
      const proof = {
        installed,
        restored,
        packageDigest: verified.packageDigest,
        formalMainDigest: mainDigest,
        formalDocumentDigest: documentDigest,
        sourceUnavailableAfterInstall: true,
        executionRows,
      };
      console.log("Formal file App proof:", JSON.stringify(proof));
      await writeFile(
        join(evidenceDirectory, "formal-file-app-proof.json"),
        JSON.stringify(proof, null, 2) + "\n",
      );
    } finally {
      await writable(root);
      await rm(root, { recursive: true, force: true });
    }
  },
  150_000,
);
function digest(bytes: Buffer) {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}
async function writable(directory: string) {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) return;
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory() && !entry.isSymbolicLink())
      await writable(join(directory, entry.name));
}
