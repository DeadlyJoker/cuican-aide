import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { it } from "vitest";
import { SqliteRunStore } from "@crewon/store";
import { nativeTaskMainAuthorityTokens } from "../../control-api/src/desktop-installed-plugin-task-main.authorities.test-support.ts";
import { professionalProviderFixture } from "../../runtime-worker/src/installed-plugin-ui-business-execution.provider.test-support.ts";
import { prepareNativeCompiledReportApp } from "./desktopInstalledPluginRuntime.compiled-app.test-support.ts";
import { nativeTaskProcessFixture } from "./desktopInstalledPluginRuntime.tasks.process.test-support.ts";
import { trackDesktopTestChildren } from "./desktopPluginTestChildren.test-support.ts";

const professionalDirectory =
  process.env.CREWON_TEST_PROFESSIONAL_PLUGIN_V1_DIR;
const kreaDirectory = process.env.CREWON_TEST_KREA_PLUGIN_DIR;
const evidenceDirectory =
  process.env.CREWON_COMPILED_REPORT_APP_EVIDENCE_DIRECTORY;
const subject = "Named compiled Native window report execution";
const expectedTranscriptText = `answer:professional:1.0.0:Actual Native activation comparison:${subject}`;
type Fixture = Awaited<ReturnType<typeof nativeTaskProcessFixture>>;
type Command = ReturnType<Fixture["command"]>;
type Receipt = Readonly<{
  disposition: "committed" | "replayed";
  threadId: string;
  threadRevision: number;
  runId: string;
  messageId: string;
  configurationRevision: number;
}>;
type AppProof = Readonly<{
  phase: "execute" | "reopen";
  nativeProcessId: number;
  formalDocument: string;
  receipt: Receipt;
  [field: string]: unknown;
}>;
const taskTokenNames = [
  "TEST_NATIVE_TASK_POLICY_TOKEN",
  "TEST_NATIVE_UI_POLICY_TOKEN",
  "TEST_NATIVE_PACKAGE_TOKEN",
  "TEST_NATIVE_QUOTE_TOKEN",
] as const;
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Actual compiled formal Main/preload/window/App and compiled runtime children.
 * Paid authority, model, supplier and 100/30 credits remain named test boundaries.
 * Frozen renderer, SDK and independently retained plugin bytes are unchanged. */
it.runIf(Boolean(professionalDirectory && kreaDirectory))(
  "compiled original Native window submits an installed report through its actual UI and shows the completed task again after a physical cold restart",
  async () => {
    const supplierCleanup: Array<() => Promise<void>> = [];
    const supplier = await professionalProviderFixture({
      after: (cleanup) => supplierCleanup.push(cleanup),
    });
    let f: Fixture | undefined;
    let failure: unknown;
    try {
      f = await nativeTaskProcessFixture(
        {
          professionalDirectory: professionalDirectory!,
          kreaDirectory: kreaDirectory!,
        },
        {
          storageLayout: "formal-electron-user-data",
          workspaceLayout: "empty-private",
          reportModelCatalog: { modelId: "named-native-process-model" },
          installedReportExecution: {
            idempotencyKey: null,
            providerBaseUrl: `${supplier.baseUrl}/`,
            subject,
          },
        },
      );
      const fixture = f;
      const configuredAuthority = fixture.metadata.namedReportExecution;
      assert.ok(configuredAuthority);
      const authority = configuredAuthority;
      const catalogRequests = fixture.metadata.model.catalogRequests;
      assert.ok(catalogRequests);
      const countCatalogRequests = catalogRequests;
      assert.equal(
        fixture.dataDirectory,
        join(fixture.directory, "control-runtime-v1"),
      );
      assert.deepEqual(await fixture.taskDirectories(), []);
      assert.equal(
        await authority.authorizePolicy({
          action: "run:execute",
          resource: {
            kind: "run",
            ...fixture.actor,
            threadId: "unbound-thread",
            runId: "unbound-run",
          },
        }),
        false,
      );
      const compiled = await prepareNativeCompiledReportApp({
        directory: fixture.directory,
        repositoryRoot: await realpath(resolve("../..")),
        rendererDirectory: await realpath(resolve("dist")),
      });
      const outputDirectory = evidenceDirectory
        ? resolve(evidenceDirectory)
        : join(fixture.directory, "evidence");
      await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
      await writeFile(
        fixture.fixedPath,
        JSON.stringify(fixture.configuration),
        { mode: 0o600 },
      );
      await writeFile(
        join(fixture.dataDirectory, "provider-credentials.json"),
        JSON.stringify({
          schemaVersion: "crewon.provider-credentials.v1",
          activeProviderId: fixture.metadata.provider.providerId,
          bindings: [
            {
              providerId: fixture.metadata.provider.providerId,
              endpoint: fixture.metadata.provider.endpoint,
              modelId: fixture.metadata.provider.modelId,
              credentialKind: "environment",
              environmentVariable: "NAMED_COMPILED_REPORT_MODEL_KEY",
              encryptedSecret: null,
            },
          ],
        }),
        { mode: 0o600 },
      );
      const launcher = join(
        compiled.launcherDirectory,
        "compiled-report-launcher.mjs",
      );
      try {
        await build({
          entryPoints: [
            resolve(
              "electron/desktopInstalledPluginRuntime.compiled-report.native.test-support.ts",
            ),
          ],
          outfile: launcher,
          bundle: true,
          platform: "node",
          format: "esm",
          target: "node24",
          external: ["electron"],
          legalComments: "none",
          logLevel: "silent",
        });
      } finally {
        await stop();
      }
      const initialEffects = fixture.effects();
      assert.equal(fixture.countQuotes(), 0);
      assert.equal(supplier.requests().length, 0);
      let observedCommand: Command | undefined;
      async function bindActualRequest(
        value: unknown,
        checkpointDirectory: string,
      ) {
        assert.equal(
          observedCommand,
          undefined,
          "compiled_report_only_one_explicit_UI_request",
        );
        const command = value as Command;
        assert.ok(command && typeof command === "object");
        assert.deepEqual(Object.keys(command).sort(), ["action", "input"]);
        assert.equal(command.action, "report.generate");
        assert.deepEqual(Object.keys(command.input).sort(), [
          "expectedThreadRevision",
          "idempotencyKey",
          "input",
          "threadId",
        ]);
        assert.deepEqual(command.input.input, { subject });
        assert.ok(
          typeof command.input.threadId === "string" &&
            command.input.threadId.length > 0,
        );
        assert.ok(
          typeof command.input.idempotencyKey === "string" &&
            command.input.idempotencyKey.length > 0,
        );
        assert.ok(Number.isSafeInteger(command.input.expectedThreadRevision));
        const store = new SqliteRunStore(fixture.databasePath);
        try {
          const thread = await store.loadThread({
            ...fixture.actor,
            threadId: command.input.threadId,
          });
          assert.ok(
            thread,
            "actual_UI_createThread_must_exist_before_report_dispatch",
          );
          assert.equal(thread.revision, command.input.expectedThreadRevision);
        } finally {
          await store.close();
        }
        assert.deepEqual(
          fixture.effects(),
          initialEffects,
          "UI request not admitted before named authority binding",
        );
        authority.bindRequestKey(command.input.idempotencyKey);
        assert.throws(
          () => authority.bindRequestKey(command.input.idempotencyKey),
          /already_bound/u,
        );
        observedCommand = structuredClone(command);
        await writeFile(
          join(checkpointDirectory, "report-request.continue"),
          "observed-original-request-authorized\n",
          { mode: 0o600, flag: "wx" },
        );
      }
      const run = async (phase: "execute" | "reopen", receipt?: Receipt) => {
        const catalogRequestsBefore = countCatalogRequests();
        const checkpointDirectory = join(
          fixture.directory,
          `compiled-${phase}-checkpoints`,
        );
        await mkdir(checkpointDirectory, { mode: 0o700 });
        const configuration = join(fixture.directory, `compiled-${phase}.json`);
        await writeFile(
          configuration,
          JSON.stringify({
            main: pathToFileURL(compiled.main).href,
            document: pathToFileURL(
              join(compiled.repositoryRoot, "apps/crewon-ui/dist/index.html"),
            ).href,
            userData: fixture.directory,
            phase,
            subject,
            expectedTranscriptText,
            screenshotDirectory: outputDirectory,
            checkpointDirectory,
            ...(receipt ? { receipt } : {}),
          }),
          { mode: 0o600 },
        );
        const environment = { ...process.env };
        for (const name of Object.keys(environment))
          if (
            name.startsWith("CREWON_") ||
            name === "ELECTRON_RUN_AS_NODE" ||
            name === "AICUICAN_API_KEY"
          )
            delete environment[name];
        environment.CREWON_REPOSITORY_ROOT = compiled.repositoryRoot;
        assert.ok(fixture.metadata.workspaceDirectory);
        environment.CREWON_DESKTOP_WORKSPACE_ROOT =
          fixture.metadata.workspaceDirectory;
        environment.NAMED_COMPILED_REPORT_MODEL_KEY =
          fixture.metadata.provider.apiKey;
        for (const name of taskTokenNames)
          environment[name] = nativeTaskMainAuthorityTokens[name];
        let child: ChildProcess | undefined;
        let tracked: ReturnType<typeof trackDesktopTestChildren> | undefined;
        let completion: Promise<void> | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let code: number | null = null;
        let spawnError: Error | undefined;
        let output = "",
          lineBuffer = "";
        let checkpoint: Promise<void> = Promise.resolve();
        let checkpointFailure: unknown;
        let mainClosed = false;
        try {
          child = spawn(
            createRequire(import.meta.url)("electron"),
            [launcher, configuration],
            { env: environment, stdio: ["ignore", "pipe", "pipe"] },
          );
          tracked = trackDesktopTestChildren(child);
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
          child.stdout!.on("data", (bytes: Buffer) => {
            output = (output + bytes.toString()).slice(-64 * 1024);
            lineBuffer += bytes.toString();
            if (lineBuffer.length > 256 * 1024) {
              checkpointFailure = new Error("compiled_report_stdout_limit");
              lineBuffer = "";
              child?.kill("SIGTERM");
              return;
            }
            let end: number;
            while ((end = lineBuffer.indexOf("\n")) >= 0) {
              const line = lineBuffer.slice(0, end);
              lineBuffer = lineBuffer.slice(end + 1);
              const prefix = "CREWON_COMPILED_REPORT_REQUEST:";
              if (line.startsWith(prefix))
                checkpoint = checkpoint
                  .then(async () => {
                    assert.equal(phase, "execute");
                    await bindActualRequest(
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
            output = (output + bytes.toString()).slice(-64 * 1024);
          });
          await Promise.race([
            completion,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                child?.kill("SIGKILL");
                reject(new Error("compiled_report_window_timeout:" + output));
              }, 100_000);
            }),
          ]);
          await checkpoint;
          if (checkpointFailure) throw checkpointFailure;
          if (spawnError) throw spawnError;
          assert.equal(code, 0, output);
          assert.equal(mainClosed, true);
          const match = /^CREWON_COMPILED_REPORT_APP_PROOF:(.+)$/mu.exec(
            output,
          );
          assert.ok(match, output);
          const proof = JSON.parse(match[1]!) as AppProof;
          assert.equal(proof.phase, phase);
          assert.equal(proof.nativeProcessId, child.pid);
          assert.equal(
            new URL(proof.formalDocument).pathname,
            join(compiled.repositoryRoot, "apps/crewon-ui/dist/index.html"),
          );
          const modelCatalogRequests =
            countCatalogRequests() - catalogRequestsBefore;
          assert.ok(
            modelCatalogRequests > 0,
            `original_Main_model_catalog_probe:${phase}`,
          );
          return { ...proof, modelCatalogRequests };
        } finally {
          if (timer) clearTimeout(timer);
          if (child && !mainClosed) child.kill("SIGKILL");
          if (completion) await completion;
          await checkpoint;
          if (tracked)
            assert.deepEqual(
              await tracked.close(),
              [],
              "original Main shutdown must physically join all actual runtime children",
            );
          assert.equal(
            mainClosed,
            true,
            "Main and its stdout/stderr must physically close",
          );
        }
      };
      const executed = await run("execute");
      assert.ok(observedCommand);
      assert.equal(executed.receipt.disposition, "committed");
      assert.equal(executed.receipt.threadId, observedCommand.input.threadId);
      assert.equal(fixture.countQuotes(), 1);
      assert.equal(fixture.metadata.model.requests.length, 2);
      assert.equal(
        supplier.requests().filter(({ method }) => method === "POST").length,
        1,
      );
      assert.equal(supplier.reports().length, 1);
      assert.equal(
        supplier.reports()[0]!.report,
        expectedTranscriptText.slice("answer:".length),
      );
      const terminal = await facts(fixture, executed.receipt.runId);
      assert.equal(terminal.run?.status, "completed");
      assert.equal(terminal.operations.length, 0);
      assert.equal(terminal.receipts.length, 1);
      assert.equal(terminal.receipts[0]!.status, "completed");
      assert.equal(
        terminal.receipts[0]!.executionId,
        supplier.reports()[0]!.executionId,
      );
      assert.ok(
        terminal.messages.some(
          ({ role, content }) =>
            role === "assistant" && content === expectedTranscriptText,
        ),
      );
      const completedWallet = fixture.wallet();
      assert.equal(completedWallet.availableCredits, "70");
      assert.equal(completedWallet.reservedCredits, "30");
      assert.equal(
        completedWallet.spentCredits,
        "0",
        "actual execution is not settlement",
      );
      const afterExecution = {
        effects: fixture.effects(),
        wallet: fixture.wallet(),
        facts: terminal,
      };
      assert.deepEqual(await fixture.taskDirectories(), []);
      authority.denyExecution();
      const reopened = await run("reopen", executed.receipt);
      assert.notEqual(reopened.nativeProcessId, executed.nativeProcessId);
      assert.deepEqual(reopened.receipt, executed.receipt);
      assert.deepEqual(
        {
          effects: fixture.effects(),
          wallet: fixture.wallet(),
          facts: await facts(fixture, executed.receipt.runId),
        },
        afterExecution,
      );
      assert.equal(fixture.countQuotes(), 1);
      assert.equal(fixture.metadata.model.requests.length, 2);
      assert.equal(
        supplier.requests().filter(({ method }) => method === "POST").length,
        1,
      );
      assert.ok(
        catalogRequests() >= 2,
        "both compiled Main startups use the original model catalogue child",
      );
      assert.deepEqual(await fixture.taskDirectories(), []);
      const children = (await fixture.metadata.observations()).filter(
        ({ entry }) => entry.startsWith(compiled.repositoryRoot),
      );
      const controls = children.filter(({ entry }) =>
        entry.endsWith("/control-api/src/main.ts"),
      );
      const workers = children.filter(({ entry }) =>
        entry.endsWith("/runtime-worker/src/main.ts"),
      );
      assert.equal(controls.length, 2);
      assert.equal(workers.length, 2);
      const imports = await fixture.metadata.installedImports();
      // Execution needs both the actual Control action and Worker factory.
      // Cold UI history reads do not invoke that action again.
      for (const child of [controls[0]!, workers[0]!])
        assert.ok(
          imports.some(
            ({ pid, url }) => pid === child.pid && url.includes("/node.mjs"),
          ),
          "actual compiled runtime loads the original installed Node bytes",
        );
      for (const child of children)
        assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
      for (const file of compiled.compiledFiles)
        assert.equal(digest(await readFile(file.path)), file.sha256);
      for (const file of compiled.rendererFiles)
        assert.equal(digest(await readFile(file.path)), file.sha256);
      const evidence = {
        acceptance:
          "actual compiled formal Native Main/preload/window/full App with compiled runtime children; not packaged .app or Krea/Comfy",
        executed,
        reopened,
        compiledFiles: compiled.compiledFiles,
        rendererFiles: compiled.rendererFiles,
        observedOriginalCommand: observedCommand,
        completedRunId: executed.receipt.runId,
        actualToolReceipt: terminal.receipts[0],
        wallet: fixture.wallet(),
        quoteCount: fixture.countQuotes(),
        modelRequestCount: fixture.metadata.model.requests.length,
        catalogRequestCount: catalogRequests(),
        supplierPostCount: 1,
        physicalChildren: children.map(({ pid, entry }) => ({ pid, entry })),
        installedNodeImports: imports.map(({ pid, url }) => ({
          pid,
          path: new URL(url).pathname,
        })),
        namedIdentityPolicyFundingPriceModelAndSupplier: true,
        spentCredits: "0",
        coldScope:
          "original persisted Thread transcript and module completed Run status; no report v1 form/receipt recovery claim",
        productNetworkDnsTlsUnchanged: true,
        comfyuiRequests: 0,
      };
      await writeFile(
        join(outputDirectory, "native-compiled-report-app-proof.json"),
        JSON.stringify(evidence, null, 2) + "\n",
        { mode: 0o600 },
      );
      console.log(
        "Compiled Native report proof:",
        JSON.stringify({
          executedPid: executed.nativeProcessId,
          reopenedPid: reopened.nativeProcessId,
          runId: executed.receipt.runId,
          modelRequests: 2,
          supplierPosts: 1,
          quoteCount: 1,
          physicalChildrenClosed: true,
          evidenceDirectory: outputDirectory,
        }),
      );
    } catch (error) {
      failure = error;
      if (f)
        console.error(
          "compiled_report_authority_diagnostic",
          JSON.stringify({
            failures: f.metadata.authorityFailures().slice(-4),
            decisions: f.metadata.namedReportExecution?.decisions.slice(-8),
            logs: f.metadata.logs.join("").slice(-8000),
          }),
        );
      throw error;
    } finally {
      const errors: unknown[] = failure === undefined ? [] : [failure];
      try {
        await f?.close();
      } catch (error) {
        errors.push(error);
      }
      for (const cleanup of supplierCleanup.toReversed())
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      if (errors.length)
        throw new AggregateError(
          errors,
          "compiled_report_window_and_cleanup_failed",
        );
    }
  },
  300_000,
);

async function facts(f: Fixture, runId: string) {
  const store = new SqliteRunStore(f.databasePath);
  const locator = { ...f.actor, runId };
  try {
    const binding = await store
      .extensionStore()
      .loadExtensionRunBinding(locator);
    assert.ok(binding);
    const operations = await store
      .externalOperationStore()
      .listExternalOperations({
        tenantId: f.actor.tenantId,
        runId,
        bindingDigest: binding.bindingDigest,
        limit: 16,
      });
    assert.equal(operations.truncated, false);
    const database = new DatabaseSync(f.databasePath, { readOnly: true });
    let receipts: Array<{ status: string; executionId: string }>;
    try {
      const rows = database
        .prepare(
          "SELECT state_json FROM tool_execution_receipts WHERE tenant_id=? AND run_id=? ORDER BY receipt_id LIMIT 17",
        )
        .all(f.actor.tenantId, runId);
      assert.ok(rows.length <= 16);
      receipts = rows.map(({ state_json }) => JSON.parse(String(state_json)));
    } finally {
      database.close();
    }
    return {
      run: await store.loadRunInSpace(locator),
      binding,
      admission: await store.extensionStore().loadPluginTaskAdmission(locator),
      credit: await store
        .extensionStore()
        .loadExtensionCreditAdmission(binding),
      messages: await store.listMessages(binding, 0, 128),
      operations: operations.operations,
      receipts,
    };
  } finally {
    await store.close();
  }
}
