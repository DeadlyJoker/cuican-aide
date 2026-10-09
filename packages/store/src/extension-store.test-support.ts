import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import {
  createExtensionConfiguration,
  createExtensionRunBinding,
  type ExtensionActivation,
  type ExtensionConfiguration,
  type ExtensionExecutionTarget,
  type ExtensionRunBindingV0,
} from "@crewon/domain";
import type {
  CommitExtensionRunInput,
  ExternalOperationStore,
} from "@crewon/application";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import { SqliteExternalOperationStore } from "./sqlite-external-operation-store.ts";
import { PostgresExternalOperationStore } from "./postgres-external-operation-store.ts";
import { extensionStoreDigester } from "./extension-store-records.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import {
  releaseActivation,
  releaseBundle,
} from "./agent-version-release-store-conformance.test-support.ts";

export const scope = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  pluginId: "crewon.comfyui-krea2",
};
export const timestamp = "2026-09-30T00:00:00.000Z";
export const digest = `sha256:${"a".repeat(64)}`;
export const target: ExtensionExecutionTarget = {
  executionAuthority: "crewonKernel",
  agentVersionId: "agent-1",
  agentVersionContentDigest: digest,
  materializationDigest: `sha256:${"1".repeat(64)}`,
  authorityId: "authority-agent-1",
  runtimeGeneration: "ts-v0",
  policySnapshotId: "policy-1",
  workspaceBindingId: null,
};
export function configuration(
  patch: Partial<Omit<ExtensionConfiguration, "contentDigest">> = {},
) {
  return createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      ...scope,
      revision: 1,
      pluginVersion: "1.0.0",
      manifestDigest: digest,
      implementationDigest: digest,
      parameters: { serviceUrl: "https://example.com/" },
      credentialBindings: [],
      createdByActorId: "actor-1",
      createdAt: timestamp,
      ...patch,
    },
    extensionStoreDigester,
  );
}
export function receipt(key: string) {
  return {
    actorId: "actor-1",
    idempotencyKey: key,
    requestDigest: extensionStoreDigester.sha256(key),
  };
}
export function activation(
  config = configuration(),
  patch: Partial<ExtensionActivation> = {},
): ExtensionActivation {
  return {
    schemaVersion: "crewon.extension-activation.v0",
    ...scope,
    revision: 1,
    configurationRevision: config.revision,
    configurationDigest: config.contentDigest,
    state: "enabled",
    target,
    updatedByActorId: "actor-1",
    updatedAt: timestamp,
    ...patch,
  };
}
export function runInput(
  id = "run-1",
  patch: Partial<Omit<ExtensionRunBindingV0, "bindingDigest">> = {},
): CommitExtensionRunInput {
  const config = configuration();
  const binding = createExtensionRunBinding(
    {
      schemaVersion: "crewon.extension-run-binding.v0",
      ...scope,
      runId: id,
      threadId: `thread-${id}`,
      actorId: "actor-1",
      configurationRevision: config.revision,
      configurationDigest: config.contentDigest,
      target,
      inputDigest: extensionStoreDigester.sha256(`prompt:${id}`),
      source: null,
      ...patch,
    },
    extensionStoreDigester,
  );
  const eventId = `event-${id}`;
  return {
    binding,
    expectedActivationRevision: 1,
    receipt: receipt(`task-${id}`),
    commit: {
      tenantId: binding.tenantId,
      idempotency: {
        scope: "unused-extension-task-scope",
        key: id,
        requestFingerprint: digest,
      },
      expectedRevision: 0,
      events: [
        {
          schemaVersion: "crewon.run-event.v0",
          identity: { runId: id },
          eventId,
          sequence: 1,
          occurredAt: timestamp,
          type: "run.created",
          data: {
            tenantId: binding.tenantId,
            spaceId: binding.spaceId,
            threadId: binding.threadId,
            createdByActorId: binding.actorId,
            agentVersionId: binding.target.agentVersionId,
            authorityId: binding.target.authorityId,
            runtimeGeneration: binding.target.runtimeGeneration,
            policySnapshotId: binding.target.policySnapshotId,
            workspaceBindingId: binding.target.workspaceBindingId,
            collaborationMode: "default",
            origin: null,
            goalBinding: null,
          },
        },
      ],
      outbox: [
        {
          messageId: `outbox-${id}`,
          tenantId: binding.tenantId,
          runId: id,
          topic: "run.updated",
          payload: { eventId, eventType: "run.created", throughSequence: 1 },
          createdAt: timestamp,
        },
      ],
      workItems: [
        {
          workItemId: `work-${id}`,
          tenantId: binding.tenantId,
          runId: id,
          kind: "run.execute",
          payload: { throughSequence: 1 },
          createdAt: timestamp,
        },
      ],
    },
  };
}

export async function extensionFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  options: Readonly<{ maxPoolSize?: number }> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "crewon-extension-"));
  const path = join(dir, "control.sqlite");
  const schema = `extension_${randomUUID().replaceAll("-", "")}`;
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
  if (backend === "postgres") assert.ok(connectionString);
  const opened: (SqliteRunStore | PostgresDomainStore)[] = [];
  const sqlDb = backend === "sqlite" ? new DatabaseSync(path) : null;
  const sqlPool =
    backend === "postgres" ? new Pool({ connectionString, max: 1 }) : null;
  const prefix = backend === "postgres" ? `"${schema}".` : "";
  t.after(async () => {
    for (const store of opened) await store.close();
    sqlDb?.close();
    if (sqlPool !== null) {
      try {
        await sqlPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await sqlPool.end();
      }
    }
    await rm(dir, { force: true, recursive: true });
  });
  const sql = async (query: string) => {
    if (sqlDb !== null) sqlDb.exec(query);
    else await sqlPool!.query(query);
  };
  const count = async (table: string) => {
    assert.ok(/^[a-z_]+$/u.test(table));
    const query = `SELECT COUNT(*) AS count FROM ${prefix}${table}`;
    return Number(
      sqlDb !== null
        ? (sqlDb.prepare(query).get() as { count: number }).count
        : (await sqlPool!.query(query)).rows[0].count,
    );
  };
  const open = async () => {
    const parent =
      backend === "sqlite"
        ? new SqliteRunStore(path)
        : await PostgresDomainStore.open({
            connectionString: connectionString!,
            schema,
            maxPoolSize: options.maxPoolSize ?? 2,
          });
    opened.push(parent);
    const store = parent.extensionStore();
    await store.migrate();
    return { parent, store };
  };
  const first = await open();
  const second = await open();
  const operations: ExternalOperationStore =
    sqlDb !== null
      ? new SqliteExternalOperationStore(sqlDb)
      : new PostgresExternalOperationStore(sqlPool!, schema);
  const seedDeployment = async () => {
    await first.parent.registerAgentVersion({
      schemaVersion: "crewon.agent-version-asset.v0",
      tenantId: scope.tenantId,
      agentVersionId: target.agentVersionId,
      contentDigest: target.agentVersionContentDigest,
      createdAt: timestamp,
      definitionJson: JSON.stringify({
        schemaVersion: "crewon.agent-version.v0",
        agentVersionId: target.agentVersionId,
        runtimeGeneration: target.runtimeGeneration,
        policySnapshotId: target.policySnapshotId,
      }),
    });
    const bundle = releaseBundle("c", [target.agentVersionId]);
    await first.parent.activateAgentVersionRelease({
      bundle,
      activation: releaseActivation(bundle, "release-1", null),
      expectedActiveReleaseId: null,
    });
  };
  const seed = async () => {
    await seedDeployment();
    await first.store.saveExtensionConfiguration({
      configuration: configuration(),
      expectedRevision: 0,
      receipt: receipt("config-1"),
    });
    await first.store.saveExtensionActivation({
      activation: activation(),
      expectedRevision: 0,
      receipt: receipt("activate-1"),
    });
  };
  const prepare = async (input = runInput()) => {
    await seedThread(first.parent, {
      ...input.binding,
      actorId: input.binding.actorId,
    });
    return input;
  };
  const failBindings = async (enable: boolean) => {
    if (backend === "sqlite")
      await sql(
        enable
          ? "CREATE TRIGGER fail_binding BEFORE INSERT ON extension_run_bindings BEGIN SELECT RAISE(ABORT, 'test_binding_failure'); END;"
          : "DROP TRIGGER fail_binding;",
      );
    else
      await sql(
        enable
          ? `CREATE FUNCTION ${prefix}fail_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test_binding_failure'; END $$; CREATE TRIGGER fail_binding BEFORE INSERT ON ${prefix}extension_run_bindings FOR EACH ROW EXECUTE FUNCTION ${prefix}fail_binding();`
          : `DROP TRIGGER fail_binding ON ${prefix}extension_run_bindings; DROP FUNCTION ${prefix}fail_binding();`,
      );
  };
  return {
    first,
    second,
    databasePath: path,
    open,
    seed,
    seedDeployment,
    prepare,
    operations,
    count,
    sql,
    prefix,
    failBindings,
  };
}
