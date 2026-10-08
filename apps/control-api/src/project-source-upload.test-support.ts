import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { Pool, type PoolClient } from "pg";
import {
  ApplicationError,
  ProjectSourceUploadApplicationService,
  type ActorContext,
  type ProjectSourceUploadCommitAuthority,
  type ProjectSourceUploadPermission,
} from "@crewon/application";
import { ProjectSourceUploadPreparationAdapter } from "@crewon/media-runtime";
import {
  PostgresCreativeProjectStore,
  SqliteCreativeProjectStore,
  SqliteProjectSourceUploadStore,
  PostgresProjectSourceUploadStore,
} from "@crewon/store";

export type UploadBackend = "sqlite" | "postgres";
export const uploadActor: ActorContext = Object.freeze({
  tenantId: "upload-tenant",
  spaceId: "upload-space",
  principalId: "upload-principal",
  actorId: "upload-ui",
});
export const uploadAgent: ActorContext = Object.freeze({
  ...uploadActor,
  actorId: "upload-agent",
});
export const uploadForeign: ActorContext = Object.freeze({
  ...uploadActor,
  principalId: "foreign",
});
export const uploadOwner = Object.freeze({
  tenantId: uploadActor.tenantId,
  spaceId: uploadActor.spaceId,
  principalId: uploadActor.principalId,
});
export const uploadHash = (value: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
export const uploadTime = "2026-10-08T00:00:00.000Z";

/** Real DB and parser, named independent policy; no public route, mount, Agent Run or model. */
export async function sourceUploadFixture(
  t: TestContext,
  backend: UploadBackend,
) {
  const directory = await mkdtemp(join(tmpdir(), "crewon-source-upload-")),
    path = join(directory, "projects.sqlite"),
    schema = `source_upload_${randomUUID().replaceAll("-", "")}`;
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
  if (backend === "postgres") assert.ok(connectionString);
  const admin =
    backend === "postgres" ? new Pool({ connectionString, max: 1 }) : null;
  if (admin) await admin.query(`CREATE SCHEMA "${schema}"`);
  let database: DatabaseSync | null = null,
    pool: Pool | null = null,
    closed = false;
  const state = {
    allow: true,
    active: true,
    parserCalls: 0,
    parserFault: null as Error | null,
    idCalls: 0,
    now: uploadTime,
    afterCommit: false,
  };
  function grant(
    action: ProjectSourceUploadPermission["action"],
    uploadId: string | null,
    actor: ActorContext = uploadActor,
  ): ProjectSourceUploadCommitAuthority {
    return {
      version: "crewon.project-source-upload-commit.v1",
      permission: {
        actor,
        action,
        resource: {
          kind: "projectSourceUpload",
          owner: {
            tenantId: actor.tenantId,
            spaceId: actor.spaceId,
            principalId: actor.principalId,
          },
          uploadId,
          projectId: null,
        },
      },
      async assertCurrent() {
        if (!state.allow || !state.active)
          throw new ApplicationError("authorization", "named-upload-denied");
      },
      assertActive() {
        if (!state.active)
          throw new ApplicationError("authorization", "named-upload-withdrawn");
      },
    };
  }
  async function close() {
    if (closed) return;
    closed = true;
    database?.close();
    database = null;
    await pool?.end();
    pool = null;
  }
  t.after(async () => {
    await close();
    try {
      await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await admin?.end();
      await rm(directory, { recursive: true, force: true });
    }
  });
  async function open() {
    closed = false;
    const assertOpen = () =>
      assert.equal(closed, false, "original host handle closed");
    database = backend === "sqlite" ? new DatabaseSync(path) : null;
    pool =
      backend === "postgres" ? new Pool({ connectionString, max: 1 }) : null;
    pool?.on("connect", (client) => {
      const query = client.query;
      let writeTransaction = false;
      Object.defineProperty(client, "query", {
        configurable: true,
        value: function (this: PoolClient, ...args: unknown[]) {
          if (args[0] === "BEGIN") writeTransaction = true;
          else if (
            args[0] === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
          )
            writeTransaction = false;
          const committedWrite = args[0] === "COMMIT" && writeTransaction;
          if (args[0] === "COMMIT" || args[0] === "ROLLBACK")
            writeTransaction = false;
          const result = Reflect.apply(query, this, args);
          // The preceding read snapshot must not trigger the write-COMMIT withdrawal.
          if (committedWrite && state.afterCommit) {
            return Promise.prototype.then.call(result, (value: unknown) => {
              state.active = false;
              return value;
            });
          }
          return result;
        },
      });
    });
    database?.exec("PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000");
    if (database) {
      const exec = database.exec.bind(database);
      database.exec = (sql: string) => {
        exec(sql);
        if (sql === "COMMIT" && state.afterCommit) state.active = false;
      };
    }
    const projects = database
      ? new SqliteCreativeProjectStore({ database, assertOpen })
      : new PostgresCreativeProjectStore({ pool: pool!, schema, assertOpen });
    await projects.migrate();
    const uploads = database
      ? new SqliteProjectSourceUploadStore({ database, assertOpen })
      : new PostgresProjectSourceUploadStore({
          pool: pool!,
          schema,
          assertOpen,
        });
    await uploads.migrate();
    const adapter = new ProjectSourceUploadPreparationAdapter();
    const service = new ProjectSourceUploadApplicationService({
      store: uploads,
      authorization: {
        async authorize() {
          return state.allow
            ? { outcome: "allow" }
            : { outcome: "deny", reasonCode: "named-upload-denied" };
        },
        assertActive() {
          if (!state.active)
            throw new ApplicationError(
              "authorization",
              "named-upload-withdrawn",
            );
        },
      },
      bytes: adapter,
      parser: {
        normalizationParserVersion: adapter.normalizationParserVersion,
        async parse(input) {
          if (state.parserFault !== null) throw state.parserFault;
          state.parserCalls++;
          return adapter.parse(input);
        },
      },
      clock: { now: () => state.now },
      digester: { sha256: uploadHash },
      ids: {
        nextUploadId() {
          state.idCalls++;
          return randomUUID();
        },
        nextClaimId() {
          state.idCalls++;
          return randomUUID();
        },
      },
      preparationClaimTtlMs: 60_000,
    });
    return { uploads, service, projects };
  }
  async function query(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<Record<string, unknown>[]> {
    if (database) {
      const statement = database.prepare(
        sql.replaceAll("$schema.", "").replace(/\$([0-9]+)/gu, "?"),
      );
      return statement.all(
        ...(parameters as (string | number | Uint8Array | null)[]),
      );
    }
    assert.ok(admin);
    return (
      await admin.query(sql.replaceAll("$schema.", `"${schema}".`), [
        ...parameters,
      ])
    ).rows;
  }
  async function execute(sql: string, parameters: readonly unknown[] = []) {
    if (database) {
      database
        .prepare(sql.replaceAll("$schema.", "").replace(/\$([0-9]+)/gu, "?"))
        .run(...(parameters as (string | number | Uint8Array | null)[]));
    } else {
      assert.ok(admin);
      await admin.query(sql.replaceAll("$schema.", `"${schema}".`), [
        ...parameters,
      ]);
    }
  }
  return { backend, state, grant, open, close, query, execute };
}
