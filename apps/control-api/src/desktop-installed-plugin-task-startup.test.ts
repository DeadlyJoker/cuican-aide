import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { createStandaloneControlApiWithPlugins } from "./standalone-composition.ts";
import { nativeTaskAuthorityFixture } from "./desktop-installed-plugin-task-authority.test-support.ts";
import {
  DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_ENV,
  parseDesktopInstalledPluginTaskConfig,
} from "./desktop-installed-plugin-task-environment.ts";
import {
  captureDesktopInstalledPluginTaskStartup,
  snapshotDesktopInstalledPluginTaskEnvironment,
} from "./desktop-installed-plugin-task-startup.ts";

const nativeOnly = { skip: process.platform === "win32", timeout: 20_000 };

test("absent Native task opt-in does not inspect unrelated or inherited secret values", () => {
  let read = 0;
  const environment = Object.create({
    TEST_NATIVE_TASK_POLICY_TOKEN: "inherited-secret",
  });
  Object.defineProperty(environment, "UNRELATED_SECRET", {
    enumerable: true,
    get: () => {
      read++;
      throw new Error("secret getter must not execute");
    },
  });
  assert.equal(
    snapshotDesktopInstalledPluginTaskEnvironment(environment),
    undefined,
  );
  assert.equal(read, 0);
});

test("Native Main task environment is a detached descriptor snapshot with no getter execution", () => {
  let getters = 0;
  const environment = {
    [DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_ENV]: "/private/named/tasks.json",
    TEST_NATIVE_TASK_POLICY_TOKEN: "t".repeat(32),
  };
  Object.defineProperty(environment, "UNRELATED_SECRET", {
    enumerable: true,
    get: () => {
      getters++;
      return "must-not-capture";
    },
  });
  const captured = snapshotDesktopInstalledPluginTaskEnvironment(environment);
  assert.ok(captured);
  environment.TEST_NATIVE_TASK_POLICY_TOKEN = "later-secret";
  environment[DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_ENV] =
    "/private/later/tasks.json";
  assert.equal(captured.TEST_NATIVE_TASK_POLICY_TOKEN, "t".repeat(32));
  assert.equal(
    captured[DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_ENV],
    "/private/named/tasks.json",
  );
  assert.equal(Object.hasOwn(captured, "UNRELATED_SECRET"), false);
  assert.equal(Object.isFrozen(captured), true);
  assert.equal(getters, 0);
});

test("Native task opt-in accessors and non-data paths are rejected without evaluating them", () => {
  let getters = 0;
  const environment = Object.defineProperty(
    {},
    DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_ENV,
    {
      enumerable: true,
      get: () => {
        getters++;
        return "/private/named/tasks.json";
      },
    },
  );
  assert.throws(
    () => snapshotDesktopInstalledPluginTaskEnvironment(environment),
    /desktop_installed_plugin_task_configuration_invalid/u,
  );
  assert.equal(getters, 0);
  assert.throws(
    () =>
      snapshotDesktopInstalledPluginTaskEnvironment({
        [DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_ENV]: 123 as unknown as string,
      }),
    /desktop_installed_plugin_task_configuration_invalid/u,
  );
});

test(
  "Standalone task startup preserves the exact current private-file issue and activation reference",
  nativeOnly,
  async (t) => {
    const f = await nativeTaskAuthorityFixture(t);
    const input = {
      desktopPluginTasks: f.binding.tasks,
      desktopPluginActivation: f.activation,
    };
    const captured = captureDesktopInstalledPluginTaskStartup(
      input,
      f.binding.configuration,
    );
    assert.equal(captured.tasks, f.binding.tasks);
    assert.equal(captured.activation, f.activation);
    assert.equal(Object.isFrozen(captured), true);
    input.desktopPluginTasks = parseDesktopInstalledPluginTaskConfig(
      f.taskDocument,
      f.environment,
    );
    assert.equal(captured.tasks, f.binding.tasks);
    assert.throws(
      () =>
        captureDesktopInstalledPluginTaskStartup(
          input,
          f.binding.configuration,
        ),
      /desktop_installed_plugin_task_configuration_invalid/u,
    );
  },
);

test(
  "programmatic Native execution config cannot cross the real Standalone FileIssued entry or allocate a fresh SQLite file",
  nativeOnly,
  async (t) => {
    const f = await nativeTaskAuthorityFixture(t);
    const tasks = parseDesktopInstalledPluginTaskConfig(
      f.taskDocument,
      f.environment,
    );
    const databasePath = join(f.root, "named-refused-standalone-task.sqlite");
    await assert.rejects(
      createStandaloneControlApiWithPlugins({
        desktopPlugins: f.binding.configuration,
        desktopPluginActivation: f.activation,
        desktopPluginTasks: tasks,
        databasePath,
        actor: f.binding.configuration.actor,
        defaultAgentVersionId:
          f.activation.publication.entries[0]!.target.agentVersionId,
        sessionToken: "named-refused-session-" + "s".repeat(32),
        csrfToken: "named-refused-csrf-" + "c".repeat(32),
        allowedOrigins: ["crewon://desktop"],
        artifactStore: new InMemoryArtifactStore(),
        artifactEncryptionKeyId: "named-refused-artifact-key",
      }),
      /desktop_installed_plugin_task_configuration_invalid/u,
    );
    await assert.rejects(lstat(databasePath), { code: "ENOENT" });
    const db = new DatabaseSync(f.databasePath);
    try {
      assert.equal(
        Number(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('plugin_task_admissions','plugin_credit_reservations')",
            )
            .get()!.n,
        ),
        0,
      );
    } finally {
      db.close();
    }
  },
);

test(
  "missing activation and accessors cannot be promoted into a Native startup approval",
  nativeOnly,
  async (t) => {
    const f = await nativeTaskAuthorityFixture(t);
    assert.throws(() =>
      captureDesktopInstalledPluginTaskStartup(
        { desktopPluginTasks: f.binding.tasks },
        f.binding.configuration,
      ),
    );
    let getters = 0;
    const input = Object.defineProperty({}, "desktopPluginTasks", {
      enumerable: true,
      get: () => {
        getters++;
        return f.binding.tasks;
      },
    });
    assert.throws(
      () =>
        captureDesktopInstalledPluginTaskStartup(
          input,
          f.binding.configuration,
        ),
      /desktop_installed_plugin_task_configuration_invalid/u,
    );
    assert.equal(getters, 0);
    assert.throws(
      () =>
        captureDesktopInstalledPluginTaskStartup(
          Object.create({ desktopPluginTasks: f.binding.tasks }),
          f.binding.configuration,
        ),
      /desktop_installed_plugin_task_configuration_invalid/u,
    );
  },
);
