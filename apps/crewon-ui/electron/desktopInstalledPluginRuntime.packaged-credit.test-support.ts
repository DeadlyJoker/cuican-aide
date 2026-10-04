import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { SqliteRunStore } from "@crewon/store";
import type { nativeTaskProcessFixture } from "./desktopInstalledPluginRuntime.tasks.process.test-support.ts";
import type { prepareNativePackagedReportApp } from "./desktopInstalledPluginRuntime.packaged-app.test-support.ts";
import {
  connectPackagedMainInspector,
  ownedPackagedInspectorPort,
} from "./desktopInstalledPluginRuntime.packaged-inspector.test-support.ts";
import { observePackagedRuntimeChildren } from "./desktopInstalledPluginRuntime.packaged-children.test-support.ts";
import { trackDesktopTestChildren } from "./desktopPluginTestChildren.test-support.ts";

export type PackagedCreditFixture = Awaited<
  ReturnType<typeof nativeTaskProcessFixture>
>;
export type PackagedCreditApp = Awaited<
  ReturnType<typeof prepareNativePackagedReportApp>
>;
export type PackagedCreditCommand = ReturnType<
  PackagedCreditFixture["command"]
>;
export type PackagedCreditReceipt = Readonly<{
  disposition: "committed" | "replayed";
  threadId: string;
  threadRevision: number;
  runId: string;
  messageId: string;
  configurationRevision: number;
}>;
export type PackagedCreditWindowProof = Readonly<{
  phase: "execute" | "reopen";
  nativeProcessId: number;
  formalDocument: string;
  receipt: PackagedCreditReceipt;
  settingsLabels: readonly string[];
  signedOutLocalManagement: true;
  rendererNodeElectronAbsent: true;
  localePreferenceChanged: false;
  reportRequests: number;
  transcript: Readonly<{ containsExpectedText: true; characters: number }>;
  sse: Readonly<{
    physicalMainFetch: true;
    status: 200;
    threadStreamCount: number;
  }>;
  module: Readonly<{
    pluginId: string;
    contributionId: string;
    version: string;
    completed: true;
  }>;
  [field: string]: unknown;
}>;

/** Original product entrypoint and original report observer. Financial configuration
 * is a named, explicit Worker deployment; neither launcher nor inspector settles. */
export async function runPackagedCreditWindow(
  input: Readonly<{
    fixture: PackagedCreditFixture;
    packaged: PackagedCreditApp;
    observerPath: string;
    outputDirectory: string;
    phase: "execute" | "reopen";
    subject: string;
    expectedTranscriptText: string;
    environment: NodeJS.ProcessEnv;
    receipt?: PackagedCreditReceipt;
    bindActualRequest(
      command: unknown,
      checkpointDirectory: string,
    ): Promise<void>;
    markRetired(retired: boolean): void;
  }>,
) {
  const { fixture, packaged, phase } = input;
  const countCatalogue = fixture.metadata.model.catalogRequests;
  assert.ok(countCatalogue);
  const catalogueBefore = countCatalogue();
  const checkpointDirectory = join(
    fixture.directory,
    `packaged-credit-${phase}-checkpoints`,
  );
  await mkdir(checkpointDirectory, { mode: 0o700 });
  const configuration = join(
    fixture.directory,
    `packaged-credit-${phase}.json`,
  );
  const document = pathToFileURL(
    join(packaged.asarPath, "dist/index.html"),
  ).href;
  await writeFile(
    configuration,
    JSON.stringify({
      main: pathToFileURL(packaged.main).href,
      executable: packaged.executable,
      resourcesPath: packaged.resourcesPath,
      appPath: packaged.asarPath,
      document,
      userData: fixture.directory,
      phase,
      subject: input.subject,
      expectedTranscriptText: input.expectedTranscriptText,
      screenshotDirectory: input.outputDirectory,
      checkpointDirectory,
      ...(input.receipt ? { receipt: input.receipt } : {}),
    }),
    { mode: 0o600 },
  );
  const port = await ownedPackagedInspectorPort();
  let inspector:
    | Awaited<ReturnType<typeof connectPackagedMainInspector>>
    | undefined;
  let runtime: ReturnType<typeof observePackagedRuntimeChildren> | undefined;
  let tracked: ReturnType<typeof trackDesktopTestChildren> | undefined;
  let child: ChildProcess | undefined;
  let completion: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let mainClosed = false,
    code: number | null = null;
  let output = "",
    lineBuffer = "";
  let spawnError: Error | undefined, primaryFailure: unknown;
  let checkpoint = Promise.resolve();
  let checkpointFailure: unknown;
  try {
    input.markRetired(false);
    child = spawn(
      packaged.executable,
      [`--user-data-dir=${fixture.directory}`, `--inspect=127.0.0.1:${port}`],
      { env: input.environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    tracked = trackDesktopTestChildren(child);
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
    child.stdout!.on("data", (bytes: Buffer) => {
      const text = bytes.toString();
      output = (output + text).slice(-128 * 1024);
      lineBuffer += text;
      if (lineBuffer.length > 256 * 1024) {
        checkpointFailure = new Error("packaged_credit_stdout_limit");
        lineBuffer = "";
        child?.kill("SIGTERM");
        return;
      }
      let end: number;
      while ((end = lineBuffer.indexOf("\n")) >= 0) {
        const line = lineBuffer.slice(0, end);
        lineBuffer = lineBuffer.slice(end + 1);
        const prefix = "CREWON_PACKAGED_REPORT_REQUEST:";
        if (line.startsWith(prefix))
          checkpoint = checkpoint
            .then(async () => {
              assert.equal(
                phase,
                "execute",
                "cold_window_must_not_dispatch_report",
              );
              await input.bindActualRequest(
                JSON.parse(line.slice(prefix.length)),
                checkpointDirectory,
              );
            })
            .catch((error: unknown) => {
              checkpointFailure = error;
              child?.kill("SIGTERM");
            });
      }
    });
    child.stderr!.on("data", (bytes: Buffer) => {
      output = (output + bytes.toString()).slice(-128 * 1024);
    });
    inspector = await connectPackagedMainInspector({ port, timeoutMs: 15_000 });
    const mainIdentity = await inspector.verifyMain({
      processId: child.pid!,
      executable: packaged.executable,
      resourcesPath: packaged.resourcesPath,
      userData: fixture.directory,
      appPath: packaged.asarPath,
      packageMain: "dist-electron/main.mjs",
    });
    await inspector.observeOriginalPackagedApp({
      observerPath: input.observerPath,
      configPath: configuration,
    });
    await inspector.close();
    inspector = undefined;
    await Promise.race([
      completion,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          child?.kill("SIGKILL");
          reject(new Error("packaged_credit_window_timeout:" + output));
        }, 110_000);
      }),
    ]);
    await checkpoint;
    if (checkpointFailure) throw checkpointFailure;
    if (spawnError) throw spawnError;
    assert.equal(code, 0, output);
    assert.equal(mainClosed, true);
    const matches = [
      ...output.matchAll(/^CREWON_PACKAGED_REPORT_APP_PROOF:(.+)$/gmu),
    ];
    assert.equal(matches.length, 1, output);
    const proof = JSON.parse(matches[0]![1]!) as PackagedCreditWindowProof;
    assert.equal(proof.phase, phase);
    assert.equal(proof.nativeProcessId, child.pid);
    assert.equal(proof.formalDocument, document);
    assert.equal(proof.signedOutLocalManagement, true);
    assert.equal(proof.rendererNodeElectronAbsent, true);
    assert.equal(proof.localePreferenceChanged, false);
    assert.equal(proof.settingsLabels.length, 10);
    assert.equal(proof.reportRequests, phase === "execute" ? 1 : 0);
    assert.equal(proof.transcript.containsExpectedText, true);
    assert.equal(proof.sse.physicalMainFetch, true);
    assert.equal(proof.sse.status, 200);
    assert.ok(proof.sse.threadStreamCount > 0);
    assert.deepEqual(proof.module, {
      pluginId: "example.professional",
      contributionId: "studio",
      version: "1.0.0",
      completed: true,
    });
    const runtimeChildren = await runtime.close();
    assert.ok(
      runtimeChildren.some(({ entry }) => entry.endsWith("/control-api.mjs")),
    );
    assert.ok(
      runtimeChildren.some(({ entry }) =>
        entry.endsWith("/runtime-worker.mjs"),
      ),
    );
    const modelCatalogueRequests = countCatalogue() - catalogueBefore;
    assert.ok(modelCatalogueRequests > 0);
    return { ...proof, mainIdentity, runtimeChildren, modelCatalogueRequests };
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    const cleanupErrors: unknown[] = [];
    try {
      await inspector?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (child && !mainClosed) child.kill("SIGKILL");
    try {
      await completion;
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await runtime?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await checkpoint;
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (tracked) {
        const forced = await tracked.close();
        input.markRetired(true);
        assert.deepEqual(
          forced,
          [],
          "original_Main_must_physically_join_actual_children",
        );
      } else if (!child?.pid) input.markRetired(true);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (!mainClosed)
      cleanupErrors.push(new Error("packaged_credit_Main_not_closed"));
    if (cleanupErrors.length)
      throw new AggregateError(
        [
          ...(primaryFailure === undefined ? [] : [primaryFailure]),
          ...cleanupErrors,
        ],
        "packaged_credit_window_and_cleanup_failed",
      );
  }
}

/** Only reads original owners and immutable rows, without seeding or settling anything. */
export async function packagedCreditFacts(
  fixture: PackagedCreditFixture,
  runId: string,
) {
  const store = new SqliteRunStore(fixture.databasePath);
  const locator = { ...fixture.actor, runId };
  try {
    const binding = await store
      .extensionStore()
      .loadExtensionRunBinding(locator);
    assert.ok(binding);
    const admission = await store
      .extensionStore()
      .loadPluginTaskAdmission(locator);
    assert.ok(admission);
    assert.equal(admission.schemaVersion, "crewon.plugin-task-admission.v1");
    assert.equal(admission.profileId, fixture.scope.profileId);
    assert.equal(admission.packageDigest, fixture.source.packageDigest);
    assert.equal(admission.publisherId, fixture.source.publisherId);
    assert.equal(admission.selectionRevision, 2);
    assert.equal(admission.action, "report.generate");
    const credit = await store
      .extensionStore()
      .loadExtensionCreditAdmission(binding);
    assert.ok(credit);
    const originalTurnReceipt = await store
      .extensionStore()
      .loadExtensionTurnReceipt({
        ...binding,
        receipt: {
          actorId: admission.actorId,
          idempotencyKey: admission.idempotencyKey,
          requestDigest: admission.requestDigest,
        },
      });
    assert.ok(originalTurnReceipt);
    assert.deepEqual(originalTurnReceipt.creditAdmission, credit);
    const operations = await store
      .externalOperationStore()
      .listExternalOperations({
        tenantId: fixture.actor.tenantId,
        runId,
        bindingDigest: binding.bindingDigest,
        limit: 16,
      });
    assert.equal(operations.truncated, false);
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    function rows(table: string) {
      const result = database
        .prepare(
          `SELECT * FROM main.${table} WHERE tenant_id=? AND run_id=? LIMIT 65`,
        )
        .all(fixture.actor.tenantId, runId);
      assert.ok(result.length <= 64);
      return result.map((row) => JSON.stringify(row)).sort();
    }
    let originalRows: Record<string, string[]>;
    let receipts: Array<{ status: string; executionId: string }>;
    try {
      const marker = database
        .prepare("SELECT * FROM main.plugin_task_admission_schema_version")
        .all();
      assert.deepEqual(
        marker.map((row) => ({ ...row })),
        [{ id: 1, version: 1 }],
      );
      originalRows = Object.fromEntries(
        [
          "run_snapshots",
          "run_events",
          "work_items",
          "run_steps",
          "run_attempts",
          "tool_execution_receipts",
          "extension_run_bindings",
          "plugin_task_admissions",
          "extension_credit_admissions",
          "plugin_credit_settlement_finalizations",
        ].map((table) => [table, rows(table)]),
      );
      receipts = database
        .prepare(
          "SELECT state_json FROM main.tool_execution_receipts WHERE tenant_id=? AND run_id=? ORDER BY receipt_id LIMIT 17",
        )
        .all(fixture.actor.tenantId, runId)
        .map(({ state_json }) => JSON.parse(String(state_json)));
      assert.ok(receipts.length <= 16);
    } finally {
      database.close();
    }
    return {
      run: await store.loadRunInSpace(locator),
      binding,
      admission,
      credit,
      originalTurnReceipt,
      messages: await store.listMessages(binding, 0, 128),
      operations: operations.operations,
      receipts,
      originalRows,
      ledgerEntries: await store.pluginCreditStore().listEntries({
        scope: fixture.creditScope,
        afterRevision: 0,
        limit: 64,
      }),
      evidence: await store
        .pluginCreditSettlementStore()
        .loadEvidence({ tenantId: locator.tenantId, runId }),
      finalization: await store
        .pluginCreditSettlementStore()
        .getFinalization({ tenantId: locator.tenantId, runId }),
      reservation: await store.pluginCreditStore().getReservation({
        scope: credit.reservation.scope,
        reservationId: credit.reservation.reservationId,
      }),
    };
  } finally {
    await store.close();
  }
}
