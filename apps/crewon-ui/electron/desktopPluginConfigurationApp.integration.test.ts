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
import { loadInstalledPluginBusinessRegistration } from "../../../packages/plugin-host/src/installed-plugin-business-registration.ts";
import {
  DESKTOP_PLUGIN_APPROVAL_FILE,
  DESKTOP_PLUGIN_APPROVAL_SCHEMA,
} from "./desktopPluginBootstrap.ts";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";
import { trackDesktopTestChildren } from "./desktopPluginTestChildren.test-support.ts";

const packageDirectory = process.env.CREWON_TEST_PROFESSIONAL_PLUGIN_V1_DIR;
const parameters = Object.freeze({
  organization: "Native configuration acceptance team",
  providerBaseUrl: "https://reports.example.invalid/api/",
});
it.runIf(packageDirectory !== undefined)(
  "formal Native file App saves a disabled installed business package through original settings and cold-reopens its actual SQLite configuration with the delivery source offline",
  async () => {
    // A defined bad path is a hard failure, not a skipped or substituted business package.
    const originalDirectory = await realpath(packageDirectory!);
    const original = await verifyLocalPluginPackage({
      directory: originalDirectory,
    });
    expect(original.descriptor.pluginId).toBe("example.professional");
    expect(original.descriptor.version).toBe("1.0.0");
    expect(original.descriptor.businessManifestPath).not.toBeNull();
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "crewon-native-business-configuration-")),
    );
    const userData = join(root, "electron-user-data");
    const dataDirectory = join(userData, "control-runtime-v1");
    const evidenceDirectory = process.env.CREWON_NATIVE_APP_EVIDENCE_DIRECTORY
      ? resolve(process.env.CREWON_NATIVE_APP_EVIDENCE_DIRECTORY)
      : join(root, "evidence");
    let cleanupSafe = true;
    try {
      await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
      await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
      const sourceRoot = join(root, "source-root");
      await mkdir(join(sourceRoot, "apps"), { recursive: true, mode: 0o700 });
      // This is the formal Main's existing repositoryRoot source-runtime selection.
      // No alternative preload, renderer entry, ambient account, provider or synthetic session is installed.
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
      const approvedDirectory = join(root, "approved-report-source");
      await cp(originalDirectory, approvedDirectory, { recursive: true });
      await chmod(approvedDirectory, 0o700);
      const verified = await verifyLocalPluginPackage({
        directory: approvedDirectory,
      });
      expect(verified.packageDigest).toBe(original.packageDigest);
      const source = {
        sourceId: "native-configuration-report-v1",
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
              publicAssets: [verified.descriptor.entrypoints.ui!.path],
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
          resolve(
            "electron/desktopPluginConfigurationApp.native.test-support.ts",
          ),
        ],
        outfile: join(root, "launcher.mjs"),
        platform: "node",
        format: "esm",
        bundle: true,
        target: "node24",
        external: ["electron"],
        logLevel: "silent",
      });
      const run = async (phase: "write" | "reopen") => {
        const configuration = join(root, `${phase}.json`);
        await writeFile(
          configuration,
          JSON.stringify({
            main: pathToFileURL(main).href,
            document: pathToFileURL(document).href,
            userData,
            phase,
            screenshotDirectory: evidenceDirectory,
            pluginId: source.pluginId,
            title: verified.descriptor.title,
            version: source.version,
            parameters,
          }),
          { mode: 0o600 },
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
        let completion: Promise<number | null> | null = null;
        let childClosed = false;
        let spawnError: Error | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let output = "";
        try {
          child = spawn(
            createRequire(import.meta.url)("electron"),
            [join(root, "launcher.mjs"), configuration],
            {
              env,
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          cleanupSafe = false;
          completion = new Promise((accept) => {
            child!.once("error", (error) => {
              spawnError = error;
            });
            child!.once("close", (code) => {
              childClosed = true;
              accept(code);
            });
          });
          children = trackDesktopTestChildren(child);
          child.stdout!.on("data", (bytes) => {
            output += bytes;
          });
          child.stderr!.on("data", (bytes) => {
            output += bytes;
          });
          const code = await Promise.race([
            completion,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                child?.kill("SIGKILL");
                reject(
                  new Error("native_configuration_process_timeout:" + output),
                );
              }, 65_000);
            }),
          ]);
          if (spawnError) throw spawnError;
          expect(code, output).toBe(0);
          expect(
            childClosed,
            "Main process and stdout/stderr physically closed",
          ).toBe(true);
          const match = /CREWON_NATIVE_CONFIGURATION_APP_PROOF:(.+)/u.exec(
            output,
          );
          expect(match, output).not.toBeNull();
          return { ...JSON.parse(match![1]), mainStreamsClosed: childClosed };
        } finally {
          if (timer !== null) clearTimeout(timer);
          if (child && child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
          // Even a logical timeout must retire the real process/streams before deleting its userData.
          let mainRetired = false;
          try {
            if (completion !== null) await waitForMainClose(completion);
            mainRetired = childClosed;
          } finally {
            const forcedChildren = children
              ? await children.close()
              : child?.pid === undefined
                ? []
                : null;
            cleanupSafe = mainRetired && forcedChildren !== null;
            expect(
              forcedChildren,
              "production shutdown physically joins all Native/Control children without test-owned killing",
            ).toEqual([]);
          }
        }
      };
      const written = await run("write");
      const firstDatabase = inspectDatabase(
        join(dataDirectory, "control.sqlite"),
        source.packageDigest,
      );
      const actualRegistration = await loadInstalledPluginBusinessRegistration({
        installRoot: join(dataDirectory, "plugins"),
        expectedPluginId: source.pluginId,
        expectedPublisherId: source.publisherId,
        expectedVersion: source.version,
        expectedPackageDigest: source.packageDigest,
        signal: new AbortController().signal,
        authorizeRead: async (candidate) =>
          candidate.packageDigest === source.packageDigest &&
          candidate.descriptor.pluginId === source.pluginId &&
          candidate.descriptor.publisherId === source.publisherId &&
          candidate.descriptor.version === source.version
            ? "allow"
            : "deny",
      });
      expect(firstDatabase.configuration.manifestDigest).toBe(
        actualRegistration.manifestDigest,
      );
      expect(firstDatabase.configuration.implementationDigest).toBe(
        actualRegistration.implementationDigest,
      );
      await rename(approvedDirectory, `${approvedDirectory}-offline`);
      const reopened = await run("reopen");
      const finalDatabase = inspectDatabase(
        join(dataDirectory, "control.sqlite"),
        source.packageDigest,
      );
      expect(reopened.scope).toEqual(written.scope);
      expect(reopened.nativeProcessId).not.toBe(written.nativeProcessId);
      expect(firstDatabase.selection).toMatchObject(written.scope);
      expect(finalDatabase).toEqual(firstDatabase);
      for (const proof of [written, reopened]) {
        expect(proof).toMatchObject({
          electron: "43.4.1",
          live: 200,
          ready: 503,
          selectedState: "disabled",
          configurationRevision: 1,
          parameters,
          mainStreamsClosed: true,
          networkObservation: "formal-Main-fetch-only",
          supplierRequests: 0,
          onlinePosts: 0,
          noProvider: true,
        });
        const actualDocument = new URL(proof.formalDocument);
        expect(actualDocument.protocol).toBe("file:");
        expect(actualDocument.pathname).toBe(pathToFileURL(document).pathname);
        expect(proof.configurationReads).toBeGreaterThan(0);
      }
      expect(written.configurationWrites).toHaveLength(1);
      expect(reopened.configurationWrites).toHaveLength(0);
      expect(digest(await readFile(main))).toBe(mainDigest);
      expect(digest(await readFile(document))).toBe(documentDigest);
      const evidence = {
        scope:
          "actual formal file Main/preload/session/App; source Control child; not packaged .app or online supplier execution",
        written,
        reopened,
        packageIdentity: source,
        formalMainDigest: mainDigest,
        formalDocumentDigest: documentDigest,
        networkObservation:
          "formal-Main-fetch-only; not all Control/renderer/SDK egress",
        sourceOfflineAfterSave: true,
        database: finalDatabase,
      };
      console.log(
        "Native business configuration proof:",
        JSON.stringify(evidence),
      );
      await writeFile(
        join(evidenceDirectory, "native-business-configuration-proof.json"),
        JSON.stringify(evidence, null, 2) + "\n",
      );
    } finally {
      if (cleanupSafe) {
        await writable(root);
        await rm(root, { recursive: true, force: true });
      } else {
        console.error("native_configuration_unretired_data_retained:" + root);
      }
    }
  },
  150_000,
);

function inspectDatabase(path: string, packageDigest: string) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = database
      .prepare(
        "SELECT configuration_json FROM extension_configurations ORDER BY revision",
      )
      .all() as { configuration_json: string }[];
    expect(rows).toHaveLength(1);
    const configuration = JSON.parse(rows[0]!.configuration_json);
    expect(configuration).toMatchObject({
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: DESKTOP_RUNTIME_OWNER.tenantId,
      spaceId: DESKTOP_RUNTIME_OWNER.spaceId,
      pluginId: "example.professional",
      pluginVersion: "1.0.0",
      revision: 1,
      parameters,
      credentialBindings: [],
      createdByActorId: DESKTOP_RUNTIME_OWNER.actorId,
    });
    for (const field of [
      "manifestDigest",
      "implementationDigest",
      "contentDigest",
    ])
      expect(configuration[field]).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const selections = database
      .prepare("SELECT record_json FROM plugin_profile_selections")
      .all() as { record_json: string }[];
    expect(selections).toHaveLength(1);
    const selection = JSON.parse(selections[0]!.record_json);
    expect(selection).toMatchObject({
      pluginId: "example.professional",
      state: "disabled",
      selectedPackageDigest: packageDigest,
    });
    const receipts = database
      .prepare(
        "SELECT kind,actor_id,request_digest,result_json FROM extension_mutation_receipts",
      )
      .all();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      kind: "configuration",
      actor_id: DESKTOP_RUNTIME_OWNER.actorId,
    });
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const executionRows: Record<string, number> = {};
    for (const { name } of tables)
      if (
        !name.endsWith("_schema_version") &&
        /^(?:run_|agent_version|active_agent_version|plugin_(?:task|query_task)_admissions|extension_(?:activations|run_bindings|external_operation|credit|plugin_task|plugin_query))|credit|quote|charge/u.test(
          name,
        )
      )
        executionRows[name] = database
          .prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`)
          .get()!.n as number;
    expect(executionRows.run_snapshots).toBe(0);
    expect(executionRows.agent_versions).toBe(0);
    const threadCount = database
      .prepare("SELECT COUNT(*) AS n FROM threads")
      .get()!.n as number;
    expect(threadCount).toBe(0);
    expect(Object.values(executionRows).every((count) => count === 0)).toBe(
      true,
    );
    return { configuration, selection, receipts, threadCount, executionRows };
  } finally {
    database.close();
  }
}
function digest(bytes: Buffer) {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}
async function waitForMainClose(completion: Promise<number | null>) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      completion,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("native_configuration_main_retirement_timeout")),
          5000,
        );
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
async function writable(directory: string) {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) return;
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory() && !entry.isSymbolicLink())
      await writable(join(directory, entry.name));
}
