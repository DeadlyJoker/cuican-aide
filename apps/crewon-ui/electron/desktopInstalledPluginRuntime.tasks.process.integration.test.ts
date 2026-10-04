import assert from "node:assert/strict";
import { chmod, lstat } from "node:fs/promises";
import {
  ControlApiClient,
  ControlApiClientError,
} from "@crewon/control-client";
import { expect, it } from "vitest";
import { nativeTaskProcessFixture } from "./desktopInstalledPluginRuntime.tasks.process.test-support.ts";

const professionalDirectory =
  process.env.CREWON_TEST_PROFESSIONAL_PLUGIN_V1_DIR;
const kreaDirectory = process.env.CREWON_TEST_KREA_PLUGIN_DIR;
const enabled =
  professionalDirectory !== undefined && kreaDirectory !== undefined;
type Fixture = Awaited<ReturnType<typeof nativeTaskProcessFixture>>;
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
  assert.deepEqual(
    Object.keys(result).sort(),
    [
      "disposition",
      "threadId",
      "threadRevision",
      "runId",
      "messageId",
      "configurationRevision",
    ].sort(),
  );
  assert.ok(
    result.disposition === "committed" || result.disposition === "replayed",
  );
  for (const key of ["threadId", "runId", "messageId"] as const)
    assert.ok(typeof result[key] === "string" && result[key].length > 0);
  assert.ok(Number.isSafeInteger(result.threadRevision));
  assert.ok(Number.isSafeInteger(result.configurationRevision));
  return result;
}
const denied = (status: number, category?: string) => (error: unknown) =>
  error instanceof ControlApiClientError &&
  error.status === status &&
  (category === undefined || error.category === category);
async function withFixture(work: (f: Fixture) => Promise<void>) {
  const f = await nativeTaskProcessFixture({
    professionalDirectory: professionalDirectory!,
    kreaDirectory: kreaDirectory!,
  });
  let failure: unknown;
  try {
    await work(f);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await f.close();
    } catch (cleanup) {
      if (failure !== undefined)
        throw new AggregateError(
          [failure, cleanup],
          "native_task_process_test_and_cleanup_failed",
        );
      throw cleanup;
    }
  }
}

it.runIf(enabled)(
  "actual Native v4 source Supervisor issues task files only to Main, admits one installed task and replays the original key after genuine authority epoch rotation",
  async () => {
    await withFixture(async (f) => {
      const first = await f.start();
      assert.ok(first.task);
      const created = await first.client.createThread(
        { title: "Named Native v4 installed task" },
        "named-native-v4-original-thread-key",
      );
      const command = f.command({
        threadId: created.thread.threadId,
        expectedThreadRevision: created.thread.revision,
        idempotencyKey: "named-native-v4-original-command-key",
      });
      const lease = await first.mount();
      const before = f.effects();
      const walletBefore = f.wallet();
      f.state.responses.task = {
        outcome: "deny",
        reasonCode: "named_native_v4_admission_denied",
      };
      await assert.rejects(
        first.client.plugins.invoke(lease.mountRef, command),
        denied(403, "authorization"),
      );
      assert.deepEqual(f.effects(), before);
      assert.deepEqual(f.wallet(), walletBefore);
      assert.equal(f.countQuotes(), 0);
      f.state.responses.task = { outcome: "allow" };

      const committed = receipt(
        (await first.client.plugins.invoke(lease.mountRef, command)).output,
      );
      assert.equal(committed.disposition, "committed");
      assert.equal(committed.threadId, created.thread.threadId);
      assert.equal(committed.threadRevision, created.thread.revision + 1);
      await f.waitWorkerExecutionDenied(committed.runId);
      const run = (await first.client.getRun(committed.runId)).run;
      await first.client.cancelRun(
        committed.runId,
        { expectedRevision: run.revision },
        "named-native-v4-explicit-cancel-after-worker-denial",
      );
      const settled = await f.waitTaskStable(first, committed.runId);
      // The actual fixture Worker denies execution. These are durable admission
      // facts, not an assertion that a paid supplier task successfully completed.
      assert.equal(settled.task.runStatus, "canceled");
      for (const table of [
        "messages",
        "run_snapshots",
        "extension_run_bindings",
        "plugin_task_admissions",
        "extension_credit_admissions",
        "plugin_credit_reservations",
      ] as const)
        assert.equal(settled.effects[table], before[table] + 1, table);
      assert.ok(
        settled.effects.plugin_credit_entries >=
          before.plugin_credit_entries + 1,
      );
      assert.equal(f.countQuotes(), 1);
      f.assertNoSupplierExecution();

      const policyStart = f.state.requests.length;
      assert.deepEqual(
        (await f.readTask(first, committed.runId)).task,
        settled.task,
      );
      const readPolicies = f.state.requests
        .slice(policyStart)
        .filter(({ role }) => role === "task");
      assert.ok(
        readPolicies.some(({ body }) => body.action === "extension:query"),
      );
      assert.ok(
        readPolicies.filter(({ body }) => body.action === "run:read").length >=
          2,
      );
      f.state.responses.task = {
        outcome: "deny",
        reasonCode: "named_native_v4_read_denied",
      };
      await assert.rejects(
        f.readTask(first, committed.runId),
        denied(403, "authorization"),
      );
      assert.deepEqual(f.effects(), settled.effects);
      assert.deepEqual(f.wallet(), settled.wallet);
      f.state.responses.task = { outcome: "allow" };
      await first.stop();

      const second = await f.start();
      assert.ok(second.task);
      assert.notEqual(second.session.sessionToken, first.session.sessionToken);
      assert.notEqual(
        second.bootstrap.authorityEpoch,
        first.bootstrap.authorityEpoch,
      );
      assert.notEqual(
        second.task.document.authorityEpoch,
        first.task.document.authorityEpoch,
      );
      assert.notEqual(
        second.task.document.activationDigest,
        first.task.document.activationDigest,
      );
      assert.notEqual(second.task.path, first.task.path);
      assert.deepEqual(second.task.document.scope, first.task.document.scope);
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
        second.client.plugins.invoke(lease.mountRef, command),
        denied(404, "notFound"),
      );
      const current = await second.mount();
      f.state.responses.task = {
        outcome: "deny",
        reasonCode: "named_native_v4_restart_current_policy_denied",
      };
      await assert.rejects(
        second.client.plugins.invoke(current.mountRef, command),
        denied(403, "authorization"),
      );
      f.state.responses.task = { outcome: "allow" };
      assert.deepEqual(
        receipt(
          (await second.client.plugins.invoke(current.mountRef, command))
            .output,
        ),
        { ...committed, disposition: "replayed" },
      );
      assert.deepEqual(
        (await f.readTask(second, committed.runId)).task,
        settled.task,
      );
      assert.deepEqual(f.effects(), settled.effects);
      assert.deepEqual(f.wallet(), settled.wallet);
      assert.equal(f.countQuotes(), 1);
      f.assertNoSupplierExecution();
      await second.stop();
    });
  },
  180_000,
);

it.runIf(enabled)(
  "actual Native v4 task directory drift and authority token withdrawal fail closed before task effects while original metadata remains usable",
  async () => {
    await withFixture(async (f) => {
      const live = await f.start();
      assert.ok(live.task);
      const created = await live.client.createThread(
        { title: "Named Native v4 authority boundaries" },
        "named-native-v4-boundary-thread-key",
      );
      const command = f.command({
        threadId: created.thread.threadId,
        expectedThreadRevision: created.thread.revision,
        idempotencyKey: "named-native-v4-boundary-command-key",
      });
      const lease = await live.mount();
      const before = f.effects(),
        wallet = f.wallet();
      const incorrectCsrf = new ControlApiClient({
        baseUrl: live.session.baseUrl,
        accessToken: live.session.sessionToken,
        csrfToken: "named-wrong-native-v4-csrf",
        origin: live.session.origin,
      });
      await assert.rejects(
        incorrectCsrf.plugins.invoke(lease.mountRef, command),
        denied(403),
      );
      await chmod(live.task.directory, 0o750);
      try {
        await assert.rejects(
          live.client.plugins.invoke(lease.mountRef, command),
          denied(403, "authorization"),
        );
      } finally {
        await chmod(live.task.directory, 0o700);
      }
      assert.equal((await lstat(live.task.directory)).mode & 0o777, 0o700);
      assert.deepEqual(f.effects(), before);
      assert.deepEqual(f.wallet(), wallet);
      assert.equal(f.countQuotes(), 0);
      f.withdrawTaskToken();
      await assert.rejects(
        live.client.plugins.invoke(lease.mountRef, command),
        denied(409, "conflict"),
      );
      expect(
        (await live.client.listExtensions()).extensions.some(
          ({ pluginId }) => pluginId === f.source.pluginId,
        ),
      ).toBe(true);
      assert.deepEqual(f.effects(), before);
      assert.deepEqual(f.wallet(), wallet);
      assert.equal(f.countQuotes(), 0);
      f.assertNoSupplierExecution();
      await live.stop();
    });
  },
  180_000,
);

it.runIf(enabled)(
  "actual Native v3 metadata startup has no independent task file, role tokens, policy calls, quote or admission",
  async () => {
    await withFixture(async (f) => {
      const live = await f.start({ taskOptIn: false });
      assert.equal(live.task, undefined);
      assert.deepEqual(await f.taskDirectories(), []);
      const created = await live.client.createThread(
        { title: "Named Native v3 preserved metadata" },
        "named-native-v3-no-task-thread-key",
      );
      const command = f.command({
        threadId: created.thread.threadId,
        expectedThreadRevision: created.thread.revision,
        idempotencyKey: "named-native-v3-no-task-command-key",
      });
      const before = f.effects(),
        wallet = f.wallet();
      const lease = await live.mount();
      await assert.rejects(
        live.client.plugins.invoke(lease.mountRef, command),
        denied(403, "authorization"),
      );
      assert.deepEqual(f.state.requests, []);
      assert.deepEqual(f.effects(), before);
      assert.deepEqual(f.wallet(), wallet);
      assert.equal(f.countQuotes(), 0);
      f.assertNoSupplierExecution();
      await live.stop();
    });
  },
  180_000,
);
