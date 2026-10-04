import assert from "node:assert/strict";
import { chmod, lstat } from "node:fs/promises";
import test from "node:test";
import {
  ControlApiClient,
  ControlApiClientError,
} from "@crewon/control-client";
import { nativeTaskDeferred } from "./desktop-installed-plugin-task-authority.test-support.ts";
import { nativeTaskMainFixture } from "./desktop-installed-plugin-task-main.integration.test-support.ts";
import { pluginSecurityRecord } from "./plugin-security-validation.ts";

const nativeOnly = { skip: process.platform === "win32", timeout: 60_000 };
const denied = (status: number, category?: string) => (error: unknown) =>
  error instanceof ControlApiClientError &&
  error.status === status &&
  (category === undefined || error.category === category);

function taskReceipt(value: unknown) {
  const output = pluginSecurityRecord(value, [
    "disposition",
    "threadId",
    "threadRevision",
    "runId",
    "messageId",
    "configurationRevision",
  ]);
  assert.ok(
    output.disposition === "committed" || output.disposition === "replayed",
  );
  for (const key of ["threadId", "runId", "messageId"] as const) {
    assert.equal(typeof output[key], "string");
    assert.ok(String(output[key]).length > 0);
  }
  assert.equal(typeof output.threadRevision, "number");
  assert.equal(typeof output.configurationRevision, "number");
  return output as {
    disposition: "committed" | "replayed";
    threadId: string;
    threadRevision: number;
    runId: string;
    messageId: string;
    configurationRevision: number;
  };
}
const countQuotes = (f: Awaited<ReturnType<typeof nativeTaskMainFixture>>) =>
  f.state.requests.filter((entry) => entry.path === "/quotes").length;

test(
  "actual Native Main loads private execution files, submits one installed Node task, reads it with independent PDP and replays the same key after physical restart",
  nativeOnly,
  async (t) => {
    const f = await nativeTaskMainFixture(t);
    const first = await f.start();
    assert.equal(
      first.environment.CREWON_DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_PATH,
      first.taskPath,
    );
    const lease = await first.mount();
    const command = f.command("named-native-main-original-command");
    const before = await f.effects();
    const accepted = taskReceipt(
      (await first.client.plugins.invoke(lease.mountRef, command)).output,
    );
    assert.equal(accepted.disposition, "committed");
    assert.equal(accepted.threadId, f.threadId);
    assert.equal(accepted.threadRevision, 2);
    assert.equal(accepted.configurationRevision, f.configuration.revision);
    const after = await f.effects();
    for (const [table, count] of Object.entries(before))
      assert.equal(after[table], count + 1, table);
    assert.equal((await f.wallet()).availableCredits, "70");
    assert.equal((await f.wallet()).reservedCredits, "30");
    assert.equal(countQuotes(f), 1);

    const peerBeforeRead = f.state.peerRequests.length;
    const policyBeforeRead = f.state.requests.length;
    const read = await first.client.getExtensionTask(
      f.source.pluginId,
      accepted.runId,
    );
    assert.equal(read.task.runId, accepted.runId);
    assert.equal(read.task.threadId, f.threadId);
    assert.equal(read.task.pluginId, f.source.pluginId);
    assert.deepEqual(read.task.operations, []);
    const policies = f.state.requests
      .slice(policyBeforeRead)
      .filter((entry) => entry.path === "/tasks");
    assert.ok(
      policies.some((entry) => entry.body.action === "extension:query"),
    );
    assert.ok(
      policies.filter((entry) => entry.body.action === "run:read").length >= 2,
    );
    assert.equal(f.state.peerRequests.length, peerBeforeRead);
    assert.equal(countQuotes(f), 1);
    assert.deepEqual(await f.effects(), after);

    f.state.responses.task = {
      outcome: "deny",
      reasonCode: "named_native_main_read_denied",
    };
    await assert.rejects(
      first.client.getExtensionTask(f.source.pluginId, accepted.runId),
      denied(403, "authorization"),
    );
    const taskPolicyCount = f.state.requests.filter(
      (entry) => entry.path === "/tasks",
    ).length;
    assert.ok(
      (await first.client.listExtensions()).extensions.some(
        (entry) => entry.pluginId === f.source.pluginId,
      ),
    );
    assert.equal(
      (await first.client.getExtensionConfiguration(f.source.pluginId))
        .configuration?.revision,
      f.configuration.revision,
    );
    await assert.rejects(
      first.client.getExtensionRuntime(f.source.pluginId, {
        agentVersionId: f.target.agentVersionId,
        configurationRevision: f.configuration.revision,
      }),
      denied(403, "authorization"),
    );
    assert.equal(
      f.state.requests.filter((entry) => entry.path === "/tasks").length,
      taskPolicyCount,
    );
    f.state.responses.task = { outcome: "allow" };

    await assert.rejects(
      first.client.createExtensionTask(
        f.source.pluginId,
        {
          threadId: f.threadId,
          expectedThreadRevision: 2,
          intent: {
            kind: "generate",
            input: { organization: "Named raw task bypass denied" },
          },
        },
        "named-native-main-forbidden-raw-create",
      ),
      denied(404),
    );
    assert.deepEqual(await f.effects(), after);
    await first.stop();

    const second = await f.start();
    assert.notEqual(second.sessionToken, first.sessionToken);
    const oldClient = new ControlApiClient({
      baseUrl: second.origin,
      accessToken: first.sessionToken,
      csrfToken: first.csrfToken,
      origin: second.origin,
    });
    await assert.rejects(
      oldClient.getExtensionTask(f.source.pluginId, accepted.runId),
      denied(401),
    );
    await assert.rejects(
      second.client.plugins.invoke(lease.mountRef, command),
      denied(404, "notFound"),
    );
    const currentLease = await second.mount();
    const replayed = taskReceipt(
      (await second.client.plugins.invoke(currentLease.mountRef, command))
        .output,
    );
    assert.deepEqual(replayed, { ...accepted, disposition: "replayed" });
    assert.deepEqual(
      await second.client.getExtensionTask(f.source.pluginId, accepted.runId),
      read,
    );
    assert.deepEqual(await f.effects(), after);
    assert.equal((await f.wallet()).availableCredits, "70");
    assert.equal((await f.wallet()).reservedCredits, "30");
    assert.equal(countQuotes(f), 1);
    await second.stop();
  },
);

test(
  "an explicit Native Main task PDP denial has no Run, admission, reservation or quote and can be retried only after an explicit fixture policy grant",
  nativeOnly,
  async (t) => {
    const f = await nativeTaskMainFixture(t);
    const live = await f.start();
    const lease = await live.mount();
    const before = await f.effects();
    const command = f.command("named-native-main-policy-denied-command");
    f.state.responses.task = {
      outcome: "deny",
      reasonCode: "named_native_main_task_denied",
    };
    await assert.rejects(
      live.client.plugins.invoke(lease.mountRef, command),
      denied(403, "authorization"),
    );
    assert.deepEqual(await f.effects(), before);
    assert.equal(countQuotes(f), 0);
    assert.equal((await f.wallet()).availableCredits, "100");
    assert.equal((await f.wallet()).reservedCredits, "0");
    f.state.responses.task = { outcome: "allow" };
    assert.equal(
      taskReceipt(
        (await live.client.plugins.invoke(lease.mountRef, command)).output,
      ).disposition,
      "committed",
    );
    assert.equal(countQuotes(f), 1);
    await live.stop();
  },
);

test(
  "Native Main without independent execution opt-in keeps metadata available and never requests task authorities",
  nativeOnly,
  async (t) => {
    const f = await nativeTaskMainFixture(t);
    const live = await f.start({
      taskOptIn: false,
      environmentOverrides: {
        TEST_NATIVE_TASK_POLICY_TOKEN: undefined,
        TEST_NATIVE_UI_POLICY_TOKEN: undefined,
        TEST_NATIVE_PACKAGE_TOKEN: undefined,
        TEST_NATIVE_QUOTE_TOKEN: undefined,
      },
    });
    assert.equal(
      live.environment.CREWON_DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_PATH,
      undefined,
    );
    const before = await f.effects();
    const lease = await live.mount();
    assert.ok(
      (await live.client.listExtensions()).extensions.some(
        (entry) => entry.pluginId === f.source.pluginId,
      ),
    );
    await assert.rejects(
      live.client.plugins.invoke(
        lease.mountRef,
        f.command("named-native-main-metadata-only"),
      ),
      denied(403, "authorization"),
    );
    assert.deepEqual(await f.effects(), before);
    assert.equal(countQuotes(f), 0);
    assert.equal(
      f.state.requests.some((entry) =>
        ["/tasks", "/ui", "/packages", "/quotes"].includes(entry.path),
      ),
      false,
    );
    await live.stop();
  },
);

test(
  "Main refuses an explicit Native task/PG mismatch before opening Artifact or SQLite resources",
  nativeOnly,
  async (t) => {
    const f = await nativeTaskMainFixture(t);
    const before = await f.effects();
    const refused = await f.startRejected({
      CREWON_CONTROL_DATABASE_URL:
        "postgres://named-unused-native-task-fixture@127.0.0.1:1/postgres",
    });
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /desktop_plugin_standalone_sqlite_required/u);
    for (const field of [
      "CREWON_ARTIFACT_ROOT",
      "CREWON_ARTIFACT_DB_PATH",
    ] as const) {
      const path = refused.environment[field];
      assert.ok(path);
      await assert.rejects(lstat(path), { code: "ENOENT" });
    }
    assert.deepEqual(await f.effects(), before);
    assert.equal(f.state.requests.length, 0);
    assert.equal(f.state.peerRequests.length, 0);
  },
);

test(
  "a changed private Native task file revokes live UI execution and HTTP task reads with no second reservation",
  nativeOnly,
  async (t) => {
    const f = await nativeTaskMainFixture(t);
    const live = await f.start();
    const lease = await live.mount();
    const accepted = taskReceipt(
      (
        await live.client.plugins.invoke(
          lease.mountRef,
          f.command("named-native-main-before-file-drift"),
        )
      ).output,
    );
    const before = await f.effects();
    const quotes = countQuotes(f);
    await chmod(live.taskPath, 0o640);
    await assert.rejects(
      live.client.plugins.invoke(
        lease.mountRef,
        f.command("named-native-main-after-file-drift", 2),
      ),
      denied(403),
    );
    await assert.rejects(
      live.client.getExtensionTask(f.source.pluginId, accepted.runId),
      denied(403),
    );
    assert.deepEqual(await f.effects(), before);
    assert.equal(countQuotes(f), quotes);
    await live.stop();
  },
);

test(
  "a final real HTTP task read rejects a late private-file revocation after its second run-read PDP await",
  nativeOnly,
  async (t) => {
    const f = await nativeTaskMainFixture(t);
    const live = await f.start();
    const lease = await live.mount();
    const accepted = taskReceipt(
      (
        await live.client.plugins.invoke(
          lease.mountRef,
          f.command("named-native-main-late-read-source"),
        )
      ).output,
    );
    const before = await f.effects();
    const entered = nativeTaskDeferred(),
      release = nativeTaskDeferred();
    let runReads = 0;
    f.state.before.task = async (body) => {
      if (body.action === "run:read" && ++runReads === 2) {
        entered.resolve();
        await release.promise;
      }
    };
    const pending = live.client.getExtensionTask(
      f.source.pluginId,
      accepted.runId,
    );
    void pending.catch(() => {});
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("native_main_final_read_gate_not_observed");
        }),
      ]);
      await chmod(live.taskPath, 0o640);
    } finally {
      release.resolve();
    }
    await assert.rejects(pending, denied(403));
    assert.equal(runReads, 2);
    assert.deepEqual(await f.effects(), before);
    assert.equal(countQuotes(f), 1);
    await live.stop();
  },
);

test(
  "Native Main refuses invalid session, CSRF and withdrawn task authority tokens before paid effects",
  nativeOnly,
  async (t) => {
    const f = await nativeTaskMainFixture(t);
    const live = await f.start();
    const lease = await live.mount();
    const before = await f.effects();
    const wrongSession = new ControlApiClient({
      baseUrl: live.origin,
      origin: live.origin,
      accessToken: "named-wrong-native-main-session-" + "x".repeat(32),
      csrfToken: live.csrfToken,
    });
    await assert.rejects(
      wrongSession.plugins.invoke(
        lease.mountRef,
        f.command("named-native-main-wrong-session"),
      ),
      denied(401),
    );
    const wrongCsrf = new ControlApiClient({
      baseUrl: live.origin,
      origin: live.origin,
      accessToken: live.sessionToken,
      csrfToken: "named-wrong-native-main-csrf-" + "x".repeat(32),
    });
    await assert.rejects(
      wrongCsrf.plugins.invoke(
        lease.mountRef,
        f.command("named-native-main-wrong-csrf"),
      ),
      denied(403),
    );
    assert.deepEqual(await f.effects(), before);
    assert.equal(countQuotes(f), 0);
    f.state.statuses.task = 401;
    await assert.rejects(
      live.client.plugins.invoke(
        lease.mountRef,
        f.command("named-native-main-authority-token-withdrawn"),
      ),
      denied(409, "conflict"),
    );
    assert.deepEqual(await f.effects(), before);
    assert.equal(countQuotes(f), 0);
    await live.stop();
  },
);

test(
  "replacement of the actual Native Main profile lock revokes an existing UI lease before paid effects",
  nativeOnly,
  async (t) => {
    const f = await nativeTaskMainFixture(t);
    const live = await f.start();
    const lease = await live.mount();
    const before = await f.effects();
    await f.replaceProfileLock();
    await assert.rejects(
      live.client.plugins.invoke(
        lease.mountRef,
        f.command("named-native-main-replaced-profile"),
      ),
      denied(403, "authorization"),
    );
    assert.deepEqual(await f.effects(), before);
    assert.equal(countQuotes(f), 0);
    await live.stop();
  },
);
