import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { it } from "vitest";
import { nativeTaskMainAuthorityTokens } from "../../control-api/src/desktop-installed-plugin-task-main.authorities.test-support.ts";
import { prepareNativePackagedReportApp } from "./desktopInstalledPluginRuntime.packaged-app.test-support.ts";
import { observePackagedRuntimeChildren } from "./desktopInstalledPluginRuntime.packaged-children.test-support.ts";
import {
  connectPackagedMainInspector,
  ownedPackagedInspectorPort,
} from "./desktopInstalledPluginRuntime.packaged-inspector.test-support.ts";
import { nativeTaskProcessFixture } from "./desktopInstalledPluginRuntime.tasks.process.test-support.ts";
import { trackDesktopTestChildren } from "./desktopPluginTestChildren.test-support.ts";

const professionalDirectory =
  process.env.CREWON_TEST_PROFESSIONAL_PLUGIN_V1_DIR;
const kreaDirectory = process.env.CREWON_TEST_KREA_PLUGIN_DIR;
const projectUiDirectory =
  process.env.CREWON_TEST_SHORT_DRAMA_RECOVERY_DIRECTORY;
const evidenceDirectory =
  process.env.CREWON_PACKAGED_PROJECTS_APP_EVIDENCE_DIRECTORY;
type Fixture = Awaited<ReturnType<typeof nativeTaskProcessFixture>>;
type AppProof = Readonly<{
  phase: "save" | "reopen";
  pid: number;
  formalDocument: string;
  settingsLabels: readonly string[];
  localePreferenceChanged: false;
  savedInputsReadBack: true;
  businessActionCounts: Readonly<Record<string, number>>;
  http: readonly Readonly<{
    method: string;
    path: string;
    status: number | null;
    action: string | null;
  }>[];
  [key: string]: unknown;
}>;
const inputs = {
  title: "Named packaged short-drama installation",
  brief:
    "Named saved project brief; this acceptance does not execute a supplier.",
  conceptName: "Named packaged concept",
  prompt:
    "Named saved concept prompt with its original revision.\nNo image generation is dispatched.",
} as const;
const projectTables = [
  "creative_projects",
  "creative_project_briefs",
  "creative_concept_assets",
  "creative_concept_revisions",
  "creative_project_mutation_receipts",
] as const;
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Original .app Settings installs the independently retained short-drama9 UI.
 * Original project writes and cold reads are real; no generation, query, image
 * selection, Thread or paid task is dispatched. The inherited 100 credits remain
 * named, unchanged fixture funding, never production authorization. */
it.runIf(Boolean(professionalDirectory && kreaDirectory && projectUiDirectory))(
  "original packaged Settings installs short-drama9; saved project inputs survive physical restart, disable, uninstall and explicit reinstall",
  async () => {
    let fixture: Fixture | undefined;
    let retired = true;
    let failure: unknown;
    try {
      fixture = await nativeTaskProcessFixture(
        {
          professionalDirectory: professionalDirectory!,
          kreaDirectory: kreaDirectory!,
          projectUiDirectory: projectUiDirectory!,
        },
        {
          scenario: "project-recovery",
          storageLayout: "formal-electron-user-data",
          workspaceLayout: "empty-private",
          isolationModelCatalog: { modelId: "named-native-process-model" },
        },
      );
      const f = fixture;
      assert.equal(f.source.pluginId, "crewon.short-drama");
      assert.equal(f.source.version, "9.0.0");
      assert.equal(
        f.source.packageDigest,
        "sha256:981c3bcdb7fc9c47186118a482bb1d8ec3dd1d4f95d3a09139f7a104dfba2334",
      );
      assert.ok(f.projects);
      assert.deepEqual(await f.taskDirectories(), []);
      const packaged = await prepareNativePackagedReportApp({
        directory: f.directory,
        repositoryRoot: await realpath(resolve("../..")),
        rendererDirectory: await realpath(resolve("dist")),
      });
      const outputDirectory = evidenceDirectory
        ? resolve(evidenceDirectory)
        : join(f.directory, "evidence");
      await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
      await writeFile(f.fixedPath, JSON.stringify(f.configuration), {
        mode: 0o600,
      });
      await writeFile(
        join(f.dataDirectory, "provider-credentials.json"),
        JSON.stringify({
          schemaVersion: "crewon.provider-credentials.v1",
          activeProviderId: f.metadata.provider.providerId,
          bindings: [
            {
              providerId: f.metadata.provider.providerId,
              endpoint: f.metadata.provider.endpoint,
              modelId: f.metadata.provider.modelId,
              credentialKind: "environment",
              environmentVariable: "NAMED_PACKAGED_PROJECT_MODEL_KEY",
              encryptedSecret: null,
            },
          ],
        }),
        { mode: 0o600 },
      );
      const observerPath = join(
        packaged.observerDirectory,
        "packaged-projects-observer.cjs",
      );
      try {
        await build({
          entryPoints: [
            resolve(
              "electron/desktopInstalledPluginRuntime.packaged-projects.native.test-support.ts",
            ),
          ],
          outfile: observerPath,
          bundle: true,
          platform: "node",
          format: "cjs",
          target: "node24",
          external: ["electron"],
          legalComments: "none",
          logLevel: "silent",
        });
      } finally {
        await stop();
      }
      const baselineEffects = f.effects();
      const baselineWallet = f.wallet();
      assert.equal(f.countQuotes(), 0);
      function readDatabase<T>(read: (database: DatabaseSync) => T): T {
        const database = new DatabaseSync(f.databasePath, { readOnly: true });
        try {
          return read(database);
        } finally {
          database.close();
        }
      }
      function projectFacts() {
        return readDatabase((database) =>
          Object.fromEntries(
            projectTables.map((table) => {
              const rows = database.prepare(`SELECT * FROM ${table}`).all();
              assert.ok(rows.length <= 16);
              return [table, rows.map((row) => JSON.stringify(row)).sort()];
            }),
          ),
        );
      }
      function selection() {
        return readDatabase((database) => {
          const row = database
            .prepare(
              "SELECT record_json FROM plugin_profile_selections WHERE plugin_id=?",
            )
            .get(f.source.pluginId);
          return row
            ? (JSON.parse(String(row.record_json)) as Record<string, unknown>)
            : null;
        });
      }
      assert.equal(
        selection(),
        null,
        "short-drama is an approved source, not preinstalled",
      );
      const runWindow = async (phase: "save" | "reopen") => {
        const catalogBefore = f.metadata.model.catalogRequests!();
        const configuration = join(
          f.directory,
          `packaged-projects-${phase}.json`,
        );
        const document = pathToFileURL(
          join(packaged.asarPath, "dist/index.html"),
        ).href;
        await writeFile(
          configuration,
          JSON.stringify({
            phase,
            executable: packaged.executable,
            resourcesPath: packaged.resourcesPath,
            appPath: packaged.asarPath,
            userData: f.directory,
            document,
            screenshotDirectory: outputDirectory,
            ...inputs,
          }),
          { mode: 0o600 },
        );
        const environment = { ...process.env };
        for (const name of Object.keys(environment))
          if (
            name.startsWith("CREWON_") ||
            name === "ELECTRON_RUN_AS_NODE" ||
            name === "ELECTRON_FORCE_IS_PACKAGED" ||
            name === "AICUICAN_API_KEY"
          )
            delete environment[name];
        delete environment.NODE_OPTIONS;
        assert.ok(f.metadata.workspaceDirectory);
        environment.CREWON_DESKTOP_WORKSPACE_ROOT =
          f.metadata.workspaceDirectory;
        environment.NAMED_PACKAGED_PROJECT_MODEL_KEY =
          f.metadata.provider.apiKey;
        for (const [name, value] of Object.entries(
          nativeTaskMainAuthorityTokens,
        ))
          environment[name] = value;
        const port = await ownedPackagedInspectorPort();
        let inspector:
          | Awaited<ReturnType<typeof connectPackagedMainInspector>>
          | undefined;
        let child: ChildProcess | undefined;
        let tracker: ReturnType<typeof trackDesktopTestChildren> | undefined;
        let runtimeObservation:
          | ReturnType<typeof observePackagedRuntimeChildren>
          | undefined;
        let completion: Promise<void> | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let mainClosed = false;
        let code: number | null = null;
        let spawnError: Error | undefined;
        let output = "";
        try {
          retired = false;
          child = spawn(
            packaged.executable,
            [`--user-data-dir=${f.directory}`, `--inspect=127.0.0.1:${port}`],
            { env: environment, stdio: ["ignore", "pipe", "pipe"] },
          );
          tracker = trackDesktopTestChildren(child);
          runtimeObservation = observePackagedRuntimeChildren(
            child,
            packaged.executable,
            packaged.runtimeDirectory,
          );
          completion = new Promise<void>((accept) => {
            child!.once("error", (error) => {
              spawnError = error;
            });
            child!.once("close", (exitCode) => {
              code = exitCode;
              mainClosed = true;
              accept();
            });
          });
          const collect = (bytes: Buffer) => {
            output = (output + bytes.toString()).slice(-128 * 1024);
          };
          child.stdout!.on("data", collect);
          child.stderr!.on("data", collect);
          inspector = await connectPackagedMainInspector({ port });
          const mainIdentity = await inspector.verifyMain({
            processId: child.pid!,
            executable: packaged.executable,
            resourcesPath: packaged.resourcesPath,
            userData: f.directory,
            appPath: packaged.asarPath,
            packageMain: "dist-electron/main.mjs",
          });
          await inspector.observeOriginalPackagedApp({
            observerPath,
            configPath: configuration,
          });
          await inspector.close();
          inspector = undefined;
          await Promise.race([
            completion,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                child?.kill("SIGKILL");
                reject(new Error("packaged_projects_window_timeout:" + output));
              }, 100_000);
            }),
          ]);
          if (spawnError) throw spawnError;
          assert.equal(code, 0, output);
          const match = /^CREWON_PACKAGED_PROJECTS_APP_PROOF:(.+)$/mu.exec(
            output,
          );
          assert.ok(match, output);
          const proof = JSON.parse(match[1]!) as AppProof;
          assert.equal(proof.phase, phase);
          assert.equal(proof.pid, child.pid);
          assert.equal(proof.formalDocument, document);
          assert.equal(proof.settingsLabels.length, 10);
          assert.equal(proof.localePreferenceChanged, false);
          assert.equal(proof.savedInputsReadBack, true);
          const runtimeChildren = await runtimeObservation.close();
          const catalogRequests =
            f.metadata.model.catalogRequests!() - catalogBefore;
          assert.ok(
            catalogRequests > 0,
            "original Main actually probes the named model catalogue",
          );
          assert.ok(
            runtimeChildren.some(({ entry }) =>
              entry.endsWith("/control-api.mjs"),
            ),
          );
          assert.ok(
            runtimeChildren.some(({ entry }) =>
              entry.endsWith("/runtime-worker.mjs"),
            ),
          );
          return { ...proof, mainIdentity, runtimeChildren, catalogRequests };
        } finally {
          if (timer) clearTimeout(timer);
          const errors: unknown[] = [];
          try {
            await inspector?.close();
          } catch (error) {
            errors.push(error);
          }
          if (child && !mainClosed) child.kill("SIGKILL");
          try {
            await completion;
          } catch (error) {
            errors.push(error);
          }
          try {
            await runtimeObservation?.close();
          } catch (error) {
            errors.push(error);
          }
          try {
            if (tracker) {
              const forced = await tracker.close();
              retired = true;
              assert.deepEqual(
                forced,
                [],
                "original Main must join its actual children without test force",
              );
            } else if (!child?.pid) retired = true;
          } catch (error) {
            errors.push(error);
          }
          if (!mainClosed)
            errors.push(new Error("packaged_projects_Main_not_closed"));
          if (errors.length)
            throw new AggregateError(
              errors,
              "packaged_projects_cleanup_failed",
            );
        }
      };
      const saved = await runWindow("save");
      assert.equal(saved.businessActionCounts.projectCreates, 1);
      assert.equal(saved.businessActionCounts.conceptCreates, 1);
      assert.equal(saved.businessActionCounts.installs, 1);
      assert.equal(saved.businessActionCounts.selectionChanges, 1);
      assert.equal(selection()!.state, "enabled");
      assert.equal(selection()!.revision, 2);
      const originalFacts = projectFacts();
      for (const table of projectTables)
        assert.equal(
          originalFacts[table]!.length,
          table === "creative_project_mutation_receipts" ? 2 : 1,
        );
      const project = JSON.parse(
        JSON.parse(originalFacts.creative_projects![0]!).record_json,
      );
      const brief = JSON.parse(
        JSON.parse(originalFacts.creative_project_briefs![0]!).record_json,
      );
      const asset = JSON.parse(
        JSON.parse(originalFacts.creative_concept_assets![0]!).record_json,
      );
      const revision = JSON.parse(
        JSON.parse(originalFacts.creative_concept_revisions![0]!).record_json,
      );
      assert.equal(project.title, inputs.title);
      assert.equal(brief.text, inputs.brief);
      assert.equal(asset.name, inputs.conceptName);
      assert.equal(revision.prompt, inputs.prompt);
      assert.deepEqual(f.effects(), baselineEffects);
      assert.deepEqual(f.wallet(), baselineWallet);
      const reopened = await runWindow("reopen");
      assert.notEqual(saved.pid, reopened.pid);
      assert.equal(reopened.businessActionCounts.projectCreates, 0);
      assert.equal(reopened.businessActionCounts.conceptCreates, 0);
      assert.equal(reopened.businessActionCounts.installs, 1);
      assert.equal(reopened.businessActionCounts.selectionChanges, 3);
      assert.equal(selection()!.state, "enabled");
      assert.equal(selection()!.revision, 6);
      assert.deepEqual(
        projectFacts(),
        originalFacts,
        "all actual saved project/input identities and mutation receipts survive uninstall/reinstall unchanged",
      );
      for (const proof of [saved, reopened])
        for (const key of [
          "generationSubmissions",
          "querySubmissions",
          "imageSelections",
          "threadCreates",
          "recoveryStages",
          "otherMetadataWrites",
        ])
          assert.equal(proof.businessActionCounts[key], 0, key);
      assert.deepEqual(f.effects(), baselineEffects);
      assert.deepEqual(f.wallet(), baselineWallet);
      assert.equal(f.countQuotes(), 0);
      f.assertNoSupplierExecution();
      assert.equal(
        sha(await readFile(packaged.asarPath)),
        packaged.proof.asarSha256,
      );
      for (const entry of packaged.proof.packagedFiles)
        if (entry.location === "runtime")
          assert.equal(
            sha(await readFile(join(packaged.runtimeDirectory, entry.entry))),
            entry.sha256,
          );
      await writeFile(
        join(outputDirectory, "native-packaged-projects-app-proof.json"),
        JSON.stringify(
          {
            acceptance:
              "original packaged Settings short-drama9 install/enable/save/cold-read/disable/uninstall/reinstall; no image supplier execution or three-lane recovery claim",
            saved,
            reopened,
            inputs,
            source: {
              pluginId: f.source.pluginId,
              version: f.source.version,
              packageDigest: f.source.packageDigest,
            },
            projectFacts: originalFacts,
            finalSelection: selection(),
            wallet: f.wallet(),
            quoteCount: f.countQuotes(),
            modelRequests: f.metadata.modelRequests(),
            supplierRequests: f.metadata.supplierRequests(),
            namedUnusedFixtureFunding: true,
            actualProductionFunding: false,
            comfyuiRequests: 0,
            packagedApp: packaged.proof,
            physicalChildren: [
              ...saved.runtimeChildren,
              ...reopened.runtimeChildren,
            ],
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
    } catch (error) {
      failure = error;
    }
    if (fixture && retired) {
      try {
        await fixture.close();
      } catch (error) {
        failure = failure
          ? new AggregateError(
              [failure, error],
              "packaged_projects_fixture_cleanup_failed",
            )
          : error;
      }
    } else if (fixture) {
      failure = new AggregateError(
        [failure],
        "packaged_projects_owned_root_retained_until_children_retire",
      );
    }
    if (failure) throw failure;
  },
  420_000,
);
