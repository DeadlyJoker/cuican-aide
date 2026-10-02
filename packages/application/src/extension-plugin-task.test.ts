import assert from "node:assert/strict";
import test from "node:test";
import { extensionCanonicalJson } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import {
  pluginTaskFixture,
  taskActor,
  taskCommand,
  taskDigester,
  taskPin,
} from "./extension-plugin-task.test-support.ts";

function applicationError(
  category: ApplicationError["category"],
  code: string,
) {
  return (error: unknown) =>
    error instanceof ApplicationError &&
    error.category === category &&
    error.code === code;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("plugin generation prepares the existing Turn with a required quote and separate full v1 provenance", async () => {
  const fixture = pluginTaskFixture();
  const result = await fixture
    .create()
    .createTaskFromPlugin(taskActor, taskCommand, taskPin);
  assert.equal(result.run.disposition, "committed");
  assert.equal(fixture.state.quoteCalls, 1);
  assert.equal(fixture.state.commits.length, 1);
  const input = fixture.state.commits[0]!;
  assert.match(input.receipt.idempotencyKey, /^plugin-task:[0-9a-f]{64}$/u);
  assert.equal(input.turn.idempotency.key, input.receipt.idempotencyKey);
  assert.equal(input.creditAdmission?.reservation.quotedCredits, "3");
  assert.equal(
    input.creditAdmission?.reservation.scope.principalId,
    taskActor.principalId,
  );
  assert.deepEqual(input.pluginAdmission, {
    schemaVersion: "crewon.plugin-task-admission.v1",
    ...taskPin,
    runId: result.binding.runId,
    threadId: taskCommand.threadId,
    extensionBindingDigest: result.binding.bindingDigest,
    requestDigest: input.receipt.requestDigest,
    idempotencyKey: input.receipt.idempotencyKey,
  });
  assert.equal("pluginAdmission" in result, false);
  assert.equal(result.binding.source, null);
  assert.equal(result.turn.messages.length, 1);
  assert.equal(fixture.state.admissionReads, 1);
});

test("paid plugin replay is receipt-first and uses neither current quote nor new IDs or time", async () => {
  const fixture = pluginTaskFixture();
  const first = await fixture
    .create()
    .createTaskFromPlugin(taskActor, taskCommand, taskPin);
  const counters = {
    ids: fixture.state.ids,
    clocks: fixture.state.clocks,
    reads: fixture.state.configurationReads,
  };
  fixture.state.quote.quotedCredits = "999";
  const replay = await fixture
    .create({ creditQuotes: undefined })
    .createTaskFromPlugin(taskActor, taskCommand, taskPin);
  assert.equal(replay.run.disposition, "replayed");
  assert.equal(replay.binding.runId, first.binding.runId);
  assert.deepEqual(replay.creditAdmission, first.creditAdmission);
  assert.deepEqual(
    {
      ids: fixture.state.ids,
      clocks: fixture.state.clocks,
      reads: fixture.state.configurationReads,
    },
    counters,
  );
  assert.equal(fixture.state.quoteCalls, 1);
  assert.equal(fixture.state.commits.length, 1);
});

test("missing plugin or credit adapter capabilities fail before authorization, reads, quote and writes", async () => {
  for (const [patch, code] of [
    [
      { pluginAdmissionVersion: undefined },
      "plugin_task_admission_unavailable",
    ],
    [
      { loadPluginTaskAdmission: undefined },
      "plugin_task_admission_unavailable",
    ],
    [
      { creditAdmissionVersion: undefined },
      "extension_credit_admission_unavailable",
    ],
  ] as const) {
    const fixture = pluginTaskFixture();
    await assert.rejects(
      fixture
        .create({ extensions: { ...fixture.extensions, ...patch } })
        .createTaskFromPlugin(taskActor, taskCommand, taskPin),
      applicationError("conflict", code),
    );
    assert.equal(fixture.state.permissions.length, 0);
    assert.equal(fixture.state.receiptReads, 0);
    assert.equal(fixture.state.quoteCalls, 0);
    assert.equal(fixture.state.commits.length, 0);
  }
});

test("new plugin generation cannot fall back to a free Run when the quote policy is absent or invalid", async () => {
  const absent = pluginTaskFixture();
  await assert.rejects(
    absent
      .create({ creditQuotes: undefined })
      .createTaskFromPlugin(taskActor, taskCommand, taskPin),
    applicationError("conflict", "extension_credit_quote_unavailable"),
  );
  assert.equal(absent.state.ids, 0);
  assert.equal(absent.state.clocks, 0);
  assert.equal(absent.state.commits.length, 0);
  for (const quote of [
    null,
    { poolId: "pool-1", priceRevision: 0, quotedCredits: "3" },
    {
      poolId: "pool-1",
      priceRevision: 1,
      quotedCredits: "0",
      secret: "hidden",
    },
  ]) {
    const fixture = pluginTaskFixture();
    await assert.rejects(
      fixture
        .create({
          creditQuotes: {
            async quoteGeneration() {
              return quote as never;
            },
          },
        })
        .createTaskFromPlugin(taskActor, taskCommand, taskPin),
      applicationError("internal", "extension_credit_quote_invalid"),
    );
    assert.equal(fixture.state.commits.length, 0);
  }
});

test("plugin query is explicitly unsupported and cannot create an unpriced query Turn", async () => {
  const fixture = pluginTaskFixture();
  await assert.rejects(
    fixture.create().createTaskFromPlugin(
      taskActor,
      {
        ...taskCommand,
        intent: {
          kind: "query",
          sourceRunId: "run-1",
          operationId: "00000000-0000-0000-0000-000000000001",
        },
      },
      taskPin,
    ),
    applicationError("validation", "plugin_task_query_unsupported"),
  );
  assert.equal(fixture.state.permissions.length, 0);
  assert.equal(fixture.state.receiptReads, 0);
  assert.equal(fixture.state.commits.length, 0);
});

test("unknown or accessor pin fields are rejected without executing getters", async () => {
  const fixture = pluginTaskFixture();
  let reads = 0;
  const accessor = Object.defineProperty({ ...taskPin }, "authorityEpoch", {
    enumerable: true,
    get() {
      reads++;
      return "epoch-1";
    },
  });
  for (const pin of [{ ...taskPin, credentials: "hidden" }, accessor])
    await assert.rejects(
      fixture.create().createTaskFromPlugin(taskActor, taskCommand, pin),
      applicationError("validation", "plugin_task_admission_invalid"),
    );
  assert.equal(reads, 0);
  assert.equal(fixture.state.permissions.length, 0);
});

test("caller identity and task plugin must match the host-derived pin before any reads", async () => {
  for (const patch of [
    { principalId: "foreign" },
    { actorId: "foreign" },
    { tenantId: "foreign" },
    { spaceId: "foreign" },
    { pluginId: "foreign.plugin" },
  ]) {
    const fixture = pluginTaskFixture();
    await assert.rejects(
      fixture
        .create()
        .createTaskFromPlugin(taskActor, taskCommand, { ...taskPin, ...patch }),
      applicationError("authorization", "plugin_task_admission_owner_mismatch"),
    );
    assert.equal(fixture.state.receiptReads, 0);
    assert.equal(fixture.state.commits.length, 0);
  }
});

test("commands, identities and host pins are detached before awaits", async () => {
  const fixture = pluginTaskFixture();
  const command = { ...structuredClone(taskCommand) };
  const pin = { ...structuredClone(taskPin) };
  const actor = { ...taskActor };
  fixture.state.onQuote = () => {
    command.intent = { kind: "generate", input: { prompt: "altered" } };
    pin.version = "9.0.0";
    actor.principalId = "foreign";
  };
  await fixture.create().createTaskFromPlugin(actor, command, pin);
  const input = fixture.state.commits[0]!;
  assert.equal(input.pluginAdmission?.version, taskPin.version);
  assert.equal(input.pluginAdmission?.principalId, taskPin.principalId);
  assert.equal(
    input.binding.inputDigest,
    taskDigester.sha256(
      extensionCanonicalJson(
        taskCommand.intent.kind === "generate"
          ? taskCommand.intent.input
          : null,
      ),
    ),
  );
});

test("current platform permission is required both initially and after the asynchronous quote", async () => {
  for (const action of [
    "extension:run",
    "thread:message:append",
    "run:create",
  ] as const) {
    const initial = pluginTaskFixture();
    initial.state.denied = action;
    await assert.rejects(
      initial.create().createTaskFromPlugin(taskActor, taskCommand, taskPin),
      applicationError("authorization", "authorization_denied"),
    );
    assert.equal(initial.state.commits.length, 0);
    const late = pluginTaskFixture();
    late.state.onQuote = () => {
      late.state.denied = action;
    };
    await assert.rejects(
      late.create().createTaskFromPlugin(taskActor, taskCommand, taskPin),
      applicationError("authorization", "authorization_denied"),
    );
    assert.equal(late.state.commits.length, 0);
  }
});

test("changing any stable invocation pin with the same user key conflicts instead of creating another Run", async () => {
  const fixture = pluginTaskFixture();
  await fixture.create().createTaskFromPlugin(taskActor, taskCommand, taskPin);
  for (const patch of [
    { packageDigest: taskDigester.sha256("other-package") },
    { version: "2.0.0" },
    { publisherId: "other.publisher" },
    { selectionRevision: 3 },
    { contributionId: "other-workbench" },
    { action: "create" },
    { authorityEpoch: "epoch-2" },
  ])
    await assert.rejects(
      fixture
        .create()
        .createTaskFromPlugin(taskActor, taskCommand, { ...taskPin, ...patch }),
      applicationError("conflict", "extension_idempotency_conflict"),
    );
  assert.equal(fixture.state.commits.length, 1);
  assert.equal(fixture.state.quoteCalls, 1);
});

test("receipt keys isolate profile, principal and actor, while original user intent remains in the digest", async () => {
  const fixture = pluginTaskFixture();
  await fixture.create().createTaskFromPlugin(taskActor, taskCommand, taskPin);
  for (const patch of [
    { profileId: "profile-2" },
    { principalId: "principal-2" },
    { actorId: "actor-2" },
  ]) {
    const pin = { ...taskPin, ...patch };
    await fixture.create().createTaskFromPlugin(
      {
        tenantId: pin.tenantId,
        spaceId: pin.spaceId,
        principalId: pin.principalId,
        actorId: pin.actorId,
      },
      taskCommand,
      pin,
    );
  }
  assert.equal(
    new Set(fixture.state.commits.map((input) => input.receipt.idempotencyKey))
      .size,
    4,
  );
  const input = fixture.state.commits[0]!;
  assert.equal(
    input.receipt.requestDigest,
    taskDigester.sha256(
      extensionCanonicalJson({
        schemaVersion: "crewon.plugin-task-command.v1",
        actor: taskActor,
        pin: taskPin,
        command: taskCommand,
      }),
    ),
  );
});

test("concurrent same-key admission replays the original server-generated Run and frozen price", async () => {
  const fixture = pluginTaskFixture();
  const gate = deferred();
  fixture.state.onQuote = async () => {
    if (fixture.state.quoteCalls === 2) gate.resolve();
    await gate.promise;
  };
  const service = fixture.create();
  const [first, second] = await Promise.all([
    service.createTaskFromPlugin(taskActor, taskCommand, taskPin),
    service.createTaskFromPlugin(taskActor, taskCommand, taskPin),
  ]);
  assert.equal(first.binding.runId, second.binding.runId);
  assert.deepEqual(first.creditAdmission, second.creditAdmission);
  assert.deepEqual(
    new Set([first.run.disposition, second.run.disposition]),
    new Set(["committed", "replayed"]),
  );
  assert.equal(fixture.state.receipts.size, 1);
  assert.equal(fixture.state.admissions.size, 1);
});

test("missing or corrupted persisted provenance fails closed even if the adapter declares support", async () => {
  for (const patch of [
    null,
    { profileId: "foreign-profile" },
    { packageDigest: taskDigester.sha256("corrupt") },
    { selectionRevision: 999 },
    { actorId: "foreign" },
    { extensionBindingDigest: taskDigester.sha256("other-binding") },
    { requestDigest: taskDigester.sha256("other-command") },
    { idempotencyKey: "foreign-key" },
  ]) {
    const fixture = pluginTaskFixture();
    const first = await fixture
      .create()
      .createTaskFromPlugin(taskActor, taskCommand, taskPin);
    if (patch === null) fixture.state.admissions.delete(first.binding.runId);
    else
      fixture.state.admissions.set(first.binding.runId, {
        ...fixture.state.admissions.get(first.binding.runId)!,
        ...patch,
      });
    await assert.rejects(
      fixture.create().createTaskFromPlugin(taskActor, taskCommand, taskPin),
      applicationError("internal", "plugin_task_admission_invalid"),
    );
    assert.equal(fixture.state.commits.length, 1);
  }
});

test("paid replay rejects a different persisted principal and missing paid link", async () => {
  const fixture = pluginTaskFixture();
  const first = await fixture
    .create()
    .createTaskFromPlugin(taskActor, taskCommand, taskPin);
  fixture.state.admissions.set(first.binding.runId, {
    ...fixture.state.admissions.get(first.binding.runId)!,
    principalId: "foreign-principal",
  });
  await assert.rejects(
    fixture.create().createTaskFromPlugin(taskActor, taskCommand, taskPin),
    applicationError("authorization", "plugin_task_admission_owner_mismatch"),
  );
  const saved = [...fixture.state.receipts.values()][0]!;
  delete (saved.result as { creditAdmission?: unknown }).creditAdmission;
  await assert.rejects(
    fixture.create().createTaskFromPlugin(taskActor, taskCommand, taskPin),
    applicationError("internal", "extension_credit_admission_missing"),
  );
});

test("late replay cannot turn a priced plugin operation into an unpriced receipt", async () => {
  const fixture = pluginTaskFixture();
  const original = fixture.extensions.commitExtensionTurn;
  const service = fixture.create({
    extensions: {
      ...fixture.extensions,
      async commitExtensionTurn(input) {
        const result = await original(input);
        const { creditAdmission: _credit, ...rest } = result;
        return {
          ...rest,
          run: { ...rest.run, disposition: "replayed" },
          turn: { ...rest.turn, disposition: "replayed" },
        };
      },
    },
  });
  await assert.rejects(
    service.createTaskFromPlugin(taskActor, taskCommand, taskPin),
    applicationError("internal", "extension_credit_admission_missing"),
  );
});

test("exact admission conflict and unknown persistence failure preserve causes with bounded public errors", async () => {
  for (const [message, category, code] of [
    [
      "plugin_task_admission_conflict",
      "conflict",
      "plugin_task_admission_conflict",
    ],
    ["database SQL secret", "internal", "extension_service_unavailable"],
  ] as const) {
    const fixture = pluginTaskFixture();
    const cause = new Error(message);
    fixture.state.commitError = cause;
    await assert.rejects(
      fixture.create().createTaskFromPlugin(taskActor, taskCommand, taskPin),
      (error) =>
        applicationError(category, code)(error) &&
        (error as ApplicationError).cause === cause,
    );
    assert.equal(fixture.state.admissions.size, 0);
  }
});

test("v0 createTask retains its exact key, request digest, optional quote behavior and result shape", async () => {
  const fixture = pluginTaskFixture();
  const result = await fixture
    .create({
      creditQuotes: undefined,
      extensions: {
        ...fixture.extensions,
        pluginAdmissionVersion: undefined,
        loadPluginTaskAdmission: undefined,
        creditAdmissionVersion: undefined,
      },
    })
    .createTask(taskActor, taskCommand);
  const input = fixture.state.commits[0]!;
  assert.equal(input.receipt.idempotencyKey, taskCommand.idempotencyKey);
  assert.equal(
    input.receipt.requestDigest,
    taskDigester.sha256(
      extensionCanonicalJson({
        schemaVersion: "crewon.extension-task-command.v0",
        tenantId: taskActor.tenantId,
        spaceId: taskActor.spaceId,
        actorId: taskActor.actorId,
        command: taskCommand,
      }),
    ),
  );
  assert.equal(input.pluginAdmission, undefined);
  assert.equal(input.creditAdmission, undefined);
  assert.equal(fixture.state.admissionReads, 0);
  assert.equal("pluginAdmission" in result, false);
});

test("legal 128-character multibyte principal identity is retained by the plugin and credit admissions", async () => {
  const fixture = pluginTaskFixture();
  const principalId = "人".repeat(128);
  const result = await fixture
    .create()
    .createTaskFromPlugin({ ...taskActor, principalId }, taskCommand, {
      ...taskPin,
      principalId,
    });
  assert.equal(
    result.creditAdmission?.reservation.scope.principalId,
    principalId,
  );
  assert.equal(
    fixture.state.admissions.get(result.binding.runId)?.principalId,
    principalId,
  );
});
