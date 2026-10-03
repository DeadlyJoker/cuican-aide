import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { access, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
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
import { installedReleaseProcessPackages } from "../../runtime-worker/src/installed-plugin-release-process.test-support.ts";
import { installedPluginReleaseDigester as digester } from "../../runtime-worker/src/plugins/installed-plugin-release-document.ts";
import {
  installTaskProcessPackages,
  prepareTaskProcessReleaseInput,
} from "./installed-plugin-tasks-process-release.test-support.ts";
import {
  taskProcessAuthorities,
  taskProcessFreePort,
  taskProcessBffToken,
  taskProcessCreditScope,
  taskProcessPeerToken,
  taskProcessServiceToken,
} from "./installed-plugin-tasks-process-authorities.test-support.ts";
import { waitTaskProcess } from "./installed-plugin-tasks-process.test-support.ts";
import {
  createFullAppEdge,
  fullAppLogin,
} from "./installed-plugin-full-app-edge.test-support.ts";
import { fullAppStoreFacts } from "./installed-plugin-full-app-facts.test-support.ts";
import { createFullAppInstallationAuthority } from "./installed-plugin-full-app-authority.test-support.ts";
import {
  startFullAppProcess,
  stopFullAppProcess,
  fullAppPortClosed,
} from "./installed-plugin-full-app-process.test-support.ts";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
type Cleanup = () => unknown | Promise<unknown>;

/** Named identity/funding/model/supplier fixtures around unchanged formal Web, Control, BFF, CLI and Worker entries. */
export async function installedPluginFullAppFixture(
  t: TestContext,
  options: Readonly<{ connectionString?: string; uiDirectory?: string }> = {},
) {
  const connectionString =
    options.connectionString ?? process.env.CREWON_TEST_POSTGRES_URL;
  assert.ok(
    connectionString,
    "full App proof requires the Root-owned actual PostgreSQL URL",
  );
  const callbacks: Cleanup[] = [];
  const context = {
    after(callback: Cleanup) {
      callbacks.push(callback);
    },
    diagnostic(message: string) {
      t.diagnostic(message);
    },
  } as TestContext;
  const schema = `full_app_${randomUUID().replaceAll("-", "")}`;
  const applicationName = `crewon_${schema}`;
  const databaseUrl = new URL(connectionString);
  databaseUrl.searchParams.set("application_name", applicationName);
  const actualConnection = databaseUrl.href;
  const database = new Pool({ connectionString, max: 1 });
  const children: InstalledProcessChild[] = [];
  const ports: number[] = [];
  let store: PostgresDomainStore | null = null;
  let edge: Awaited<ReturnType<typeof createFullAppEdge>> | null = null;
  let directory: string | null = null;
  let closing: Promise<void> | null = null;
  let cleanup: Readonly<{
    children: readonly {
      pid: number | undefined;
      code: number | null;
      signal: NodeJS.Signals | null;
    }[];
    connections: number;
    schemaRemoved: boolean;
    portsClosed: boolean;
    ownedDirectoryRemoved: boolean;
    physicalCallbacksJoined: boolean;
  }> | null = null;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      const attempt = async (operation: Cleanup) => {
        try {
          await operation();
        } catch (error) {
          failures.push(error);
        }
      };
      await attempt(async () => {
        await edge?.close();
      });
      for (const child of [...children].reverse())
        await attempt(() => stopFullAppProcess(child));
      for (const callback of [...callbacks].reverse()) await attempt(callback);
      await attempt(async () => {
        await store?.close();
      });
      await attempt(async () => {
        await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      });
      const connections = await database.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1",
        [applicationName],
      );
      const schemas = await database.query<{ exists: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS exists",
        [schema],
      );
      let ownedDirectoryRemoved = true;
      if (directory) {
        try {
          await access(directory);
          ownedDirectoryRemoved = false;
        } catch {
          /* Owned fixture has removed its private directory. */
        }
      }
      cleanup = Object.freeze({
        children: await Promise.all(
          children.map(async (child) => ({
            pid: child.child.pid,
            ...(await child.completion),
          })),
        ),
        connections: connections.rows[0]!.count,
        schemaRemoved: !schemas.rows[0]!.exists,
        portsClosed: (await Promise.all(ports.map(fullAppPortClosed))).every(
          Boolean,
        ),
        ownedDirectoryRemoved,
        physicalCallbacksJoined: failures.length === 0,
      });
      await database.end();
      if (failures.length)
        throw new AggregateError(failures, "full_app_fixture_cleanup_failed");
      assert.equal(cleanup.connections, 0);
      assert.equal(cleanup.schemaRemoved, true);
      assert.equal(cleanup.portsClosed, true);
      assert.equal(cleanup.ownedDirectoryRemoved, true);
    });
    return closing;
  };
  t.after(close);
  try {
    const workerFixture = await installedWorkerProcessFixture(context);
    directory = workerFixture.directory;
    const supplier = await professionalProviderFixture(context);
    const authority = await taskProcessAuthorities(context);
    ports.push(
      new URL(supplier.baseUrl).port
        ? Number(new URL(supplier.baseUrl).port)
        : 0,
      Number(new URL(authority.origin).port),
      Number(new URL(workerFixture.endpoint).port),
    );
    edge = await createFullAppEdge(
      options.uiDirectory ?? join(repository, "apps/crewon-ui/dist"),
    );
    ports.push(edge.port);
    const browserEdge = edge;
    workerFixture.environment.CREWON_CONTROL_DATABASE_URL = actualConnection;
    workerFixture.environment.CREWON_CONTROL_DATABASE_SCHEMA = schema;
    store = await PostgresDomainStore.open({
      connectionString: actualConnection,
      schema,
      maxPoolSize: 1,
    });
    const actualStore = store;
    const registrations = await installTaskProcessPackages({
      fixture: workerFixture,
      store: actualStore,
    });
    assert.equal(registrations.length, 2);
    const installationAuthority = await createFullAppInstallationAuthority();
    callbacks.push(installationAuthority.close);
    ports.push(installationAuthority.port);
    const pluginId = registrations[0]!.identity.pluginId;
    const select = async (index: number, state: "disabled" | "enabled") => {
      const identity = registrations[index]!.identity;
      const ledger = actualStore.pluginInstallationStore();
      const current = await ledger.loadSelection({ scope, pluginId });
      assert.ok(current);
      const key = `named-full-app-select-${index}-${state}`;
      return (
        await ledger.commitSelection({
          scope,
          actor,
          expectedSelectionRevision: current.revision,
          selection: {
            ...current,
            revision: current.revision + 1,
            state,
            selectedPackageDigest: identity.packageDigest,
            updatedAt: new Date().toISOString(),
            updatedByActorId: actor.actorId,
            updatedByPrincipalId: actor.principalId,
          },
          receipt: { idempotencyKey: key, requestDigest: digester.sha256(key) },
        })
      ).selection;
    };
    const endpoint = (path: string) => ({
      url: `${authority.origin}/${path}`,
      serviceTokenEnvironmentVariable: "NAMED_PROCESS_CONTROL_AUTHORITY_TOKEN",
    });
    const metadataPath = join(directory, "full-app-control-configuration.json");
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
    const keyPath = join(directory, "full-app-artifact-key");
    await writeFile(keyPath, randomBytes(32), { mode: 0o600 });
    const controlPort = await taskProcessFreePort(),
      bffPort = await taskProcessFreePort(),
      peerPort = await taskProcessFreePort();
    ports.push(controlPort, bffPort, peerPort);
    let controlEnvironment: NodeJS.ProcessEnv = {
      ...workerFixture.environment,
      CREWON_CONTROL_SECURITY_MODE: "production",
      CREWON_CONTROL_PORT: String(controlPort),
      CREWON_CONTROL_BFF_TOKEN: taskProcessBffToken,
      CREWON_BFF_ALLOWED_ORIGINS: browserEdge.origin,
      CREWON_BFF_ALLOWED_REMOTE_ADDRESSES: "127.0.0.1",
      CREWON_IDENTITY_VERIFY_URL: `${authority.origin}/verify`,
      CREWON_IDENTITY_SERVICE_TOKEN: taskProcessServiceToken,
      CREWON_IDENTITY_EXPECTED_ISSUER: "https://named-process-identity.example",
      CREWON_IDENTITY_EXPECTED_AUDIENCE: "crewon-control",
      CREWON_POLICY_DECISION_URL: `${authority.origin}/policy`,
      CREWON_POLICY_SERVICE_TOKEN: taskProcessServiceToken,
      CREWON_SECURITY_AUTHORITY_TIMEOUT_MS: "10000",
      CREWON_ARTIFACT_RETENTION: "off",
      CREWON_ARTIFACT_ROOT: join(directory, "artifacts"),
      CREWON_ARTIFACT_DB_PATH: join(directory, "artifacts.sqlite"),
      CREWON_ARTIFACT_ENCRYPTION_KEY_PATH: keyPath,
      CREWON_ARTIFACT_ENCRYPTION_KEY_ID: "named-full-app-key",
      CREWON_INSTALLED_PLUGIN_CONFIGURATION_CONFIG_PATH:
        await realpath(metadataPath),
      NAMED_PROCESS_CONTROL_AUTHORITY_TOKEN: taskProcessServiceToken,
      NAMED_PROCESS_PEER_TOKEN: taskProcessPeerToken,
      CREWON_OUTBOX_SCAN_INTERVAL_MS: "30",
      CREWON_OUTBOX_RETENTION_MS: "off",
      CREWON_AUTOMATION_SCAN_INTERVAL_MS: "10000",
      CREWON_PLUGIN_INSTALLATION_ENABLED: "1",
      CREWON_PLUGIN_INSTALLATION_INSTALL_ROOT: workerFixture.installRoot,
      CREWON_PLUGIN_INSTALLATION_SOURCES_JSON: JSON.stringify(
        registrations.map((registration, index) => ({
          sourceId: `named-full-app-approved-report-${index + 1}`,
          directory: installedReleaseProcessPackages[index],
          ...registration.identity,
        })),
      ),
      CREWON_PLUGIN_INSTALLATION_PROFILE_AUTHORITY_URL: `${authority.origin}/profile`,
      CREWON_PLUGIN_INSTALLATION_PROFILE_AUTHORITY_TOKEN:
        taskProcessServiceToken,
      CREWON_PLUGIN_INSTALLATION_POLICY_AUTHORITY_URL: `${installationAuthority.origin}/installation-policy`,
      CREWON_PLUGIN_INSTALLATION_POLICY_AUTHORITY_TOKEN:
        taskProcessServiceToken,
      CREWON_PLUGIN_INSTALLATION_AUTHORITY_TIMEOUT_MS: "10000",
    };
    const start = (
      entry: "control" | "bff",
      changes: NodeJS.ProcessEnv = {},
    ) => {
      const child = startFullAppProcess(entry, {
        ...controlEnvironment,
        ...changes,
      });
      children.push(child);
      return child;
    };
    let control = start("control");
    await waitTaskProcess(
      "full App metadata Control",
      async () => control.stdout().includes("CrewON Control API listening"),
      [control],
    );
    const bff = start("bff", {
      CREWON_WEB_PUBLIC_ORIGIN: browserEdge.origin,
      CREWON_CONTROL_TARGET: `http://127.0.0.1:${controlPort}`,
      CREWON_CONTROL_CSRF_TOKEN:
        "named-full-app-control-csrf-" + "c".repeat(32),
      CREWON_WEB_CSRF_SECRET: "named-full-app-browser-csrf-" + "s".repeat(32),
      CREWON_IDENTITY_SESSION_URL: `${authority.origin}/session`,
      CREWON_WEB_BFF_PORT: String(bffPort),
    });
    await waitTaskProcess(
      "full App BFF",
      async () => bff.stdout().includes("CrewON Web BFF listening"),
      [control, bff],
    );
    browserEdge.target(`http://127.0.0.1:${bffPort}`);
    const session = await browserEdge.request("/control-api/session");
    assert.equal(session.status, 200, session.text);
    const csrfToken = session.body.csrfToken as string;
    assert.equal(typeof csrfToken, "string");
    const request = (
      path: string,
      body?: unknown,
      method = body === undefined ? "GET" : "POST",
      idempotencyKey?: string,
    ) => browserEdge.request(path, body, method, csrfToken, idempotencyKey);
    const configurationValue = {
      organization: "Named full Web App organization",
      providerBaseUrl: `${supplier.baseUrl}/`,
    };
    const configurations: unknown[] = [];
    for (const [index, registration] of registrations.entries()) {
      if (index !== 0) await select(index, "disabled");
      const catalog = await request("/api/v1/extensions");
      assert.equal(catalog.status, 200, catalog.text);
      assert.equal(
        catalog.body.extensions[0].pluginVersion,
        registration.identity.version,
      );
      const saved = await request(
        `/api/v1/extensions/${pluginId}/configuration`,
        {
          pluginVersion: registration.identity.version,
          expectedRevision: index,
          parameters: configurationValue,
          credentialBindings: [],
        },
        "PUT",
        `named-full-app-configuration-${index}`,
      );
      assert.equal(saved.status, 200, saved.text);
      assert.equal(saved.body.configuration.revision, index + 1);
      configurations.push(saved.body.configuration);
    }
    await stopFullAppProcess(control);
    const prepared = await prepareTaskProcessReleaseInput({
      fixture: workerFixture,
      store: actualStore,
      registrations,
      configurations,
    });
    const release = workerFixture.start("release");
    children.push(release);
    const released = await installedProcessCompletion(release);
    assert.equal(released.code, 0, release.stderr());
    assert.equal(
      JSON.parse(release.stdout()).releaseId,
      prepared.plan.bundle.releaseId,
    );
    const credits = actualStore.pluginCreditStore();
    await credits.migrate();
    assert.equal(await credits.getAccount(taskProcessCreditScope), null);
    await credits.grant({
      scope: taskProcessCreditScope,
      grantId: "named-full-app-test-funding-only",
      credits: "100",
    });
    const selection = await select(1, "enabled");
    const workerEnvironment: NodeJS.ProcessEnv = {
      CREWON_CONTROL_SECURITY_MODE: "production",
      CREWON_WORKER_ONCE: "0",
      CREWON_WORKER_SCAN_INTERVAL_MS: "30",
      CREWON_INSTALLED_PLUGIN_PEER_PORT: String(peerPort),
      CREWON_INSTALLED_PLUGIN_PEER_TOKEN: taskProcessPeerToken,
      CREWON_INSTALLED_PLUGIN_PEER_DEADLINE_MS: "10000",
    };
    const startWorker = () => {
      const child = workerFixture.start("worker", workerEnvironment);
      children.push(child);
      return child;
    };
    let worker = startWorker();
    const waitWorker = () =>
      waitTaskProcess(
        "full App Worker peer",
        async () =>
          worker
            .stdout()
            .includes(
              `CrewON Installed Plugin Peer origin http://127.0.0.1:${peerPort}`,
            ),
        [worker],
      );
    await waitWorker();
    const taskPath = join(directory, "full-app-control-tasks.json");
    await writeFile(
      taskPath,
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
      CREWON_INSTALLED_PLUGIN_TASK_CONFIG_PATH: await realpath(taskPath),
      CREWON_PLUGIN_UI_ENABLED: "1",
      CREWON_PLUGIN_UI_INSTALL_ROOT: workerFixture.installRoot,
      CREWON_PLUGIN_UI_PROFILE_AUTHORITY_URL: `${authority.origin}/profile`,
      CREWON_PLUGIN_UI_PROFILE_AUTHORITY_TOKEN: taskProcessServiceToken,
      CREWON_PLUGIN_UI_POLICY_AUTHORITY_URL: `${authority.origin}/policy`,
      CREWON_PLUGIN_UI_POLICY_AUTHORITY_TOKEN: taskProcessServiceToken,
      CREWON_PLUGIN_UI_AUTHORITY_TIMEOUT_MS: "10000",
      CREWON_PLUGIN_UI_PUBLICATIONS_JSON: JSON.stringify(
        registrations.map(
          ({ identity: { version: _version, ...identity } }) => ({
            ...identity,
            publicAssets: ["ui.mjs"],
          }),
        ),
      ),
    };
    control = start("control");
    const waitControl = () =>
      waitTaskProcess(
        "full App task Control",
        async () => control.stdout().includes("CrewON Control API listening"),
        [control, bff, worker],
      );
    await waitControl();
    const activation = await request(
      `/api/v1/extensions/${pluginId}/activation`,
      {
        configurationRevision: 2,
        expectedRevision: 0,
        state: "enabled",
        agentVersionId: prepared.document.entries[1]!.version.agentVersionId,
      },
      "PUT",
      "named-full-app-activate-v2",
    );
    assert.equal(activation.status, 200, activation.text);
    assert.deepEqual(
      activation.body.activation.target,
      prepared.document.entries[1]!.target,
    );
    const storeFacts = (
      query: Readonly<{ runId?: string; threadId?: string }> = {},
    ) => fullAppStoreFacts({ database, store: actualStore, schema, ...query });
    assert.deepEqual((await storeFacts()).counts, {
      threads: 0,
      runs: 0,
      admissions: 0,
      holds: 0,
    });
    assert.equal(supplier.requests().length, 0);
    t.diagnostic(
      "operator prerequisites: verified immutable package install/selection, real HTTP configurations, unique release CLI and HTTP activation; only named test funding/identity/quote/model/supplier. Browser actions have not created a Thread or Run.",
    );
    const reportSubject = "Actual formal Worker fixture report";
    const expectedReportText = `professional:2.0.0:${configurationValue.organization}:${reportSubject}`;
    return Object.freeze({
      origin: browserEdge.origin,
      schema,
      actor,
      scope,
      packageIdentity: registrations[1]!.identity,
      selection,
      browser: Object.freeze({
        origin: browserEdge.origin,
        certificateFingerprint: browserEdge.certificateFingerprint,
        caPath: join(directory, "test-authority-ca.pem"),
      }),
      login: fullAppLogin,
      configurationValue,
      configurationRevision: 2,
      reportSubject,
      expectedReportText,
      expectedTranscriptText: `answer:${expectedReportText}`,
      request,
      storeFacts,
      supplierRequests: supplier.requests,
      supplierReports: supplier.reports,
      modelRequests: () => [...workerFixture.modelRequests],
      browserRequests: browserEdge.requests,
      edgeFailures: browserEdge.failures,
      authorityRequests: () =>
        authority.state.requests.map(({ path, body }) => ({
          path,
          action: typeof body.action === "string" ? body.action : null,
        })),
      installationAuthorityRequests: installationAuthority.requests,
      staticProof: browserEdge.staticProof,
      async waitForRun(runId: string) {
        await waitTaskProcess(
          `full App Run ${runId}`,
          async () =>
            (await actualStore.loadRunInSpace({ ...actor, runId }))?.status ===
            "completed",
          [control, bff, worker],
        );
        return {
          ...(await storeFacts({ runId })),
          supplierReports: supplier.reports(),
        };
      },
      async reopenControl() {
        await stopFullAppProcess(control);
        control = start("control");
        await waitControl();
      },
      async reopenWorker() {
        await stopFullAppProcess(worker);
        worker = startWorker();
        await waitWorker();
      },
      close,
      cleanupProof() {
        assert.ok(
          cleanup,
          "cleanup proof is only available after actual close",
        );
        return cleanup;
      },
    });
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "full_app_fixture_startup_and_cleanup_failed",
      );
    }
    throw error;
  }
}
