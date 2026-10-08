import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import {
  ApplicationError,
  ProjectFoundationApplicationService,
  type ActorContext,
  type CreateProjectFoundationCommand,
  type CreativeProjectStore,
  type PreparedProjectSource,
  type ProjectFoundationCommitOptions,
  type ProjectFoundationMutationResult,
  type ProjectFoundationStore,
} from "@crewon/application";
import {
  projectFoundationUiCodec,
  PROJECT_FOUNDATION_UI_METHOD_ACTIONS,
  type ProjectFoundationMutationResponse,
  type ProjectFoundationUiInputMap,
  type ProjectFoundationUiMethod,
} from "@crewon/contracts/project-foundation";
import type {
  ProjectCreationParameters,
  ProjectFoundation,
  ProjectProposal,
  ProjectSource,
  ProjectSourceChapter,
} from "@crewon/domain";
import {
  parseProjectSourceFile,
  type ParseProjectSourceFileInput,
} from "@crewon/media-runtime";
import {
  PostgresCreativeProjectStore,
  PostgresProjectFoundationStore,
  SqliteCreativeProjectStore,
  SqliteProjectFoundationStore,
} from "@crewon/store";

export type ImportBackend = "sqlite" | "postgres";
export const importActor: ActorContext = Object.freeze({
  tenantId: "import-tenant",
  spaceId: "import-space",
  principalId: "import-principal",
  actorId: "import-ui-actor",
});
export const importAgent: ActorContext = Object.freeze({
  ...importActor,
  actorId: "import-agent-actor",
});
export const foreignActor: ActorContext = Object.freeze({
  ...importActor,
  principalId: "foreign-principal",
  actorId: "foreign-actor",
});
export function importHash(value: string | Uint8Array) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
export function category(expected: ApplicationError["category"]) {
  return (error: unknown) =>
    error instanceof ApplicationError && error.category === expected;
}
export function importParameters(
  origin: "creative" | "novel",
): ProjectCreationParameters {
  return {
    genre: "悬疑",
    episodeMode: "series",
    episodeCount: origin === "novel" ? 120 : 3,
    episodeDurationSeconds:
      origin === "novel" ? { minimum: 120, maximum: 300 } : null,
    aspectRatio: "16:9",
    visualStyle: origin === "novel" ? "semi-realistic" : null,
    needsCharacters: true,
    needsArt: true,
    adaptation:
      origin === "novel"
        ? {
            strategy: "core",
            retainedCharacters: ["林雨"],
            retainedScenes: ["雨夜重逢"],
          }
        : null,
  };
}
export function importCreation(
  origin: "creative" | "novel",
  key: string,
  source: PreparedProjectSource | null = null,
): CreateProjectFoundationCommand {
  return {
    title: `雨夜相逢 · ${key}`,
    briefText: "林雨在雨夜收到未来的信。先保留人物内核，再制作短剧。",
    origin,
    parameters: importParameters(origin),
    creativeStartMode: origin === "creative" ? "confirm-plan" : null,
    sourceUpload:
      source === null
        ? null
        : { uploadId: source.uploadId, fileDigest: source.fileDigest },
    idempotencyKey: key,
  };
}

/** Independent host port fixture: real parsing and DB, named policy and upload ownership. No HTTP/upload UI. */
export async function foundationImportFixture(
  t: TestContext,
  backend: ImportBackend,
) {
  const directory = await mkdtemp(join(tmpdir(), "crewon-foundation-import-"));
  const databasePath = join(directory, "projects.sqlite");
  const schema = `foundation_import_${randomUUID().replaceAll("-", "")}`;
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
  if (backend === "postgres") assert.ok(connectionString);
  const observer = backend === "sqlite" ? new DatabaseSync(databasePath) : null;
  const admin =
    backend === "postgres" ? new Pool({ connectionString, max: 1 }) : null;
  const uploads = new Map<string, PreparedProjectSource>();
  const state = {
    sourceReads: 0,
    idCalls: 0,
    clockCalls: 0,
    allow: true,
    active: true,
  };
  const handles: Array<{ close(): Promise<void> }> = [];
  t.after(async () => {
    try {
      for (const handle of handles) await handle.close();
    } finally {
      observer?.close();
      try {
        await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin?.end();
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  if (admin !== null) await admin.query(`CREATE SCHEMA "${schema}"`);

  function stage(
    uploadId: string,
    input: ParseProjectSourceFileInput,
    actor: ActorContext = importActor,
  ) {
    const parsed = parseProjectSourceFile({
      fileName: input.fileName,
      format: input.format,
      bytes: input.bytes,
    });
    const prepared = Object.freeze({
      uploadId,
      owner: Object.freeze({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        principalId: actor.principalId,
      }),
      ...parsed,
    });
    uploads.set(uploadId, prepared);
    return prepared;
  }
  function authority(): ProjectFoundationCommitOptions {
    return {
      authority: {
        async assertCurrent() {
          if (!state.allow || !state.active)
            throw new ApplicationError(
              "authorization",
              "named-import-policy-denied",
            );
        },
        assertActive() {
          if (!state.active)
            throw new ApplicationError(
              "authorization",
              "named-import-request-withdrawn",
            );
        },
      },
    };
  }
  async function open() {
    let closed = false;
    const assertOpen = () => {
      assert.equal(closed, false, "borrowed host database closed");
    };
    const database =
      backend === "sqlite" ? new DatabaseSync(databasePath) : null;
    const pool =
      backend === "postgres" ? new Pool({ connectionString, max: 1 }) : null;
    database?.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const projects: CreativeProjectStore & { migrate(): Promise<void> } =
      database !== null
        ? new SqliteCreativeProjectStore({ database, assertOpen })
        : new PostgresCreativeProjectStore({ pool: pool!, schema, assertOpen });
    const foundations: ProjectFoundationStore & { migrate(): Promise<void> } =
      database !== null
        ? new SqliteProjectFoundationStore({
            database,
            assertOpen,
            sourceAdmission: "trusted-internal-recipe",
          })
        : new PostgresProjectFoundationStore({
            pool: pool!,
            schema,
            assertOpen,
            sourceAdmission: "trusted-internal-recipe",
          });
    const service = new ProjectFoundationApplicationService({
      sourceAdmission: "trusted-internal-recipe",
      projects,
      store: foundations,
      sourcePreparation: {
        async loadPrepared(request) {
          state.sourceReads++;
          const source = uploads.get(request.uploadId);
          return source !== undefined &&
            (["tenantId", "spaceId", "principalId"] as const).every(
              (field) => source.owner[field] === request.actor[field],
            )
            ? source
            : null;
        },
      },
      authorization: {
        async authorize() {
          return state.allow
            ? { outcome: "allow" }
            : { outcome: "deny", reasonCode: "named-import-policy-denied" };
        },
      },
      ids: {
        nextId() {
          state.idCalls++;
          return `import-project-${randomUUID()}`;
        },
      },
      clock: {
        now() {
          return new Date(
            Date.UTC(2026, 9, 8, 0, 0, ++state.clockCalls),
          ).toISOString();
        },
      },
      digester: { sha256: importHash },
    });
    const handle = {
      projects,
      foundations,
      service,
      async close() {
        if (closed) return;
        closed = true;
        database?.close();
        await pool?.end();
      },
    };
    handles.push(handle);
    return handle;
  }
  const first = await open();
  await first.projects.migrate();
  await first.foundations.migrate();
  async function counts() {
    const tables = [
      "creative_projects",
      "creative_project_briefs",
      "project_foundations",
      "project_sources",
      "project_source_chunks",
      "project_source_chapters",
      "project_proposals",
      "project_foundation_mutation_receipts",
    ] as const;
    const result: Record<string, number> = {};
    for (const table of tables) {
      const rows =
        observer !== null
          ? observer.prepare(`SELECT count(*) AS n FROM ${table}`).all()
          : (
              await admin!.query(
                `SELECT count(*) AS n FROM "${schema}".${table}`,
              )
            ).rows;
      result[table] = Number(rows[0]!.n);
    }
    return result;
  }
  return { first, open, stage, uploads, state, authority, counts };
}

export function publicFoundation(record: ProjectFoundation) {
  return {
    schemaVersion: record.schemaVersion,
    projectId: record.projectId,
    origin: record.origin,
    revision: record.revision,
    parametersRevision: record.parametersRevision,
    parameters: record.parameters,
    source: record.source,
    confirmedProposal: record.confirmedProposal,
    creativeStartMode: record.creativeStartMode,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
export function publicSource(record: ProjectSource) {
  return {
    schemaVersion: record.schemaVersion,
    projectId: record.projectId,
    revision: record.revision,
    digest: record.digest,
    fileDigest: record.fileDigest,
    fileName: record.fileName,
    format: record.format,
    byteLength: record.byteLength,
    characterLength: record.characterLength,
    createdAt: record.createdAt,
  };
}
export function publicChapter(record: ProjectSourceChapter) {
  return {
    projectId: record.projectId,
    sourceRevision: record.sourceRevision,
    chapterId: record.chapterId,
    title: record.title,
    startOffset: record.startOffset,
    endOffset: record.endOffset,
  };
}
export function publicProposal(record: ProjectProposal) {
  return {
    schemaVersion: record.schemaVersion,
    projectId: record.projectId,
    revision: record.revision,
    kind: record.kind,
    foundationRevision: record.foundationRevision,
    parametersRevision: record.parametersRevision,
    source: record.source,
    text: record.text,
    contentDigest: record.contentDigest,
    createdAt: record.createdAt,
  };
}
export function publicMutation(
  record: ProjectFoundationMutationResult,
): ProjectFoundationMutationResponse {
  const { project, brief } = record;
  return {
    kind: record.kind,
    disposition: record.disposition,
    project: {
      projectId: project.projectId,
      kind: project.kind,
      title: project.title,
      revision: project.revision,
      state: project.state,
      latestBriefRevision: project.latestBriefRevision,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    },
    foundation: publicFoundation(record.foundation),
    brief:
      brief === null
        ? null
        : {
            projectId: brief.projectId,
            briefRevision: brief.briefRevision,
            text: brief.text,
            contentDigest: brief.contentDigest,
            createdAt: brief.createdAt,
          },
    source: record.source === null ? null : publicSource(record.source),
    proposal: record.proposal === null ? null : publicProposal(record.proposal),
  };
}
export function checkPublicResponse<M extends ProjectFoundationUiMethod>(
  method: M,
  input: ProjectFoundationUiInputMap[M],
  response: unknown,
) {
  const rawRequest = {
    action: PROJECT_FOUNDATION_UI_METHOD_ACTIONS[method],
    input,
  };
  assert.doesNotThrow(
    () => projectFoundationUiCodec.parseRequest(rawRequest),
    JSON.stringify(rawRequest),
  );
  const request = projectFoundationUiCodec.parseRequest(rawRequest);
  assert.deepEqual(
    projectFoundationUiCodec.parseResponse(response, request),
    response,
  );
  function noPrivateFields(value: unknown) {
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(
        [
          "tenantId",
          "spaceId",
          "ownerPrincipalId",
          "createdByActorId",
          "updatedByActorId",
        ].includes(key),
        false,
        key,
      );
      noPrivateFields(child);
    }
  }
  noPrivateFields(response);
}
