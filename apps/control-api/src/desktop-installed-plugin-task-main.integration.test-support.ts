import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ControlApiClient } from "@crewon/control-client";
import {
  parseDesktopInstalledPluginActivationConfiguration,
  parseDesktopInstalledPluginTaskConfiguration,
  parseInstalledPluginPeerResponse,
} from "@crewon/contracts/plugins";
import { extensionCanonicalJson, validateCreditAccount } from "@crewon/domain";
import { seedThread } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
import { TEST_CA_CERT } from "../../device-gateway/src/mtls-test-certificates.test-support.ts";
import type { InstalledProcessChild } from "../../runtime-worker/src/installed-plugin-worker-process.test-support.ts";
import {
  actor,
  scope,
  target,
  nativeTaskAuthorityFixture,
  nativeTaskDigester,
} from "./desktop-installed-plugin-task-authority.test-support.ts";
import { nativeConfigurationManifest } from "./desktop-plugin-configuration.test-support.ts";
import {
  createNativeTaskMainAuthorities,
  nativeTaskMainAuthorityTokens,
} from "./desktop-installed-plugin-task-main.authorities.test-support.ts";
import {
  startFullAppProcess,
  stopFullAppProcess,
  fullAppPortClosed,
} from "./installed-plugin-full-app-process.test-support.ts";

const creditScope = Object.freeze({
  tenantId: actor.tenantId,
  principalId: actor.principalId,
  poolId: "named-native-main-personal-credit-fixture",
});
const effectTables = Object.freeze([
  "messages",
  "run_snapshots",
  "extension_run_bindings",
  "plugin_task_admissions",
  "extension_credit_admissions",
  "plugin_credit_reservations",
  "plugin_credit_entries",
] as const);
export type NativeTaskMainStartOptions = Readonly<{
  taskOptIn?: boolean;
  environmentOverrides?: Record<string, string | undefined>;
}>;
type ChildRecord = {
  child: InstalledProcessChild;
  port: number;
  expectedReject: boolean;
  stopped: Promise<void> | undefined;
};

/** Actual installed files/SQLite prerequisites, followed by the untouched formal Main
 * child and HTTP handlers. Deployment/readiness, five PDPs, 100-credit test funding and
 * the 30-credit quote are named offline fixtures, not production grants or a Worker. */
export async function nativeTaskMainFixture(t: TestContext) {
  const originalCleanup: (() => Promise<void>)[] = [];
  const children: ChildRecord[] = [];
  let authorities:
    | Awaited<ReturnType<typeof createNativeTaskMainAuthorities>>
    | undefined;
  let active: ChildRecord | undefined;
  let sequence = 0;
  let closing: Promise<void> | undefined;
  const context = new Proxy(t, {
    get(object, key) {
      if (key === "after")
        return (callback: Parameters<TestContext["after"]>[0]) => {
          if (callback === undefined) return;
          originalCleanup.push(async () => {
            await callback(t, (error?: unknown) => {
              if (error !== undefined) throw error;
            });
          });
        };
      const value: unknown = Reflect.get(object, key, object);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
  // Register before setup, so a partial installer/authority/server failure is also owned.
  t.after(() => close());
  const f = await nativeTaskAuthorityFixture(context, { nodeActions: "task" });
  await f.seedDeployment();
  await f.run(() =>
    f.installed.extensions.setActivation(actor, {
      pluginId: f.source.pluginId,
      configurationRevision: f.configuration.revision,
      expectedRevision: 0,
      idempotencyKey: "named-native-main-business-activation-prerequisite",
      state: "enabled",
      agentVersionId: target.agentVersionId,
    }),
  );
  const selection = await f.installation.service.select(actor, {
    pluginId: f.source.pluginId,
    selectedPackageDigest: f.source.packageDigest,
    state: "enabled",
    expectedSelectionRevision: 1,
    idempotencyKey: "named-native-main-selected-enabled-prerequisite",
  });
  assert.equal(selection.mutation.selection.revision, 2);
  const credits = f.store.pluginCreditStore();
  await credits.migrate();
  await credits.grant({
    scope: creditScope,
    grantId: "named-native-main-100-personal-credit-test-funding",
    credits: "100",
  });
  const threadId = "named-native-main-original-thread";
  await seedThread(f.store, { ...actor, threadId });

  // Main must acquire the actual profile and its own connection. No setup authority or
  // Store remains available to admit a task on behalf of the child.
  await f.owner.close();
  await f.installed.close();
  await f.metadataOnly.close();
  await f.activationOwner.close();
  await f.installation.close();
  await f.authority.close();
  await f.store.close();

  // Parse the actual source projection through the same private peer DTO contract.
  const catalog = parseInstalledPluginPeerResponse({
    protocol: "crewon.installed-plugin-peer-response.v1",
    requestId: "named-native-main-catalog-fixture",
    operation: "catalog",
    actor,
    scope,
    entries: [
      {
        identity: f.activation.publication.entries[0]!.identity,
        manifest: nativeConfigurationManifest,
        configuration: f.configuration,
        configuredTarget: target,
      },
    ],
  });
  assert.equal(catalog.operation, "catalog");
  authorities = await createNativeTaskMainAuthorities({
    actor,
    scope,
    entry: catalog.entries[0]!,
    poolId: creditScope.poolId,
  });
  const actualAuthorities = authorities;
  const caPath = join(f.root, "named-native-main-authority-ca.pem");
  const keyPath = join(f.root, "named-native-main-artifact-key");
  await writeFile(caPath, TEST_CA_CERT, { mode: 0o600 });
  await writeFile(keyPath, randomBytes(32), { mode: 0o600 });

  async function inputs(options: NativeTaskMainStartOptions = {}) {
    assert.equal(closing, undefined, "named_native_main_fixture_closed");
    assert.ok(
      active === undefined || active.child.finished(),
      "named_native_main_already_running",
    );
    const serial = ++sequence;
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const sessionToken =
      "named-native-main-session-" + randomBytes(32).toString("hex");
    const csrfToken =
      "named-native-main-csrf-" + randomBytes(32).toString("hex");
    const activationDocument =
      parseDesktopInstalledPluginActivationConfiguration({
        ...f.activationDocument,
        peer: {
          ...f.activationDocument.peer,
          origin: actualAuthorities.peerOrigin,
        },
        authority: {
          ...f.activationDocument.authority,
          url: `${actualAuthorities.authorityOrigin}/activation`,
        },
      });
    const taskDocument = parseDesktopInstalledPluginTaskConfiguration({
      ...f.taskDocument,
      activationDigest: nativeTaskDigester.sha256(
        extensionCanonicalJson(activationDocument),
      ),
      taskPolicyAuthority: {
        ...f.taskDocument.taskPolicyAuthority,
        url: `${actualAuthorities.authorityOrigin}/tasks`,
      },
      uiPolicyAuthority: {
        ...f.taskDocument.uiPolicyAuthority,
        url: `${actualAuthorities.authorityOrigin}/ui`,
      },
      packageAuthority: {
        ...f.taskDocument.packageAuthority,
        url: `${actualAuthorities.authorityOrigin}/packages`,
      },
      quoteAuthority: {
        ...f.taskDocument.quoteAuthority,
        url: `${actualAuthorities.authorityOrigin}/quotes`,
      },
    });
    // Every start issues fresh actual files only after the previous child physically retired.
    for (const [path, document] of [
      [f.bootstrapPath, f.binding.configuration],
      [f.activationPath, activationDocument],
      [f.taskPath, taskDocument],
    ] as const) {
      await writeFile(path, JSON.stringify(document), { mode: 0o600 });
      await chmod(path, 0o600);
    }
    const artifactRoot = join(f.root, `main-artifacts-${serial}`);
    const artifactDbPath = join(f.root, `main-artifacts-${serial}.sqlite`);
    // Allow only process/toolchain essentials. Ambient production tokens, endpoints,
    // proxy settings, Worker ports and provider/SDK variables are never inherited.
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      LANG: "en_US.UTF-8",
      NODE_EXTRA_CA_CERTS: caPath,
      NODE_TLS_REJECT_UNAUTHORIZED: "1",
      CREWON_CONTROL_SECURITY_MODE: "standalone",
      CREWON_PRINCIPAL_ID: actor.principalId,
      CREWON_ACTOR_ID: actor.actorId,
      CREWON_TENANT_ID: actor.tenantId,
      CREWON_SPACE_ID: actor.spaceId,
      CREWON_AGENT_VERSION_ID: target.agentVersionId,
      CREWON_CONTROL_DB_PATH: f.databasePath,
      CREWON_CONTROL_PORT: String(port),
      CREWON_CONTROL_SESSION_TOKEN: sessionToken,
      CREWON_CONTROL_CSRF_TOKEN: csrfToken,
      CREWON_CONTROL_ALLOWED_ORIGINS: origin,
      CREWON_DESKTOP_PLUGIN_BOOTSTRAP_PATH: f.bootstrapPath,
      CREWON_DESKTOP_INSTALLED_PLUGIN_ACTIVATION_CONFIG_PATH: f.activationPath,
      CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN:
        nativeTaskMainAuthorityTokens.CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN,
      TEST_NATIVE_ACTIVATION_TOKEN:
        nativeTaskMainAuthorityTokens.TEST_NATIVE_ACTIVATION_TOKEN,
      CREWON_ARTIFACT_ROOT: artifactRoot,
      CREWON_ARTIFACT_DB_PATH: artifactDbPath,
      CREWON_ARTIFACT_ENCRYPTION_KEY_PATH: keyPath,
      CREWON_ARTIFACT_ENCRYPTION_KEY_ID: "named-native-main-artifact-key",
      CREWON_ARTIFACT_RETENTION: "off",
      CREWON_OUTBOX_RETENTION_MS: "off",
      ...(options.taskOptIn === false
        ? {}
        : {
            CREWON_DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_PATH: f.taskPath,
            TEST_NATIVE_TASK_POLICY_TOKEN:
              nativeTaskMainAuthorityTokens.TEST_NATIVE_TASK_POLICY_TOKEN,
            TEST_NATIVE_UI_POLICY_TOKEN:
              nativeTaskMainAuthorityTokens.TEST_NATIVE_UI_POLICY_TOKEN,
            TEST_NATIVE_PACKAGE_TOKEN:
              nativeTaskMainAuthorityTokens.TEST_NATIVE_PACKAGE_TOKEN,
            TEST_NATIVE_QUOTE_TOKEN:
              nativeTaskMainAuthorityTokens.TEST_NATIVE_QUOTE_TOKEN,
          }),
    };
    for (const [name, value] of Object.entries(
      options.environmentOverrides ?? {},
    )) {
      if (value === undefined) delete environment[name];
      else environment[name] = value;
    }
    return {
      environment,
      port,
      origin,
      artifactRoot,
      artifactDbPath,
      sessionToken,
      csrfToken,
      taskPath: f.taskPath,
      bootstrapPath: f.bootstrapPath,
      activationPath: f.activationPath,
    };
  }

  async function start(options: NativeTaskMainStartOptions = {}) {
    const prepared = await inputs(options);
    const child = startFullAppProcess("control", prepared.environment);
    const record: ChildRecord = {
      child,
      port: prepared.port,
      expectedReject: false,
      stopped: undefined,
    };
    children.push(record);
    active = record;
    try {
      await waitForListening(child, prepared.port);
    } catch (error) {
      record.expectedReject = true;
      await stopRecord(record);
      throw error;
    }
    const client = new ControlApiClient({
      baseUrl: prepared.origin,
      accessToken: prepared.sessionToken,
      csrfToken: prepared.csrfToken,
      origin: prepared.origin,
    });
    return {
      ...prepared,
      client,
      child,
      mount: () =>
        client.plugins.openMount({
          pluginId: f.source.pluginId,
          contributionId: "workbench",
          expectedPackageDigest: f.source.packageDigest,
          expectedSelectionRevision: 2,
        }),
      stop: () => stopRecord(record),
    };
  }

  /** Expected pre-resource failures own their actual child close separately from a
   * healthy shutdown; a nonzero exit is evidence, not a second cleanup assertion. */
  async function startRejected(
    environmentOverrides: Record<string, string | undefined>,
  ) {
    const prepared = await inputs({ environmentOverrides });
    const child = startFullAppProcess("control", prepared.environment);
    const record: ChildRecord = {
      child,
      port: prepared.port,
      expectedReject: true,
      stopped: undefined,
    };
    children.push(record);
    active = record;
    const result = await processCompletion(child);
    assert.notEqual(result.code, 0, "named_native_main_expected_rejection");
    assert.equal(result.signal, null, child.stderr());
    assert.equal(await fullAppPortClosed(prepared.port), true);
    record.stopped = Promise.resolve();
    active = undefined;
    return {
      ...prepared,
      child,
      ...result,
      stdout: child.stdout(),
      stderr: child.stderr(),
    };
  }

  function stopRecord(record: ChildRecord): Promise<void> {
    return (record.stopped ??= (async () => {
      if (record.expectedReject) {
        if (!record.child.finished()) record.child.child.kill("SIGTERM");
        await processCompletion(record.child);
      } else {
        await stopFullAppProcess(record.child);
      }
      assert.equal(
        await fullAppPortClosed(record.port),
        true,
        "named_native_main_port_leaked",
      );
      if (active === record) active = undefined;
    })());
  }
  function close(): Promise<void> {
    return (closing ??= (async () => {
      // Even a failed stop must first join every child. Failed physical retirement
      // preserves the fixture root rather than deleting live files or SQLite locks.
      const retired = await Promise.allSettled(children.map(stopRecord));
      assert.ok(
        children.every((record) => record.child.finished()),
        "named_native_main_child_still_live",
      );
      const errors = retired.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      await authorities?.close();
      if (authorities)
        for (const port of authorities.ports)
          assert.equal(
            await fullAppPortClosed(port),
            true,
            "named_native_main_authority_port_leaked",
          );
      for (const cleanup of originalCleanup.reverse()) await cleanup();
      if (errors.length)
        throw new AggregateError(
          errors,
          "named_native_main_child_cleanup_failed",
        );
      assert.deepEqual(
        authorities?.state.failures ?? [],
        [],
        "named_native_main_authority_fixture_failed",
      );
    })());
  }

  function effects() {
    return readDatabase(
      (db) =>
        Object.fromEntries(
          effectTables.map((table) => {
            const present = db
              .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
              )
              .get(table);
            return [
              table,
              present
                ? Number(
                    db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,
                  )
                : 0,
            ];
          }),
        ) as Record<string, number>,
    );
  }
  function wallet() {
    return readDatabase((db) => {
      const row = db
        .prepare(
          "SELECT account_json FROM plugin_credit_accounts WHERE tenant_id=? AND principal_id=? AND pool_id=?",
        )
        .get(creditScope.tenantId, creditScope.principalId, creditScope.poolId);
      assert.ok(row, "named_native_main_funded_account_missing");
      return validateCreditAccount(JSON.parse(String(row.account_json)));
    });
  }
  function readDatabase<T>(read: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(f.databasePath, { readOnly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  }
  return {
    actor,
    source: f.source,
    target,
    configuration: f.configuration,
    databasePath: f.databasePath,
    creditScope,
    threadId,
    root: f.root,
    state: actualAuthorities.state,
    start,
    startRejected,
    effects,
    wallet,
    replaceProfileLock: () => f.replaceProfileLock(),
    command: (key: string, threadRevision = 1) => ({
      action: "image.generate",
      input: {
        threadId,
        expectedThreadRevision: threadRevision,
        idempotencyKey: key,
        input: { organization: "Named Native Main task" },
      },
    }),
    close,
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      accept();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept())),
  );
  return address.port;
}
async function waitForListening(
  child: InstalledProcessChild,
  port: number,
): Promise<void> {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (child.finished())
      throw new Error(
        `named_native_main_start_failed\n${child.stdout()}\n${child.stderr()}`,
      );
    if (
      child
        .stdout()
        .includes(`CrewON Control API listening on 127.0.0.1:${port}`)
    )
      return;
    await delay(25);
  }
  throw new Error(
    `named_native_main_start_timeout\n${child.stdout()}\n${child.stderr()}`,
  );
}
async function processCompletion(child: InstalledProcessChild) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.completion,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("named_native_main_close_timeout")),
          15_000,
        );
      }),
    ]);
  } catch (error) {
    if (!child.finished()) child.child.kill("SIGKILL");
    await child.completion.catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
