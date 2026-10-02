import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationError } from "./application-error.ts";
import type { ExtensionHostPort } from "./extension-host-port.ts";
import {
  pluginTaskFixture,
  taskActor,
  taskCommand,
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

function assertNoTaskWrite(fixture: ReturnType<typeof pluginTaskFixture>) {
  assert.equal(fixture.state.ids, 0);
  assert.equal(fixture.state.clocks, 0);
  assert.equal(fixture.state.quoteCalls, 0);
  assert.equal(fixture.state.commits.length, 0);
  assert.equal(fixture.state.receipts.size, 0);
  assert.equal(fixture.state.admissions.size, 0);
}

// Application doubles only: the quote is fixture data, not a production price.
test("an unchanged legacy host keeps its unpriced v0 admission without extra reads", async () => {
  const fixture = pluginTaskFixture();
  const result = await fixture
    .create({ creditQuotes: undefined })
    .createTask(taskActor, taskCommand);
  assert.equal(result.run.disposition, "committed");
  assert.equal(result.creditAdmission, undefined);
  assert.equal(fixture.state.commits[0]!.pluginAdmission, undefined);
  assert.equal(fixture.state.receiptReads, 1);
  assert.equal(fixture.state.configurationReads, 1);
  assert.equal(fixture.state.admissionReads, 0);
  assert.equal(fixture.state.quoteCalls, 0);
  assert.equal(fixture.state.commits.length, 1);
});

test("installed registrations cannot enter through public v0 before readiness or Turn preparation", async () => {
  for (const configuredQuote of [false, true]) {
    const fixture = pluginTaskFixture();
    let modeCalls = 0;
    let readinessCalls = 0;
    const host: ExtensionHostPort = {
      ...fixture.dependencies.host,
      taskAdmissionMode({ registration }) {
        modeCalls++;
        assert.equal(this, host);
        assert.deepEqual(Object.keys(registration).sort(), [
          "implementationDigest",
          "manifest",
          "manifestDigest",
        ]);
        assert.equal(registration.manifest.pluginId, taskCommand.pluginId);
        return "installed";
      },
      async evaluate(input) {
        readinessCalls++;
        return fixture.dependencies.host.evaluate(input);
      },
    };
    await assert.rejects(
      fixture
        .create({
          host,
          creditQuotes: configuredQuote
            ? fixture.dependencies.creditQuotes
            : undefined,
        })
        .createTask(taskActor, taskCommand),
      applicationError("conflict", "installed_plugin_task_admission_required"),
    );
    assert.equal(modeCalls, 1);
    assert.equal(readinessCalls, 0);
    assert.equal(fixture.state.configurationReads, 1);
    assertNoTaskWrite(fixture);
  }
});

test("installed v1 admission keeps the original priced Turn and full package pin", async () => {
  const fixture = pluginTaskFixture();
  let modeCalls = 0;
  const service = fixture.create({
    host: {
      ...fixture.dependencies.host,
      taskAdmissionMode() {
        modeCalls++;
        return "installed";
      },
    },
  });
  const first = await service.createTaskFromPlugin(
    taskActor,
    taskCommand,
    taskPin,
  );
  const replay = await service.createTaskFromPlugin(
    taskActor,
    taskCommand,
    taskPin,
  );
  assert.equal(first.run.disposition, "committed");
  assert.equal(replay.run.disposition, "replayed");
  assert.equal(replay.binding.runId, first.binding.runId);
  assert.deepEqual(replay.creditAdmission, first.creditAdmission);
  assert.equal(first.creditAdmission?.reservation.quotedCredits, "3");
  assert.equal(modeCalls, 1);
  assert.equal(fixture.state.quoteCalls, 1);
  assert.equal(fixture.state.commits.length, 1);
  assert.equal(fixture.state.receipts.size, 1);
  const admission = fixture.state.admissions.get(first.binding.runId)!;
  for (const key of Object.keys(taskPin) as (keyof typeof taskPin)[])
    assert.equal(admission[key], taskPin[key]);
});

test("a historical v0 receipt replays before the installed classifier or current readiness", async () => {
  const fixture = pluginTaskFixture();
  const first = await fixture
    .create({ creditQuotes: undefined })
    .createTask(taskActor, taskCommand);
  const counters = {
    ids: fixture.state.ids,
    clocks: fixture.state.clocks,
    configurationReads: fixture.state.configurationReads,
  };
  const replay = await fixture
    .create({
      host: {
        ...fixture.dependencies.host,
        taskAdmissionMode(): never {
          assert.fail("old receipt must not require current admission mode");
        },
        async evaluate(): Promise<never> {
          assert.fail("old receipt must not require current readiness");
        },
      },
    })
    .createTask(taskActor, taskCommand);
  assert.equal(replay.run.disposition, "replayed");
  assert.equal(replay.binding.runId, first.binding.runId);
  assert.equal(replay.creditAdmission, undefined);
  assert.deepEqual(
    {
      ids: fixture.state.ids,
      clocks: fixture.state.clocks,
      configurationReads: fixture.state.configurationReads,
    },
    counters,
  );
  assert.equal(fixture.state.quoteCalls, 0);
  assert.equal(fixture.state.commits.length, 1);
});

test("an explicit legacy classifier remains compatible with v0", async () => {
  const fixture = pluginTaskFixture();
  let calls = 0;
  const result = await fixture
    .create({
      creditQuotes: undefined,
      host: {
        ...fixture.dependencies.host,
        taskAdmissionMode() {
          calls++;
          return "legacy";
        },
      },
    })
    .createTask(taskActor, taskCommand);
  assert.equal(result.run.disposition, "committed");
  assert.equal(result.creditAdmission, undefined);
  assert.equal(calls, 1);
});

test("unknown or unavailable admission decisions cannot fall back to v0", async () => {
  for (const mode of [null, undefined, "future-mode"] as const) {
    const fixture = pluginTaskFixture();
    await assert.rejects(
      fixture
        .create({
          host: {
            ...fixture.dependencies.host,
            taskAdmissionMode: () => mode as never,
          },
        })
        .createTask(taskActor, taskCommand),
      applicationError("internal", "extension_task_admission_mode_invalid"),
    );
    assertNoTaskWrite(fixture);
  }
  const fixture = pluginTaskFixture();
  const failure = new Error("classifier-unavailable");
  await assert.rejects(
    fixture
      .create({
        host: {
          ...fixture.dependencies.host,
          taskAdmissionMode() {
            throw failure;
          },
        },
      })
      .createTask(taskActor, taskCommand),
    (error: unknown) =>
      applicationError("internal", "extension_service_unavailable")(error) &&
      (error as ApplicationError).cause === failure,
  );
  assertNoTaskWrite(fixture);
});

test("the bound classifier cannot be replaced during an earlier receipt await", async () => {
  const fixture = pluginTaskFixture();
  let originalCalls = 0;
  let replacementCalls = 0;
  const host: ExtensionHostPort = {
    ...fixture.dependencies.host,
    taskAdmissionMode() {
      assert.equal(this, host);
      originalCalls++;
      return "installed";
    },
  };
  const service = fixture.create({ host });
  fixture.state.onReceipt = () => {
    host.taskAdmissionMode = () => {
      replacementCalls++;
      return "legacy";
    };
  };
  await assert.rejects(
    service.createTask(taskActor, taskCommand),
    applicationError("conflict", "installed_plugin_task_admission_required"),
  );
  assert.equal(originalCalls, 1);
  assert.equal(replacementCalls, 0);
  assertNoTaskWrite(fixture);
});

test("registration identity must be verified before asking the host admission mode", async () => {
  const fixture = pluginTaskFixture();
  const saved = fixture.dependencies.catalog.resolve({
    pluginId: taskCommand.pluginId,
    pluginVersion: "0.1.0",
  })!;
  let calls = 0;
  await assert.rejects(
    fixture
      .create({
        catalog: {
          list: () => [],
          resolve: () => ({
            ...saved,
            implementationDigest: `sha256:${"f".repeat(64)}`,
          }),
        },
        host: {
          ...fixture.dependencies.host,
          taskAdmissionMode() {
            calls++;
            return "installed";
          },
        },
      })
      .createTask(taskActor, taskCommand),
    applicationError("conflict", "extension_implementation_unavailable"),
  );
  assert.equal(calls, 0);
  assertNoTaskWrite(fixture);
});
