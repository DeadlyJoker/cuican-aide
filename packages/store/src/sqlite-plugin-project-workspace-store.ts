import type { DatabaseSync } from "node:sqlite";
import {
  capturePluginProjectWorkspaceUiWrite,
  type PluginProjectWorkspaceReadStore,
  type PluginUiActionContext,
  type RecordPluginProjectWorkspaceNamespaceInput,
  type RecordPluginProjectWorkspaceNamespaceResult,
} from "@crewon/application";
import {
  hasSqlitePluginProjectWorkspaceSchema,
  migrateSqlitePluginProjectWorkspaces,
  PLUGIN_PROJECT_WORKSPACE_TABLE as table,
} from "./plugin-project-workspace-schema.ts";
import { assertSqliteProjectTextUiCommit } from "./project-text-ui-commit-support.ts";
import {
  assertNamespaceReplay,
  decodeNamespace,
  namespaceColumns,
  namespaceList,
  namespaceLoad,
  namespaceOwnerValues,
  namespaceOwnerWhere,
  namespaceValues,
} from "./plugin-project-workspace-store-support.ts";

/** Shares the original parent database. Namespace ownership only; no filesystem or execution engine. */
export class SqlitePluginProjectWorkspaceStore
  implements PluginProjectWorkspaceReadStore
{
  readonly #db: DatabaseSync;
  readonly #open: () => void;
  constructor(input: { database: DatabaseSync; assertOpen(): void }) {
    this.#db = input.database;
    this.#open = input.assertOpen.bind(input);
  }
  readonlyView(): PluginProjectWorkspaceReadStore {
    return Object.freeze({
      loadNamespace: this.loadNamespace.bind(this),
      listNamespaces: this.listNamespaces.bind(this),
    });
  }
  async migrate(): Promise<void> {
    this.#transaction(() => migrateSqlitePluginProjectWorkspaces(this.#db));
  }
  async loadNamespace(
    input: Parameters<PluginProjectWorkspaceReadStore["loadNamespace"]>[0],
  ) {
    const owner = namespaceLoad(input);
    this.#open();
    if (!hasSqlitePluginProjectWorkspaceSchema(this.#db)) return null;
    return decodeNamespace(
      this.#db
        .prepare(
          `SELECT * FROM ${table} WHERE ${namespaceOwnerWhere} AND project_id=?`,
        )
        .get(...namespaceOwnerValues(owner), owner.projectId),
      owner,
    );
  }
  async listNamespaces(
    input: Parameters<PluginProjectWorkspaceReadStore["listNamespaces"]>[0],
  ) {
    const v = namespaceList(input);
    this.#open();
    if (!hasSqlitePluginProjectWorkspaceSchema(this.#db))
      return Object.freeze({
        namespaces: Object.freeze([]),
        nextProjectId: null,
      });
    const rows = this.#db
      .prepare(
        `SELECT * FROM ${table} WHERE ${namespaceOwnerWhere} ${v.afterProjectId === null ? "" : "AND project_id COLLATE BINARY>?"} ORDER BY project_id COLLATE BINARY LIMIT ?`,
      )
      .all(
        ...namespaceOwnerValues(v.owner),
        ...(v.afterProjectId === null ? [] : [v.afterProjectId]),
        v.limit + 1,
      );
    const all = rows.map((row) => decodeNamespace(row, v.owner)!);
    const namespaces = Object.freeze(all.slice(0, v.limit));
    return Object.freeze({
      namespaces,
      nextProjectId:
        all.length > v.limit ? namespaces.at(-1)!.owner.projectId : null,
    });
  }
  /** Only an original live installed UI invocation can enter this internal write path today. */
  async recordFromPluginUi(
    context: PluginUiActionContext,
    input: RecordPluginProjectWorkspaceNamespaceInput,
  ): Promise<RecordPluginProjectWorkspaceNamespaceResult> {
    const q = capturePluginProjectWorkspaceUiWrite(context, input),
      n = q.namespace;
    await q.assertCurrent();
    await q.assertTransactionCurrent();
    q.assertActive();
    return this.#transaction(
      () => {
        if (!hasSqlitePluginProjectWorkspaceSchema(this.#db))
          throw new Error("plugin_project_workspace_schema_missing");
        assertSqliteProjectTextUiCommit(this.#db, q);
        const previous = decodeNamespace(
          this.#db
            .prepare(
              `SELECT * FROM ${table} WHERE ${namespaceOwnerWhere} AND project_id=?`,
            )
            .get(...namespaceOwnerValues(n.owner), n.owner.projectId),
          n.owner,
        );
        if (previous !== null) {
          assertNamespaceReplay(previous, n);
          return Object.freeze({
            disposition: "replayed" as const,
            namespace: previous,
          });
        }
        if (
          this.#db
            .prepare(`SELECT workspace_id FROM ${table} WHERE workspace_id=?`)
            .get(n.workspaceId)
        )
          throw new Error("plugin_project_workspace_namespace_conflict");
        if (
          this.#db
            .prepare(
              "SELECT 1 FROM threads WHERE json_extract(state_json,'$.workspaceId')=? LIMIT 1",
            )
            .get(n.workspaceId) ||
          this.#db
            .prepare(
              "SELECT 1 FROM thread_events WHERE json_extract(event_json,'$.type')='thread.created' AND json_extract(event_json,'$.data.workspaceId')=? LIMIT 1",
            )
            .get(n.workspaceId)
        )
          throw new Error("plugin_project_workspace_existing_thread_conflict");
        this.#db
          .prepare(
            `INSERT INTO ${table}(${namespaceColumns}) VALUES(${Array(11).fill("?").join(",")})`,
          )
          .run(...namespaceValues(n));
        return Object.freeze({
          disposition: "committed" as const,
          namespace: n,
        });
      },
      () => {
        q.assertActive();
        assertSqliteProjectTextUiCommit(this.#db, q);
        q.assertActive();
      },
    );
  }
  #transaction<T>(run: () => T, beforeCommit: () => void = () => {}): T {
    this.#open();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      beforeCommit();
      this.#open();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
}
