import type { Pool, PoolClient } from "pg";
import {
  capturePluginProjectWorkspaceUiWrite,
  qualifyPluginProjectWorkspaceNativeObservation,
  type PluginProjectWorkspaceNativeObservation,
  type PluginProjectWorkspaceReadStore,
  type PluginUiActionContext,
  type RecordPluginProjectWorkspaceNamespaceInput,
  type RecordPluginProjectWorkspaceNamespaceResult,
} from "@crewon/application";
import {
  parsePluginProjectWorkspaceNamespace,
  pluginInstallationRecord,
} from "@crewon/domain";
import { pluginInstallationSchemaName } from "./plugin-installation-schema.ts";
import {
  hasPostgresPluginProjectWorkspaceSchema,
  migratePostgresPluginProjectWorkspaces,
  PLUGIN_PROJECT_WORKSPACE_TABLE,
} from "./plugin-project-workspace-schema.ts";
import { assertPostgresProjectTextUiCommit } from "./project-text-ui-commit-support.ts";
import { assertPostgresPluginProjectWorkspaceHistory } from "./plugin-project-workspace-history-fence.ts";
import { assertPostgresPluginProjectWorkspaceMetadata } from "./plugin-project-workspace-metadata-fence.ts";
import {
  assertNamespaceReplay,
  decodeNamespace,
  namespaceColumns,
  namespaceList,
  namespaceLoad,
  namespaceOwnerValues,
  namespaceOwnerWhere,
  namespaceProjectWhere,
  namespaceProjectValues,
  namespaceValues,
  pluginProjectWorkspaceLock,
  pluginProjectNamespaceLock,
} from "./plugin-project-workspace-store-support.ts";
import { advisoryLock } from "./postgres-thread-lock.ts";
import { migratePostgresPluginProjectMetadataOwners } from "./plugin-project-metadata-owner-schema.ts";
import { rollbackPostgres } from "./postgres-store-support.ts";

/** Same original parent pool; explicit migration and no directory/runtime ownership. */
export class PostgresPluginProjectWorkspaceStore
  implements PluginProjectWorkspaceReadStore
{
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #prefix: string;
  readonly #open: () => void;
  constructor(input: { pool: Pool; schema: string; assertOpen(): void }) {
    this.#pool = input.pool;
    this.#schema = input.schema;
    this.#prefix = `${pluginInstallationSchemaName(input.schema)}.`;
    this.#open = input.assertOpen.bind(input);
  }
  readonlyView(): PluginProjectWorkspaceReadStore {
    return Object.freeze({
      loadNamespace: this.loadNamespace.bind(this),
      listNamespaces: this.listNamespaces.bind(this),
    });
  }
  async migrateOwnership(): Promise<void> {
    await this.#transaction(async (c) => {
      await advisoryLock(c, `plugin-project-workspace-migrate:${this.#schema}`);
      await migratePostgresPluginProjectMetadataOwners(c, this.#schema);
      await migratePostgresPluginProjectWorkspaces(c, this.#schema);
    });
  }
  async migrate(): Promise<void> {
    await this.#transaction(async (c) => {
      await advisoryLock(c, `plugin-project-workspace-migrate:${this.#schema}`);
      await migratePostgresPluginProjectWorkspaces(c, this.#schema);
    });
  }
  async loadNamespace(
    input: Parameters<PluginProjectWorkspaceReadStore["loadNamespace"]>[0],
  ) {
    const owner = namespaceLoad(input);
    return this.#transaction(async (c) => {
      if (!(await hasPostgresPluginProjectWorkspaceSchema(c, this.#schema)))
        return null;
      const namespace = decodeNamespace(
        (
          await c.query(
            `SELECT * FROM ${this.#prefix}${PLUGIN_PROJECT_WORKSPACE_TABLE} WHERE ${parameters(namespaceOwnerWhere)} AND project_id=$8`,
            [...namespaceOwnerValues(owner), owner.projectId],
          )
        ).rows[0],
        owner,
      );
      if (namespace !== null)
        await assertPostgresPluginProjectWorkspaceMetadata(
          c,
          this.#schema,
          namespace.owner,
        );
      return namespace;
    });
  }
  async listNamespaces(
    input: Parameters<PluginProjectWorkspaceReadStore["listNamespaces"]>[0],
  ) {
    const v = namespaceList(input);
    return this.#transaction(async (c) => {
      if (!(await hasPostgresPluginProjectWorkspaceSchema(c, this.#schema)))
        return Object.freeze({
          namespaces: Object.freeze([]),
          nextProjectId: null,
        });
      const rows = (
        await c.query(
          `SELECT * FROM ${this.#prefix}${PLUGIN_PROJECT_WORKSPACE_TABLE} WHERE ${parameters(namespaceOwnerWhere)} ${v.afterProjectId === null ? "" : 'AND project_id COLLATE "C">$8'} ORDER BY project_id COLLATE "C" LIMIT $${v.afterProjectId === null ? 8 : 9}`,
          [
            ...namespaceOwnerValues(v.owner),
            ...(v.afterProjectId === null ? [] : [v.afterProjectId]),
            v.limit + 1,
          ],
        )
      ).rows;
      const all = rows.map((row) => decodeNamespace(row, v.owner)!);
      for (const namespace of all)
        await assertPostgresPluginProjectWorkspaceMetadata(
          c,
          this.#schema,
          namespace.owner,
        );
      const namespaces = Object.freeze(all.slice(0, v.limit));
      return Object.freeze({
        namespaces,
        nextProjectId:
          all.length > v.limit ? namespaces.at(-1)!.owner.projectId : null,
      });
    });
  }
  async recordFromPluginUi(
    context: PluginUiActionContext,
    input: RecordPluginProjectWorkspaceNamespaceInput,
  ): Promise<RecordPluginProjectWorkspaceNamespaceResult> {
    return this.#record(
      capturePluginProjectWorkspaceUiWrite(context, input),
      "original",
    );
  }
  /** Same original pool and transaction; a scoped Native observation supplies all ownership. */
  async recordFromNativeObservation(
    reference: PluginProjectWorkspaceNativeObservation,
    input: Readonly<{ createdAt: string }>,
  ): Promise<RecordPluginProjectWorkspaceNamespaceResult> {
    const source = qualifyPluginProjectWorkspaceNativeObservation(reference);
    const fields = pluginInstallationRecord(input, ["createdAt"]);
    return this.#record(
      {
        namespace: parsePluginProjectWorkspaceNamespace({
          schemaVersion: "crewon.plugin-project-workspace-namespace.v1",
          owner: source.owner,
          workspaceId: source.expectedWorkspaceId,
          createdAt: fields.createdAt,
        }),
        installation: source.commit.pin,
        selection: source.commit.selection,
        package: source.commit.package,
        assertCurrent: source.assertCurrent,
        assertTransactionCurrent: source.commit.assertTransactionCurrent,
        assertActive: source.assertActive,
      },
      "protected",
    );
  }
  async #record(
    q: ReturnType<typeof capturePluginProjectWorkspaceUiWrite>,
    mode: "original" | "protected",
  ): Promise<RecordPluginProjectWorkspaceNamespaceResult> {
    const n = q.namespace;
    await q.assertCurrent();
    if (mode === "protected") await q.assertTransactionCurrent();
    q.assertActive();
    return this.#transaction(
      async (c) => {
        await advisoryLock(c, pluginProjectNamespaceLock(n.owner));
        await advisoryLock(c, pluginProjectWorkspaceLock(n.workspaceId));
        if (!(await hasPostgresPluginProjectWorkspaceSchema(c, this.#schema)))
          throw new Error("plugin_project_workspace_schema_missing");
        await assertPostgresProjectTextUiCommit(c, this.#schema, q);
        const metadata = await assertPostgresPluginProjectWorkspaceMetadata(
          c,
          this.#schema,
          n.owner,
        );
        if (mode === "protected") {
          if (metadata !== "protected")
            throw new Error("plugin_project_workspace_metadata_required");
          await this.#assertActiveProject(c, n.owner);
        }
        await q.assertTransactionCurrent();
        q.assertActive();
        const table = `${this.#prefix}${PLUGIN_PROJECT_WORKSPACE_TABLE}`;
        const previous = decodeNamespace(
          (
            await c.query(
              `SELECT * FROM ${table} WHERE ${parameters(namespaceOwnerWhere)} AND project_id=$8 FOR UPDATE`,
              [...namespaceOwnerValues(n.owner), n.owner.projectId],
            )
          ).rows[0],
          n.owner,
        );
        if (previous !== null) {
          assertNamespaceReplay(
            previous,
            mode === "protected" ? { ...n, createdAt: previous.createdAt } : n,
          );
          return Object.freeze({
            disposition: "replayed" as const,
            namespace: previous,
          });
        }
        if (
          (
            await c.query(
              `SELECT 1 FROM ${table} WHERE ${parameters(namespaceProjectWhere)} LIMIT 1`,
              namespaceProjectValues(n.owner),
            )
          ).rows.length ||
          (
            await c.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1`, [
              n.workspaceId,
            ])
          ).rows.length
        )
          throw new Error("plugin_project_workspace_namespace_conflict");
        await assertPostgresPluginProjectWorkspaceHistory(
          c,
          this.#schema,
          n.owner,
        );
        if (
          (
            await c.query(
              `SELECT 1 FROM ${this.#prefix}threads WHERE state_json->>'workspaceId'=$1 LIMIT 1`,
              [n.workspaceId],
            )
          ).rows.length ||
          (
            await c.query(
              `SELECT 1 FROM ${this.#prefix}thread_events WHERE event_json->>'type'='thread.created' AND event_json->'data'->>'workspaceId'=$1 LIMIT 1`,
              [n.workspaceId],
            )
          ).rows.length
        )
          throw new Error("plugin_project_workspace_existing_thread_conflict");
        await c.query(
          `INSERT INTO ${table}(${namespaceColumns}) VALUES(${Array.from({ length: 11 }, (_, i) => `$${i + 1}`).join(",")})`,
          [...namespaceValues(n)],
        );
        return Object.freeze({
          disposition: "committed" as const,
          namespace: n,
        });
      },
      async (c) => {
        await q.assertTransactionCurrent();
        if (mode === "protected") {
          await assertPostgresProjectTextUiCommit(c, this.#schema, q);
          if (
            (await assertPostgresPluginProjectWorkspaceMetadata(
              c,
              this.#schema,
              n.owner,
            )) !== "protected"
          )
            throw new Error("plugin_project_workspace_metadata_required");
          await this.#assertActiveProject(c, n.owner);
          await q.assertTransactionCurrent();
        }
      },
      q.assertActive,
    );
  }
  async #assertActiveProject(
    c: PoolClient,
    owner: ReturnType<typeof parsePluginProjectWorkspaceNamespace>["owner"],
  ): Promise<void> {
    const result = await c.query(
      `SELECT state FROM ${this.#prefix}creative_projects WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3 AND owner_principal_id=$4 FOR SHARE`,
      [owner.tenantId, owner.spaceId, owner.projectId, owner.principalId],
    );
    if (result.rows[0]?.state !== "active")
      throw new Error("plugin_project_workspace_project_inactive");
  }
  async #transaction<T>(
    run: (c: PoolClient) => Promise<T>,
    assertTransactionCurrent?: (client: PoolClient) => Promise<void>,
    assertActive?: () => void,
  ): Promise<T> {
    this.#open();
    const c = await this.#pool.connect();
    try {
      await c.query("BEGIN");
      const result = await run(c);
      // SQL awaits can outlive the captured Host policy/epoch even while the mount remains live.
      await assertTransactionCurrent?.(c);
      assertActive?.();
      this.#open();
      await c.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackPostgres(c);
      throw error;
    } finally {
      c.release();
    }
  }
}
function parameters(input: string): string {
  let i = 0;
  return input.replaceAll("?", () => `$${++i}`);
}
