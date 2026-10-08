import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { Pool, type PoolClient } from "pg";
import {
  ApplicationError,
  ProjectFoundationApplicationService,
  ProjectSourceUploadApplicationService,
  ProjectSourceUploadFoundationAdapter,
  type ActorContext,
  type CreateProjectFoundationCommand,
  type PreparedProjectSource,
  type ProjectFoundationCommitOptions,
  type ProjectSourcePreparationPort,
  type ProjectSourceUploadPermission,
} from "@crewon/application";
import { ProjectSourceUploadPreparationAdapter } from "@crewon/media-runtime";
import {
  PostgresCreativeProjectStore,
  PostgresProjectFoundationStore,
  PostgresProjectSourceUploadStore,
  SqliteCreativeProjectStore,
  SqliteProjectFoundationStore,
  SqliteProjectSourceUploadStore,
} from "@crewon/store";
import { importParameters } from "./project-foundation-import.test-support.ts";
import {
  uploadActor,
  uploadHash,
  type UploadBackend,
} from "./project-source-upload.test-support.ts";

export function adoptedNovel(
  sourceUpload: { uploadId: string; fileDigest: string },
  key: string,
): CreateProjectFoundationCommand {
  return {
    title: `雨夜 · ${key}`,
    briefText: "保留雨夜来信的悬疑内核，改编为120集短剧。",
    origin: "novel",
    parameters: importParameters("novel"),
    creativeStartMode: null,
    sourceUpload,
    idempotencyKey: key,
  };
}
export function adoptionFailure(code: string) {
  return (error: unknown) =>
    error instanceof ApplicationError && error.code === code;
}

/**
 * Actual original SQL parent, multipart upload service, parser, bridge and strict foundation
 * stores. The independent policies are named internal fixtures, not public HTTP/UI/Agent proof.
 * SQL wrappers only observe real statements or withdraw a named live policy after they succeed.
 */
export async function sourceAdoptionFixture(
  t: TestContext,
  backend: UploadBackend,
) {
  const directory = await mkdtemp(join(tmpdir(), "crewon-source-adoption-"));
  const path = join(directory, "projects.sqlite");
  const schema = `source_adoption_${randomUUID().replaceAll("-", "")}`;
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
  if (backend === "postgres") assert.ok(connectionString);
  const admin =
    backend === "postgres" ? new Pool({ connectionString, max: 1 }) : null;
  if (admin !== null) await admin.query(`CREATE SCHEMA "${schema}"`);
  let database: DatabaseSync | null = null;
  let pool: Pool | null = null;
  let closed = true;
  const state = {
    allowCreative: true,
    activeCreative: true,
    allowUpload: true,
    activeUpload: true,
    allowAdopt: true,
    activeAdopt: true,
    sourceReads: 0,
    projectIds: 0,
    uploadIds: 0,
    parserCalls: 0,
    clockCalls: 0,
    associationWrites: 0,
    withdrawCreativeAfterAssociation: false,
    withdrawAdoptAfterAssociation: false,
    withdrawAdoptAfterWriteCommit: false,
    transformPrepared: null as
      | ((source: PreparedProjectSource) => PreparedProjectSource)
      | null,
    permissions: [] as ProjectSourceUploadPermission[],
  };
  function afterAssociation() {
    state.associationWrites++;
    if (state.withdrawCreativeAfterAssociation) state.activeCreative = false;
    if (state.withdrawAdoptAfterAssociation) state.activeAdopt = false;
  }
  function afterAssociationCommit() {
    if (state.withdrawAdoptAfterWriteCommit) state.activeAdopt = false;
  }
  function now() {
    return new Date(
      Date.UTC(2026, 9, 8, 0, 0, ++state.clockCalls),
    ).toISOString();
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
  function authority(): ProjectFoundationCommitOptions {
    return {
      authority: {
        async assertCurrent() {
          if (!state.allowCreative)
            throw new ApplicationError(
              "authorization",
              "named-creative-denied",
            );
          if (!state.activeCreative)
            throw new ApplicationError(
              "authorization",
              "named-creative-withdrawn",
            );
        },
        assertActive() {
          if (!state.activeCreative)
            throw new ApplicationError(
              "authorization",
              "named-creative-withdrawn",
            );
        },
      },
    };
  }
  async function open() {
    assert.equal(closed, true, "close the original handle before reopening");
    closed = false;
    database = backend === "sqlite" ? new DatabaseSync(path) : null;
    pool =
      backend === "postgres" ? new Pool({ connectionString, max: 1 }) : null;
    const assertOpen = () =>
      assert.equal(closed, false, "host database closed");
    if (database !== null) {
      database.exec("PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000");
      let associated = false;
      const prepare = database.prepare.bind(database);
      database.prepare = (sql) => {
        const statement = prepare(sql);
        if (/INSERT\s+INTO\s+project_source_upload_associations/iu.test(sql)) {
          const run = statement.run;
          statement.run = (...parameters) => {
            const result: ReturnType<typeof run> = Reflect.apply(
              run,
              statement,
              parameters,
            );
            associated = true;
            afterAssociation();
            return result;
          };
        }
        return statement;
      };
      const exec = database.exec.bind(database);
      database.exec = (sql) => {
        if (sql === "BEGIN IMMEDIATE") associated = false;
        exec(sql);
        if (sql === "COMMIT" && associated) afterAssociationCommit();
        if (sql === "COMMIT" || sql === "ROLLBACK") associated = false;
      };
    }
    pool?.on("connect", (client) => {
      const query = client.query;
      let writeTransaction = false;
      let associated = false;
      Object.defineProperty(client, "query", {
        configurable: true,
        value: function (this: PoolClient, ...args: unknown[]) {
          const sql = args[0];
          if (typeof sql === "string" && sql.startsWith("BEGIN")) {
            writeTransaction = sql === "BEGIN";
            associated = false;
          }
          const writesAssociation =
            typeof sql === "string" &&
            /INSERT\s+INTO\s+[^\s]*project_source_upload_associations/iu.test(
              sql,
            );
          const commitsAssociation =
            sql === "COMMIT" && writeTransaction && associated;
          if (sql === "COMMIT" || sql === "ROLLBACK") {
            writeTransaction = false;
            associated = false;
          }
          const result = Reflect.apply(query, this, args);
          if (!writesAssociation && !commitsAssociation) return result;
          return Promise.prototype.then.call(result, (value: unknown) => {
            if (writesAssociation) {
              associated = true;
              afterAssociation();
            }
            if (commitsAssociation) afterAssociationCommit();
            return value;
          });
        },
      });
    });
    const projects = database
      ? new SqliteCreativeProjectStore({ database, assertOpen })
      : new PostgresCreativeProjectStore({ pool: pool!, schema, assertOpen });
    const uploads = database
      ? new SqliteProjectSourceUploadStore({ database, assertOpen })
      : new PostgresProjectSourceUploadStore({
          pool: pool!,
          schema,
          assertOpen,
        });
    const foundations = database
      ? new SqliteProjectFoundationStore({ database, assertOpen })
      : new PostgresProjectFoundationStore({ pool: pool!, schema, assertOpen });
    const parser = new ProjectSourceUploadPreparationAdapter();
    const uploadService = new ProjectSourceUploadApplicationService({
      store: uploads,
      authorization: {
        async authorize(permission) {
          state.permissions.push(permission);
          return state.allowUpload &&
            (permission.action !== "projectSourceUpload:adopt" ||
              state.allowAdopt)
            ? { outcome: "allow" }
            : { outcome: "deny", reasonCode: "named-upload-denied" };
        },
        assertActive(permission) {
          if (!state.activeUpload)
            throw new ApplicationError(
              "authorization",
              "named-upload-withdrawn",
            );
          if (
            permission.action === "projectSourceUpload:adopt" &&
            !state.activeAdopt
          )
            throw new ApplicationError(
              "authorization",
              "named-adopt-withdrawn",
            );
        },
      },
      bytes: parser,
      parser: {
        normalizationParserVersion: parser.normalizationParserVersion,
        async parse(input) {
          state.parserCalls++;
          return parser.parse(input);
        },
      },
      clock: { now },
      digester: { sha256: uploadHash },
      ids: {
        nextUploadId() {
          state.uploadIds++;
          return randomUUID();
        },
        nextClaimId() {
          state.uploadIds++;
          return randomUUID();
        },
      },
      preparationClaimTtlMs: 60_000,
    });
    const bridge = new ProjectSourceUploadFoundationAdapter(uploadService);
    const sourcePreparation: ProjectSourcePreparationPort = {
      captureAdoptionAuthority(request) {
        return bridge.captureAdoptionAuthority(request);
      },
      async loadPrepared(request) {
        state.sourceReads++;
        const source = await bridge.loadPrepared(request);
        return source !== null && state.transformPrepared !== null
          ? state.transformPrepared(source)
          : source;
      },
    };
    const service = new ProjectFoundationApplicationService({
      projects,
      store: foundations,
      sourcePreparation,
      authorization: {
        async authorize() {
          return state.allowCreative
            ? { outcome: "allow" }
            : { outcome: "deny", reasonCode: "named-creative-denied" };
        },
      },
      clock: { now },
      ids: {
        nextId() {
          state.projectIds++;
          return `adopted-project-${randomUUID()}`;
        },
      },
      digester: { sha256: uploadHash },
    });
    return { projects, uploads, foundations, uploadService, bridge, service };
  }
  const first = await open();
  await first.projects.migrate();
  await first.uploads.migrate();
  await first.foundations.migrate();
  async function query(sql: string, parameters: readonly unknown[] = []) {
    if (database) {
      return database
        .prepare(sql.replaceAll("$schema.", "").replace(/\$([0-9]+)/gu, "?"))
        .all(...(parameters as (string | number | Uint8Array | null)[]));
    }
    assert.ok(admin);
    return (
      await admin.query(sql.replaceAll("$schema.", `"${schema}".`), [
        ...parameters,
      ])
    ).rows as Record<string, unknown>[];
  }
  async function counts() {
    const result: Record<string, number> = {};
    for (const table of [
      "creative_projects",
      "creative_project_briefs",
      "project_foundations",
      "project_sources",
      "project_source_chunks",
      "project_source_chapters",
      "project_proposals",
      "project_foundation_mutation_receipts",
      "project_source_uploads",
      "project_source_upload_associations",
    ]) {
      result[table] = Number(
        (await query(`SELECT count(*) AS n FROM $schema.${table}`))[0]!.n,
      );
    }
    return result;
  }
  return { first, open, close, state, authority, query, counts };
}

export async function prepareOwnedUpload(
  service: ProjectSourceUploadApplicationService,
  bytes: Uint8Array,
  key: string,
  actor: ActorContext = uploadActor,
) {
  let state = (
    await service.begin(actor, {
      idempotencyKey: key,
      fileName: "story.txt",
      format: "txt",
      byteLength: bytes.byteLength,
      fileDigest: uploadHash(bytes),
    })
  ).state;
  for (let index = 0; index < state.initial.partCount; index++) {
    const part = bytes.slice(index * 65_536, (index + 1) * 65_536);
    state = (
      await service.writePart(actor, {
        uploadId: state.initial.uploadId,
        expectedRevision: state.revision,
        index,
        byteOffset: index * 65_536,
        rawDigest: uploadHash(part),
        bytes: part,
      })
    ).state;
  }
  const ready = await service.prepare(actor, {
    uploadId: state.initial.uploadId,
    expectedRevision: state.revision,
  });
  assert.equal(ready.disposition, "ready");
  assert.equal(ready.state.phase, "ready");
  assert.ok(ready.state.prepared);
  return {
    reference: {
      uploadId: state.initial.uploadId,
      fileDigest: uploadHash(bytes),
    },
    state: ready.state,
  };
}
