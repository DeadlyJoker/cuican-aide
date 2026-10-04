import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { Client } from "pg";
import type { TestContext } from "node:test";
import {
  CreativeProjectApplicationService,
  ExtensionReadApplicationService,
  ExtensionTaskApplicationService,
  ProjectGenerationReadApplicationService,
  type PluginTaskUnmeteredAuthorityPort,
  type PluginQueryHostPort,
} from "@crewon/application";
import {
  createConceptAsset,
  parsePluginTaskAdmissionPin,
} from "@crewon/domain";
import {
  actor,
  configurationServiceFixture,
  saveCommand,
  activateCommand,
} from "./extension-configuration-service.test-support.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "./plugin-installation-store.test-support.ts";
import {
  creationRecipe,
  receipt as projectReceipt,
} from "./creative-project-store.test-support.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import { extensionStoreDigester as digester } from "./extension-store-records.ts";
import { scope, timestamp } from "./extension-store.test-support.ts";

/** Real original SQL adapters with named, local test authorization; no balances, price quotes or supplier calls. */
export async function unmeteredFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  options: { optIn?: boolean } = {},
) {
  const f = await configurationServiceFixture(t, backend, { maxPoolSize: 1 });
  await f.seedDeployment();
  await f.service.saveConfiguration(actor, saveCommand);
  await f.service.setActivation(actor, activateCommand);
  const installs = f.first.parent.pluginInstallationStore();
  await installs.migrate();
  const profile = {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    profileId: "unmetered-personal-profile",
  };
  const recipe = installationRecipe("unmetered-installed-package", {
    scope: profile,
    actor,
    pluginId: scope.pluginId,
    version: saveCommand.pluginVersion,
  });
  const installed = await installs.recordInstalledPackage(recipe);
  const enabled = await installs.commitSelection(
    selectionRecipe(installed.selection, "unmetered-enable", { actor }),
  );
  await f.first.store.migratePluginAdmissions();
  await f.second.store.migratePluginAdmissions();
  if (options.optIn !== false) {
    await f.first.store.migrateUnmeteredPluginAdmissions();
    await f.second.store.migrateUnmeteredPluginAdmissions();
  }
  const pin = parsePluginTaskAdmissionPin({
    ...actor,
    ...profile,
    pluginId: scope.pluginId,
    publisherId: recipe.package.publisherId,
    version: recipe.package.version,
    packageDigest: recipe.package.packageDigest,
    selectionRevision: enabled.selection.revision,
    contributionId: "workbench",
    action: "image.generate",
    authorityEpoch: "unmetered-test-epoch",
  });
  const authorityState = {
    live: true,
    prepared: 0,
    current: 0,
    active: 0,
    beforeCurrent: null as null | (() => void | Promise<void>),
  };
  const authorization = Object.freeze({
    authorityId: "named-local-test-unmetered-policy",
    policyRevision: 1,
  });
  const active = () => {
    authorityState.active++;
    if (!authorityState.live) throw new Error("test_unmetered_withdrawn");
  };
  const authority = {
    authorization,
    async assertCurrent() {
      assert.equal(this, authority);
      authorityState.current++;
      active();
      await authorityState.beforeCurrent?.();
      active();
    },
    assertActive() {
      assert.equal(this, authority);
      active();
    },
  };
  const unmeteredTasks: PluginTaskUnmeteredAuthorityPort = {
    async prepareGeneration(input) {
      assert.deepEqual(input.actor, actor);
      assert.deepEqual(input.pin, pin);
      authorityState.prepared++;
      active();
      return authority;
    },
  };
  const metadata = f.first.parent.creativeProjectStore();
  await metadata.migrate();
  const created = await metadata.commitProjectCreation(
    creationRecipe("unmetered-project", "unmetered-create", actor, timestamp),
  );
  const concept = createConceptAsset(
    {
      project: created.project,
      actor,
      expectedProjectRevision: created.project.revision,
      brief: created.brief,
      assetId: "unmetered-concept",
      name: "Concept",
      prompt: "A saved image prompt",
      at: timestamp,
    },
    digester,
  );
  const saved = await metadata.commitConceptRevision({
    kind: "create-concept",
    actor,
    receipt: projectReceipt("unmetered-concept"),
    expectedProjectRevision: created.project.revision,
    ...concept,
  });
  const reference = {
    projectId: saved.project.projectId,
    assetId: saved.asset.assetId,
    assetRevision: saved.assetRevision.assetRevision,
    expectedProjectRevision: saved.project.revision,
    expectedAssetMetadataRevision: saved.asset.revision,
  };
  await f.first.store.migrateProjectGenerations();
  await f.second.store.migrateProjectGenerations();
  const projectAuthority = Object.freeze({
    async assertCurrent() {},
    assertActive() {},
  });
  const allow = {
    async authorize() {
      return { outcome: "allow" as const };
    },
  };
  const creativeProjects = { store: metadata, authorization: allow };
  const create = (
    store = f.first.store,
    parent = f.first.parent,
    unmetered: PluginTaskUnmeteredAuthorityPort | null = unmeteredTasks,
    pluginQueryHost?: PluginQueryHostPort,
  ) =>
    new ExtensionTaskApplicationService({
      ...f.dependencies,
      store: parent,
      extensions: store,
      operations: f.operations,
      ids: { nextId: () => randomUUID() },
      host: { ...f.dependencies.host, taskAdmissionMode: () => "installed" },
      creativeProjects,
      ...(unmetered === null ? {} : { unmeteredTasks: unmetered }),
      ...(pluginQueryHost === undefined ? {} : { pluginQueryHost }),
    });
  const command = (
    threadId = "unmetered-generation",
    key = "unmetered-user-intent",
  ) => ({
    pluginId: scope.pluginId,
    threadId,
    expectedThreadRevision: 1,
    idempotencyKey: key,
    intent: {
      kind: "generate" as const,
      input: { prompt: concept.assetRevision.prompt },
    },
  });
  await seedThread(f.first.parent, { ...actor, threadId: command().threadId });
  const generate = () =>
    create().createProjectTaskFromPlugin(
      actor,
      command(),
      pin,
      reference,
      projectAuthority,
    );
  const reads = async (store = f.first.store, parent = f.first.parent) => {
    await store.enableProjectGenerationReads();
    const projects = new CreativeProjectApplicationService({
      store: parent.creativeProjectStore(),
      authorization: allow,
      clock: { now: () => timestamp },
      ids: { nextId: () => assert.fail("read cannot create identity") },
      digester,
    });
    const tasks = new ExtensionReadApplicationService({
      ...f.dependencies,
      runs: parent,
      agentVersions: parent,
      extensions: store,
      operations: parent.externalOperationStore(),
    });
    return new ProjectGenerationReadApplicationService({
      projects,
      tasks,
      extensions: store,
      digester,
    });
  };
  const db = backend === "sqlite" ? new DatabaseSync(f.databasePath) : null;
  const pool =
    backend === "postgres"
      ? new Pool({
          connectionString: process.env.CREWON_TEST_POSTGRES_URL,
          max: 1,
        })
      : null;
  t.after(async () => {
    db?.close();
    await pool?.end();
  });
  const rows = async (query: string) =>
    db === null ? (await pool!.query(query)).rows : db.prepare(query).all();
  const creditObjects = async () =>
    rows(
      backend === "sqlite"
        ? "SELECT name FROM sqlite_schema WHERE name LIKE 'plugin_credit_%' OR name LIKE 'extension_credit_%'"
        : `SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='${f.prefix.slice(1, -2)}' AND (c.relname LIKE 'plugin_credit_%' OR c.relname LIKE 'extension_credit_%')`,
    );
  return {
    ...f,
    actor,
    pin,
    reference,
    metadata,
    installed,
    enabled,
    installs,
    authorization,
    authority,
    authorityState,
    unmeteredTasks,
    projectAuthority,
    command,
    create,
    generate,
    reads,
    rows,
    creditObjects,
  };
}

/** Observe the real companion INSERT, preserving native SQL and bound statement receivers. */
export function observeUnmeteredInsert(
  backend: "sqlite" | "postgres",
  afterInsert: () => void,
): () => void {
  const prototype =
    backend === "sqlite" ? DatabaseSync.prototype : Client.prototype;
  const key = backend === "sqlite" ? "prepare" : "query";
  const descriptor = Object.getOwnPropertyDescriptor(prototype, key)!;
  Object.defineProperty(prototype, key, {
    ...descriptor,
    value: function (this: unknown, ...args: unknown[]) {
      const result = Reflect.apply(descriptor.value, this, args);
      if (
        typeof args[0] !== "string" ||
        !/INSERT INTO .*plugin_task_unmetered_admissions/u.test(args[0])
      )
        return result;
      if (backend === "postgres")
        return Promise.resolve(result).then((value) => {
          afterInsert();
          return value;
        });
      const statement = result as { run(...values: unknown[]): unknown };
      const run = statement.run.bind(statement);
      statement.run = (...values: unknown[]) => {
        const value = run(...values);
        afterInsert();
        return value;
      };
      return result;
    },
  });
  return () => Object.defineProperty(prototype, key, descriptor);
}
