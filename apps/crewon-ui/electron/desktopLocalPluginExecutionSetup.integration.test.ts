import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
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
import {
  parseExtensionConfiguration,
  parsePluginSelection,
} from "@crewon/domain";
import { verifyLocalPluginPackage } from "../../../packages/plugin-host/src/local-plugin-package-verifier.ts";
import { loadInstalledPluginBusinessRegistration } from "../../../packages/plugin-host/src/installed-plugin-business-registration.ts";
import {
  DESKTOP_PLUGIN_APPROVAL_FILE,
  DESKTOP_PLUGIN_APPROVAL_SCHEMA,
  parseDesktopPluginApproval,
} from "./desktopPluginBootstrap.ts";
import { composeDesktopLocalPluginProjectApproval } from "./desktopLocalPluginProjectApproval.ts";
import { DESKTOP_NATIVE_PLUGIN_POLICY_FILE } from "./desktopNativePluginAuthority.ts";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";
import { trackDesktopTestChildren } from "./desktopPluginTestChildren.test-support.ts";
import type { DesktopLocalPluginExecutionStatus } from "../src/lib/desktop/desktopLocalPluginExecutionSetupProtocol.ts";

const packageDirectory = process.env.CREWON_TEST_SHORT_DRAMA_PLUGIN_DIR;
const parameters = Object.freeze({
  baseUrl: "https://comfy.example.invalid/",
  preset: "krea2-portrait",
});
type AppProof = Readonly<{
  phase: "prepare" | "reopen";
  formalMain: boolean;
  originalSettings: boolean;
  isolatedPreload: boolean;
  disabledSelection: boolean;
  accessGenerationBefore: number;
  selfRestarts: number;
  nativeProcessId: number;
  formalDocument: string;
  receipt: DesktopLocalPluginExecutionStatus | null;
  mainStreamsClosed: boolean;
}>;

it.runIf(packageDirectory !== undefined)(
  "formal isolated Main installs Short12, saves parameters, explicitly prepares both Native stages and cold-reopens the installed package with its source offline",
  async () => {
    // A supplied invalid artifact is a hard failure; no source plugin/SDK build or substitute package.
    const originalDirectory = await realpath(packageDirectory!);
    const original = await verifyLocalPluginPackage({
      directory: originalDirectory,
    });
    expect(original.descriptor).toMatchObject({
      pluginId: "crewon.short-drama",
      publisherId: "example.publisher",
      version: "12.0.0",
    });
    expect(original.descriptor.entrypoints.node).not.toBeNull();
    expect(original.descriptor.entrypoints.ui).not.toBeNull();
    expect(original.descriptor.businessManifestPath).not.toBeNull();
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "crewon-native-execution-setup-")),
    );
    const userData = join(root, "electron-user-data");
    const dataDirectory = join(userData, "control-runtime-v1");
    const evidenceDirectory = process.env.CREWON_NATIVE_APP_EVIDENCE_DIRECTORY
      ? resolve(process.env.CREWON_NATIVE_APP_EVIDENCE_DIRECTORY)
      : join(root, "evidence");
    let cleanupSafe = true;
    let catalogGets = 0,
      inferencePosts = 0,
      otherRequests = 0;
    const catalog = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        catalogGets++;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: "named-catalog-only",
                object: "model",
                owned_by: "local-test",
              },
            ],
          }),
        );
      } else {
        if (request.method === "POST") inferencePosts++;
        otherRequests++;
        response.writeHead(405);
        response.end();
      }
    });
    try {
      await chmod(root, 0o700);
      await new Promise<void>((accept, reject) => {
        catalog.once("error", reject);
        catalog.listen(0, "127.0.0.1", () => {
          catalog.off("error", reject);
          accept();
        });
      });
      const address = catalog.address();
      if (address === null || typeof address === "string")
        throw new Error("named_model_catalog_address_missing");
      const modelEndpoint = `http://127.0.0.1:${address.port}/v1`;
      await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
      await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
      await chmod(evidenceDirectory, 0o700);
      const sourceRoot = join(root, "source-root");
      await mkdir(sourceRoot, { mode: 0o700 });
      for (const name of ["apps", "packages", "scripts", "node_modules"])
        await symlink(resolve("../..", name), join(sourceRoot, name), "dir");
      expect((await readdir(sourceRoot)).sort()).toEqual([
        "apps",
        "node_modules",
        "packages",
        "scripts",
      ]);
      const approvedDirectory = join(root, "approved-short12-source");
      await cp(originalDirectory, approvedDirectory, { recursive: true });
      await chmod(approvedDirectory, 0o700);
      const verified = await verifyLocalPluginPackage({
        directory: approvedDirectory,
      });
      expect(verified.packageDigest).toBe(original.packageDigest);
      const source = Object.freeze({
        sourceId: "native-execution-short12",
        directory: approvedDirectory,
        pluginId: verified.descriptor.pluginId,
        publisherId: verified.descriptor.publisherId,
        version: verified.descriptor.version,
        packageDigest: verified.packageDigest,
      });
      // Trusted source/UI plus metadata services only. The actual Settings confirmation must write policy and v3.
      const initialApproval = composeDesktopLocalPluginProjectApproval({
        approval: parseDesktopPluginApproval({
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
        descriptor: verified.descriptor,
        packageDigest: verified.packageDigest,
      });
      expect(initialApproval.schemaVersion).toBe(
        "crewon.desktop-plugin-approval.v2",
      );
      expect(
        "projects" in initialApproval &&
          "pluginGenerations" in initialApproval.projects,
      ).toBe(false);
      await writeFile(
        join(dataDirectory, DESKTOP_PLUGIN_APPROVAL_FILE),
        JSON.stringify(initialApproval),
        { mode: 0o600 },
      );
      const provider = {
        schemaVersion: "crewon.provider-credentials.v1",
        activeProviderId: "named-local-catalog",
        bindings: [
          {
            providerId: "named-local-catalog",
            endpoint: modelEndpoint,
            modelId: "named-catalog-only",
            credentialKind: "none",
            environmentVariable: null,
            encryptedSecret: null,
          },
        ],
      };
      await writeFile(
        join(dataDirectory, "provider-credentials.json"),
        JSON.stringify(provider),
        { mode: 0o600 },
      );
      await expect(
        lstat(join(dataDirectory, DESKTOP_NATIVE_PLUGIN_POLICY_FILE)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const main = resolve("dist-electron/main.mjs"),
        document = resolve("dist/index.html");
      const mainDigest = digest(await readFile(main)),
        documentDigest = digest(await readFile(document));
      await build({
        entryPoints: [
          resolve(
            "electron/desktopLocalPluginExecutionSetup.native.test-support.ts",
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
      await chmod(join(root, "launcher.mjs"), 0o600);
      const run = async (phase: "prepare" | "reopen"): Promise<AppProof> => {
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
            baseUrl: parameters.baseUrl,
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
        let childClosed = false,
          spawnError: Error | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let output = "";
        try {
          child = spawn(
            createRequire(import.meta.url)("electron"),
            [join(root, "launcher.mjs"), configuration],
            { env, stdio: ["ignore", "pipe", "pipe"] },
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
          const observe = (bytes: Buffer) => {
            output += bytes.toString();
            if (output.length > 1024 * 1024)
              output = output.slice(-1024 * 1024);
          };
          child.stdout!.on("data", observe);
          child.stderr!.on("data", observe);
          const code = await Promise.race([
            completion,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                child?.kill("SIGKILL");
                reject(
                  new Error("native_execution_setup_process_timeout:" + output),
                );
              }, 100_000);
            }),
          ]);
          if (spawnError) throw spawnError;
          const match = /CREWON_NATIVE_EXECUTION_SETUP_PROOF:(.+)/u.exec(
            output,
          );
          const domFailure =
            /Error: (native_execution_setup_timeout:[\s\S]*?)(?=\n\s+at |$)/u.exec(
              output,
            );
          if (domFailure)
            await writeFile(
              join(evidenceDirectory, `${phase}-dom-failure.txt`),
              domFailure[1]!.slice(0, 16 * 1024) + "\n",
              { mode: 0o600 },
            );
          if (!match)
            await writeFile(
              join(evidenceDirectory, `${phase}-stdout-summary.json`),
              JSON.stringify({
                phase,
                exitCode: code,
                mainStreamsClosed: childClosed,
                proof: null,
                failureCodes: [
                  "CREWON_PROVIDER_PROBE_CONFIGURATION_invalid",
                  "agent_version_runtime_provider_key_missing",
                  "control_runtime_unavailable",
                  "native_execution_setup_timeout",
                ].filter((value) => output.includes(value)),
                modelCatalog: { catalogGets, inferencePosts, otherRequests },
              }) + "\n",
              { mode: 0o600 },
            );
          expect(code, output).toBe(0);
          expect(childClosed, "formal Main and streams physically closed").toBe(
            true,
          );
          expect(match, output).not.toBeNull();
          const proof = {
            ...JSON.parse(match![1]),
            mainStreamsClosed: childClosed,
          } as AppProof;
          await writeFile(
            join(evidenceDirectory, `${phase}-stdout-summary.json`),
            JSON.stringify(
              { phase, exitCode: code, mainStreamsClosed: childClosed, proof },
              null,
              2,
            ) + "\n",
            { mode: 0o600 },
          );
          return proof;
        } finally {
          if (timer !== null) clearTimeout(timer);
          if (child && child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
          let mainRetired = false;
          try {
            if (completion !== null) await waitForMainClose(completion);
            mainRetired = childClosed;
          } finally {
            const forced = children
              ? await children.close()
              : child?.pid === undefined
                ? []
                : null;
            cleanupSafe = mainRetired && forced !== null;
            await writeFile(
              join(evidenceDirectory, `${phase}-retirement.json`),
              JSON.stringify({
                phase,
                mainRetired,
                childrenPhysicallyRetired: forced !== null,
                fixtureForcedChildCount: forced?.length ?? null,
              }) + "\n",
              { mode: 0o600 },
            );
            expect(
              forced,
              "formal shutdown physically joins every Native/Control/Worker child without fixture-owned killing",
            ).toEqual([]);
          }
        }
      };
      const prepared = await run("prepare");
      const firstDatabase = inspectDatabase(
        join(dataDirectory, "control.sqlite"),
        source.packageDigest,
      );
      const registration = await loadInstalledPluginBusinessRegistration({
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
        registration.manifestDigest,
      );
      expect(firstDatabase.configuration.implementationDigest).toBe(
        registration.implementationDigest,
      );
      const expectedIdentity = {
        pluginId: source.pluginId,
        publisherId: source.publisherId,
        version: source.version,
        packageDigest: source.packageDigest,
        manifestDigest: registration.manifestDigest,
        implementationDigest: registration.implementationDigest,
        selectionRevision: firstDatabase.selection.revision,
        configurationRevision: 1,
        configurationDigest: firstDatabase.configuration.contentDigest,
      };
      expect(prepared.receipt).toMatchObject({
        state: "committed",
        pluginId: source.pluginId,
        result: {
          ...expectedIdentity,
          state: "prepared",
          runtimeStatus: "ready",
          stage: "mappingCommitted",
        },
      });
      const policyPath = join(dataDirectory, DESKTOP_NATIVE_PLUGIN_POLICY_FILE);
      const policyBytes = await readFile(policyPath);
      const policy = JSON.parse(policyBytes.toString());
      const pkg = {
        pluginId: source.pluginId,
        publisherId: source.publisherId,
        version: source.version,
        packageDigest: source.packageDigest,
        approvalRequirement: "none",
      };
      expect(policy).toEqual({
        schemaVersion: "crewon.desktop-native-plugin-policy.v1",
        packages: [pkg],
        networkGrants: [
          {
            pluginId: source.pluginId,
            publisherId: source.publisherId,
            version: source.version,
            packageDigest: source.packageDigest,
            baseUrl: parameters.baseUrl,
            baseUrlParameter: "baseUrl",
            paths: [
              { method: "POST", path: "/prompt" },
              { method: "GET", path: "/queue" },
              { method: "GET", operationPathPrefix: "/history/" },
              { method: "GET", path: "/view" },
            ],
          },
        ],
      });
      const approvalPath = join(dataDirectory, DESKTOP_PLUGIN_APPROVAL_FILE);
      const approvalBytes = await readFile(approvalPath);
      const approval = parseDesktopPluginApproval(
        JSON.parse(approvalBytes.toString()),
      );
      expect(approval.schemaVersion).toBe("crewon.desktop-plugin-approval.v3");
      if (approval.schemaVersion !== "crewon.desktop-plugin-approval.v3")
        throw new Error("native_execution_setup_v3_missing");
      expect(approval.sources).toEqual(initialApproval.sources);
      expect(approval.publications).toEqual(initialApproval.publications);
      const publication = {
        pluginId: source.pluginId,
        packageDigest: source.packageDigest,
        contributionId: "workbench",
      };
      expect(approval.projects.pluginGenerations?.publications).toEqual([
        {
          source: publication,
          target: { ...publication, action: "image.generate" },
        },
      ]);
      expect(approval.projects.pluginQueries?.publications).toEqual([
        {
          source: publication,
          target: { ...publication, action: "image.query" },
        },
      ]);
      expect(approval.projects.resultSelections?.identities).toEqual([
        {
          pluginId: source.pluginId,
          pluginVersion: source.version,
          manifestDigest: registration.manifestDigest,
          implementationDigest: registration.implementationDigest,
        },
      ]);
      expect(approval.projects.uiRecovery?.publications).toEqual([
        {
          ...publication,
          actions: [
            "crewon.project-generations.v1.generateConcept",
            "crewon.project-generation-queries.v1.queryConceptGeneration",
            "crewon.project-generation-selections.v1.selectConceptImage",
          ],
        },
      ]);
      expect((await lstat(policyPath)).mode & 0o777).toBe(0o600);
      expect((await lstat(approvalPath)).mode & 0o777).toBe(0o600);
      await rename(approvedDirectory, `${approvedDirectory}-offline`);
      const reopened = await run("reopen");
      const finalDatabase = inspectDatabase(
        join(dataDirectory, "control.sqlite"),
        source.packageDigest,
      );
      expect(finalDatabase).toEqual(firstDatabase);
      expect(reopened.receipt).toBeNull();
      expect(reopened.nativeProcessId).not.toBe(prepared.nativeProcessId);
      expect(await readFile(policyPath)).toEqual(policyBytes);
      expect(await readFile(approvalPath)).toEqual(approvalBytes);
      for (const proof of [prepared, reopened]) {
        expect(proof).toMatchObject({
          formalMain: true,
          originalSettings: true,
          isolatedPreload: true,
          disabledSelection: true,
          mainStreamsClosed: true,
        });
        expect(new URL(proof.formalDocument).pathname).toBe(
          pathToFileURL(document).pathname,
        );
      }
      expect(prepared.selfRestarts).toBe(2);
      expect(reopened.selfRestarts).toBe(0);
      expect(catalogGets).toBeGreaterThan(0);
      expect(inferencePosts).toBe(0);
      expect(otherRequests).toBe(0);
      expect(digest(await readFile(main))).toBe(mainDigest);
      expect(digest(await readFile(document))).toBe(documentDigest);
      for (const entry of await readdir(evidenceDirectory, {
        withFileTypes: true,
      }))
        if (entry.isFile())
          await chmod(join(evidenceDirectory, entry.name), 0o600);
      const evidence = {
        scope:
          "formal source Main/preload/file App and actual Native/Control/Worker children; not installed user App or supplier execution",
        prepared,
        reopened,
        packageDigest: source.packageDigest,
        expectedIdentity,
        database: finalDatabase,
        sourceOfflineAfterPreparation: true,
        initialApprovalSchema: initialApproval.schemaVersion,
        finalApprovalSchema: approval.schemaVersion,
        policy,
        modelCatalog: { catalogGets, inferencePosts, otherRequests },
        supplierBaseUrl: parameters.baseUrl,
        noGeneration: true,
        physicalChildJoin: true,
        formalMainDigest: mainDigest,
        formalDocumentDigest: documentDigest,
      };
      await writeFile(
        join(evidenceDirectory, "native-execution-setup-proof.json"),
        JSON.stringify(evidence, null, 2) + "\n",
        { mode: 0o600 },
      );
      console.log("Native execution setup proof:", JSON.stringify(evidence));
    } finally {
      const evidenceFiles = await readdir(evidenceDirectory, {
        withFileTypes: true,
      }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const entry of evidenceFiles)
        if (entry.isFile())
          await chmod(join(evidenceDirectory, entry.name), 0o600);
      if (catalog.listening) {
        catalog.closeAllConnections();
        await new Promise<void>((accept, reject) =>
          catalog.close((error) => (error ? reject(error) : accept())),
        );
      }
      if (cleanupSafe) {
        await writable(root);
        await rm(root, { recursive: true, force: true });
      } else
        console.error("native_execution_setup_unretired_data_retained:" + root);
    }
  },
  240_000,
);

function inspectDatabase(path: string, packageDigest: string) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const configurations = database
      .prepare(
        "SELECT configuration_json FROM extension_configurations ORDER BY revision",
      )
      .all();
    expect(configurations).toHaveLength(1);
    const configuration = parseExtensionConfiguration(
      JSON.parse(configurations[0]!.configuration_json as string),
      { sha256: digest },
    );
    expect(configuration).toMatchObject({
      tenantId: DESKTOP_RUNTIME_OWNER.tenantId,
      spaceId: DESKTOP_RUNTIME_OWNER.spaceId,
      pluginId: "crewon.short-drama",
      pluginVersion: "12.0.0",
      revision: 1,
      parameters,
      credentialBindings: [],
      createdByActorId: DESKTOP_RUNTIME_OWNER.actorId,
    });
    const selections = database
      .prepare("SELECT record_json FROM plugin_profile_selections")
      .all();
    expect(selections).toHaveLength(1);
    const selection = parsePluginSelection(
      JSON.parse(selections[0]!.record_json as string),
    );
    expect(selection).toMatchObject({
      pluginId: "crewon.short-drama",
      state: "disabled",
      selectedPackageDigest: packageDigest,
    });
    const receipts = database
      .prepare("SELECT kind,actor_id FROM extension_mutation_receipts")
      .all();
    expect(receipts).toEqual([
      { kind: "configuration", actor_id: DESKTOP_RUNTIME_OWNER.actorId },
    ]);
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const executionRows: Record<string, number> = {};
    for (const { name } of tables)
      if (
        !name.endsWith("_schema_version") &&
        /^(?:run_|work_items$|threads$|extension_(?:activations|run_bindings|external_operations)|plugin_(?:task|query_task|credit)|creative_(?:projects|concept_|project_generation|project_query)|.*(?:credit|quote|charge))/u.test(
          name,
        )
      )
        executionRows[name] = database
          .prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`)
          .get()!.n as number;
    for (const table of [
      "run_snapshots",
      "threads",
      "extension_activations",
      "extension_run_bindings",
      "extension_external_operations",
    ])
      expect(
        executionRows[table],
        `${table} must be physically present and empty`,
      ).toBe(0);
    expect(Object.values(executionRows).every((count) => count === 0)).toBe(
      true,
    );
    return { configuration, selection, receipts, executionRows };
  } finally {
    database.close();
  }
}
function digest(bytes: string | Buffer) {
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
            reject(new Error("native_execution_setup_main_retirement_timeout")),
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
