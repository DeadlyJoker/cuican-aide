import assert from "node:assert/strict";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { ControlApiClient } from "@crewon/control-client";
import {
  parseDesktopInstalledPluginActivationConfiguration,
  parseDesktopInstalledPluginTaskConfiguration,
  parseInstalledPluginPeerResponse,
  type DesktopInstalledPluginTaskExecutionSettings,
} from "@crewon/contracts/plugins";
import {
  extensionCanonicalJson,
  parseExtensionManifest,
  validateCreditAccount,
} from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import { verifyLocalPluginPackage } from "../../../packages/plugin-host/src/local-plugin-package-verifier.ts";
import { parseDesktopPluginConfiguration } from "../../control-api/src/desktop-plugin-configuration.ts";
import {
  createNativeTaskMainAuthorities,
  nativeTaskMainAuthorityTokens,
} from "../../control-api/src/desktop-installed-plugin-task-main.authorities.test-support.ts";
import { fullAppPortClosed } from "../../control-api/src/installed-plugin-full-app-process.test-support.ts";
import { installedPluginReleaseDigester as digester } from "../../runtime-worker/src/plugins/installed-plugin-release-document.ts";
import { DESKTOP_RUNTIME_OWNER as actor } from "./desktopExtensionRuntime.ts";
import {
  activationSnapshot,
  businessActivate,
  moduleEnable,
  nativeActivationProcessFixture,
} from "./desktopInstalledPluginRuntime.activation.process.test-support.ts";
import { parseDesktopInstalledPluginRuntimeConfiguration } from "./desktopInstalledPluginRuntimeConfiguration.ts";
import {
  prepareNativeTaskProjectApproval,
  retainNativeProjectUiSource,
} from "./desktopInstalledPluginRuntime.projects.process.test-support.ts";
import {
  nativeProcessHttp,
  type NativeInstalledProcessFixtureOptions,
} from "./desktopInstalledPluginRuntime.process.test-support.ts";

const professional = "example.professional";
const effectTables = [
  "messages",
  "run_snapshots",
  "extension_run_bindings",
  "plugin_task_admissions",
  "extension_credit_admissions",
  "plugin_credit_reservations",
  "plugin_credit_entries",
] as const;
const tokenNames = [
  "TEST_NATIVE_TASK_POLICY_TOKEN",
  "TEST_NATIVE_UI_POLICY_TOKEN",
  "TEST_NATIVE_PACKAGE_TOKEN",
  "TEST_NATIVE_QUOTE_TOKEN",
] as const;
type ChildObservation = Readonly<{
  pid: number;
  entry: string;
  bootstrapPath: string | null;
  taskPath: string | null;
  activationPath: string | null;
  tokenPresence: Readonly<Record<(typeof tokenNames)[number], boolean>>;
}>;
type NativeActivationFixture = Awaited<
  ReturnType<typeof nativeActivationProcessFixture>
>;
type Session = ReturnType<NativeActivationFixture["runtime"]["session"]>;
type TaskSnapshot = Awaited<ReturnType<typeof taskSnapshot>>;
export type NativeTaskProcessLive = Readonly<{
  session: Session;
  client: ControlApiClient;
  controlPid: number;
  workerPid: number;
  bootstrap: ReturnType<typeof parseDesktopPluginConfiguration>;
  bootstrapPath: string;
  activation: Awaited<ReturnType<typeof activationSnapshot>>;
  task: TaskSnapshot | undefined;
  observations: readonly ChildObservation[];
  mount(): ReturnType<ControlApiClient["plugins"]["openMount"]>;
  stop(): Promise<void>;
}>;

/** Genuine Electron source Supervisor → original release/Worker/Main and installed
 * professional Node invocation. Four execution policies and 100/30 personal credits
 * are explicit named test boundaries. The original Worker remains metadata-only:
 * it may claim the admitted Run, but run:execute/extension:run and supplier IO are
 * never granted. This fixture proves admission and replay, not paid completion or
 * the compiled Electron renderer. Retained package bytes are only verified/copied. */
export async function nativeTaskProcessFixture(
  input: Readonly<{
    professionalDirectory: string;
    kreaDirectory: string;
    projectUiDirectory?: string;
  }>,
  options: NativeInstalledProcessFixtureOptions &
    Readonly<{ scenario?: "ordinary-task" | "project-recovery" }> = {},
) {
  const { scenario = "ordinary-task", ...nativeOptions } = options;
  const f = await nativeActivationProcessFixture(
    { ...input, network: "public" },
    { authorityRequestAuditLimit: 2048, ...nativeOptions },
  );
  let authorities:
    | Awaited<ReturnType<typeof createNativeTaskMainAuthorities>>
    | undefined;
  let runtime: NativeActivationFixture["runtime"] | undefined;
  let live: NativeTaskProcessLive | undefined;
  let closing: Promise<void> | undefined;
  const creditScope = Object.freeze({
    tenantId: actor.tenantId,
    principalId: actor.principalId,
    poolId: "named-electron-native-task-personal-credit-fixture",
  });
  try {
    const approvedSource = f.sources.find(
      (entry) => entry.pluginId === professional,
    );
    assert.ok(approvedSource);
    const source = approvedSource;
    const executionSource =
      scenario === "ordinary-task"
        ? source
        : f.sources.find(({ pluginId }) => pluginId === "crewon.comfyui-krea2");
    assert.ok(executionSource);
    const verified = await verifyLocalPluginPackage({
      directory: source.directory,
    });
    assert.equal(verified.packageDigest, source.packageDigest);
    assert.equal(verified.descriptor.entrypoints.node, "node.mjs");
    assert.ok(verified.descriptor.entrypoints.ui);
    assert.ok(
      verified.descriptor.contributions.some(({ id }) => id === "studio"),
    );
    assert.ok(verified.descriptor.businessManifestPath);
    const executionPackage = await verifyLocalPluginPackage({
      directory: executionSource.directory,
    });
    assert.ok(executionPackage.descriptor.businessManifestPath);
    const manifest = parseExtensionManifest(
      JSON.parse(
        await readFile(
          join(
            executionSource.directory,
            executionPackage.descriptor.businessManifestPath,
          ),
          "utf8",
        ),
      ),
    );
    const selected = await moduleEnable(f, professional);
    assert.equal(selected.status, 200, await selected.clone().text());
    assert.equal((await selected.json()).mutation.selection.revision, 2);
    const activated = await businessActivate(f, professional);
    assert.equal(activated.status, 200, await activated.clone().text());
    if (scenario === "project-recovery") {
      const executionSelected = await moduleEnable(f, executionSource.pluginId);
      assert.equal(
        executionSelected.status,
        200,
        await executionSelected.clone().text(),
      );
      assert.equal(
        (await executionSelected.json()).mutation.selection.revision,
        2,
      );
      const executionActivated = await businessActivate(
        f,
        executionSource.pluginId,
      );
      assert.equal(
        executionActivated.status,
        200,
        await executionActivated.clone().text(),
      );
    }
    const entry = f.preparation.document.entries.find(
      ({ packageIdentity }) =>
        packageIdentity.pluginId === executionSource.pluginId,
    );
    assert.ok(entry);
    const scope = await f.currentProfile();
    assert.ok(scope);
    const catalog = parseInstalledPluginPeerResponse({
      protocol: "crewon.installed-plugin-peer-response.v1",
      requestId: "named-electron-native-task-authority-catalog",
      operation: "catalog",
      actor,
      scope,
      entries: [
        {
          identity: {
            ...entry.packageIdentity,
            manifestDigest: entry.configuration.manifestDigest,
            implementationDigest: entry.configuration.implementationDigest,
          },
          manifest,
          configuration: entry.configuration,
          configuredTarget: entry.target,
        },
      ],
    });
    assert.equal(catalog.operation, "catalog");
    // Retire both actual v3 consumers before opening the separate funding connection.
    await f.runtime.stop();
    assertChildrenClosed([f.controlPid, f.workerPid]);
    const funding = new SqliteRunStore(f.databasePath);
    try {
      const credits = funding.pluginCreditStore();
      await credits.migrate();
      await credits.grant({
        scope: creditScope,
        grantId: "named-electron-native-task-100-personal-credit-test-funding",
        credits: "100",
      });
    } finally {
      await funding.close();
    }
    const uiSource =
      scenario === "project-recovery"
        ? await retainNativeProjectUiSource({
            directory: f.directory,
            dataDirectory: f.dataDirectory,
            packageDirectory: input.projectUiDirectory!,
          })
        : source;
    if (uiSource !== source) f.sources.push(uiSource);
    const projects =
      scenario === "project-recovery"
        ? await prepareNativeTaskProjectApproval({
            dataDirectory: f.dataDirectory,
            source: uiSource,
            target: executionSource,
            configuration: entry.configuration,
          })
        : undefined;
    if (projects) f.authority.expectProjectExecutionApproval();
    authorities = await createNativeTaskMainAuthorities({
      actor,
      scope,
      entry: catalog.entries[0]!,
      poolId: creditScope.poolId,
      ...(scenario === "ordinary-task"
        ? {}
        : {
            additionalPackages: [
              {
                pluginId: uiSource.pluginId,
                publisherId: uiSource.publisherId,
                version: uiSource.version,
                packageDigest: uiSource.packageDigest,
              },
            ],
          }),
    });
    const taskAuthorities = authorities;
    const endpoint = (path: string, name: (typeof tokenNames)[number]) => ({
      url: `${taskAuthorities.authorityOrigin}/${path}`,
      serviceTokenEnvironmentVariable: name,
    });
    const settings: DesktopInstalledPluginTaskExecutionSettings = {
      uiPublications: [
        {
          pluginId: uiSource.pluginId,
          packageDigest: uiSource.packageDigest,
          contributionId: scenario === "ordinary-task" ? "studio" : "workbench",
        },
        ...(scenario === "ordinary-task"
          ? []
          : [
              {
                pluginId: executionSource.pluginId,
                packageDigest: executionSource.packageDigest,
                contributionId: "studio",
              },
            ]),
      ],
      taskPolicyAuthority: endpoint("tasks", "TEST_NATIVE_TASK_POLICY_TOKEN"),
      uiPolicyAuthority: endpoint("ui", "TEST_NATIVE_UI_POLICY_TOKEN"),
      packageAuthority: endpoint("packages", "TEST_NATIVE_PACKAGE_TOKEN"),
      quoteAuthority: endpoint("quotes", "TEST_NATIVE_QUOTE_TOKEN"),
      timeoutMs: 10_000,
      maximumPackages: 8,
    };
    const v3 = JSON.parse(await readFile(f.fixedPath, "utf8"));
    const v4 = {
      ...v3,
      schemaVersion: "crewon.desktop-installed-plugin-runtime.v4",
      taskExecution: settings,
    };
    const auditPath = join(f.directory, "native-task-child-observation.jsonl");
    const observerPath = join(f.directory, "observe-native-task-runtime.mjs");
    await writeFile(observerPath, taskObserver(auditPath), { mode: 0o600 });
    process.env.NODE_OPTIONS =
      `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(observerPath).href}`.trim();
    async function observations(): Promise<readonly ChildObservation[]> {
      try {
        const bytes = await readFile(auditPath, "utf8");
        assert.ok(bytes.endsWith("\n"), "native_task_observation_incomplete");
        const lines = bytes.trim().split("\n").filter(Boolean);
        assert.ok(lines.length <= 64, "native_task_observation_limit");
        return lines.map((line) => JSON.parse(line) as ChildObservation);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return [];
        throw error;
      }
    }
    async function start(
      startOptions: Readonly<{ taskOptIn?: boolean }> = {},
    ): Promise<NativeTaskProcessLive> {
      assert.equal(closing, undefined, "native_task_fixture_closed");
      assert.equal(live, undefined, "native_task_fixture_already_running");
      const taskOptIn = startOptions.taskOptIn !== false;
      const selectedConfiguration = taskOptIn ? v4 : v3;
      // These writes are inside the inherited fixture's saved/isolated environment
      // owner. Its physical teardown restores every original variable. Explicit
      // metadata-only startup receives no independent task credential at all.
      for (const name of tokenNames)
        if (taskOptIn) process.env[name] = nativeTaskMainAuthorityTokens[name];
        else delete process.env[name];
      // Formal parser, fixed Native filename and real Supervisor startup. Do not
      // pin authorityEpoch: each genuine bootstrap uses new session entropy.
      parseDesktopInstalledPluginRuntimeConfiguration(selectedConfiguration);
      await writeFile(f.fixedPath, JSON.stringify(selectedConfiguration), {
        mode: 0o600,
      });
      // A cold Electron restart constructs a new Supervisor. Its original
      // session/CSRF fields belong to the instance, not to start()/stop().
      const taskRuntime = f.supervisor(true);
      runtime = taskRuntime;
      const before = (await observations()).length;
      try {
        await taskRuntime.start();
        const session = taskRuntime.session();
        const health = await nativeProcessHttp(
          session,
          "GET",
          "/api/v1/health/ready",
        );
        assert.equal(health.status, 200);
        const children = (await observations()).slice(before);
        assert.equal(children.length, 4);
        const control = children.find(({ entry }) =>
          entry.endsWith("/control-api/src/main.ts"),
        );
        const worker = children.find(({ entry }) =>
          entry.endsWith("/runtime-worker/src/main.ts"),
        );
        assert.ok(control?.bootstrapPath && control.activationPath && worker);
        assert.equal(worker.taskPath, null);
        for (const child of children)
          for (const name of tokenNames)
            assert.equal(
              child.tokenPresence[name],
              taskOptIn && child.pid === control.pid,
              `native_task_token_projection:${name}`,
            );
        assert.equal(control.taskPath !== null, taskOptIn);
        const bootstrap = parseDesktopPluginConfiguration(
          JSON.parse(await readFile(control.bootstrapPath, "utf8")),
        );
        assert.deepEqual(bootstrap.actor, actor);
        assert.deepEqual(bootstrap.scope, scope);
        const activation = await activationSnapshot(
          f.dataDirectory,
          control.activationPath,
        );
        const publication = parseDesktopInstalledPluginActivationConfiguration(
          activation.document,
        );
        const task =
          control.taskPath === null
            ? undefined
            : await taskSnapshot(f.dataDirectory, control.taskPath);
        if (task)
          assert.deepEqual(task.document, {
            schemaVersion: "crewon.desktop-installed-plugin-tasks.v1",
            actor,
            scope,
            authorityEpoch: bootstrap.authorityEpoch,
            installRoot: bootstrap.installRoot,
            activationDigest: digester.sha256(
              extensionCanonicalJson(publication),
            ),
            ...settings,
          });
        const client = new ControlApiClient({
          baseUrl: session.baseUrl,
          accessToken: session.sessionToken,
          csrfToken: session.csrfToken,
          origin: session.origin,
        });
        const result: NativeTaskProcessLive = {
          session,
          client,
          controlPid: control.pid,
          workerPid: worker.pid,
          bootstrap,
          bootstrapPath: control.bootstrapPath,
          activation,
          task,
          observations: children,
          mount: () =>
            client.plugins.openMount({
              pluginId: uiSource.pluginId,
              contributionId:
                scenario === "ordinary-task" ? "studio" : "workbench",
              expectedPackageDigest: uiSource.packageDigest,
              expectedSelectionRevision: 2,
            }),
          async stop() {
            assert.equal(live, result, "native_task_stale_stop");
            await taskRuntime.stop();
            assertChildrenClosed([control.pid, worker.pid]);
            assert.deepEqual(await taskDirectories(f.dataDirectory), []);
            live = undefined;
          },
        };
        live = result;
        return result;
      } catch (error) {
        try {
          await taskRuntime.stop();
        } catch (cleanup) {
          throw new AggregateError(
            [error, cleanup],
            "native_task_start_cleanup_failed",
          );
        }
        throw error;
      }
    }

    function readDatabase<T>(read: (database: DatabaseSync) => T): T {
      const database = new DatabaseSync(f.databasePath, { readOnly: true });
      try {
        return read(database);
      } finally {
        database.close();
      }
    }
    function effects(): Record<(typeof effectTables)[number], number> {
      return readDatabase(
        (database) =>
          Object.fromEntries(
            effectTables.map((table) => {
              const present = database
                .prepare(
                  "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
                )
                .get(table);
              return [
                table,
                present
                  ? Number(
                      database
                        .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
                        .get()!.n,
                    )
                  : 0,
              ];
            }),
          ) as Record<(typeof effectTables)[number], number>,
      );
    }
    function wallet() {
      return readDatabase((database) => {
        const row = database
          .prepare(
            "SELECT account_json FROM plugin_credit_accounts WHERE tenant_id=? AND principal_id=? AND pool_id=?",
          )
          .get(
            creditScope.tenantId,
            creditScope.principalId,
            creditScope.poolId,
          );
        assert.ok(row, "native_task_funded_account_missing");
        return validateCreditAccount(JSON.parse(String(row.account_json)));
      });
    }
    const readTask = (current: NativeTaskProcessLive, runId: string) =>
      current.client.getExtensionTask(executionSource.pluginId, runId);
    async function waitWorkerExecutionDenied(
      runId: string,
      waitOptions: Readonly<{ timeoutMs?: number }> = {},
    ) {
      const timeout = waitOptions.timeoutMs ?? 10_000;
      assert.ok(
        Number.isSafeInteger(timeout) && timeout >= 1 && timeout <= 29_000,
      );
      assert.ok(typeof runId === "string" && runId.length > 0);
      assert.equal(
        new URL(f.configuration.workerAuthorities.policyAuthority.url).pathname,
        "/policy",
      );
      assert.notEqual(
        f.configuration.workerAuthorities.policyAuthority.url,
        settings.taskPolicyAuthority.url,
      );
      const until = Date.now() + timeout;
      do {
        const request = f.requests.find(({ path, body }) => {
          if (path !== "/policy" || body.action !== "run:execute") return false;
          const resource = body.resource;
          return (
            resource !== null &&
            typeof resource === "object" &&
            !Array.isArray(resource) &&
            (resource as Record<string, unknown>).runId === runId
          );
        });
        if (request) {
          assert.deepEqual(Object.keys(request.body).sort(), [
            "action",
            "actor",
            "resource",
          ]);
          assert.deepEqual(request.body.actor, actor);
          const resource = request.body.resource as Record<string, unknown>;
          assert.deepEqual(Object.keys(resource).sort(), [
            "kind",
            "runId",
            "spaceId",
            "tenantId",
            "threadId",
          ]);
          assert.equal(resource.kind, "run");
          assert.equal(resource.tenantId, actor.tenantId);
          assert.equal(resource.spaceId, actor.spaceId);
          assert.equal(resource.runId, runId);
          assert.ok(
            typeof resource.threadId === "string" &&
              resource.threadId.length > 0,
          );
          // This is the original metadata TLS server's actual request log. Its
          // /policy handler only allows extension:read and agentVersion:read;
          // run:execute returns native_metadata_only_no_execution. Return the
          // observed request, without inventing a response or terminal Run state.
          return request;
        }
        const remaining = until - Date.now();
        if (remaining <= 0) break;
        await delay(Math.min(25, remaining));
      } while (Date.now() < until);
      throw new Error("native_task_worker_execution_denial_not_observed");
    }
    async function waitTaskStable(
      current: NativeTaskProcessLive,
      runId: string,
      waitOptions: Readonly<{ timeoutMs?: number }> = {},
    ) {
      const timeout = waitOptions.timeoutMs ?? 45_000;
      assert.ok(
        Number.isSafeInteger(timeout) && timeout >= 1 && timeout <= 60_000,
      );
      const until = Date.now() + timeout;
      let signature: string | undefined;
      let stable = 0;
      do {
        const result = await readTask(current, runId);
        const snapshot = {
          task: result.task,
          effects: effects(),
          wallet: wallet(),
        };
        const terminal = ["completed", "failed", "canceled"].includes(
          result.task.runStatus,
        );
        const actual = JSON.stringify(snapshot);
        stable = terminal && actual === signature ? stable + 1 : 0;
        signature = actual;
        if (stable >= 2) return snapshot;
        await delay(50);
      } while (Date.now() < until);
      throw new Error("native_task_actual_run_did_not_stabilize");
    }
    return {
      directory: f.directory,
      dataDirectory: f.dataDirectory,
      databasePath: f.databasePath,
      fixedPath: f.fixedPath,
      actor,
      scope,
      source: uiSource,
      executionSource,
      projects,
      creditScope,
      settings,
      configuration: v4,
      metadata: f,
      state: taskAuthorities.state,
      start,
      observations,
      effects,
      wallet,
      readTask,
      waitWorkerExecutionDenied,
      waitTaskStable,
      taskDirectories: () => taskDirectories(f.dataDirectory),
      countQuotes: () =>
        taskAuthorities.state.requests.filter(({ role }) => role === "quote")
          .length,
      withdrawTaskToken() {
        taskAuthorities.state.statuses.task = 401;
      },
      command(
        commandInput: Readonly<{
          threadId: string;
          expectedThreadRevision: number;
          idempotencyKey: string;
          subject?: string;
        }>,
      ) {
        return {
          action: "report.generate",
          input: {
            threadId: commandInput.threadId,
            expectedThreadRevision: commandInput.expectedThreadRevision,
            idempotencyKey: commandInput.idempotencyKey,
            input: {
              subject:
                commandInput.subject ??
                "Named Electron original professional task",
            },
          },
        };
      },
      assertNoSupplierExecution() {
        assert.equal(f.modelRequests(), 0);
        assert.equal(f.supplierRequests(), 0);
        assert.equal(f.model.requests.length, 0);
        assert.equal(f.model.supplierRequests(), 0);
        assert.equal(
          f.authority.requests.some(({ body }) => body.kind === "run"),
          false,
        );
        // The generic authority's unused peer cannot substitute for the original
        // real Worker catalog/readiness challenge and runtime factory borrowing.
        assert.equal(taskAuthorities.state.peerRequests.length, 0);
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "native_task_fixture_setup_cleanup_failed",
      );
    }
    throw error;
  }

  function close(): Promise<void> {
    return (closing ??= (async () => {
      const errors: unknown[] = [];
      try {
        await runtime?.stop();
      } catch (error) {
        errors.push(error);
      }
      if (live) {
        try {
          assertChildrenClosed([live.controlPid, live.workerPid]);
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await authorities?.close();
        if (authorities)
          for (const port of authorities.ports)
            assert.equal(
              await fullAppPortClosed(port),
              true,
              "native_task_authority_port_leaked",
            );
      } catch (error) {
        errors.push(error);
      }
      // Original teardown joins all Supervisor children, HTTPS bodies and only
      // then retires its owned root/restores the isolated process environment.
      try {
        await f.close();
      } catch (error) {
        errors.push(error);
      }
      if (authorities && authorities.state.failures.length)
        errors.push(
          new Error(
            "native_task_authority_fixture_protocol_failed:" +
              authorities.state.failures.join(";"),
          ),
        );
      if (errors.length)
        throw new AggregateError(errors, "native_task_fixture_cleanup_failed");
    })());
  }
}

async function taskDirectories(dataDirectory: string) {
  return (await readdir(dataDirectory)).filter((name) =>
    name.startsWith(".installed-plugin-tasks-"),
  );
}
async function taskSnapshot(dataDirectory: string, path: string) {
  const directory = dirname(path);
  assert.equal(dirname(directory), dataDirectory);
  assert.ok(
    directory.startsWith(join(dataDirectory, ".installed-plugin-tasks-")),
  );
  assert.equal(path, join(directory, "tasks.json"));
  assert.deepEqual(await taskDirectories(dataDirectory), [
    directory.slice(dataDirectory.length + 1),
  ]);
  const parent = await lstat(directory);
  assert.ok(parent.isDirectory() && !parent.isSymbolicLink());
  assert.equal(parent.uid, process.getuid?.());
  assert.equal(parent.mode & 0o777, 0o700);
  assert.deepEqual(await readdir(directory), ["tasks.json"]);
  const file = await lstat(path);
  assert.ok(file.isFile() && !file.isSymbolicLink());
  assert.equal(file.uid, parent.uid);
  assert.equal(file.mode & 0o777, 0o600);
  assert.equal(file.nlink, 1);
  const bytes = await readFile(path);
  const document = parseDesktopInstalledPluginTaskConfiguration(
    JSON.parse(bytes.toString("utf8")),
  );
  return {
    directory,
    path,
    document,
    bytes,
    ino: parent.ino,
    fileIno: file.ino,
  };
}
function assertChildrenClosed(pids: readonly number[]) {
  for (const pid of pids)
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}
function taskObserver(path: string) {
  return `import {appendFileSync} from 'node:fs';
const names=${JSON.stringify(tokenNames)};
appendFileSync(${JSON.stringify(path)},JSON.stringify({pid:process.pid,entry:process.argv[1],bootstrapPath:process.env.CREWON_DESKTOP_PLUGIN_BOOTSTRAP_PATH??null,taskPath:process.env.CREWON_DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_PATH??null,activationPath:process.env.CREWON_DESKTOP_INSTALLED_PLUGIN_ACTIVATION_CONFIG_PATH??null,tokenPresence:Object.fromEntries(names.map(name=>[name,!!process.env[name]]))})+'\\n',{mode:0o600});`;
}
