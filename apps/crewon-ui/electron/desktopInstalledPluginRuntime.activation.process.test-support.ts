import assert from "node:assert/strict";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  parseExtensionConfiguration,
  parsePluginSelection,
  type ExtensionConfiguration,
} from "@crewon/domain";
import { installedPluginReleaseDigester as digester } from "../../runtime-worker/src/plugins/installed-plugin-release-document.ts";
import { DESKTOP_RUNTIME_OWNER as actor } from "./desktopExtensionRuntime.ts";
import { candidatePreparationSnapshot } from "./desktopInstalledPluginRuntime.candidate-preparation.test-support.ts";
import { nativeActivationAuthority } from "./desktopInstalledPluginRuntime.activation-authority.test-support.ts";
import {
  installIsolationPlugin,
  nativeIsolationProcessFixture,
  writeIsolationRuntimeConfiguration,
} from "./desktopInstalledPluginRuntime.fault-isolation.test-support.ts";
import { parseDesktopInstalledPluginRuntimeConfiguration } from "./desktopInstalledPluginRuntimeConfiguration.ts";
import {
  nativeProcessFacts,
  nativeProcessHttp,
  type NativeInstalledProcessFixtureOptions,
} from "./desktopInstalledPluginRuntime.process.test-support.ts";

/** Installation and first configuration use the unchanged Native HTTP path.
 * Explicit v3 uses the original real CLI, Worker and parent SQLite; no selection,
 * business activation, Run or funding row is written by fixture setup. */
export async function nativeActivationProcessFixture(
  input: Readonly<{
    professionalDirectory: string;
    kreaDirectory: string;
    network: "public" | "private" | "missing";
  }>,
  options: NativeInstalledProcessFixtureOptions = {},
) {
  const f = await nativeIsolationProcessFixture(
    input.professionalDirectory,
    input.kreaDirectory,
    options,
  );
  let authority:
    | Awaited<ReturnType<typeof nativeActivationAuthority>>
    | undefined;
  try {
    const auditPath = join(f.directory, "activation-child-observation.jsonl");
    const observerPath = join(f.directory, "observe-activation-runtime.mjs");
    await writeFile(observerPath, activationObserver(auditPath), {
      mode: 0o600,
    });
    process.env.NODE_OPTIONS =
      `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(observerPath).href}`.trim();
    const management = f.supervisor(false);
    await management.start();
    const installed: Awaited<ReturnType<typeof installIsolationPlugin>>[] = [];
    const configurations: ExtensionConfiguration[] = [];
    for (const source of f.sources) {
      installed.push(
        await installIsolationPlugin(management.session(), source),
      );
      const response = await nativeProcessHttp(
        management.session(),
        "PUT",
        `/api/v1/extensions/${source.pluginId}/configuration`,
        {
          pluginVersion: source.version,
          expectedRevision: 0,
          parameters:
            source.pluginId === "crewon.comfyui-krea2"
              ? {
                  baseUrl:
                    input.network === "private"
                      ? "https://127.0.0.1/"
                      : "https://8.8.8.8/",
                }
              : {
                  organization: "Actual Native activation comparison",
                  providerBaseUrl: "https://8.8.8.8/",
                },
          credentialBindings: [],
        },
        `activation-configure-${source.pluginId}`,
      );
      assert.equal(response.status, 200, await response.clone().text());
      configurations.push(
        parseExtensionConfiguration(
          (await response.json()).configuration,
          digester,
        ),
      );
    }
    await f.assertNoNodeImports();
    assert.ok(
      Object.values(nativeProcessFacts(f.databasePath).counts).every(
        (count) => count === 0,
      ),
    );
    await management.stop();
    authority = await nativeActivationAuthority(f);
    const fixedPath = await writeIsolationRuntimeConfiguration(
      f,
      f.sources.map(({ pluginId }) => pluginId),
    );
    const fixed = JSON.parse(await readFile(fixedPath, "utf8"));
    fixed.schemaVersion = "crewon.desktop-installed-plugin-runtime.v3";
    fixed.activationAuthority = {
      url: `${authority.origin}/activate`,
      serviceTokenEnvironmentVariable: "NATIVE_INSTALLED_AUTHORITY_TOKEN",
    };
    fixed.workerAuthorities.packageAuthority.url = `${authority.origin}/package`;
    fixed.workerAuthorities.networkAuthority =
      input.network === "missing"
        ? null
        : {
            url: `${authority.origin}/network`,
            serviceTokenEnvironmentVariable: "NATIVE_INSTALLED_AUTHORITY_TOKEN",
          };
    await writeFile(fixedPath, JSON.stringify(fixed));
    const parsedConfiguration =
      parseDesktopInstalledPluginRuntimeConfiguration(fixed);
    assert.ok(
      parsedConfiguration.enabled &&
        parsedConfiguration.schemaVersion ===
          "crewon.desktop-installed-plugin-runtime.v3",
    );
    const configuration = parsedConfiguration;
    const currentScope = await f.currentProfile();
    assert.ok(currentScope);
    const scope = currentScope;
    const runtime = f.supervisor(true);
    const ownedAuthority = authority;
    function failureDiagnostics() {
      const counts = (requests: readonly Readonly<{ path: string }>[]) => ({
        total: requests.length,
        paths: Object.fromEntries(
          [
            "/actor",
            "/profile",
            "/package",
            "/policy",
            "/activate",
            "/network",
          ].map((path) => [
            path,
            requests.filter((request) => request.path === path).length,
          ]),
        ),
      });
      return {
        baseAuthority: counts(f.requests),
        activationAuthority: counts(ownedAuthority.requests),
      };
    }
    async function childObservations() {
      const text = await readFile(auditPath, "utf8");
      assert.ok(
        text.endsWith("\n"),
        "activation_observer_missing_actual_line_ending",
      );
      return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              pid: number;
              entry: string;
              activationPath: string | null;
              peerTokenPresent: boolean;
              authorityTokenPresent: boolean;
            },
        );
    }
    async function start() {
      const before = (await f.observations()).length;
      await runtime.start();
      const health = await nativeProcessHttp(
        runtime.session(),
        "GET",
        "/api/v1/health/ready",
      );
      assert.equal(health.status, 200);
      assert.ok(
        !(await health.text()).includes(
          "CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN",
        ),
      );
      const children = (await f.observations()).slice(before);
      assert.equal(children.length, 4);
      const worker = children.find(({ entry }) =>
        entry.endsWith("/runtime-worker/src/main.ts"),
      );
      const control = children.find(({ entry }) =>
        entry.endsWith("/control-api/src/main.ts"),
      );
      assert.ok(worker && control);
      assert.equal(worker.peer, true);
      assert.equal(control.nativeBootstrap, true);
      assert.equal(control.installed, false);
      assert.equal(control.task, false);
      assert.equal(control.preparation, false);
      const extra = await childObservations();
      const controlExtra = extra.findLast(({ pid }) => pid === control.pid);
      const workerExtra = extra.findLast(({ pid }) => pid === worker.pid);
      assert.ok(
        controlExtra?.activationPath &&
          controlExtra.peerTokenPresent &&
          controlExtra.authorityTokenPresent,
      );
      assert.equal(workerExtra?.activationPath, null);
      const preparation = await candidatePreparationSnapshot({
        dataDirectory: f.dataDirectory,
        scope,
        approvedPackages: f.sources.map(
          ({ sourceId: _id, directory: _directory, ...identity }) => identity,
        ),
        plugins: configuration.plugins,
        configurations,
        workerAuthorities: configuration.workerAuthorities,
      });
      const activation = await activationSnapshot(
        f.dataDirectory,
        controlExtra.activationPath,
      );
      const origins = [
        ...f.logs
          .join("")
          .matchAll(
            /CrewON Installed Plugin Peer origin (http:\/\/127\.0\.0\.1:[1-9][0-9]*)/gu,
          ),
      ];
      const origin = origins.at(-1)?.[1];
      assert.ok(origin);
      assert.deepEqual(activation.document, {
        schemaVersion: "crewon.desktop-installed-plugin-activation.v1",
        actor,
        scope,
        installRoot: join(f.dataDirectory, "plugins"),
        peer: {
          origin,
          tokenEnvironmentVariable:
            "CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN",
        },
        authority: configuration.activationAuthority,
        timeoutMs: 10_000,
        entries: preparation.document.entries.map((entry) => ({
          identity: {
            ...entry.packageIdentity,
            manifestDigest: entry.configuration.manifestDigest,
            implementationDigest: entry.configuration.implementationDigest,
          },
          configuration: entry.configuration,
          target: entry.target,
        })),
      });
      return {
        preparation,
        activation,
        workerPid: worker.pid,
        controlPid: control.pid,
      };
    }
    const started = await start();
    await f.assertNoNodeImports();
    const owned = {
      ...f,
      authority: ownedAuthority,
      installed,
      configurations,
      configuration,
      fixedPath,
      runtime,
      ...started,
      start,
      childObservations,
      async installedImports() {
        const text = await readFile(
          join(f.directory, "plugin-node-imports.jsonl"),
          "utf8",
        );
        return text
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { pid: number; url: string });
      },
      async removeKreaDeployment() {
        // Fault injection touches only this fixture's actual published Krea deployment.
        // Do not rebind an immutable version, replace an asset, or remove a trigger.
        assert.equal(await realpath(f.databasePath), f.databasePath);
        assert.ok(f.databasePath.startsWith(f.directory + "/"));
        const metadata = await lstat(f.databasePath);
        assert.ok(metadata.isFile() && !metadata.isSymbolicLink());
        assert.equal(metadata.uid, process.getuid?.());
        const entry = started.preparation.document.entries.find(
          ({ packageIdentity }) =>
            packageIdentity.pluginId === "crewon.comfyui-krea2",
        );
        assert.ok(entry);
        const database = new DatabaseSync(f.databasePath);
        try {
          database.exec("PRAGMA foreign_keys=ON");
          const all = () =>
            database
              .prepare(
                "SELECT * FROM agent_version_deployments ORDER BY tenant_id,agent_version_id",
              )
              .all();
          const before = all();
          const savedSelection = database
            .prepare(
              "SELECT record_json FROM plugin_profile_selections WHERE tenant_id=? AND space_id=? AND profile_id=? AND plugin_id=?",
            )
            .get(
              scope.tenantId,
              scope.spaceId,
              scope.profileId,
              entry.packageIdentity.pluginId,
            );
          assert.ok(
            savedSelection && typeof savedSelection.record_json === "string",
          );
          const installedSelection = installed.find(
            ({ selection }) =>
              selection.pluginId === entry.packageIdentity.pluginId,
          );
          assert.ok(installedSelection);
          assert.deepEqual(
            parsePluginSelection(JSON.parse(savedSelection.record_json)),
            parsePluginSelection({
              schemaVersion: "crewon.plugin-selection.v1",
              ...scope,
              ...installedSelection.selection,
              updatedByActorId: actor.actorId,
              updatedByPrincipalId: actor.principalId,
            }),
          );
          assert.equal(
            Number(
              database
                .prepare(
                  "SELECT count(*) AS count FROM plugin_installation_receipts WHERE kind='select'",
                )
                .get()!.count,
            ),
            0,
          );
          const existing = database
            .prepare(
              "SELECT deployment_json FROM agent_version_deployments WHERE tenant_id=? AND agent_version_id=?",
            )
            .get(scope.tenantId, entry.target.agentVersionId);
          assert.ok(existing && typeof existing.deployment_json === "string");
          const deployment = JSON.parse(existing.deployment_json) as Record<
            string,
            unknown
          >;
          assert.equal(
            deployment.contentDigest,
            entry.target.agentVersionContentDigest,
          );
          assert.equal(
            deployment.materializationDigest,
            entry.target.materializationDigest,
          );
          assert.equal(deployment.authorityId, entry.target.authorityId);
          assert.equal(
            deployment.workspaceBindingId,
            entry.target.workspaceBindingId,
          );
          const changed = database
            .prepare(
              "DELETE FROM agent_version_deployments WHERE tenant_id=? AND agent_version_id=?",
            )
            .run(scope.tenantId, entry.target.agentVersionId);
          assert.equal(changed.changes, 1);
          assert.deepEqual(
            all(),
            before.filter(
              (row) =>
                !(
                  row.tenant_id === scope.tenantId &&
                  row.agent_version_id === entry.target.agentVersionId
                ),
            ),
          );
          return entry.target;
        } finally {
          database.close();
        }
      },
      selectionReceiptCount() {
        const database = new DatabaseSync(f.databasePath, { readOnly: true });
        try {
          return Number(
            database
              .prepare(
                "SELECT count(*) AS count FROM plugin_installation_receipts WHERE kind='select'",
              )
              .get()!.count,
          );
        } finally {
          database.close();
        }
      },
      async close() {
        const errors: unknown[] = [];
        try {
          await runtime.stop();
        } catch (error) {
          errors.push(error);
        }
        try {
          await ownedAuthority.close();
        } catch (error) {
          errors.push(error);
        }
        // Snapshot only bounded error codes/operators and route counts before the
        // original fixture retires its owned directory. No body, message or token.
        const diagnostics = failureDiagnostics();
        try {
          await f.close();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length)
          throw new AggregateError(
            errors,
            `native_activation_fixture_cleanup_failed ${JSON.stringify({
              ...diagnostics,
              errors: errors
                .slice(0, 8)
                .map((error) => safeActivationError(error)),
            })}`,
          );
      },
    };
    return owned;
  } catch (error) {
    const errors: unknown[] = [error];
    try {
      await authority?.close();
    } catch (cleanup) {
      errors.push(cleanup);
    }
    try {
      await f.close();
    } catch (cleanup) {
      errors.push(cleanup);
    }
    throw new AggregateError(errors, "native_activation_fixture_failed");
  }
}
export type NativeActivationFixture = Awaited<
  ReturnType<typeof nativeActivationProcessFixture>
>;

export async function activationDirectories(dataDirectory: string) {
  return (await readdir(dataDirectory)).filter((name) =>
    /^\.installed-plugin-activation-/u.test(name),
  );
}
export async function activationSnapshot(dataDirectory: string, path: string) {
  const names = await activationDirectories(dataDirectory);
  assert.equal(names.length, 1);
  const directory = join(dataDirectory, names[0]!);
  assert.equal(path, join(directory, "activation.json"));
  const metadata = await lstat(directory);
  assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink());
  assert.equal(metadata.uid, process.getuid?.());
  assert.equal(metadata.mode & 0o777, 0o700);
  assert.deepEqual(await readdir(directory), ["activation.json"]);
  const file = await lstat(path);
  assert.ok(file.isFile() && !file.isSymbolicLink());
  assert.equal(file.uid, metadata.uid);
  assert.equal(file.mode & 0o777, 0o600);
  assert.equal(file.nlink, 1);
  const bytes = await readFile(path);
  const document: Record<string, unknown> = JSON.parse(bytes.toString("utf8"));
  return {
    directory,
    ino: metadata.ino,
    path,
    fileIno: file.ino,
    bytes,
    document,
  };
}
export async function selection(f: NativeActivationFixture, pluginId: string) {
  const response = await nativeProcessHttp(
    f.runtime.session(),
    "GET",
    `/api/v1/plugins/selections/${pluginId}`,
  );
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).selection;
}
export async function moduleEnable(
  f: NativeActivationFixture,
  pluginId: string,
  revision = 1,
  key = `native-v3-enable-${pluginId}`,
) {
  const source = f.sources.find((value) => value.pluginId === pluginId);
  assert.ok(source);
  return nativeProcessHttp(
    f.runtime.session(),
    "PUT",
    `/api/v1/plugins/selections/${pluginId}`,
    {
      expectedSelectionRevision: revision,
      selectedPackageDigest: source.packageDigest,
      state: "enabled",
    },
    key,
  );
}
export function businessActivate(
  f: NativeActivationFixture,
  pluginId: string,
  input?: Readonly<{
    expectedRevision?: number;
    configurationRevision?: number;
    state?: "enabled" | "disabled" | "revoked";
    agentVersionId?: string;
    key?: string;
  }>,
) {
  const state = input?.state ?? "enabled";
  const entry = f.preparation.document.entries.find(
    ({ packageIdentity }) => packageIdentity.pluginId === pluginId,
  );
  assert.ok(entry);
  return nativeProcessHttp(
    f.runtime.session(),
    "PUT",
    `/api/v1/extensions/${pluginId}/activation`,
    {
      state,
      expectedRevision: input?.expectedRevision ?? 0,
      configurationRevision:
        input?.configurationRevision ?? entry.configuration.revision,
      agentVersionId:
        state === "enabled"
          ? (input?.agentVersionId ?? entry.target.agentVersionId)
          : null,
    },
    input?.key ?? `native-v3-activate-${pluginId}`,
  );
}
export async function assertActivationNoPluginExecution(
  f: NativeActivationFixture,
  ordinaryRun = false,
) {
  const facts = nativeProcessFacts(f.databasePath);
  for (const [table, count] of Object.entries(facts.counts))
    if (
      /^(?:plugin_(?:task|query_task)_admissions|extension_(?:run_bindings|external_operation))/u.test(
        table,
      ) ||
      (!ordinaryRun &&
        !/^(?:agent_version|active_agent_version|extension_activations)/u.test(
          table,
        ))
    )
      assert.equal(count, 0, table);
  assert.equal(
    facts.tables.some((table) => /credit|quote|charge/u.test(table)),
    false,
  );
  assert.equal(f.model.requests.length, ordinaryRun ? 1 : 0);
  assert.equal(f.modelRequests(), 0);
  assert.equal(f.supplierRequests(), 0);
  assert.equal(f.model.supplierRequests(), 0);
  assert.equal(
    f.authority.requests.some(({ body }) => body.kind === "run"),
    false,
  );
}
function safeActivationError(error: unknown, depth = 0): unknown {
  if (depth >= 4 || !(error instanceof Error)) return { name: "UnknownError" };
  const text = (key: string, pattern: RegExp) => {
    let current: object | null = error;
    for (
      let i = 0;
      current && i < 3;
      i++, current = Object.getPrototypeOf(current)
    ) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) {
        const value = "value" in descriptor ? descriptor.value : null;
        return typeof value === "string" && pattern.test(value) ? value : null;
      }
    }
    return null;
  };
  const cause = Object.getOwnPropertyDescriptor(error, "cause");
  const errors = Object.getOwnPropertyDescriptor(error, "errors");
  return {
    name: text("name", /^(?:Error|[A-Za-z][A-Za-z0-9]*Error)$/u),
    code: text("code", /^[A-Za-z][A-Za-z0-9_:-]{0,127}$/u),
    category: text("category", /^[A-Za-z]{1,32}$/u),
    operator: text("operator", /^(?:[=!<>]{1,3}|[A-Za-z]{1,32})$/u),
    ...(cause && "value" in cause
      ? { cause: safeActivationError(cause.value, depth + 1) }
      : {}),
    ...(errors && "value" in errors && Array.isArray(errors.value)
      ? {
          errors: errors.value
            .slice(0, 8)
            .map((value: unknown) => safeActivationError(value, depth + 1)),
        }
      : {}),
  };
}
function activationObserver(auditPath: string) {
  return `import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(auditPath)},JSON.stringify({pid:process.pid,entry:process.argv[1],activationPath:process.env.CREWON_DESKTOP_INSTALLED_PLUGIN_ACTIVATION_CONFIG_PATH??null,peerTokenPresent:!!process.env.CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN,authorityTokenPresent:!!process.env.NATIVE_INSTALLED_AUTHORITY_TOKEN})+'\\n',{mode:0o600});`;
}
