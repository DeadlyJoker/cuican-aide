import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  ApplicationError,
  ExtensionTaskApplicationService,
  type CommitExtensionTurnResult,
} from "@crewon/application";
import { pluginSecurityRecord } from "./plugin-security-validation.ts";
import { seedThread } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
import { createDesktopPluginRuntime } from "./desktop-plugin-runtime.ts";
import { assertDesktopInstalledPluginTaskComposition } from "./desktop-installed-plugin-task-runtime.ts";
import {
  actor,
  target,
  nativeTaskAuthorityFixture,
  nativeTaskDeferred,
  nativeTaskDigester,
} from "./desktop-installed-plugin-task-authority.test-support.ts";

const nativeOnly = { skip: process.platform === "win32", timeout: 20_000 };
const creditScope = Object.freeze({
  tenantId: actor.tenantId,
  principalId: actor.principalId,
  poolId: "named-native-factory-personal-credit-fixture",
});

/** Actual Native factory, installed Node/UI bytes, request scope and original SQLite
 * transactions. Peer readiness, deployment, policies and funding are named offline fixtures. */
async function factoryFixture(
  t: TestContext,
  options: Readonly<{ credits?: string }> = {},
) {
  let runtime:
    | Awaited<ReturnType<typeof createDesktopPluginRuntime>>
    | undefined;
  t.after(async () => {
    await runtime?.close();
  });
  const f = await nativeTaskAuthorityFixture(t, { nodeActions: "task" });
  await f.seedDeployment();
  await f.run(() =>
    f.installed.extensions.setActivation(actor, {
      pluginId: f.source.pluginId,
      configurationRevision: f.configuration.revision,
      expectedRevision: 0,
      idempotencyKey: "named-native-factory-business-enable",
      state: "enabled",
      agentVersionId: target.agentVersionId,
    }),
  );
  await f.installation.service.select(actor, {
    pluginId: f.source.pluginId,
    selectedPackageDigest: f.source.packageDigest,
    state: "enabled",
    expectedSelectionRevision: 1,
    idempotencyKey: "named-native-factory-package-enable",
  });
  // Release the original Native profile before the actual factory claims the same file-backed profile.
  await f.owner.close();
  await f.installed.close();
  await f.activationOwner.close();
  await f.installation.close();
  await f.authority.close();
  runtime = await createDesktopPluginRuntime(
    {
      configuration: f.binding.configuration,
      activation: f.activation,
      tasks: f.binding.tasks,
    },
    {
      store: f.store,
      identity: f.identity,
      clock: f.clock,
      digester: nativeTaskDigester,
      fetch: f.fetch,
    },
  );
  const actual = runtime;
  assert.ok(actual.tasks);
  assert.equal(actual.tasks.requests, actual.configuration.requests);
  const credits = f.store.pluginCreditStore();
  await credits.grant({
    scope: creditScope,
    grantId: "named-native-factory-funding-fixture",
    credits: options.credits ?? "100",
  });
  f.state.responses.quote = {
    poolId: creditScope.poolId,
    priceRevision: 17,
    quotedCredits: "30",
  };
  const threadId = "named-native-factory-thread";
  await seedThread(f.store, { ...actor, threadId });
  const catalog = await actual.ui.catalog(actor, {
    afterPluginId: null,
    limit: 20,
  });
  assert.equal(catalog.plugins.length, 1);
  const lease = await actual.ui.openMount(actor, {
    pluginId: f.source.pluginId,
    contributionId: "workbench",
    expectedPackageDigest: f.source.packageDigest,
    expectedSelectionRevision: 2,
  });
  const command = {
    mountRef: lease.mountRef,
    action: "image.generate",
    input: {
      threadId,
      expectedThreadRevision: 1,
      idempotencyKey: "named-native-factory-original-task",
      input: { organization: "Named offline Native paid task" },
    },
  };
  const invoke = () =>
    actual.ui.invokeAuthenticatedRequest!(
      f.request(),
      actor,
      command,
      new AbortController().signal,
    );
  const counts = () => {
    const db = new DatabaseSync(f.databasePath);
    try {
      return Object.fromEntries(
        [
          "messages",
          "run_snapshots",
          "extension_run_bindings",
          "plugin_task_admissions",
          "extension_credit_admissions",
          "plugin_credit_reservations",
          "plugin_credit_entries",
        ].map((table) => [
          table,
          Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n),
        ]),
      );
    } finally {
      db.close();
    }
  };
  f.calls.length = 0;
  return {
    ...f,
    runtime: actual,
    credits,
    creditScope,
    lease,
    command,
    invoke,
    counts,
  };
}

test(
  "actual Native factory commits and replays one installed SQLite task with an independently quoted personal reservation",
  nativeOnly,
  async (t) => {
    const f = await factoryFixture(t);
    const before = f.counts();
    const output = pluginSecurityRecord(await f.invoke(), [
      "disposition",
      "threadId",
      "threadRevision",
      "runId",
      "messageId",
      "configurationRevision",
    ]);
    assert.equal(output.disposition, "committed");
    const after = f.counts();
    for (const table of Object.keys(before))
      assert.equal(after[table], before[table]! + 1, table);
    const wallet = await f.credits.getAccount(creditScope);
    assert.equal(wallet?.availableCredits, "70");
    assert.equal(wallet?.reservedCredits, "30");
    assert.equal(f.calls.filter((call) => call.role === "quote").length, 1);
    assert.ok(f.calls.some((call) => call.role === "task"));
    assert.ok(f.calls.some((call) => call.role === "package"));
    assert.equal(
      f.calls.filter((call) => call.role === "activation").length,
      0,
    );
    assert.deepEqual(await f.invoke(), { ...output, disposition: "replayed" });
    assert.deepEqual(f.counts(), after);
    assert.deepEqual(await f.credits.getAccount(creditScope), wallet);
    assert.equal(f.calls.filter((call) => call.role === "quote").length, 1);
    await f.runtime.close();
    assert.deepEqual(
      f.counts(),
      after,
      "the borrowed parent Store remains open after factory close",
    );
    await assert.rejects(
      f.runtime.tasks!.extensionReads.getTask(actor, {
        pluginId: f.source.pluginId,
        runId: String(output.runId),
      }),
    );
  },
);

test(
  "activation approval and UI access cannot substitute for an actual denied Native task policy",
  nativeOnly,
  async (t) => {
    const f = await factoryFixture(t);
    f.state.responses.task = {
      outcome: "deny",
      reasonCode: "named-native-factory-task-denied",
    };
    const before = f.counts(),
      wallet = await f.credits.getAccount(creditScope);
    await assert.rejects(
      f.invoke(),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.category === "authorization" &&
        error.code === "authorization_denied",
    );
    assert.deepEqual(f.counts(), before);
    assert.deepEqual(await f.credits.getAccount(creditScope), wallet);
    assert.equal(f.calls.filter((call) => call.role === "quote").length, 0);
  },
);

test(
  "Native factory rejects an old UI lease when the independent task UI policy epoch changes",
  nativeOnly,
  async (t) => {
    const f = await factoryFixture(t);
    f.state.responses.ui = {
      outcome: "allow",
      authorityEpoch: "changed-native-factory-task-ui-epoch",
    };
    const before = f.counts();
    await assert.rejects(f.invoke(), /plugin_ui_authority_changed/);
    assert.deepEqual(f.counts(), before);
    assert.equal(f.calls.filter((call) => call.role === "quote").length, 0);
  },
);

test(
  "Native factory close joins a real committed task and preserves its original opaque success receipt",
  nativeOnly,
  async (t) => {
    const entered = nativeTaskDeferred(),
      release = nativeTaskDeferred();
    const original =
      ExtensionTaskApplicationService.prototype.createTaskFromPlugin;
    let accepted: CommitExtensionTurnResult | undefined;
    let actualRuntime:
      | Awaited<ReturnType<typeof createDesktopPluginRuntime>>
      | undefined;
    t.mock.method(
      ExtensionTaskApplicationService.prototype,
      "createTaskFromPlugin",
      async function (
        this: ExtensionTaskApplicationService,
        ...args: Parameters<typeof original>
      ) {
        const result = await Reflect.apply(original, this, args);
        if (this === actualRuntime?.tasks?.extensionTasks) {
          accepted = result;
          entered.resolve();
          await release.promise;
        }
        return result;
      },
    );
    const f = await factoryFixture(t);
    actualRuntime = f.runtime;
    const pending = f.invoke();
    await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error("native_fixture_commit_not_observed");
      }),
    ]);
    let joined = false;
    const closing = f.runtime.close().then(() => {
      joined = true;
    });
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(joined, false);
    release.resolve();
    const output = await pending;
    await closing;
    assert.ok(accepted);
    assert.deepEqual(output, {
      disposition: "committed",
      threadId: accepted.binding.threadId,
      threadRevision: accepted.turn.threadState.revision,
      runId: accepted.binding.runId,
      messageId: accepted.turn.messages[0]!.messageId,
      configurationRevision: accepted.binding.configurationRevision,
    });
    assert.equal(
      (await f.credits.getAccount(creditScope))?.reservedCredits,
      "30",
    );
  },
);

test(
  "Native execution preflight refuses missing activation and copied task configuration before any task schema",
  nativeOnly,
  async (t) => {
    const f = await nativeTaskAuthorityFixture(t);
    assert.throws(() =>
      assertDesktopInstalledPluginTaskComposition({
        configuration: f.binding.configuration,
        tasks: f.binding.tasks,
        activation: undefined,
        digester: nativeTaskDigester,
      }),
    );
    assert.throws(() =>
      assertDesktopInstalledPluginTaskComposition({
        configuration: f.binding.configuration,
        tasks: { ...f.binding.tasks },
        activation: f.activation,
        digester: nativeTaskDigester,
      }),
    );
    const db = new DatabaseSync(f.databasePath);
    try {
      assert.equal(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='plugin_task_admissions' OR name='plugin_credit_accounts'",
          )
          .get()!.n,
        0,
      );
    } finally {
      db.close();
    }
    assert.equal(f.calls.length, 0);
  },
);
