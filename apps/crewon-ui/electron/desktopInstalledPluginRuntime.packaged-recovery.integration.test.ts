import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
import {
  assertPreparedPackagedRecovery,
  packagedRecoveryDatabaseFacts,
  packagedRecoveryDirectories,
  packagedRecoveryIdentity,
  packagedRecoveryInputs,
  type PackagedRecoveryFixture,
  type PackagedRecoveryProof,
} from "./desktopInstalledPluginRuntime.packaged-recovery.test-support.ts";

const available = Boolean(
  process.env.CREWON_TEST_PROFESSIONAL_PLUGIN_V1_DIR &&
    process.env.CREWON_TEST_KREA_PLUGIN_DIR &&
    process.env.CREWON_TEST_SHORT_DRAMA_RECOVERY_DIRECTORY,
);
const evidenceDirectory =
  process.env.CREWON_PACKAGED_RECOVERY_APP_EVIDENCE_DIRECTORY;
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Real original .app/HTTP/SQLite/renderer. The initial three commands are staged by
 * an authenticated fixture client using UI-saved inputs and a UI-created Thread.
 * Their operation does not exist: there is no successful image history, selection,
 * admission, Worker execution, price request or online S0 claim. */
it.runIf(available)(
  "original packaged short-drama9 saves inputs and a Thread; three actual authenticated prepared ACKs hydrate as UNKNOWN after physical Main restart without business dispatch or successful operation history",
  async () => {
    let fixture: PackagedRecoveryFixture | undefined;
    let retired = true;
    let failure: unknown;
    try {
      fixture = await nativeTaskProcessFixture(
        await packagedRecoveryDirectories(),
        {
          scenario: "project-recovery",
          storageLayout: "formal-electron-user-data",
          workspaceLayout: "empty-private",
          isolationModelCatalog: { modelId: "named-native-process-model" },
        },
      );
      const f = fixture;
      for (const [key, value] of Object.entries(packagedRecoveryIdentity))
        assert.equal(
          f.source[key as keyof typeof packagedRecoveryIdentity],
          value,
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
              environmentVariable: "NAMED_PACKAGED_RECOVERY_MODEL_KEY",
              encryptedSecret: null,
            },
          ],
        }),
        { mode: 0o600 },
      );
      const observerPath = join(
        packaged.observerDirectory,
        "packaged-recovery-observer.cjs",
      );
      try {
        await build({
          entryPoints: [
            resolve(
              "electron/desktopInstalledPluginRuntime.packaged-recovery.native.test-support.ts",
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
      function databaseRead<T>(read: (database: DatabaseSync) => T): T {
        const database = new DatabaseSync(f.databasePath, { readOnly: true });
        try {
          return read(database);
        } finally {
          database.close();
        }
      }
      const selection = () =>
        databaseRead((database) => {
          const row = database
            .prepare(
              "SELECT record_json FROM plugin_profile_selections WHERE plugin_id=?",
            )
            .get(packagedRecoveryIdentity.pluginId);
          return row
            ? (JSON.parse(String(row.record_json)) as Record<string, unknown>)
            : null;
        });
      const baselineEffects = f.effects(),
        baselineWallet = f.wallet();
      const baselineThreads = databaseRead((database) =>
        Number(database.prepare("SELECT count(*) AS n FROM threads").get()!.n),
      );
      assert.equal(
        selection(),
        null,
        "the original Settings must install the retained approved source",
      );
      assert.equal(f.countQuotes(), 0);
      const operationId = randomUUID();
      const runWindow = async (
        phase: "stage" | "hydrate",
        requests?: PackagedRecoveryProof["requests"],
      ) => {
        const catalogBefore = f.metadata.model.catalogRequests!();
        const configuration = join(
          f.directory,
          `packaged-recovery-${phase}.json`,
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
            ...packagedRecoveryInputs,
            operationId,
            ...(requests === undefined ? {} : { requests }),
          }),
          { mode: 0o600 },
        );
        // This is exactly the existing packaged project fixture's environment boundary.
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
        environment.NAMED_PACKAGED_RECOVERY_MODEL_KEY =
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
        let runtime:
          | ReturnType<typeof observePackagedRuntimeChildren>
          | undefined;
        let completion: Promise<void> | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let mainClosed = false;
        let code: number | null = null;
        let spawnError: Error | undefined;
        let primaryFailure: unknown;
        let output = "";
        try {
          retired = false;
          child = spawn(
            packaged.executable,
            [`--user-data-dir=${f.directory}`, `--inspect=127.0.0.1:${port}`],
            { env: environment, stdio: ["ignore", "pipe", "pipe"] },
          );
          tracker = trackDesktopTestChildren(child);
          runtime = observePackagedRuntimeChildren(
            child,
            packaged.executable,
            packaged.runtimeDirectory,
          );
          completion = new Promise<void>((done) => {
            child!.once("error", (error) => {
              spawnError = error;
            });
            child!.once("close", (exitCode) => {
              code = exitCode;
              mainClosed = true;
              done();
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
                reject(new Error("packaged_recovery_window_timeout:" + output));
              }, 100_000);
            }),
          ]);
          if (spawnError) throw spawnError;
          assert.equal(code, 0, output);
          const match = /^CREWON_PACKAGED_RECOVERY_APP_PROOF:(.+)$/mu.exec(
            output,
          );
          assert.ok(match, output);
          const proof = JSON.parse(match[1]!) as PackagedRecoveryProof;
          assert.equal(proof.phase, phase);
          assert.equal(proof.pid, child.pid);
          assert.equal(proof.formalDocument, document);
          assert.equal(proof.userData, f.directory);
          assert.equal(proof.appPath, packaged.asarPath);
          assert.equal(proof.executable, packaged.executable);
          assert.equal(proof.localePreferenceChanged, false);
          assert.equal(proof.settingsLabels.length, 10);
          assert.equal(proof.savedInputsReadBack, true);
          assert.equal(proof.operationId, operationId);
          assertPreparedPackagedRecovery(proof);
          const runtimeChildren = await runtime.close();
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
          const catalogRequests =
            f.metadata.model.catalogRequests!() - catalogBefore;
          assert.ok(
            catalogRequests > 0,
            "the original model catalogue probe is separate from execution",
          );
          return { ...proof, mainIdentity, runtimeChildren, catalogRequests };
        } catch (error) {
          primaryFailure = error;
          throw error;
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
            await runtime?.close();
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
                "original Main must physically join its children without fixture force",
              );
            } else if (!child?.pid) retired = true;
          } catch (error) {
            errors.push(error);
          }
          if (!mainClosed)
            errors.push(new Error("packaged_recovery_Main_not_closed"));
          if (errors.length)
            throw new AggregateError(
              primaryFailure === undefined
                ? errors
                : [primaryFailure, ...errors],
              "packaged_recovery_cleanup_failed",
            );
        }
      };
      const staged = await runWindow("stage");
      const warm = packagedRecoveryDatabaseFacts(f.databasePath);
      assert.equal(warm.selection!.state, "enabled");
      assert.equal(warm.selection!.revision, 2);
      assert.equal(warm.intents.length, 3);
      assert.equal(warm.facts.creative_projects!.length, 1);
      assert.equal(warm.facts.creative_project_briefs!.length, 1);
      assert.equal(warm.facts.creative_concept_assets!.length, 1);
      assert.equal(warm.facts.creative_concept_revisions!.length, 1);
      assert.equal(warm.facts.creative_project_mutation_receipts!.length, 2);
      assert.equal(warm.facts.threads!.length, baselineThreads + 1);
      for (const key of [
        "extension_external_operations",
        "creative_project_generation_links",
        "creative_project_query_links",
        "creative_operation_result_links",
        "creative_current_concept_selections",
        "creative_concept_selection_receipts",
      ])
        assert.equal(warm.facts[key]!.length, 0, key);
      for (const intent of warm.intents) {
        assert.equal(intent.phase, "prepared");
        assert.equal(intent.dispatchAttemptCount, 0);
        assert.equal(intent.receiptJson, null);
        const request = staged.requests.find(
          (value) => value.action === intent.sourcePin.action,
        );
        assert.ok(request);
        assert.deepEqual(JSON.parse(intent.requestJson), request);
        assert.equal(intent.rawIdempotencyKey, request.input.idempotencyKey);
      }
      assert.deepEqual(f.effects(), baselineEffects);
      assert.deepEqual(f.wallet(), baselineWallet);
      assert.equal(f.countQuotes(), 0);
      f.assertNoSupplierExecution();
      const hydrated = await runWindow("hydrate", staged.requests);
      assert.notEqual(hydrated.pid, staged.pid);
      assert.deepEqual(hydrated.requests, staged.requests);
      assert.deepEqual(hydrated.hints, staged.hints);
      assert.ok(
        hydrated.hydrateResponseAt > 0 &&
          hydrated.hydrateResponseAt <= hydrated.moduleReadyObservedAt,
      );
      assert.deepEqual(hydrated.businessActionCounts, {
        projectCreates: 0,
        conceptCreates: 0,
        threadCreates: 0,
        generationSubmissions: 0,
        querySubmissions: 0,
        imageSelections: 0,
        recoveryStages: 0,
        installs: 0,
        selectionChanges: 0,
        otherMetadataWrites: 0,
      });
      assert.deepEqual(
        packagedRecoveryDatabaseFacts(f.databasePath),
        warm,
        "cold hydrate preserves every saved input, source pin, original key/CAS and prepared record",
      );
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
        join(outputDirectory, "native-packaged-recovery-app-proof.json"),
        JSON.stringify(
          {
            acceptance:
              "original packaged short-drama9 UI-saved inputs and Thread; authenticated fixture-client three prepared ACKs; physical restart and actual renderer UNKNOWN hydrate; nonexistent operation, no online execution, no successful image history or selection/S0 claim",
            staged,
            hydrated,
            operationId,
            originalDatabaseFacts: warm,
            baselineEffects,
            baselineWallet,
            quoteCount: f.countQuotes(),
            packaged: packaged.proof,
            source: packagedRecoveryIdentity,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    } catch (error) {
      failure = error;
    } finally {
      if (fixture) {
        if (retired) {
          try {
            await fixture.close();
          } catch (error) {
            failure =
              failure === undefined
                ? error
                : new AggregateError(
                    [failure, error],
                    "packaged_recovery_test_and_cleanup_failed",
                  );
          }
        } else
          failure = new AggregateError(
            [
              failure ?? new Error("packaged_recovery_failed"),
              new Error("packaged_recovery_owned_consumers_not_retired"),
            ],
            "packaged_recovery_fixture_retained",
          );
      }
    }
    if (failure !== undefined) throw failure;
  },
  240_000,
);
