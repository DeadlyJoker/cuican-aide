import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { Pool, PoolClient } from "pg";
import {
  CreativeProjectApplicationService,
  ProjectTextApplicationService,
  type CreativeProjectCommitAuthority,
  type ProjectTextUiMutationAction,
} from "@crewon/application";
import { textDigester, textAt } from "./project-text-store.test-support.ts";
import {
  pluginCommitFixture,
  actor,
  type Backend,
} from "./creative-project-plugin-commit.test-support.ts";
import { PostgresProjectTextStore } from "./project-text-postgres-store.ts";
import { SqliteProjectTextStore } from "./project-text-sqlite-store.ts";

/** Real installed tuple and text persistence; no UI issuer, Run, model or funding is synthesized. */
export async function textUiCommitFixture(t: TestContext, backend: Backend) {
  const f = await pluginCommitFixture(t, backend);
  let afterTextSql: ((sql: string) => Promise<void>) | null = null;
  let borrowed = 0;
  let ownerOpen = true;
  const controlled = (client: PoolClient) =>
    new Proxy(client, {
      get(target, key) {
        if (key === "query")
          return async (sql: string, values?: unknown[]) => {
            const result = await target.query(sql, values);
            await afterTextSql?.(sql);
            return result;
          };
        if (key === "release")
          return () => {
            borrowed--;
            target.release();
          };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const pool =
    f.pool === null
      ? null
      : (new Proxy(f.pool, {
          get(target, key) {
            if (key === "connect")
              return async () => {
                const client = await target.connect();
                borrowed++;
                return controlled(client);
              };
            const value: unknown = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as Pool);
  const assertOpen = () => {
    if (!ownerOpen) throw new Error("metadata_text_owner_closed");
  };
  const textStore =
    pool === null
      ? new SqliteProjectTextStore({ database: assertDatabase(), assertOpen })
      : new PostgresProjectTextStore({ pool, schema: f.schema, assertOpen });
  function assertDatabase() {
    assert.ok(f.database);
    return f.database;
  }
  await textStore.migrate();
  const policy = { allow: true };
  const dependencies = {
    authorization: {
      authorize: async () => ({
        outcome: policy.allow ? ("allow" as const) : ("deny" as const),
        reasonCode: "named_text_ui_policy",
      }),
    },
    clock: { now: () => textAt },
    ids: { nextId: () => randomUUID() },
    digester: textDigester,
  };
  const projects = new CreativeProjectApplicationService({
    ...dependencies,
    store: f.projects,
  });
  const project = await projects.createProject(actor, {
    title: "雨夜",
    briefText: "三集悬疑，修复师找到一封旧信。",
    idempotencyKey: "text-ui-project",
  });
  const text = new ProjectTextApplicationService({
    ...dependencies,
    store: textStore,
    projects: f.projects,
  });
  const installation = Object.freeze({
    tenantId: f.scope.tenantId,
    spaceId: f.scope.spaceId,
    profileId: f.scope.profileId,
    pluginId: f.source.package.pluginId,
    publisherId: f.source.package.publisherId,
    version: f.source.package.version,
    packageDigest: f.source.package.packageDigest,
    selectionRevision: f.source.selection.revision,
  });
  const grant = (actionId: ProjectTextUiMutationAction, input: unknown) => {
    const old = f.grant();
    const transaction = old.authority.transaction;
    if (transaction === undefined)
      throw new Error("fixture_original_transaction_missing");
    const authority: CreativeProjectCommitAuthority = Object.freeze({
      assertCurrent: async () => {
        assert.equal(
          borrowed,
          0,
          "full current callback must not borrow the active one-connection text pool",
        );
        await old.authority.assertCurrent();
      },
      assertActive: old.authority.assertActive.bind(old.authority),
      textUiTransaction: Object.freeze({
        version: "crewon.project-text-plugin-commit.v1" as const,
        actor,
        installation,
        actionId,
        input,
        selection: f.source.selection,
        package: f.source.package,
        assertCurrent: transaction.assertCurrent.bind(transaction),
      }),
    });
    return {
      authority,
      state: old.state,
      options: Object.freeze({ authority }),
    };
  };
  const counts = async () => {
    const result: Record<string, number> = {};
    for (const table of [
      "project_text_artifacts",
      "project_text_revisions",
      "project_text_mutation_receipts",
    ])
      result[table] = Number(
        (await f.query(`SELECT COUNT(*) AS n FROM ${f.prefix}${table}`))[0]?.n,
      );
    return result;
  };
  return {
    ...f,
    actor,
    policy,
    projects,
    project,
    textStore,
    text,
    installation,
    grant,
    legacyGrant: f.grant,
    textCounts: counts,
    observeTextSql(work: ((sql: string) => Promise<void>) | null) {
      afterTextSql = work;
    },
    closeTextOwner() {
      ownerOpen = false;
      f.closeOwner();
    },
    get textBorrowed() {
      return borrowed;
    },
  };
}
