import {
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { inspect } from "node:util";
import { expect, it } from "vitest";
import { prepareAutomaticDesktopInstalledPluginRuntime } from "./desktopAutomaticInstalledPluginRuntime.ts";
import {
  withFixture,
  type Fixture,
} from "./desktopAutomaticInstalledPluginRuntime.test-support.ts";
import {
  createDesktopInstalledPluginRuntimeActivationFiles,
  type DesktopInstalledPluginActivationFiles,
} from "./desktopInstalledPluginActivationFiles.ts";
import {
  DESKTOP_ACTIVATABLE_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
  DESKTOP_TASK_ENABLED_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
  loadDesktopInstalledPluginRuntimeConfiguration,
  parseDesktopInstalledPluginRuntimeConfiguration,
} from "./desktopInstalledPluginRuntimeConfiguration.ts";
import {
  captureDesktopInstalledPluginTaskRuntimePublication,
  failDesktopInstalledPluginTaskPublicationCapture,
} from "./desktopInstalledPluginTaskRuntimePublication.ts";

const PATH = "CREWON_DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_PATH";
const secret = "native-independent-task-secret-canary-0000000000000000";
const authority = (name: string) => ({
  url: `https://native-task-publication.example/${name}`,
  serviceTokenEnvironmentVariable: `NATIVE_TASK_${name.toUpperCase()}_TOKEN`,
});
function settings(f: Fixture) {
  return {
    taskPolicyAuthority: authority("policy"),
    uiPolicyAuthority: authority("ui"),
    packageAuthority: authority("package"),
    quoteAuthority: authority("quote"),
    uiPublications: [
      {
        pluginId: f.source.pluginId,
        packageDigest: f.source.packageDigest,
        contributionId: "short-drama.studio",
      },
    ],
    timeoutMs: 1_000,
    maximumPackages: 4,
  };
}
function configuration(f: Fixture, taskExecution = settings(f)) {
  const value = {
    ...f.value,
    schemaVersion: DESKTOP_TASK_ENABLED_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
    activationAuthority: authority("activation"),
    taskExecution,
  };
  f.write(value);
  const result = loadDesktopInstalledPluginRuntimeConfiguration(
    f.dataDirectory,
  );
  if (!result.enabled) throw new Error("fixture v4 required");
  return { result, value };
}
function tokens(f: Fixture) {
  return Object.fromEntries(
    [
      settings(f).taskPolicyAuthority,
      settings(f).uiPolicyAuthority,
      settings(f).packageAuthority,
      settings(f).quoteAuthority,
      authority("activation"),
    ].map(({ serviceTokenEnvironmentVariable }) => [
      serviceTokenEnvironmentVariable,
      secret,
    ]),
  );
}
function activation(f: Fixture) {
  return createDesktopInstalledPluginRuntimeActivationFiles({
    dataDirectory: f.dataDirectory,
    bootstrap: f.bootstrap,
    origin: "http://127.0.0.1:43101",
    authority: authority("activation"),
    timeoutMs: 1_000,
    entries: f.release.entries.map((entry) => ({
      identity: {
        ...entry.packageIdentity,
        manifestDigest: entry.configuration.manifestDigest,
        implementationDigest: entry.configuration.implementationDigest,
      },
      configuration: entry.configuration,
      configuredTarget: {
        ...entry.target,
        executionAuthority: "crewonKernel" as const,
      },
    })),
  });
}

it("genuine v1/v2/v3 configurations read no task secrets or companion input, and parsed DTOs cannot issue publication", async () => {
  await withFixture(async (f) => {
    for (const value of [
      f.operatorConfiguration,
      f.value,
      {
        ...f.value,
        schemaVersion: DESKTOP_ACTIVATABLE_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
        activationAuthority: authority("activation"),
      },
    ]) {
      f.write(value);
      const config = loadDesktopInstalledPluginRuntimeConfiguration(
        f.dataDirectory,
      );
      if (!config.enabled) throw new Error("fixture issued config required");
      const input = {
        configuration: config,
        get dataDirectory(): string {
          throw new Error("old-path-must-not-read-task-input");
        },
        get bootstrap(): Fixture["bootstrap"] {
          throw new Error("old-path-must-not-read-task-input");
        },
        get sharedEnvironment(): NodeJS.ProcessEnv {
          throw new Error("old-path-must-not-read-task-secret");
        },
        get workerEnvironment(): NodeJS.ProcessEnv {
          throw new Error("old-path-must-not-read-task-secret");
        },
      };
      expect(captureDesktopInstalledPluginTaskRuntimePublication(input)).toBe(
        null,
      );
      const parsed = parseDesktopInstalledPluginRuntimeConfiguration(value);
      if (!parsed.enabled) throw new Error("fixture DTO enabled required");
      const parsedInput = Object.create(Object.getPrototypeOf(input), {
        ...Object.getOwnPropertyDescriptors(input),
        configuration: { value: parsed, enumerable: true },
      });
      expect(() =>
        captureDesktopInstalledPluginTaskRuntimePublication(parsedInput),
      ).toThrow(/unissued/);
    }
    expect(
      readdirSync(f.dataDirectory).filter((name) =>
        name.startsWith(".installed-plugin-tasks-"),
      ),
    ).toEqual([]);
  });
});

it("captures four task refs before awaits, strips every default projection, and issues one file only for the actual activation owner", async () => {
  await withFixture(async (f) => {
    const { result: config } = configuration(f);
    const shared: NodeJS.ProcessEnv = {
      ...f.input.sharedEnvironment,
      ...tokens(f),
      [PATH]: "/ambient/unissued.json",
    };
    const worker: NodeJS.ProcessEnv = { ...shared };
    const publication = captureDesktopInstalledPluginTaskRuntimePublication({
      configuration: config,
      dataDirectory: f.dataDirectory,
      bootstrap: f.bootstrap,
      sharedEnvironment: shared,
      workerEnvironment: worker,
    })!;
    let actual: DesktopInstalledPluginActivationFiles | undefined;
    try {
      for (const name of publication.environmentNames) {
        shared[name] = "changed-after-capture";
        worker[name] = "changed-after-capture";
      }
      const projected = publication.project(shared);
      for (const name of publication.environmentNames)
        expect(projected[name]).toBeUndefined();
      expect(projected[PATH]).toBeUndefined();
      expect(projected.CREWON_CONTROL_SESSION_TOKEN).toBe(
        f.input.sharedEnvironment.CREWON_CONTROL_SESSION_TOKEN,
      );
      expect(
        readdirSync(f.dataDirectory).filter((name) =>
          name.startsWith(".installed-plugin-tasks-"),
        ),
      ).toEqual([]);
      actual = activation(f);
      expect(() =>
        publication.controlAfterPeer(projected, { ...actual! }),
      ).toThrow(/unissued/);
      const control = publication.controlAfterPeer(projected, actual);
      for (const name of publication.environmentNames)
        expect(control[name]).toBe(secret);
      expect(readFileSync(control[PATH]!, "utf8")).not.toContain(secret);
      expect(JSON.stringify(publication)).not.toContain(secret);
      expect(inspect(publication)).not.toContain(secret);
      expect(publication.controlAfterPeer(control, actual)).toEqual(control);
      expect(
        readdirSync(f.dataDirectory).filter((name) =>
          name.startsWith(".installed-plugin-tasks-"),
        ),
      ).toHaveLength(1);
      const other = activation(f);
      try {
        expect(() => publication.controlAfterPeer(control, other)).toThrow(
          /owner_changed/,
        );
      } finally {
        other.close();
      }
      publication.withdraw();
      expect(() => publication.project(shared)).toThrow(/withdrawn/);
      expect(() => publication.controlAfterPeer(control, actual!)).toThrow(
        /withdrawn/,
      );
      expect(existsSync(control[PATH]!)).toBe(true);
      publication.close();
      expect(existsSync(control[PATH]!)).toBe(false);
    } finally {
      publication.close();
      actual?.close();
    }
  });
});

it("retains a same-name task ref only in the actual explicit Worker authority projection and refuses conflicting captured values", async () => {
  await withFixture(async (f) => {
    const { result: config } = configuration(f);
    const environment = { ...f.input.sharedEnvironment, ...tokens(f) };
    const publication = captureDesktopInstalledPluginTaskRuntimePublication({
      configuration: config,
      dataDirectory: f.dataDirectory,
      bootstrap: f.bootstrap,
      sharedEnvironment: environment,
      workerEnvironment: { ...environment },
    })!;
    try {
      const name = settings(f).packageAuthority.serviceTokenEnvironmentVariable;
      const worker = publication.project(environment, { [name]: secret });
      expect(worker[name]).toBe(secret);
      for (const other of publication.environmentNames.filter(
        (key) => key !== name,
      ))
        expect(worker[other]).toBeUndefined();
      expect(() =>
        publication.project(environment, { [name]: "different-task-token" }),
      ).toThrow(/conflict/);
      expect(publication.project(environment)[name]).toBeUndefined();
    } finally {
      publication.close();
    }
    expect(() =>
      captureDesktopInstalledPluginTaskRuntimePublication({
        configuration: config,
        dataDirectory: f.dataDirectory,
        bootstrap: f.bootstrap,
        sharedEnvironment: environment,
        workerEnvironment: {
          ...environment,
          NATIVE_TASK_POLICY_TOKEN:
            "different-captured-service-token-0000000000000000",
        },
      }),
    ).toThrow(/conflict/);
  });
});

it("actual automatic derived runtime preserves the initially captured task tokens and default Agent/session, then retires task and activation files", async () => {
  await withFixture(async (f) => {
    const { result: config } = configuration(f);
    if (!("workerAuthorities" in config))
      throw new Error("fixture automatic v4 required");
    const shared: NodeJS.ProcessEnv = {
        ...f.input.sharedEnvironment,
        ...tokens(f),
      },
      worker: NodeJS.ProcessEnv = { ...shared };
    const automatic = prepareAutomaticDesktopInstalledPluginRuntime({
      ...f.input,
      configuration: config,
      sharedEnvironment: shared,
      workerEnvironment: worker,
    });
    try {
      expect(automatic.preparationEnvironment[PATH]).toBeUndefined();
      for (const name of Object.keys(tokens(f)))
        expect(automatic.preparationEnvironment[name]).toBeUndefined();
      for (const name of Object.keys(tokens(f))) {
        shared[name] = "changed-after-preparation-capture";
        worker[name] = "changed-after-preparation-capture";
      }
      f.output(automatic);
      const completed = automatic.complete();
      if (completed.kind !== "installed")
        throw new Error("fixture prepared installed required");
      const runtime = completed.runtime;
      for (const environment of [
        runtime.release,
        runtime.worker,
        runtime.control,
      ]) {
        expect(environment[PATH]).toBeUndefined();
        for (const name of Object.keys(tokens(f)))
          expect(environment[name]).toBeUndefined();
        expect(environment.CREWON_AGENT_VERSION_ID).toBe(
          f.release.defaultAgentVersionId,
        );
      }
      const control = runtime.controlAfterPeer({
        origin: "http://127.0.0.1:43201",
      });
      for (const name of Object.keys(tokens(f)))
        expect(control[name]).toBe(secret);
      expect(control.CREWON_CONTROL_SESSION_TOKEN).toBe(
        f.input.sharedEnvironment.CREWON_CONTROL_SESSION_TOKEN,
      );
      expect(
        runtime.controlAfterPeer({ origin: "http://127.0.0.1:43201" }),
      ).toEqual(control);
      expect(() =>
        runtime.controlAfterPeer({ origin: "http://127.0.0.1:43202" }),
      ).toThrow(/peer_changed/);
      const tasksDirectory = dirname(control[PATH]!),
        activationDirectory = dirname(
          control.CREWON_DESKTOP_INSTALLED_PLUGIN_ACTIVATION_CONFIG_PATH!,
        );
      await automatic.close();
      expect(existsSync(tasksDirectory)).toBe(false);
      expect(existsSync(activationDirectory)).toBe(false);
      expect(() => runtime.control).toThrow(/withdrawn/);
    } finally {
      await automatic.close();
    }
  });
});

it("all-blocked preparation never issues task files or leaves task tokens in the original default path", async () => {
  await withFixture(async (f) => {
    const { result: config } = configuration(f);
    if (!("workerAuthorities" in config))
      throw new Error("fixture automatic v4 required");
    const shared = { ...f.input.sharedEnvironment, ...tokens(f) };
    const automatic = prepareAutomaticDesktopInstalledPluginRuntime({
      ...f.input,
      configuration: config,
      sharedEnvironment: shared,
      workerEnvironment: { ...shared },
    });
    try {
      f.writeResult(automatic, [
        {
          pluginId: f.source.pluginId,
          state: "blocked",
          reasonCode: "notApproved",
        },
      ]);
      const completed = automatic.complete();
      if (completed.kind !== "default")
        throw new Error("fixture original default required");
      for (const environment of [
        completed.environments.sharedEnvironment,
        completed.environments.workerEnvironment,
      ]) {
        expect(environment[PATH]).toBeUndefined();
        for (const name of Object.keys(tokens(f)))
          expect(environment[name]).toBeUndefined();
        expect(environment.CREWON_CONTROL_SESSION_TOKEN).toBe(
          f.input.sharedEnvironment.CREWON_CONTROL_SESSION_TOKEN,
        );
        expect(environment.CREWON_AGENT_VERSION_ID).toBe(
          f.release.defaultAgentVersionId,
        );
      }
      expect(
        readdirSync(f.dataDirectory).filter((name) =>
          name.startsWith(".installed-plugin-tasks-"),
        ),
      ).toEqual([]);
    } finally {
      await automatic.close();
    }
  });
});

it("actual automatic preparation/release/Worker retain a same-name task slot only when their own Worker authority explicitly declares it", async () => {
  await withFixture(async (f) => {
    const { value } = configuration(f);
    f.write({
      ...value,
      workerAuthorities: {
        ...value.workerAuthorities,
        packageAuthority: settings(f).packageAuthority,
      },
    });
    const config = loadDesktopInstalledPluginRuntimeConfiguration(
      f.dataDirectory,
    );
    if (!config.enabled || !("workerAuthorities" in config))
      throw new Error("fixture issued automatic v4 required");
    const shared = { ...f.input.sharedEnvironment, ...tokens(f) };
    const automatic = prepareAutomaticDesktopInstalledPluginRuntime({
      ...f.input,
      configuration: config,
      sharedEnvironment: shared,
      workerEnvironment: { ...shared },
    });
    try {
      const name = settings(f).packageAuthority.serviceTokenEnvironmentVariable;
      expect(automatic.preparationEnvironment[name]).toBe(secret);
      f.output(automatic);
      const completed = automatic.complete();
      if (completed.kind !== "installed")
        throw new Error("fixture installed required");
      expect(completed.runtime.release[name]).toBe(secret);
      expect(completed.runtime.worker[name]).toBe(secret);
      expect(completed.runtime.control[name]).toBeUndefined();
      for (const other of Object.keys(tokens(f)).filter(
        (key) => key !== name,
      )) {
        expect(automatic.preparationEnvironment[other]).toBeUndefined();
        expect(completed.runtime.release[other]).toBeUndefined();
        expect(completed.runtime.worker[other]).toBeUndefined();
      }
    } finally {
      await automatic.close();
    }
  });
});

it("constructor failure preserves the original and cleanup errors while withdrawing the actual captured task owner and clearing every captured role reference", async () => {
  await withFixture(async (f) => {
    const { result: config } = configuration(f);
    const shared: NodeJS.ProcessEnv = {
        ...f.input.sharedEnvironment,
        ...tokens(f),
      },
      worker: NodeJS.ProcessEnv = { ...shared };
    const publication = captureDesktopInstalledPluginTaskRuntimePublication({
      configuration: config,
      dataDirectory: f.dataDirectory,
      bootstrap: f.bootstrap,
      sharedEnvironment: shared,
      workerEnvironment: worker,
    })!;
    const authorityTokens = {
      NATIVE_INSTALLED_AUTHORITY_TOKEN:
        shared.NATIVE_INSTALLED_AUTHORITY_TOKEN!,
    };
    const activationTokens = { NATIVE_TASK_ACTIVATION_TOKEN: secret };
    const original = new Error("named_constructor_failure"),
      cleanup = new Error("named_partial_file_cleanup_failure");
    let observed: unknown;
    try {
      failDesktopInstalledPluginTaskPublicationCapture({
        error: original,
        tasks: publication,
        shared,
        worker,
        authorityTokens,
        activationTokens,
        cleanup() {
          throw cleanup;
        },
      });
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(AggregateError);
    expect((observed as AggregateError).errors).toEqual([original, cleanup]);
    expect(() => publication.assertCurrent()).toThrow(/withdrawn/);
    expect(authorityTokens).toEqual({});
    expect(activationTokens).toEqual({});
    for (const name of [
      ...publication.environmentNames,
      "NATIVE_INSTALLED_AUTHORITY_TOKEN",
      "NATIVE_TASK_ACTIVATION_TOKEN",
    ]) {
      expect(shared[name]).toBeUndefined();
      expect(worker[name]).toBeUndefined();
    }
    expect(shared.CREWON_AGENT_VERSION_ID).toBe(
      f.release.defaultAgentVersionId,
    );
    expect(shared.CREWON_CONTROL_SESSION_TOKEN).toBe(
      f.input.sharedEnvironment.CREWON_CONTROL_SESSION_TOKEN,
    );
    expect(
      readdirSync(f.dataDirectory).filter((name) =>
        name.startsWith(".installed-plugin-tasks-"),
      ),
    ).toEqual([]);
    publication.close();
  });
});

it("task cleanup failure is propagated, still closes activation, clears publication authority and retains only the unknown owned file until safe retry", async () => {
  await withFixture(async (f) => {
    const { result: config } = configuration(f);
    if (!("workerAuthorities" in config))
      throw new Error("fixture automatic v4 required");
    const shared = { ...f.input.sharedEnvironment, ...tokens(f) };
    const automatic = prepareAutomaticDesktopInstalledPluginRuntime({
      ...f.input,
      configuration: config,
      sharedEnvironment: shared,
      workerEnvironment: { ...shared },
    });
    let unexpected: string | undefined;
    try {
      f.output(automatic);
      const completed = automatic.complete();
      if (completed.kind !== "installed")
        throw new Error("fixture installed required");
      const control = completed.runtime.controlAfterPeer({
        origin: "http://127.0.0.1:43301",
      });
      const tasks = control[PATH]!,
        activationPath =
          control.CREWON_DESKTOP_INSTALLED_PLUGIN_ACTIVATION_CONFIG_PATH!;
      unexpected = join(dirname(tasks), "not-owned.json");
      writeFileSync(unexpected, "foreign", { mode: 0o600 });
      await expect(automatic.close()).rejects.toThrow(/cleanup_failed/);
      expect(existsSync(tasks)).toBe(true);
      expect(existsSync(activationPath)).toBe(false);
      expect(() => completed.runtime.control).toThrow(/withdrawn/);
      expect(inspect(automatic)).not.toContain(secret);
      unlinkSync(unexpected);
      unexpected = undefined;
      await automatic.close();
      expect(existsSync(tasks)).toBe(false);
    } finally {
      if (unexpected !== undefined && existsSync(unexpected))
        unlinkSync(unexpected);
      await automatic.close();
    }
  });
});
