import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Pool } from "pg";
import { ControlApiClient } from "@crewon/control-client";
import {
  createConceptAsset,
  createExtensionCreditAdmission,
  parsePluginTaskAdmission,
} from "@crewon/domain";
import { parsePluginUiRecoveryRequest } from "@crewon/contracts";
import {
  installLocalPluginPackage,
  loadInstalledPluginBusinessRegistration,
} from "@crewon/plugin-host";
import {
  extensionFixture,
  configuration,
  activation,
  scope,
  timestamp,
} from "../../../packages/store/src/extension-store.test-support.ts";
import { extensionTurnInput } from "../../../packages/store/src/extension-turn.test-support.ts";
import { extensionStoreDigester as digester } from "../../../packages/store/src/extension-store-records.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import {
  creationRecipe,
  receipt as projectReceipt,
} from "../../../packages/store/src/creative-project-store.test-support.ts";
import { seedThread } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
import { generationTables } from "../../../packages/store/src/project-generation.test-support.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import {
  startFullAppProcess,
  stopFullAppProcess,
  fullAppPortClosed,
} from "./installed-plugin-full-app-process.test-support.ts";
import { waitTaskProcess } from "./installed-plugin-tasks-process.test-support.ts";
import { taskProcessFreePort } from "./installed-plugin-tasks-process-authorities.test-support.ts";
import { TEST_CA_CERT } from "../../device-gateway/src/mtls-test-certificates.test-support.ts";
import { PRODUCTION_BFF_AUTHORIZATION_HEADER } from "./production-security-adapters.ts";
import { startMainRecoveryAuthorities } from "./plugin-ui-recovery-main-authorities.test-support.ts";

export const mainRecoveryActions = Object.freeze({
  generation: "crewon.project-generations.v1.generateConcept",
  query: "crewon.project-generation-queries.v1.queryConceptGeneration",
  selection: "crewon.project-generation-selections.v1.selectConceptImage",
});
const repository = fileURLToPath(new URL("../../..", import.meta.url));
const authorityToken = "named-main-authority-" + "a".repeat(32);
const accessToken = "named-main-session-" + "s".repeat(32);
const bffToken = "named-main-bff-" + "b".repeat(32);
const browserOrigin = "https://named-main-browser.fixture.test";
type PoolObservation = Readonly<{
  pid: number;
  phase: "connect" | "acquired";
  max: number;
  total: number;
}>;

/** Real original main.ts, TLS authorities and exact installed bytes. Paid history/funding/results
 * are explicitly seeded fixtures; no Worker, model, supplier execution or human funds are involved. */
export async function recoveryMainFixture(t: TestContext) {
  const cleanup: (() => unknown | Promise<unknown>)[] = [];
  const children: ReturnType<typeof startFullAppProcess>[] = [];
  const authorities: (() => Promise<void>)[] = [];
  let closed = false;
  t.after(async () => {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    for (const close of [
      ...[...children]
        .reverse()
        .map((child) => () => stopFullAppProcess(child)),
      ...authorities,
      ...cleanup,
    ]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "main_recovery_fixture_cleanup_failed",
      );
  });
  // Existing fixture cleanup is deferred so physical child/authority retirement always happens first.
  const context = new Proxy(t, {
    get(target, key) {
      if (key === "after")
        return (close: () => unknown | Promise<unknown>) => cleanup.push(close);
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const parentPoolObservations: PoolObservation[] = [];
  const observedPools = new WeakSet<Pool>();
  const connect = Pool.prototype.connect;
  t.mock.method(
    Pool.prototype,
    "connect",
    new Proxy(connect, {
      apply(method, receiver: Pool, args) {
        const observe = (phase: PoolObservation["phase"]) =>
          parentPoolObservations.push({
            pid: process.pid,
            phase,
            max: receiver.options.max!,
            total: receiver.totalCount,
          });
        if (!observedPools.has(receiver)) {
          observedPools.add(receiver);
          receiver.on("acquire", () => observe("acquired"));
        }
        observe("connect");
        return Reflect.apply(method, receiver, args);
      },
    }),
  );
  const storage = await extensionFixture(context, "postgres", {
    maxPoolSize: 1,
  });
  await storage.seedDeployment();
  const files = await productionSourceFixture(context);
  const actor = {
    tenantId: scope.tenantId,
    spaceId: scope.spaceId,
    actorId: "actor-1",
    principalId: "named-main-history-owner",
  };
  const profile = { ...scope, profileId: "named-main-profile" };
  const { pluginId: _pluginId, ...profileScope } = profile;
  const ledger = storage.first.parent.pluginInstallationStore();
  await ledger.migrate();
  const deliver = async (directory: string, key: string) => {
    const installed = await installLocalPluginPackage({
      directory,
      installRoot: files.installRoot,
      authorization: async () => ({ outcome: "allow" }),
    });
    const record = await ledger.recordInstalledPackage(
      installationRecipe(key, {
        scope: profileScope,
        actor,
        pluginId: installed.descriptor.pluginId,
        publisherId: installed.descriptor.publisherId,
        version: installed.descriptor.version,
        packageDigest: installed.packageDigest,
      }),
    );
    const enabled = await ledger.commitSelection(
      selectionRecipe(record.selection, `${key}-enable`, { actor }),
    );
    return { ...installed, enabled };
  };
  const target = await deliver(
    await realpath(
      process.env.CREWON_TEST_KREA2_PACKAGE ??
        join(
          repository,
          "output/extensions/installable-plugins/krea2-20261003/2.0.0",
        ),
    ),
    "named-main-actual-krea2",
  );
  const registration = await loadInstalledPluginBusinessRegistration({
    installRoot: files.installRoot,
    expectedPluginId: target.descriptor.pluginId,
    expectedPublisherId: target.descriptor.publisherId,
    expectedVersion: target.descriptor.version,
    expectedPackageDigest: target.packageDigest,
    authorizeRead: async () => "allow",
    signal: new AbortController().signal,
  });
  const sourceBytes = await files.source("recovery-module", {
    pluginId: "test.main-recovery",
    publisherId: "test.main-recovery-publisher",
    uiOnly: true,
    requires: [
      {
        service: "crewon.plugin-ui-recovery",
        apiVersion: "1",
        optional: false,
      },
      ...[
        "crewon.project-generations",
        "crewon.project-generation-queries",
        "crewon.project-generation-selections",
      ].map((service) => ({ service, apiVersion: "1", optional: true })),
    ],
  });
  const source = await deliver(sourceBytes.directory, "named-main-source");
  const metadata = storage.first.parent.creativeProjectStore();
  await metadata.migrate();
  const initial = await metadata.commitProjectCreation(
    creationRecipe("named-main-project", "named-main-create", actor, timestamp),
  );
  const created = createConceptAsset(
    {
      project: initial.project,
      actor,
      expectedProjectRevision: initial.project.revision,
      brief: initial.brief,
      assetId: "named-main-concept",
      name: "Named seeded source image",
      prompt: "A ceramic teapot by a sunlit window.",
      at: timestamp,
    },
    digester,
  );
  const saved = await metadata.commitConceptRevision({
    kind: "create-concept",
    actor,
    receipt: projectReceipt("named-main-concept"),
    expectedProjectRevision: initial.project.revision,
    ...created,
  });
  const reference = {
    projectId: saved.project.projectId,
    assetId: saved.asset.assetId,
    assetRevision: saved.assetRevision.assetRevision,
    expectedProjectRevision: saved.project.revision,
    expectedAssetMetadataRevision: saved.asset.revision,
  };
  const config = configuration({
    pluginVersion: registration.manifest.version,
    manifestDigest: registration.manifestDigest,
    implementationDigest: registration.implementationDigest,
    parameters: { baseUrl: "https://named-comfy-result.fixture.test/" },
  });
  await storage.first.store.saveExtensionConfiguration({
    configuration: config,
    expectedRevision: 0,
    receipt: {
      actorId: actor.actorId,
      idempotencyKey: "named-main-config",
      requestDigest: digester.sha256("named-main-config"),
    },
  });
  await storage.first.store.saveExtensionActivation({
    activation: activation(config),
    expectedRevision: 0,
    receipt: {
      actorId: actor.actorId,
      idempotencyKey: "named-main-activation",
      requestDigest: digester.sha256("named-main-activation"),
    },
  });
  await storage.first.store.migrateCredits();
  await storage.first.store.migratePluginAdmissions();
  await storage.first.store.migrateProjectGenerations();
  const creditScope = {
    tenantId: actor.tenantId,
    principalId: actor.principalId,
    poolId: "named-main-history-funding",
  };
  const credits = storage.first.parent.pluginCreditStore();
  await credits.grant({
    scope: creditScope,
    grantId: "named-main-fixture-grant",
    credits: "100",
  });
  const turn = extensionTurnInput(randomUUID(), {
    configurationRevision: config.revision,
    configurationDigest: config.contentDigest,
  });
  await storage.prepare({
    ...turn,
    commit: {
      ...turn.turn.run,
      tenantId: turn.turn.tenantId,
      idempotency: turn.turn.idempotency,
    },
  });
  const receipt = {
    actorId: actor.actorId,
    idempotencyKey: "named-main-paid-history",
    requestDigest: digester.sha256("named-main-paid-history"),
  };
  const paid = await storage.first.store.commitExtensionTurn(
    {
      ...turn,
      receipt,
      projectGeneration: reference,
      pluginAdmission: parsePluginTaskAdmission({
        schemaVersion: "crewon.plugin-task-admission.v1",
        ...profileScope,
        principalId: actor.principalId,
        actorId: actor.actorId,
        pluginId: target.descriptor.pluginId,
        publisherId: target.descriptor.publisherId,
        version: target.descriptor.version,
        packageDigest: target.packageDigest,
        selectionRevision: target.enabled.selection.revision,
        contributionId: "studio",
        action: "image.generate",
        authorityEpoch: "named-main-seed-authority",
        runId: turn.binding.runId,
        threadId: turn.binding.threadId,
        extensionBindingDigest: turn.binding.bindingDigest,
        requestDigest: receipt.requestDigest,
        idempotencyKey: receipt.idempotencyKey,
      }),
      creditAdmission: createExtensionCreditAdmission(
        {
          binding: turn.binding,
          receipt,
          principalId: actor.principalId,
          poolId: creditScope.poolId,
          priceRevision: 1,
          quotedCredits: "30",
        },
        digester,
      ),
    },
    {
      projectGenerationAuthority: {
        assertCurrent: async () => {},
        assertActive() {},
      },
    },
  );
  await storage.first.parent.commitRun({
    tenantId: actor.tenantId,
    expectedRevision: paid.run.state.revision,
    idempotency: {
      scope: "named-main-history",
      key: "start",
      requestFingerprint: digester.sha256("named-main-start"),
    },
    events: [
      {
        schemaVersion: "crewon.run-event.v0",
        identity: { runId: turn.binding.runId },
        eventId: randomUUID(),
        sequence: paid.run.state.revision + 1,
        occurredAt: timestamp,
        type: "run.started",
        data: {},
      },
    ],
    outbox: [],
    workItems: [],
  });
  const operations = storage.first.parent.externalOperationStore();
  await operations.migrate();
  const locator = {
    tenantId: actor.tenantId,
    runId: turn.binding.runId,
    bindingDigest: turn.binding.bindingDigest,
    operationId: randomUUID(),
  };
  await operations.reserveExternalOperation({
    ...locator,
    executionId: "named-main-seeded-tool",
    idempotencyKey: "named-main-operation",
    actionDigest: digester.sha256("image.generate"),
    requestDigest: digester.sha256("named-main-result"),
    correlationId: locator.operationId,
    createdAt: timestamp,
  });
  const images = ["named-first.png", "named-second.png"].map((filename) => {
    const image = { filename, subfolder: "", type: "output" };
    return {
      ...image,
      url: new URL(
        `/view?${new URLSearchParams(image)}`,
        config.parameters.baseUrl as string,
      ).href,
    };
  });
  const observed = await operations.advanceExternalOperation({
    ...locator,
    expectedRevision: 1,
    status: "succeeded",
    providerOperationId: locator.operationId,
    resultJson: JSON.stringify({ images }),
    updatedAt: timestamp,
  });
  const threadId = "named-main-staged-thread";
  await seedThread(storage.first.parent, { ...actor, threadId });
  const selectionRequest = parsePluginUiRecoveryRequest({
    action: mainRecoveryActions.selection,
    input: {
      reference,
      operationId: locator.operationId,
      expectedOperationRevision: observed.operation.revision,
      resultIndex: 0,
      expectedSelectionRevision: 0,
      idempotencyKey: "named-main-original-selection",
    },
  });
  const requests = [
    parsePluginUiRecoveryRequest({
      action: mainRecoveryActions.generation,
      input: {
        reference,
        threadId,
        expectedThreadRevision: 1,
        idempotencyKey: "named-main-original-generation",
      },
    }),
    parsePluginUiRecoveryRequest({
      action: mainRecoveryActions.query,
      input: {
        reference: {
          projectId: reference.projectId,
          assetId: reference.assetId,
          assetRevision: reference.assetRevision,
        },
        operationId: locator.operationId,
        threadId,
        expectedThreadRevision: 1,
        idempotencyKey: "named-main-original-query",
      },
    }),
    selectionRequest,
  ];
  const database = new Pool({
    connectionString: process.env.CREWON_TEST_POSTGRES_URL,
    max: 1,
  });
  // Before the existing Store/schema cleanup, retire this independent fixture observer connection.
  cleanup.unshift(() => database.end());
  const query = async (sql: string) => (await database.query(sql)).rows;
  const faultName = "named_main_confirmation_failure";
  const confirmationFault = async (enabled: boolean) =>
    storage.sql(
      enabled
        ? `CREATE FUNCTION ${storage.prefix}${faultName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'named-main-confirmation-storage-failed'; END $$; CREATE TRIGGER ${faultName} BEFORE UPDATE ON ${storage.prefix}plugin_ui_intents FOR EACH ROW WHEN (NEW.phase='accepted') EXECUTE FUNCTION ${storage.prefix}${faultName}();`
        : `DROP TRIGGER ${faultName} ON ${storage.prefix}plugin_ui_intents; DROP FUNCTION ${storage.prefix}${faultName}();`,
    );
  const state = {
    dropStageAck: false,
    armConfirmationFault: false,
    faultInstalled: false,
    peerCalls: 0,
    quoteCalls: 0,
    tlsConnections: 0,
    failures: [] as unknown[],
    policyCalls: 0,
  };
  const { authorityOrigin, peerOrigin } = await startMainRecoveryAuthorities({
    actor,
    profileScope,
    accessToken,
    authorityToken,
    state,
    registerClose: (close) => authorities.push(close),
    async beforePolicy() {
      if (state.armConfirmationFault && !state.faultInstalled) {
        const current = await query(
          `SELECT phase FROM ${storage.prefix}plugin_ui_intents WHERE kind='selection'`,
        );
        if (current[0]?.phase === "dispatched") {
          state.faultInstalled = true;
          await confirmationFault(true);
        }
      }
    },
  });
  const endpoint = (path: string) => ({
    url: `${authorityOrigin}/${path}`,
    serviceTokenEnvironmentVariable: "NAMED_MAIN_AUTHORITY_TOKEN",
  });
  const sourcePublication = {
    pluginId: source.descriptor.pluginId,
    packageDigest: source.packageDigest,
    contributionId: "workbench",
  };
  const projectPath = join(files.root, "project-composition.json");
  const taskPath = join(files.root, "installed-tasks.json");
  const caPath = join(files.root, "authority-ca.pem");
  const keyPath = join(files.root, "artifact-key");
  const observerPath = join(files.root, "pool-connect-observer.mjs");
  const observationsPath = join(files.root, "physical-pool-observations.jsonl");
  await writeFile(
    projectPath,
    JSON.stringify({
      schemaVersion: "crewon.production-project-composition.v1",
      pluginUi: { publications: [sourcePublication] },
      pluginGenerations: {
        publications: [
          {
            source: sourcePublication,
            target: {
              pluginId: target.descriptor.pluginId,
              packageDigest: target.packageDigest,
              contributionId: "studio",
              action: "image.generate",
            },
          },
        ],
      },
      pluginQueries: {
        publications: [
          {
            source: sourcePublication,
            target: {
              pluginId: target.descriptor.pluginId,
              packageDigest: target.packageDigest,
              contributionId: "studio",
              action: "image.query",
            },
          },
        ],
      },
      generationReads: { version: "crewon.project-generation-read.v1" },
      generationReadUi: { publications: [sourcePublication] },
      resultSelections: {
        version: "crewon.project-concept-selection.v1",
        adapter: "comfyui-krea2",
        identities: [
          {
            pluginVersion: config.pluginVersion,
            manifestDigest: config.manifestDigest,
            implementationDigest: config.implementationDigest,
          },
        ],
      },
      selectionUi: { publications: [sourcePublication] },
      uiRecovery: {
        version: "crewon.plugin-ui-recovery.v1",
        publications: [
          { ...sourcePublication, actions: Object.values(mainRecoveryActions) },
        ],
      },
    }),
    { mode: 0o600 },
  );
  await writeFile(
    taskPath,
    JSON.stringify({
      schemaVersion: "crewon.installed-plugin-control-tasks.v1",
      installRoot: files.installRoot,
      peer: {
        origin: peerOrigin,
        tokenEnvironmentVariable: "NAMED_MAIN_PEER_TOKEN",
      },
      packageAuthority: endpoint("package"),
      quoteAuthority: endpoint("quote"),
      timeoutMs: 10000,
      maximumPackages: 4,
    }),
    { mode: 0o600 },
  );
  await writeFile(caPath, TEST_CA_CERT, { mode: 0o600 });
  await writeFile(keyPath, randomBytes(32), { mode: 0o600 });
  await writeFile(observationsPath, "", { mode: 0o600 });
  await writeFile(
    observerPath,
    `import {Pool} from ${JSON.stringify(import.meta.resolve("pg"))};import {appendFileSync} from 'node:fs';const original=Pool.prototype.connect;const observed=new WeakSet();Pool.prototype.connect=new Proxy(original,{apply(method,pool,args){const observe=phase=>appendFileSync(${JSON.stringify(observationsPath)},JSON.stringify({pid:process.pid,phase,max:pool.options.max,total:pool.totalCount})+'\\n');if(!observed.has(pool)){observed.add(pool);pool.on('acquire',()=>observe('acquired'));}observe('connect');return Reflect.apply(method,pool,args);}});`,
    { mode: 0o600 },
  );
  const environment: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("CREWON_")),
    ),
    NODE_EXTRA_CA_CERTS: caPath,
    NODE_TLS_REJECT_UNAUTHORIZED: "1",
    NODE_OPTIONS: `--dns-result-order=ipv4first --import=${pathToFileURL(observerPath).href}`,
    CREWON_CONTROL_SECURITY_MODE: "production",
    CREWON_CONTROL_DATABASE_URL: process.env.CREWON_TEST_POSTGRES_URL,
    CREWON_CONTROL_DATABASE_SCHEMA: storage.prefix.slice(1, -2),
    CREWON_CONTROL_DATABASE_MAX_POOL_SIZE: "1",
    CREWON_CONTROL_BFF_TOKEN: bffToken,
    CREWON_BFF_ALLOWED_ORIGINS: browserOrigin,
    CREWON_BFF_ALLOWED_REMOTE_ADDRESSES: "127.0.0.1",
    CREWON_IDENTITY_VERIFY_URL: `${authorityOrigin}/verify`,
    CREWON_IDENTITY_SERVICE_TOKEN: authorityToken,
    CREWON_IDENTITY_EXPECTED_ISSUER: "https://named-main-identity.fixture.test",
    CREWON_IDENTITY_EXPECTED_AUDIENCE: "crewon-main-recovery",
    CREWON_POLICY_DECISION_URL: `${authorityOrigin}/policy`,
    CREWON_POLICY_SERVICE_TOKEN: authorityToken,
    CREWON_SECURITY_AUTHORITY_TIMEOUT_MS: "10000",
    CREWON_PLUGIN_UI_ENABLED: "1",
    CREWON_PLUGIN_UI_INSTALL_ROOT: files.installRoot,
    CREWON_PLUGIN_UI_PROFILE_AUTHORITY_URL: `${authorityOrigin}/profile`,
    CREWON_PLUGIN_UI_PROFILE_AUTHORITY_TOKEN: authorityToken,
    CREWON_PLUGIN_UI_POLICY_AUTHORITY_URL: `${authorityOrigin}/policy`,
    CREWON_PLUGIN_UI_POLICY_AUTHORITY_TOKEN: authorityToken,
    CREWON_PLUGIN_UI_AUTHORITY_TIMEOUT_MS: "10000",
    CREWON_PLUGIN_UI_PUBLICATIONS_JSON: JSON.stringify([
      {
        pluginId: source.descriptor.pluginId,
        publisherId: source.descriptor.publisherId,
        packageDigest: source.packageDigest,
        publicAssets: ["ui.mjs"],
      },
    ]),
    CREWON_PROJECT_COMPOSITION_CONFIG_PATH: projectPath,
    CREWON_INSTALLED_PLUGIN_TASK_CONFIG_PATH: taskPath,
    NAMED_MAIN_AUTHORITY_TOKEN: authorityToken,
    NAMED_MAIN_PEER_TOKEN: "named-main-peer-" + "p".repeat(32),
    CREWON_ARTIFACT_ROOT: join(files.root, "artifacts"),
    CREWON_ARTIFACT_DB_PATH: join(files.root, "artifacts.sqlite"),
    CREWON_ARTIFACT_ENCRYPTION_KEY_PATH: keyPath,
    CREWON_ARTIFACT_ENCRYPTION_KEY_ID: "named-main-artifact-key",
    CREWON_ARTIFACT_RETENTION: "off",
    CREWON_OUTBOX_RETENTION_MS: "off",
    CREWON_OUTBOX_SCAN_INTERVAL_MS: "10000",
    CREWON_AUTOMATION_SCAN_INTERVAL_MS: "10000",
  };
  const start = async () => {
    const port = await taskProcessFreePort();
    const child = startFullAppProcess("control", {
      ...environment,
      CREWON_CONTROL_PORT: String(port),
    });
    children.push(child);
    await waitTaskProcess(
      "original production main recovery child",
      async () => child.stdout().includes("CrewON Control API listening"),
      [child],
    );
    const physicalRequests: { method: string; path: string; body: unknown }[] =
      [];
    const client = new ControlApiClient({
      baseUrl: `http://127.0.0.1:${port}`,
      accessToken,
      csrfToken: "named-main-csrf-" + "c".repeat(32),
      origin: browserOrigin,
      fetch: async (raw, init) => {
        const url = new URL(raw instanceof Request ? raw.url : String(raw));
        physicalRequests.push({
          method: init?.method ?? "GET",
          path: url.pathname,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        });
        const headers = new Headers(init?.headers);
        headers.set(PRODUCTION_BFF_AUTHORIZATION_HEADER, `Bearer ${bffToken}`);
        const response = await globalThis.fetch(raw, { ...init, headers });
        if (
          state.dropStageAck &&
          init?.method === "POST" &&
          url.pathname.endsWith("/recovery")
        ) {
          state.dropStageAck = false;
          await response.arrayBuffer();
          assert.ok(response.status === 200 || response.status === 201);
          throw new Error("named_main_stage_ack_lost_after_real_sql_commit");
        }
        return response;
      },
    });
    const mount = () =>
      client.plugins.openMount({
        pluginId: source.descriptor.pluginId,
        contributionId: "workbench",
        expectedSelectionRevision: source.enabled.selection.revision,
        expectedPackageDigest: source.packageDigest,
      });
    return {
      child,
      port,
      client,
      mount,
      physicalRequests,
      async stop() {
        await stopFullAppProcess(child);
        assert.equal(await fullAppPortClosed(port), true);
      },
    };
  };
  const effects = async () => ({
    counts: Object.fromEntries(
      await Promise.all(
        generationTables.map(async (table) => [
          table,
          await storage.count(table),
        ]),
      ),
    ),
    wallet: await credits.getAccount(creditScope),
  });
  const rawRecords = () =>
    query(
      `SELECT record_json FROM ${storage.prefix}plugin_ui_intents ORDER BY sequence`,
    );
  const poolObservations = async () => ({
    parent: parentPoolObservations,
    children: (await readFile(observationsPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as PoolObservation),
  });
  const selectionUrl = `/api/v1/creative-projects/${reference.projectId}/concepts/${reference.assetId}/selection`;
  const publicSelection = async (
    session: Awaited<ReturnType<typeof start>>,
    method = "GET",
    input?: unknown,
    key?: string,
  ) => {
    const result = await globalThis.fetch(
      `http://127.0.0.1:${session.port}${selectionUrl}`,
      {
        method,
        headers: {
          "authorization": `Bearer ${accessToken}`,
          "origin": browserOrigin,
          [PRODUCTION_BFF_AUTHORIZATION_HEADER]: `Bearer ${bffToken}`,
          "x-csrf-token": "named-main-csrf-" + "c".repeat(32),
          "content-type": "application/json",
          ...(key === undefined ? {} : { "idempotency-key": key }),
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      },
    );
    const body = await result.json();
    assert.equal(result.status, 200, JSON.stringify(body));
    return body;
  };
  return {
    ...storage,
    files,
    actor,
    config,
    source,
    target,
    requests,
    selectionRequest,
    reference,
    images,
    state,
    start,
    effects,
    rawRecords,
    poolObservations,
    publicSelection,
    confirmationFault,
  };
}
