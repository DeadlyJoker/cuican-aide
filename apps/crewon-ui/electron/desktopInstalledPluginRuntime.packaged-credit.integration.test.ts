import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build, stop } from "esbuild";
import { it } from "vitest";
import { extensionCanonicalJson } from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import { nativeTaskMainAuthorityTokens } from "../../control-api/src/desktop-installed-plugin-task-main.authorities.test-support.ts";
import { professionalProviderFixture } from "../../runtime-worker/src/installed-plugin-ui-business-execution.provider.test-support.ts";
import { createPluginCreditSettlementWorkerHttpFixture } from "../../runtime-worker/src/plugin-credit-settlement-worker-http.test-support.ts";
import { prepareNativePackagedReportApp } from "./desktopInstalledPluginRuntime.packaged-app.test-support.ts";
import { nativeTaskProcessFixture } from "./desktopInstalledPluginRuntime.tasks.process.test-support.ts";
import {
  packagedCreditFacts,
  runPackagedCreditWindow,
  type PackagedCreditCommand,
  type PackagedCreditFixture,
  type PackagedCreditReceipt,
} from "./desktopInstalledPluginRuntime.packaged-credit.test-support.ts";

const professionalDirectory =
  process.env.CREWON_TEST_PROFESSIONAL_PLUGIN_V1_DIR;
const kreaDirectory = process.env.CREWON_TEST_KREA_PLUGIN_DIR;
const evidenceDirectory =
  process.env.CREWON_PACKAGED_CREDIT_APP_EVIDENCE_DIRECTORY;
const subject = "Named packaged report with independent financial decision 18";
const expectedTranscriptText = `answer:professional:1.0.0:Actual Native activation comparison:${subject}`;
const bytesDigest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const recordDigest = (value: unknown) =>
  `sha256:${createHash("sha256").update(extensionCanonicalJson(value)).digest("hex")}`;

/** Actual original .app/UI report execution plus explicit independent financial HTTPS.
 * Identity/PDP, supplier, model, grant100, quote30 and decision18 are named test inputs.
 * No Run, admission, Tool, successful operation or financial finalization is seeded.
 * This does not prove Comfy, real consumer billing, enterprise API or online S0/E5. */
it.runIf(Boolean(professionalDirectory && kreaDirectory))(
  "original packaged UI report executes once and independent Worker HTTPS settles18; cold original App reads the same receipt and immutable decision without another financial decision or business execution",
  async () => {
    const supplierCleanups: Array<() => Promise<void>> = [];
    const supplier = await professionalProviderFixture({
      after: (cleanup) => supplierCleanups.push(cleanup),
    });
    let fixture: PackagedCreditFixture | undefined;
    let finance:
      | Awaited<
          ReturnType<typeof createPluginCreditSettlementWorkerHttpFixture>
        >
      | undefined;
    let consumersRetired = true;
    let failure: unknown;
    try {
      fixture = await nativeTaskProcessFixture(
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
      const f = fixture;
      const authority = f.metadata.namedReportExecution;
      assert.ok(authority);
      assert.deepEqual(await f.taskDirectories(), []);
      const initialEffects = f.effects(),
        initialWallet = f.wallet();
      assert.deepEqual(
        {
          available: initialWallet.availableCredits,
          reserved: initialWallet.reservedCredits,
          spent: initialWallet.spentCredits,
          granted: initialWallet.grantedCredits,
        },
        { available: "100", reserved: "0", spent: "0", granted: "100" },
      );
      assert.equal(f.countQuotes(), 0);
      assert.equal(supplier.requests().length, 0);
      assert.equal(
        await authority.authorizePolicy({
          action: "run:execute",
          resource: {
            kind: "run",
            tenantId: f.actor.tenantId,
            spaceId: f.actor.spaceId,
            threadId: "unbound-thread",
            runId: "unbound-run",
          },
        }),
        false,
      );
      finance = await createPluginCreditSettlementWorkerHttpFixture({
        directory: f.directory,
        scope: f.scope,
        requestAuditLimit: 4096,
      });
      const financial = finance;
      const financialPath = await financial.writeConfiguration(
        join(f.directory, "packaged-credit-financial.json"),
        {
          migrate: true,
          intervalMs: 50,
          timeoutMs: 5000,
          maxAuthorizationAgeMs: 10_000,
          maxRoundMs: 10_000,
          batchSize: 1,
        },
      );
      const financialConfiguration = financial.configuration({
        migrate: true,
        intervalMs: 50,
        timeoutMs: 5000,
        maxAuthorizationAgeMs: 10_000,
        maxRoundMs: 10_000,
        batchSize: 1,
      });
      assert.deepEqual(financialConfiguration.scope, f.scope);
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
              environmentVariable: "NAMED_PACKAGED_CREDIT_MODEL_KEY",
              encryptedSecret: null,
            },
          ],
        }),
        { mode: 0o600 },
      );
      const observerPath = join(
        packaged.observerDirectory,
        "packaged-credit-original-report-observer.cjs",
      );
      try {
        await build({
          entryPoints: [
            resolve(
              "electron/desktopInstalledPluginRuntime.packaged-report.native.test-support.ts",
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

      let observedCommand: PackagedCreditCommand | undefined;
      function originalCommand(): PackagedCreditCommand {
        const value = observedCommand;
        assert.ok(value, "packaged_credit_actual_UI_command_missing");
        return value;
      }
      async function bindActualRequest(
        value: unknown,
        checkpointDirectory: string,
      ) {
        assert.equal(
          observedCommand,
          undefined,
          "one_original_UI_report_request",
        );
        assert.ok(
          value !== null && typeof value === "object" && !Array.isArray(value),
        );
        assert.deepEqual(Object.keys(value).sort(), ["action", "input"]);
        const command = value as PackagedCreditCommand;
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
        const store = new SqliteRunStore(f.databasePath);
        try {
          const thread = await store.loadThread({
            ...f.actor,
            threadId: command.input.threadId,
          });
          assert.ok(thread, "original_UI_Thread_exists_before_report_dispatch");
          assert.equal(thread.revision, command.input.expectedThreadRevision);
        } finally {
          await store.close();
        }
        assert.deepEqual(
          f.effects(),
          initialEffects,
          "named_authority_does_not_seed_business_evidence",
        );
        assert.deepEqual(f.wallet(), initialWallet);
        assert.equal(
          financial.requests.filter(({ path }) => path === "/decide").length,
          0,
        );
        const currentAuthority = authority;
        assert.ok(currentAuthority, "original_named_report_authority_missing");
        currentAuthority.bindRequestKey(command.input.idempotencyKey);
        assert.throws(
          () => currentAuthority.bindRequestKey(command.input.idempotencyKey),
          /already_bound/u,
        );
        observedCommand = structuredClone(command);
        // This is a separate named server financial rule; UI supplies no amount or payer.
        financial.setDecision("settle18");
        await writeFile(
          join(checkpointDirectory, "report-request.continue"),
          "observed-original-request-authorized\n",
          { mode: 0o600, flag: "wx" },
        );
      }
      function environment() {
        const value = { ...process.env };
        for (const name of Object.keys(value))
          if (
            name.startsWith("CREWON_") ||
            name === "ELECTRON_RUN_AS_NODE" ||
            name === "ELECTRON_FORCE_IS_PACKAGED" ||
            name === "AICUICAN_API_KEY"
          )
            delete value[name];
        delete value.NODE_OPTIONS;
        assert.ok(f.metadata.workspaceDirectory);
        value.CREWON_DESKTOP_WORKSPACE_ROOT = f.metadata.workspaceDirectory;
        value.NAMED_PACKAGED_CREDIT_MODEL_KEY = f.metadata.provider.apiKey;
        for (const name of [
          "TEST_NATIVE_TASK_POLICY_TOKEN",
          "TEST_NATIVE_UI_POLICY_TOKEN",
          "TEST_NATIVE_PACKAGE_TOKEN",
          "TEST_NATIVE_QUOTE_TOKEN",
        ] as const)
          value[name] = nativeTaskMainAuthorityTokens[name];
        // Original explicit config capture projects these values to the actual Worker only.
        Object.assign(value, financial.environment);
        value.CREWON_PLUGIN_CREDIT_SETTLEMENT_CONFIG_PATH = financialPath;
        value.CREWON_WORKER_SCAN_INTERVAL_MS = "25";
        return value;
      }
      const run = (
        phase: "execute" | "reopen",
        receipt?: PackagedCreditReceipt,
      ) =>
        runPackagedCreditWindow({
          fixture: f,
          packaged,
          observerPath,
          outputDirectory,
          phase,
          subject,
          expectedTranscriptText,
          environment: environment(),
          ...(receipt ? { receipt } : {}),
          bindActualRequest,
          markRetired: (value) => {
            consumersRetired = value;
          },
        });
      const executed = await run("execute");
      const submitted = originalCommand();
      assert.equal(executed.receipt.disposition, "committed");
      assert.equal(executed.receipt.threadId, submitted.input.threadId);
      assert.equal(
        executed.receipt.threadRevision,
        submitted.input.expectedThreadRevision + 1,
      );
      const warm = await packagedCreditFacts(f, executed.receipt.runId);
      assert.equal(warm.run?.status, "completed");
      assert.equal(
        warm.operations.length,
        0,
        "report adapter has no Comfy external operation history",
      );
      assert.equal(warm.receipts.length, 1);
      assert.equal(warm.receipts[0]!.status, "completed");
      assert.equal(
        warm.receipts[0]!.executionId,
        supplier.reports()[0]?.executionId,
      );
      assert.ok(
        warm.messages.some(
          ({ role, content }) =>
            role === "assistant" && content === expectedTranscriptText,
        ),
      );
      assert.equal(
        warm.originalTurnReceipt.binding.runId,
        executed.receipt.runId,
      );
      assert.equal(
        warm.originalTurnReceipt.turn.messages[0]!.messageId,
        executed.receipt.messageId,
      );
      assert.equal(
        warm.binding.configurationRevision,
        executed.receipt.configurationRevision,
      );
      assert.equal(warm.credit.reservation.priceRevision, 17);
      assert.equal(warm.credit.reservation.quotedCredits, "30");
      assert.equal(
        warm.credit.reservation.scope.principalId,
        f.actor.principalId,
      );
      const decisions = financial.requests.filter(
        ({ path }) => path === "/decide",
      );
      assert.equal(
        decisions.length,
        1,
        "exactly_one_independent_actual_HTTP_financial_decision",
      );
      const request = decisions[0]!;
      assert.equal(request.responseOutcome, "settle18");
      const originalEvidence = request.evidence;
      assert.ok(originalEvidence);
      assert.equal(originalEvidence.readyToFinalize, true);
      assert.equal(
        originalEvidence.installedAdmissionDigest,
        recordDigest(warm.admission),
      );
      assert.deepEqual(originalEvidence.locator, {
        tenantId: f.actor.tenantId,
        runId: executed.receipt.runId,
      });
      assert.deepEqual(originalEvidence.scope, f.creditScope);
      assert.equal(originalEvidence.spaceId, f.scope.spaceId);
      assert.equal(originalEvidence.actorId, f.actor.actorId);
      assert.equal(originalEvidence.pluginId, "example.professional");
      assert.equal(originalEvidence.bindingDigest, warm.binding.bindingDigest);
      assert.equal(originalEvidence.quotedCredits, "30");
      assert.equal(originalEvidence.priceRevision, 17);
      assert.equal(originalEvidence.run.status, "completed");
      assert.equal(originalEvidence.run.revision, warm.run!.revision);
      assert.equal(originalEvidence.run.terminalAt, warm.run!.terminalAt);
      assert.equal(originalEvidence.operations.length, 0);
      assert.equal(originalEvidence.mutationReceipts.length, 1);
      assert.equal(originalEvidence.mutationReceipts[0]!.status, "completed");
      assert.ok(originalEvidence.workItems.length > 0);
      assert.ok(
        originalEvidence.workItems.every(
          ({ status }) => status === "completed",
        ),
      );
      assert.ok(originalEvidence.attempts.length > 0);
      assert.ok(
        originalEvidence.attempts.every(({ status }) => status !== "running"),
      );
      const finalized = warm.finalization;
      assert.ok(
        finalized,
        "original_Worker_must_commit_before_original_Main_exits",
      );
      assert.deepEqual(
        finalized.decision,
        request.response,
        "immutable_decision_equals_original_HTTPS_response_including_decisionId",
      );
      assert.equal(
        finalized.decision.evidenceDigest,
        originalEvidence.evidenceDigest,
      );
      assert.equal(finalized.decision.authorityId, financial.authorityId);
      assert.equal(
        finalized.decision.authorityRevision,
        financial.authorityRevision,
      );
      assert.deepEqual(finalized.decision.outcome, {
        kind: "settle",
        actualCredits: "18",
      });
      assert.equal(finalized.bindingDigest, originalEvidence.bindingDigest);
      assert.equal(finalized.admissionDigest, originalEvidence.admissionDigest);
      assert.deepEqual(finalized.reservation, warm.reservation);
      assert.equal(warm.reservation!.state, "settled");
      assert.equal(warm.reservation!.settledCredits, "18");
      assert.deepEqual(finalized.account, f.wallet());
      assert.deepEqual(
        {
          available: f.wallet().availableCredits,
          reserved: f.wallet().reservedCredits,
          spent: f.wallet().spentCredits,
          granted: f.wallet().grantedCredits,
        },
        { available: "82", reserved: "0", spent: "18", granted: "100" },
      );
      assert.equal(f.wallet().revision, initialWallet.revision + 2);
      assert.deepEqual(
        warm.ledgerEntries.map(({ kind, credits, reservationId }) => ({
          kind,
          credits,
          reservationId,
        })),
        [
          { kind: "grant", credits: "100", reservationId: null },
          {
            kind: "reserve",
            credits: "30",
            reservationId: executed.receipt.runId,
          },
          {
            kind: "settle",
            credits: "18",
            reservationId: executed.receipt.runId,
          },
        ],
      );
      assert.equal(
        warm.evidence!.readyToFinalize,
        false,
        "settled evidence is no longer a charge candidate",
      );
      assert.notEqual(
        warm.evidence!.evidenceDigest,
        originalEvidence.evidenceDigest,
        "current settled evidence is distinct from historical decision input",
      );
      assert.equal(f.countQuotes(), 1);
      assert.equal(f.metadata.model.requests.length, 2);
      assert.equal(
        supplier.requests().filter(({ method }) => method === "POST").length,
        1,
      );
      assert.equal(supplier.reports().length, 1);
      assert.equal(
        supplier.reports()[0]!.report,
        expectedTranscriptText.slice("answer:".length),
      );
      const afterExecution = {
        effects: f.effects(),
        wallet: f.wallet(),
        facts: warm,
      };
      const supplierRequestsAfterExecution = structuredClone(
        supplier.requests(),
      );
      assert.deepEqual(await f.taskDirectories(), []);
      authority.denyExecution();
      financial.setDecision("hold");
      const financialRequestsBeforeCold = financial.requests.length;
      const reopened = await run("reopen", executed.receipt);
      assert.notEqual(reopened.nativeProcessId, executed.nativeProcessId);
      assert.deepEqual(reopened.receipt, executed.receipt);
      assert.deepEqual(
        {
          effects: f.effects(),
          wallet: f.wallet(),
          facts: await packagedCreditFacts(f, executed.receipt.runId),
        },
        afterExecution,
        "cold original receipt, business facts and immutable financial decision remain exact",
      );
      const coldAuthorizations = financial.requests
        .slice(financialRequestsBeforeCold)
        .filter(({ path }) => path === "/authorize");
      // Explicit migrate:true: prepare authorizes three times, the first round
      // once, then Service fences before and after reading the existing decision.
      assert.ok(
        coldAuthorizations.length >= 6,
        "cold_actual_Worker_must_reach_existing_finalization_read",
      );
      assert.equal(
        financial.responseCompleted(coldAuthorizations[5]!.index),
        true,
        "actual_HTTPS_response_after_existing_finalization_read_completed",
      );
      assert.equal(
        financial.requests.filter(({ path }) => path === "/decide").length,
        1,
        "existing finalization needs no new amount decision",
      );
      assert.equal(f.countQuotes(), 1);
      assert.equal(f.metadata.model.requests.length, 2);
      assert.deepEqual(
        structuredClone(supplier.requests()),
        supplierRequestsAfterExecution,
        "cold_App_must_not_add_any_supplier_GET_POST_or_DELETE_request",
      );
      assert.equal(
        supplier.requests().filter(({ method }) => method === "POST").length,
        1,
      );
      assert.deepEqual(financial.failures, []);
      assert.deepEqual(await f.taskDirectories(), []);
      const children = [
        ...executed.runtimeChildren,
        ...reopened.runtimeChildren,
      ];
      assert.equal(
        children.filter(({ entry }) => entry.endsWith("/control-api.mjs"))
          .length,
        2,
      );
      assert.equal(
        children.filter(({ entry }) => entry.endsWith("/runtime-worker.mjs"))
          .length,
        2,
      );
      for (const child of children) {
        assert.equal(child.executable, packaged.executable);
        assert.ok(child.entry.startsWith(packaged.runtimeDirectory + "/"));
        assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
      }
      for (const file of [...packaged.compiledFiles, ...packaged.rendererFiles])
        assert.equal(bytesDigest(await readFile(file.path)), file.sha256);
      assert.equal(
        bytesDigest(await readFile(packaged.asarPath)),
        packaged.proof.asarSha256,
      );
      for (const file of packaged.packagedFiles)
        if (file.location === "runtime")
          assert.equal(
            bytesDigest(
              await readFile(join(packaged.runtimeDirectory, file.entry)),
            ),
            file.sha256,
          );
      await writeFile(
        join(outputDirectory, "native-packaged-credit-app-proof.json"),
        JSON.stringify(
          {
            acceptance:
              "original .app report UI/Worker/tool/transcript and independent HTTPS settlement; named identity/PDP/supplier/model/grant100/quote30/decision18, not real billing/Comfy/enterprise E5",
            executed,
            reopened,
            originalCommand: submitted,
            originalBusinessAndFinancialFacts: warm,
            originalReadyDecisionEvidence: originalEvidence,
            financialRequests: financial.requests,
            financialConfiguration,
            wallet: f.wallet(),
            quoteCount: f.countQuotes(),
            modelRequestCount: f.metadata.model.requests.length,
            supplierPostCount: 1,
            packagedApp: packaged.proof,
            compiledFiles: packaged.compiledFiles,
            rendererFiles: packaged.rendererFiles,
            physicalChildren: children,
            physicalChildrenClosed: true,
            productNetworkDnsTlsUnchanged: true,
            coldScope:
              "original persisted Thread transcript/module task status plus Store-read original task receipt and immutable financial decision; no report-v1 form recovery claim",
            comfyuiRequests: 0,
            onlineS0OrE5Claim: false,
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
    } catch (error) {
      failure = error;
      if (fixture)
        console.error(
          "packaged_credit_named_fixture_diagnostic",
          JSON.stringify({
            financialFailures: finance?.failures,
            financialRequests: finance?.requests.map(
              ({ path, responseOutcome, evidence }) => ({
                path,
                responseOutcome,
                runId: evidence?.locator.runId ?? null,
              }),
            ),
            authorityFailures: fixture.metadata.authorityFailures().slice(-4),
            decisions:
              fixture.metadata.namedReportExecution?.decisions.slice(-8),
          }),
        );
    } finally {
      const errors: unknown[] = failure === undefined ? [] : [failure];
      try {
        await finance?.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        if (consumersRetired) await fixture?.close();
        else
          throw new Error(
            "packaged_credit_owned_consumers_not_retired_private_root_retained",
          );
      } catch (error) {
        errors.push(error);
      }
      for (const cleanup of supplierCleanups.toReversed())
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      if (errors.length)
        throw new AggregateError(
          errors,
          "packaged_credit_test_and_physical_cleanup_failed",
        );
    }
  },
  420_000,
);
