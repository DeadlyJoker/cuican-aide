import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { it } from "vitest";
import {
  ControlApiClient,
  ControlApiClientError,
  streamRunEvents,
} from "@crewon/control-client";
import { SqliteRunStore } from "@crewon/store";
import { professionalProviderFixture } from "../../runtime-worker/src/installed-plugin-ui-business-execution.provider.test-support.ts";
import { nativeTaskProcessFixture } from "./desktopInstalledPluginRuntime.tasks.process.test-support.ts";

const professionalDirectory =
  process.env.CREWON_TEST_PROFESSIONAL_PLUGIN_V1_DIR;
const kreaDirectory = process.env.CREWON_TEST_KREA_PLUGIN_DIR;
const enabled =
  professionalDirectory !== undefined && kreaDirectory !== undefined;
const requestKey = "named-native-report-actual-execution-original-key";
const subject = "Named actual Native Worker report execution";
type Fixture = Awaited<ReturnType<typeof nativeTaskProcessFixture>>;
type Live = Awaited<ReturnType<Fixture["start"]>>;
type Receipt = Readonly<{
  disposition: "committed" | "replayed";
  threadId: string;
  threadRevision: number;
  runId: string;
  messageId: string;
  configurationRevision: number;
}>;
function receipt(value: unknown): Receipt {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  const result = value as Receipt;
  assert.deepEqual(Object.keys(result).sort(), [
    "configurationRevision",
    "disposition",
    "messageId",
    "runId",
    "threadId",
    "threadRevision",
  ]);
  assert.ok(
    result.disposition === "committed" || result.disposition === "replayed",
  );
  for (const field of ["messageId", "runId", "threadId"] as const)
    assert.ok(typeof result[field] === "string" && result[field].length > 0);
  assert.ok(Number.isSafeInteger(result.threadRevision));
  assert.ok(Number.isSafeInteger(result.configurationRevision));
  return result;
}
const denied = (status: number) => (error: unknown) =>
  error instanceof ControlApiClientError && error.status === status;

/** Actual source Supervisor/release/Worker/Main/SQLite/HTTPS model and HTTP report
 * transport. Identity, policy, 100/30 personal credits and supplier are named
 * fixtures. No transport is replaced; no Run/admission/tool/supplier rows are seeded.
 * This does not prove Comfy, real funds/settlement, a renderer or packaged App. */
it.runIf(enabled)(
  "actual Native source Worker executes one explicitly authorized installed report, streams its persisted tool result and preserves the original receipt after cold restart",
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
          installedReportExecution: {
            idempotencyKey: requestKey,
            providerBaseUrl: `${supplier.baseUrl}/`,
            subject,
          },
        },
      );
      const first = await f.start();
      assert.ok(first.task && f.metadata.namedReportExecution);
      assert.equal(f.configuration.workerAuthorities.networkAuthority, null);
      const created = await first.client.createThread(
        { title: "Named Native report execution" },
        "named-native-report-execution-create-thread",
      );
      const command = f.command({
        threadId: created.thread.threadId,
        expectedThreadRevision: created.thread.revision,
        idempotencyKey: requestKey,
        subject,
      });
      const mount1 = await first.mount();
      const before = f.effects();
      assert.equal(supplier.requests().length, 0);
      assert.equal(f.metadata.model.requests.length, 0);
      assert.equal(f.countQuotes(), 0);
      const committed = receipt(
        (await first.client.plugins.invoke(mount1.mountRef, command)).output,
      );
      assert.equal(committed.disposition, "committed");
      const completed = await f.waitTaskStable(first, committed.runId);
      assert.equal(completed.task.runStatus, "completed");
      for (const table of [
        "run_snapshots",
        "extension_run_bindings",
        "plugin_task_admissions",
        "extension_credit_admissions",
        "plugin_credit_reservations",
      ] as const)
        assert.equal(completed.effects[table], before[table] + 1, table);
      assert.equal(f.countQuotes(), 1);
      assert.equal(completed.wallet.availableCredits, "70");
      assert.equal(completed.wallet.reservedCredits, "30");
      assert.equal(
        completed.wallet.spentCredits,
        "0",
        "execution is not settlement",
      );
      const reports = supplier.reports();
      assert.equal(reports.length, 1);
      assert.equal(reports[0]!.pluginVersion, "1.0.0");
      assert.equal(
        reports[0]!.report,
        `professional:1.0.0:Actual Native activation comparison:${subject}`,
      );
      const posts = supplier
        .requests()
        .filter(({ method }) => method === "POST");
      assert.equal(posts.length, 1);
      assert.equal(posts[0]!.executionId, reports[0]!.executionId);
      assert.equal(JSON.parse(posts[0]!.body!).subject, subject);
      assert.equal(f.metadata.model.requests.length, 2);
      assert.equal(f.metadata.model.supplierRequests(), 0);
      assert.equal(f.metadata.supplierRequests(), 0);
      assert.equal(f.metadata.modelRequests(), 0);
      const imports = await f.metadata.installedImports();
      assert.ok(
        imports.some(
          ({ pid, url }) =>
            pid === first.workerPid && url.includes("/node.mjs"),
        ),
      );
      assert.ok(
        imports.some(
          ({ pid, url }) =>
            pid === first.controlPid && url.includes("/node.mjs"),
        ),
      );
      const importingChildren = (await f.metadata.observations()).filter(
        ({ entry }) =>
          entry.endsWith("/control-api/src/main.ts") ||
          entry.endsWith("/runtime-worker/src/main.ts"),
      );
      assert.ok(
        imports.every(({ pid }) =>
          importingChildren.some((child) => child.pid === pid),
        ),
        "only actual owned Main/Worker children import the installed Node package",
      );

      const terminal = await reportFacts(f, committed.runId);
      assert.equal(terminal.run?.status, "completed");
      assert.equal(terminal.receipts.length, 1);
      assert.equal(terminal.receipts[0]!.status, "completed");
      assert.equal(terminal.receipts[0]!.executionId, reports[0]!.executionId);
      assert.equal(
        terminal.operations.length,
        0,
        "this retained report uses ToolExecutionReceipt, not the Comfy operation store",
      );
      assert.ok(
        terminal.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.content === `answer:${reports[0]!.report}`,
        ),
      );
      const events = await reportEvents(first, committed.runId);
      assert.ok(events.some(({ type }) => type === "tool.requested"));
      assert.ok(events.some(({ type }) => type === "tool.completed"));
      assert.ok(events.some(({ type }) => type === "run.completed"));
      assert.equal(
        events
          .flatMap((event) =>
            event.type === "model.output.delta" ? [event.data.delta] : [],
          )
          .join(""),
        `answer:${reports[0]!.report}`,
      );
      const firstDelta = events.find(
        ({ type }) => type === "model.output.delta",
      );
      assert.ok(firstDelta);
      const resumed = await reportEvents(
        first,
        committed.runId,
        firstDelta.sequence,
      );
      assert.ok(
        resumed.every(({ sequence }) => sequence > firstDelta.sequence),
      );
      assert.ok(resumed.some(({ type }) => type === "run.completed"));

      // Another explicitly submitted key is not covered by this named Worker grant.
      const thread = (
        await first.client.createThread(
          { title: "Named separate ungranted Native task" },
          "named-native-report-ungranted-create-thread",
        )
      ).thread;
      const other = receipt(
        (
          await first.client.plugins.invoke(
            mount1.mountRef,
            f.command({
              threadId: thread.threadId,
              expectedThreadRevision: thread.revision,
              idempotencyKey: "named-native-report-ungranted-execution-key",
              subject:
                "An explicit separate task must not borrow the report grant",
            }),
          )
        ).output,
      );
      await f.waitWorkerExecutionDenied(other.runId);
      const ungranted = (await first.client.getRun(other.runId)).run;
      await first.client.cancelRun(
        other.runId,
        { expectedRevision: ungranted.revision },
        "named-native-report-cancel-ungranted-task",
      );
      assert.equal(
        (await f.waitTaskStable(first, other.runId)).task.runStatus,
        "canceled",
      );
      assert.equal(
        supplier.requests().filter(({ method }) => method === "POST").length,
        1,
      );
      assert.equal(f.metadata.model.requests.length, 2);
      assert.equal(
        f.countQuotes(),
        2,
        "only two explicitly submitted task keys have quotes",
      );
      const stable = f.effects(),
        wallet = f.wallet(),
        supplierRequests = supplier.requests();
      await first.stop();

      f.metadata.namedReportExecution.denyExecution();
      const second = await f.start();
      assert.ok(second.task);
      assert.notEqual(second.session.sessionToken, first.session.sessionToken);
      assert.notEqual(
        second.bootstrap.authorityEpoch,
        first.bootstrap.authorityEpoch,
      );
      assert.notEqual(
        second.task.document.activationDigest,
        first.task.document.activationDigest,
      );
      const oldClient = new ControlApiClient({
        baseUrl: second.session.baseUrl,
        accessToken: first.session.sessionToken,
        csrfToken: first.session.csrfToken,
        origin: second.session.origin,
      });
      await assert.rejects(
        oldClient.getExtensionTask(f.source.pluginId, committed.runId),
        denied(401),
      );
      await assert.rejects(
        second.client.plugins.invoke(mount1.mountRef, command),
        denied(404),
      );
      const mount2 = await second.mount();
      f.state.responses.task = {
        outcome: "deny",
        reasonCode: "named-native-report-current-replay-policy-revoked",
      };
      await assert.rejects(
        second.client.plugins.invoke(mount2.mountRef, command),
        denied(403),
      );
      f.state.responses.task = { outcome: "allow" };
      assert.deepEqual(
        receipt(
          (await second.client.plugins.invoke(mount2.mountRef, command)).output,
        ),
        { ...committed, disposition: "replayed" },
      );
      assert.deepEqual(await reportFacts(f, committed.runId), terminal);
      assert.deepEqual(f.effects(), stable);
      assert.deepEqual(f.wallet(), wallet);
      assert.deepEqual(supplier.requests(), supplierRequests);
      assert.equal(f.metadata.model.requests.length, 2);
      assert.equal(f.countQuotes(), 2);
      const coldEvents = await reportEvents(second, committed.runId);
      assert.deepEqual(coldEvents, events);
      assert.ok(
        f.metadata.namedReportExecution.decisions.some(
          ({ action, allowed }) => action === "run:execute" && allowed,
        ),
      );
      assert.ok(
        f.metadata.namedReportExecution.decisions.some(
          ({ action, allowed }) => action === "extension:run" && allowed,
        ),
      );
      assert.ok(
        f.metadata.namedReportExecution.decisions.some(
          ({ action, allowed }) => action === "run:execute" && !allowed,
        ),
      );
      await second.stop();
      assert.deepEqual(await f.taskDirectories(), []);
    } catch (error) {
      failure = error;
      if (f)
        console.error(
          "named_native_report_diagnostic",
          JSON.stringify({
            logs: f.metadata.logs.join("").slice(-12_000),
            authority: f.metadata.authorityFailures().slice(-4),
            decisions: f.metadata.namedReportExecution?.decisions.slice(-8),
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
          "native_report_execution_and_cleanup_failed",
        );
    }
  },
  180_000,
);

async function reportEvents(live: Live, runId: string, afterSequence = 0) {
  const events = [];
  for await (const event of streamRunEvents(live.client, {
    runId,
    afterSequence,
    view: "audit",
    signal: AbortSignal.timeout(15_000),
  })) {
    assert.ok(events.length < 128, "native_report_sse_event_limit");
    events.push(event);
    if (event.type === "run.completed") break;
  }
  return events;
}

async function reportFacts(f: Fixture, runId: string) {
  const store = new SqliteRunStore(f.databasePath);
  const locator = {
    tenantId: f.actor.tenantId,
    spaceId: f.actor.spaceId,
    runId,
  };
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
