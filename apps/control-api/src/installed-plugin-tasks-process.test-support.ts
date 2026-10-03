import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PostgresDomainStore } from "@crewon/store";
import { Pool } from "pg";
import {
  installedProcessActor as actor,
  installedProcessScope as scope,
  installedProcessCompletion,
  installedWorkerProcessFixture,
  type InstalledProcessChild,
} from "../../runtime-worker/src/installed-plugin-worker-process.test-support.ts";
import { professionalProviderFixture } from "../../runtime-worker/src/installed-plugin-ui-business-execution.provider.test-support.ts";
import { installedPluginReleaseDigester as digester } from "../../runtime-worker/src/plugins/installed-plugin-release-document.ts";
import {
  installTaskProcessPackages,
  prepareTaskProcessReleaseInput,
} from "./installed-plugin-tasks-process-release.test-support.ts";
import {
  taskProcessAuthorities,
  taskProcessBrowserEdge,
  taskProcessFreePort,
  taskProcessBffToken,
  taskProcessCreditScope,
  taskProcessPeerToken,
  taskProcessServiceToken,
} from "./installed-plugin-tasks-process-authorities.test-support.ts";

const repository = fileURLToPath(new URL("../../..", import.meta.url));

export async function waitTaskProcess(
  description: string,
  ready: () => Promise<boolean>,
  children: readonly InstalledProcessChild[] = [],
) {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    for (const child of children)
      if (child.finished())
        throw new Error(
          `${description}: child exited\n${child.stdout()}\n${child.stderr()}`,
        );
    if (await ready()) return;
    await delay(30);
  }
  throw new Error(
    `named_task_process_wait_timeout:${description}\n${children.map((c) => c.stderr()).join("\n")}`,
  );
}

async function stopChild(child: InstalledProcessChild) {
  if (!child.finished()) child.child.kill("SIGTERM");
  const result = await installedProcessCompletion(child).catch(
    async (error) => {
      child.child.kill("SIGKILL");
      await child.completion;
      throw error;
    },
  );
  assert.equal(result.code, 0, child.stderr());
  assert.equal(result.signal, null);
}

/** Real PostgreSQL, CLI release and installed bytes. No direct task Application admission is available here. */
export async function installedTaskProcessFixture(t: TestContext) {
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
  assert.ok(
    connectionString,
    "actual process proof requires the Root-owned PostgreSQL URL",
  );
  const workerFixture = await installedWorkerProcessFixture(t);
  const supplier = await professionalProviderFixture(t);
  const authority = await taskProcessAuthorities(t);
  const browser = await taskProcessBrowserEdge(t);
  const schema = `installed_tasks_process_${randomUUID().replaceAll("-", "")}`;
  const database = new Pool({ connectionString, max: 1 });
  const children: InstalledProcessChild[] = [];
  let closed = false;
  let store: PostgresDomainStore | null = null;
  const close = async () => {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    try {
      for (const child of [...children].reverse()) {
        try {
          await stopChild(child);
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await store?.close();
      } catch (error) {
        failures.push(error);
      }
    } finally {
      try {
        await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await database.end();
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "named_task_process_cleanup_failed");
  };
  t.after(close);
  workerFixture.environment.CREWON_CONTROL_DATABASE_URL = connectionString;
  workerFixture.environment.CREWON_CONTROL_DATABASE_SCHEMA = schema;
  store = await PostgresDomainStore.open({
    connectionString,
    schema,
    maxPoolSize: 1,
  });
  const registrations = await installTaskProcessPackages({
    fixture: workerFixture,
    store,
  });
  t.diagnostic(
    "operator prerequisite: actual verifier/installer immutable bytes and installation ledger only; configurations and activation must use original HTTP, Agents/releases must use the actual CLI",
  );

  async function select(
    index: number,
    options: Readonly<{ state: "disabled" | "enabled" }> = { state: "enabled" },
  ) {
    const identity = registrations[index]!.identity;
    const ledger = store!.pluginInstallationStore();
    const current = await ledger.loadSelection({
      scope,
      pluginId: identity.pluginId,
    });
    assert.ok(current);
    // Explicit operator installation selection; activation and task creation use HTTP below.
    const result = await ledger.commitSelection({
      scope,
      actor,
      expectedSelectionRevision: current.revision,
      selection: {
        ...current,
        revision: current.revision + 1,
        state: options.state,
        selectedPackageDigest: identity.packageDigest,
        updatedAt: new Date().toISOString(),
        updatedByActorId: actor.actorId,
        updatedByPrincipalId: actor.principalId,
      },
      receipt: {
        idempotencyKey: `named-test-select-${index}-${options.state}`,
        requestDigest: digester.sha256(
          `named-test-select-${index}-${options.state}`,
        ),
      },
    });
    return result.selection;
  }
  const endpoint = (path: string) => ({
    url: `${authority.origin}/${path}`,
    serviceTokenEnvironmentVariable: "NAMED_PROCESS_CONTROL_AUTHORITY_TOKEN",
  });
  const metadataPath = join(
    workerFixture.directory,
    "control-configuration.json",
  );
  await writeFile(
    metadataPath,
    JSON.stringify({
      schemaVersion: "crewon.installed-plugin-control-configuration.v1",
      installRoot: workerFixture.installRoot,
      profileAuthority: endpoint("profile"),
      packageAuthority: endpoint("package"),
      timeoutMs: 10000,
      maximumPackages: 2,
    }),
    { mode: 0o600 },
  );
  const keyPath = join(workerFixture.directory, "artifact-encryption-key");
  await writeFile(keyPath, randomBytes(32), { mode: 0o600 });
  const controlPort = await taskProcessFreePort(),
    bffPort = await taskProcessFreePort();
  const controlOrigin = `http://127.0.0.1:${controlPort}`;
  let controlEnvironment: NodeJS.ProcessEnv = {
    ...workerFixture.environment,
    CREWON_CONTROL_SECURITY_MODE: "production",
    CREWON_CONTROL_PORT: String(controlPort),
    CREWON_CONTROL_BFF_TOKEN: taskProcessBffToken,
    CREWON_BFF_ALLOWED_ORIGINS: browser.origin,
    CREWON_BFF_ALLOWED_REMOTE_ADDRESSES: "127.0.0.1",
    CREWON_IDENTITY_VERIFY_URL: `${authority.origin}/verify`,
    CREWON_IDENTITY_SERVICE_TOKEN: taskProcessServiceToken,
    CREWON_IDENTITY_EXPECTED_ISSUER: "https://named-process-identity.example",
    CREWON_IDENTITY_EXPECTED_AUDIENCE: "crewon-control",
    CREWON_POLICY_DECISION_URL: `${authority.origin}/policy`,
    CREWON_POLICY_SERVICE_TOKEN: taskProcessServiceToken,
    CREWON_SECURITY_AUTHORITY_TIMEOUT_MS: "10000",
    CREWON_ARTIFACT_RETENTION: "off",
    CREWON_ARTIFACT_ROOT: join(workerFixture.directory, "artifacts"),
    CREWON_ARTIFACT_DB_PATH: join(workerFixture.directory, "artifacts.sqlite"),
    CREWON_ARTIFACT_ENCRYPTION_KEY_PATH: keyPath,
    CREWON_ARTIFACT_ENCRYPTION_KEY_ID: "named-process-key",
    CREWON_INSTALLED_PLUGIN_CONFIGURATION_CONFIG_PATH:
      await realpath(metadataPath),
    NAMED_PROCESS_CONTROL_AUTHORITY_TOKEN: taskProcessServiceToken,
    NAMED_PROCESS_PEER_TOKEN: taskProcessPeerToken,
    CREWON_OUTBOX_SCAN_INTERVAL_MS: "30",
    CREWON_OUTBOX_RETENTION_MS: "off",
    CREWON_AUTOMATION_SCAN_INTERVAL_MS: "10000",
  };
  const importCounterPath = join(
    workerFixture.directory,
    "actual-installed-module-loads.jsonl",
  );
  const importHookPath = join(
    workerFixture.directory,
    "test-only-installed-import-observer.mjs",
  );
  await writeFile(importCounterPath, "", { mode: 0o600 });
  await writeFile(
    importHookPath,
    `import {registerHooks} from 'node:module';\nimport {appendFileSync} from 'node:fs';\nconst prefix=${JSON.stringify(`${pathToFileURL(await realpath(workerFixture.installRoot)).href}/`)};\nregisterHooks({load(url,context,nextLoad){if(url.startsWith(prefix)&&/\\.m?js(?:\\?|$)/u.test(url))appendFileSync(${JSON.stringify(importCounterPath)},JSON.stringify({url})+'\\n');return nextLoad(url,context);}});\n`,
    { mode: 0o600 },
  );
  const start = (
    entry: "control" | "bff",
    changes: NodeJS.ProcessEnv = {},
    observation: Readonly<{ installedImports?: boolean }> = {},
  ) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        ...(observation.installedImports ? ["--import", importHookPath] : []),
        join(
          repository,
          `apps/${entry === "control" ? "control-api" : "web-bff"}/src/main.ts`,
        ),
      ],
      {
        cwd: repository,
        env: { ...controlEnvironment, ...changes },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.stdin.end();
    let stdout = "",
      stderr = "",
      finished = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 256 * 1024) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 256 * 1024) child.kill("SIGKILL");
    });
    const completion = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        finished = true;
        resolve({ code, signal });
      });
    });
    const owned = {
      child,
      completion,
      stdout: () => stdout,
      stderr: () => stderr,
      finished: () => finished,
    };
    children.push(owned);
    return owned;
  };
  const metadataControl = start("control", {}, { installedImports: true });
  await waitTaskProcess(
    "actual production Control",
    async () =>
      metadataControl.stdout().includes("CrewON Control API listening"),
    [metadataControl],
  );
  const bff = start("bff", {
    CREWON_WEB_PUBLIC_ORIGIN: browser.origin,
    CREWON_CONTROL_TARGET: controlOrigin,
    CREWON_CONTROL_CSRF_TOKEN: "named-bff-control-csrf-" + "c".repeat(32),
    CREWON_WEB_CSRF_SECRET: "named-browser-csrf-secret-" + "s".repeat(32),
    CREWON_IDENTITY_SESSION_URL: `${authority.origin}/session`,
    CREWON_WEB_BFF_PORT: String(bffPort),
  });
  await waitTaskProcess(
    "actual production BFF",
    async () => bff.stdout().includes("CrewON Web BFF listening"),
    [bff, metadataControl],
  );
  browser.target(`http://127.0.0.1:${bffPort}`);
  const session = await browser.request("/control-api/session");
  assert.equal(session.status, 200, session.text);
  assert.equal(typeof session.body.csrfToken, "string");
  const csrfToken = session.body.csrfToken as string;
  const request = (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    idempotencyKey?: string,
  ) => browser.request(path, { method, body, csrfToken, idempotencyKey });

  const pluginId = registrations[0]!.identity.pluginId;
  const firstSelection = await store
    .pluginInstallationStore()
    .loadSelection({ scope, pluginId });
  assert.ok(firstSelection);
  assert.equal(firstSelection.state, "disabled");
  assert.equal(
    firstSelection.selectedPackageDigest,
    registrations[0]!.identity.packageDigest,
  );
  const initialCatalog = await request("/api/v1/extensions");
  assert.equal(initialCatalog.status, 200, initialCatalog.text);
  assert.equal(initialCatalog.body.extensions.length, 1);
  assert.equal(
    initialCatalog.body.extensions[0].pluginVersion,
    registrations[0]!.identity.version,
  );
  assert.deepEqual(
    initialCatalog.body.extensions[0].configurationSchema,
    registrations[0]!.manifest.configurationSchema,
  );
  const emptyConfiguration = await request(
    `/api/v1/extensions/${pluginId}/configuration`,
  );
  assert.equal(emptyConfiguration.status, 200, emptyConfiguration.text);
  assert.equal(emptyConfiguration.body.configuration, null);
  const parameters = {
    organization: "Named HTTPS Control/BFF process supplier fixture",
    providerBaseUrl: `${supplier.baseUrl}/`,
  };
  const firstBody = {
    pluginVersion: registrations[0]!.identity.version,
    expectedRevision: 0,
    parameters,
    credentialBindings: [],
  };
  const firstConfiguration = await request(
    `/api/v1/extensions/${pluginId}/configuration`,
    firstBody,
    "PUT",
    "named-process-http-configuration-v1",
  );
  assert.equal(firstConfiguration.status, 200, firstConfiguration.text);
  assert.equal(firstConfiguration.body.disposition, "created");
  assert.equal(firstConfiguration.body.configuration.revision, 1);
  assert.equal(
    firstConfiguration.body.configuration.manifestDigest,
    registrations[0]!.manifestDigest,
  );
  assert.equal(
    firstConfiguration.body.configuration.implementationDigest,
    registrations[0]!.implementationDigest,
  );
  const absentRuntime = await request(
    `/api/v1/extensions/${pluginId}/activation`,
    {
      configurationRevision: 1,
      expectedRevision: 0,
      state: "enabled",
      agentVersionId: "installed-release-process-plugin-1",
    },
    "PUT",
    "named-process-cannot-activate-before-publication",
  );
  assert.equal(absentRuntime.status, 409, absentRuntime.text);
  assert.equal(absentRuntime.body.error.code, "extension_runtime_unavailable");
  assert.equal(
    await store.extensionStore().loadExtensionActivation({
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      pluginId,
    }),
    null,
  );

  await select(1, { state: "disabled" });
  const currentCatalog = await request("/api/v1/extensions");
  assert.equal(currentCatalog.status, 200, currentCatalog.text);
  assert.equal(currentCatalog.body.extensions.length, 1);
  assert.equal(
    currentCatalog.body.extensions[0].pluginVersion,
    registrations[1]!.identity.version,
  );
  // A committed receipt is replayed before any package/metadata validation, even after selection changes.
  authority.state.packagesAllowed = false;
  const packageReadsBeforeReplay = authority.state.requests.filter(
    (entry) => entry.path === "/package",
  ).length;
  let replayConfiguration: Awaited<ReturnType<typeof request>>;
  try {
    replayConfiguration = await request(
      `/api/v1/extensions/${pluginId}/configuration`,
      firstBody,
      "PUT",
      "named-process-http-configuration-v1",
    );
  } finally {
    authority.state.packagesAllowed = true;
  }
  assert.equal(replayConfiguration.status, 200, replayConfiguration.text);
  assert.equal(replayConfiguration.body.disposition, "replayed");
  assert.deepEqual(
    replayConfiguration.body.configuration,
    firstConfiguration.body.configuration,
  );
  assert.equal(
    authority.state.requests.filter((entry) => entry.path === "/package")
      .length,
    packageReadsBeforeReplay,
  );
  const secondConfiguration = await request(
    `/api/v1/extensions/${pluginId}/configuration`,
    {
      ...firstBody,
      pluginVersion: registrations[1]!.identity.version,
      expectedRevision: 1,
    },
    "PUT",
    "named-process-http-configuration-v2",
  );
  assert.equal(secondConfiguration.status, 200, secondConfiguration.text);
  assert.equal(secondConfiguration.body.disposition, "created");
  assert.equal(secondConfiguration.body.configuration.revision, 2);
  assert.equal(
    secondConfiguration.body.configuration.implementationDigest,
    registrations[1]!.implementationDigest,
  );

  const zeroCounts: Record<string, number> = {};
  for (const table of [
    "run_snapshots",
    "extension_run_bindings",
    "extension_external_operations",
    "extension_activations",
    "agent_versions",
    "agent_version_deployments",
    "agent_version_release_bundles",
    "agent_version_release_activations",
    "active_agent_version_releases",
  ]) {
    const count = await database.query(
      `SELECT count(*)::int AS count FROM "${schema}"."${table}"`,
    );
    zeroCounts[table] = count.rows[0].count;
    assert.equal(
      count.rows[0].count,
      0,
      `metadata-only HTTP cannot write ${table}`,
    );
  }
  const creditTables = await database.query(
    "SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename LIKE 'plugin_credit_%'",
    [schema],
  );
  assert.deepEqual(
    creditTables.rows,
    [],
    "metadata-only must not initialize personal credit tables",
  );
  assert.equal(workerFixture.modelRequests.length, 0);
  assert.equal(supplier.requests().length, 0);
  assert.equal(
    authority.state.requests.filter((entry) => entry.path === "/quote").length,
    0,
  );
  assert.equal(
    await readFile(importCounterPath, "utf8"),
    "",
    "actual Control metadata-only never imports installed ESM, so no setup/factory create can run",
  );
  await stopChild(metadataControl);
  const prepublication = {
    catalogVersions: [
      initialCatalog.body.extensions[0].pluginVersion,
      currentCatalog.body.extensions[0].pluginVersion,
    ],
    configurations: [
      firstConfiguration.body.configuration,
      secondConfiguration.body.configuration,
    ],
    replayAfterSelectionChanged: replayConfiguration.body.disposition,
    activationBeforeReleaseStatus: absentRuntime.status,
    disabledSelections: true,
    zeroCounts,
    creditTables: creditTables.rows,
    installedModuleImports: 0,
    modelRequests: 0,
    supplierRequests: 0,
    quoteRequests: 0,
    workerStarted: false,
    metadataControlClose: await metadataControl.completion,
  };
  t.diagnostic(
    "actual metadata-only HTTP saved revisions1/2 with disabled selections; no Worker/peer/release/quote/funds, no installed ESM load/setup/create, zero publication/Run/operation rows and no credit tables",
  );

  const prepared = await prepareTaskProcessReleaseInput({
    fixture: workerFixture,
    store,
    registrations,
    configurations: prepublication.configurations,
  });
  const release = workerFixture.start("release");
  assert.equal(
    (await installedProcessCompletion(release)).code,
    0,
    release.stderr(),
  );
  assert.equal(
    JSON.parse(release.stdout()).releaseId,
    prepared.plan.bundle.releaseId,
  );
  const credits = store.pluginCreditStore();
  await credits.migrate();
  assert.equal(await credits.getAccount(taskProcessCreditScope), null);
  await credits.grant({
    scope: taskProcessCreditScope,
    grantId: "named-process-test-grant-only",
    credits: "100",
  });
  const selection = await select(0);
  const peerPort = await taskProcessFreePort();
  const worker = workerFixture.start("worker", {
    CREWON_CONTROL_SECURITY_MODE: "production",
    CREWON_WORKER_ONCE: "0",
    CREWON_WORKER_SCAN_INTERVAL_MS: "30",
    CREWON_INSTALLED_PLUGIN_PEER_PORT: String(peerPort),
    CREWON_INSTALLED_PLUGIN_PEER_TOKEN: taskProcessPeerToken,
    CREWON_INSTALLED_PLUGIN_PEER_DEADLINE_MS: "10000",
  });
  children.push(worker);
  await waitTaskProcess(
    "actual Worker private peer",
    async () =>
      worker
        .stdout()
        .includes(
          `CrewON Installed Plugin Peer origin http://127.0.0.1:${peerPort}`,
        ),
    [worker],
  );
  const configPath = join(workerFixture.directory, "control-tasks.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: "crewon.installed-plugin-control-tasks.v1",
      installRoot: workerFixture.installRoot,
      peer: {
        origin: `http://127.0.0.1:${peerPort}`,
        tokenEnvironmentVariable: "NAMED_PROCESS_PEER_TOKEN",
      },
      packageAuthority: endpoint("package"),
      quoteAuthority: endpoint("quote"),
      timeoutMs: 10000,
      maximumPackages: 2,
    }),
    { mode: 0o600 },
  );
  controlEnvironment = {
    ...controlEnvironment,
    CREWON_INSTALLED_PLUGIN_CONFIGURATION_CONFIG_PATH: undefined,
    CREWON_INSTALLED_PLUGIN_TASK_CONFIG_PATH: await realpath(configPath),
    CREWON_PLUGIN_UI_ENABLED: "1",
    CREWON_PLUGIN_UI_INSTALL_ROOT: workerFixture.installRoot,
    CREWON_PLUGIN_UI_PROFILE_AUTHORITY_URL: `${authority.origin}/profile`,
    CREWON_PLUGIN_UI_PROFILE_AUTHORITY_TOKEN: taskProcessServiceToken,
    CREWON_PLUGIN_UI_POLICY_AUTHORITY_URL: `${authority.origin}/policy`,
    CREWON_PLUGIN_UI_POLICY_AUTHORITY_TOKEN: taskProcessServiceToken,
    CREWON_PLUGIN_UI_AUTHORITY_TIMEOUT_MS: "10000",
    CREWON_PLUGIN_UI_PUBLICATIONS_JSON: JSON.stringify(
      registrations.map(({ identity: { version: _version, ...identity } }) => ({
        ...identity,
        publicAssets: ["ui.mjs"],
      })),
    ),
  };
  const control = start("control");
  await waitTaskProcess(
    "actual full-task production Control",
    async () => control.stdout().includes("CrewON Control API listening"),
    [control, bff, worker],
  );
  return {
    workerFixture,
    supplier,
    authority,
    browser,
    schema,
    database,
    store,
    credits,
    prepared,
    selection,
    select,
    children: children.filter((child) => child !== metadataControl),
    prepublication,
    worker,
    control,
    bff,
    peerOrigin: `http://127.0.0.1:${peerPort}`,
    csrfToken,
    request,
    close,
  };
}
