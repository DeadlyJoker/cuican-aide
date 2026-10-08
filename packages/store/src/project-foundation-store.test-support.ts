import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import {
  confirmProjectProposal,
  createProjectFoundation,
  createProjectProposal,
  projectSourceScalarLength,
  setProjectFoundationSource,
  updateProjectFoundationParameters,
  validateProjectProposal,
  type CreativeProject,
  type ProjectCreationParameters,
  type ProjectFoundation,
  type ProjectProposal,
  type ProjectSource,
  type ProjectSourceChapter,
  type ProjectSourceChunk,
} from "@crewon/domain";
import type {
  ActorContext,
  ProjectFoundationCommitAuthority,
  ProjectFoundationStore,
} from "@crewon/application";
import { SqliteCreativeProjectStore } from "./sqlite-creative-project-store.ts";
import { PostgresCreativeProjectStore } from "./postgres-creative-project-store.ts";
import { SqliteProjectFoundationStore } from "./project-foundation-sqlite-store.ts";
import { PostgresProjectFoundationStore } from "./project-foundation-postgres-store.ts";
import {
  actor,
  creationRecipe,
  digester,
  owner,
  receipt,
  timestamp,
  withDigest,
  type Backend,
} from "./creative-project-store.test-support.ts";

export { actor, digester, owner, receipt, withDigest, type Backend };
type Input<M extends keyof ProjectFoundationStore> = Parameters<
  ProjectFoundationStore[M]
>[0];
export const foundationTables = [
  "creative_projects",
  "creative_project_briefs",
  "creative_project_mutation_receipts",
  "project_foundations",
  "project_sources",
  "project_source_chunks",
  "project_source_chapters",
  "project_proposals",
  "project_foundation_mutation_receipts",
] as const;
export function time(step = 0) {
  return new Date(Date.parse(timestamp) + step * 1_000).toISOString();
}
export function parameters(
  origin: "creative" | "novel",
): ProjectCreationParameters {
  return {
    genre: "悬疑",
    episodeMode: "series",
    episodeCount: origin === "novel" ? 120 : 3,
    episodeDurationSeconds:
      origin === "novel" ? { minimum: 120, maximum: 300 } : null,
    aspectRatio: "9:16",
    visualStyle: origin === "novel" ? "semi-realistic" : null,
    needsCharacters: true,
    needsArt: true,
    adaptation:
      origin === "novel"
        ? {
            strategy: "core",
            retainedCharacters: ["林雨"],
            retainedScenes: ["重逢"],
          }
        : null,
  };
}
export function sourceBundle(
  project: CreativeProject,
  revision = 1,
  at = time(),
  parts: readonly string[] = ["雨😀夜\n", "重逢 café。"],
  who: ActorContext = actor,
) {
  const scope = {
    tenantId: project.tenantId,
    spaceId: project.spaceId,
    projectId: project.projectId,
  };
  const text = parts.join("");
  const raw = `<p>${text.replaceAll("\n", "</p>\r\n<p>")}</p>`;
  const source: ProjectSource = {
    schemaVersion: "crewon.project-source.v1",
    ...scope,
    revision,
    digest: digester.sha256(text),
    fileDigest: digester.sha256(raw),
    fileName: "原文.html",
    format: "html",
    byteLength: Buffer.byteLength(raw),
    characterLength: projectSourceScalarLength(text),
    createdByActorId: who.actorId,
    createdAt: at,
  };
  let offset = 0;
  const chunks: ProjectSourceChunk[] = [];
  const chapters: ProjectSourceChapter[] = [];
  parts.forEach((content, index) => {
    const startOffset = offset;
    offset += projectSourceScalarLength(content);
    chunks.push({
      ...scope,
      sourceRevision: revision,
      index,
      startOffset,
      content,
      digest: digester.sha256(content),
    });
    chapters.push({
      ...scope,
      sourceRevision: revision,
      chapterId: `chapter-${index + 1}`,
      title: `第${index + 1}章`,
      startOffset,
      endOffset: offset,
    });
  });
  return { source, chunks, chapters, text };
}
export function foundationCreationRecipe(
  projectId: string,
  key = `create-${projectId}`,
  origin: "creative" | "novel" = "creative",
  who: ActorContext = actor,
): Input<"commitCreation"> {
  const base = creationRecipe(projectId, key, who, time());
  const bundle =
    origin === "novel"
      ? sourceBundle(base.project, 1, time(), undefined, who)
      : null;
  const foundation = createProjectFoundation({
    project: base.project,
    actor: who,
    expectedProjectRevision: base.project.revision,
    origin,
    parameters: parameters(origin),
    source:
      bundle === null
        ? null
        : { revision: bundle.source.revision, digest: bundle.source.digest },
    creativeStartMode: origin === "creative" ? "confirm-plan" : null,
    at: time(),
  });
  return {
    ...base,
    foundation,
    source: bundle?.source ?? null,
    chunks: bundle?.chunks ?? [],
    chapters: bundle?.chapters ?? [],
  };
}
/** Canonical plaintext fixture only; this does not stand in for upload decoding/staging. */
export function mixedUnicodeSourceBundle(
  project: CreativeProject,
  byteLength: number,
) {
  const scope = {
    tenantId: project.tenantId,
    spaceId: project.spaceId,
    projectId: project.projectId,
  };
  const pattern = "雨😀a"; // Eight UTF-8 bytes and three Unicode scalar values.
  const fullChunk = pattern.repeat(512);
  const fullChunkDigest = digester.sha256(fullChunk);
  const chunks: ProjectSourceChunk[] = [];
  const hash = createHash("sha256");
  let remaining = byteLength;
  let startOffset = 0;
  while (remaining > 0) {
    const bytes = Math.min(4_096, remaining);
    const content =
      bytes === 4_096
        ? fullChunk
        : pattern.repeat(Math.floor(bytes / 8)) + "a".repeat(bytes % 8);
    chunks.push({
      ...scope,
      sourceRevision: 1,
      index: chunks.length,
      startOffset,
      content,
      digest: bytes === 4_096 ? fullChunkDigest : digester.sha256(content),
    });
    hash.update(content);
    startOffset += Math.floor(bytes / 8) * 3 + (bytes % 8);
    remaining -= bytes;
  }
  const digest = `sha256:${hash.digest("hex")}`;
  const source: ProjectSource = {
    schemaVersion: "crewon.project-source.v1",
    ...scope,
    revision: 1,
    digest,
    fileDigest: digest,
    fileName: "规范正文.txt",
    format: "txt",
    byteLength,
    characterLength: startOffset,
    createdByActorId: actor.actorId,
    createdAt: time(),
  };
  const chapters: ProjectSourceChapter[] = [
    {
      ...scope,
      sourceRevision: 1,
      chapterId: "complete",
      title: "完整正文",
      startOffset: 0,
      endOffset: startOffset,
    },
  ];
  return { source, chunks, chapters };
}
export function proposalRecipe(
  project: CreativeProject,
  foundation: ProjectFoundation,
  key: string,
  previousProposal: ProjectProposal | null = null,
  step = 1,
): Input<"commitProposal"> {
  const proposal = validateProjectProposal(
    withDigest(
      createProjectProposal({
        project,
        foundation,
        actor,
        expectedFoundationRevision: foundation.revision,
        previousProposal,
        expectedProposalRevision: previousProposal?.revision ?? 0,
        kind:
          foundation.origin === "creative"
            ? "creative-plan"
            : "novel-adaptation",
        text: `创作方案 ${key}：雨夜重逢，人物作出选择。`,
        contentDigest: digester.sha256("placeholder"),
        at: time(step),
      }),
    ),
  );
  return {
    actor,
    receipt: receipt(key),
    project,
    foundation,
    expectedFoundationRevision: foundation.revision,
    proposal,
  };
}
export function parameterChangeRecipe(
  project: CreativeProject,
  foundation: ProjectFoundation,
  key: string,
  step = 2,
): Input<"commitFoundationChange"> {
  return {
    actor,
    receipt: receipt(key),
    kind: "update-parameters",
    expectedFoundationRevision: foundation.revision,
    foundation: updateProjectFoundationParameters({
      project,
      foundation,
      actor,
      expectedFoundationRevision: foundation.revision,
      parameters: {
        ...foundation.parameters,
        episodeCount: (foundation.parameters.episodeCount ?? 1) + 1,
      },
      at: time(step),
    }),
    source: null,
    chunks: [],
    chapters: [],
    proposal: null,
  };
}
export function sourceChangeRecipe(
  project: CreativeProject,
  foundation: ProjectFoundation,
  key: string,
  revision = 2,
  step = 5,
): Input<"commitFoundationChange"> {
  const { text: _text, ...bundle } = sourceBundle(
    project,
    revision,
    time(step),
    ["新的😀原文\n", "第二章 café。"],
  );
  return {
    actor,
    receipt: receipt(key),
    kind: "append-source",
    expectedFoundationRevision: foundation.revision,
    foundation: setProjectFoundationSource({
      project,
      foundation,
      actor,
      expectedFoundationRevision: foundation.revision,
      source: { revision, digest: bundle.source.digest },
      at: time(step),
    }),
    ...bundle,
    proposal: null,
  };
}
export function confirmationRecipe(
  project: CreativeProject,
  foundation: ProjectFoundation,
  proposal: ProjectProposal,
  key: string,
  step = 2,
): Input<"commitFoundationChange"> {
  return {
    actor,
    receipt: receipt(key),
    kind: "confirm-proposal",
    expectedFoundationRevision: foundation.revision,
    foundation: confirmProjectProposal({
      project,
      foundation,
      actor,
      expectedFoundationRevision: foundation.revision,
      proposal,
      at: time(step),
    }),
    source: null,
    chunks: [],
    chapters: [],
    proposal,
  };
}
export function ordinaryAuthority() {
  const state = { active: true, currentCalls: 0, activeCalls: 0 };
  const authority: ProjectFoundationCommitAuthority = {
    async assertCurrent() {
      state.currentCalls++;
      assert.ok(state.active, "foundation authority withdrawn");
    },
    assertActive() {
      state.activeCalls++;
      assert.ok(state.active, "foundation authority withdrawn");
    },
  };
  return { state, authority };
}

/** Actual files / actual single-connection PostgreSQL pools; hooks run after native SQL. */
export async function fixture(
  t: TestContext,
  backend: Backend,
  options: { migrate?: boolean } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "crewon-foundation-"));
  const path = join(directory, "projects.sqlite");
  const schema = `foundation_${randomUUID().replaceAll("-", "")}`;
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
  if (backend === "postgres") assert.ok(connectionString);
  const admin =
    backend === "postgres" ? new Pool({ connectionString, max: 1 }) : null;
  const observer = backend === "sqlite" ? new DatabaseSync(path) : null;
  const prefix = backend === "postgres" ? `"${schema}".` : "";
  const handles: Array<{ close(): Promise<void> }> = [];
  async function open() {
    let closed = false;
    let inactive = false;
    const hooks: { afterStatement: ((sql: string) => void) | null } = {
      afterStatement: null,
    };
    const assertOpen = () => {
      assert.ok(!closed && !inactive, "fixture store closed");
    };
    const database = backend === "sqlite" ? new DatabaseSync(path) : null;
    const pool =
      backend === "postgres" ? new Pool({ connectionString, max: 1 }) : null;
    database?.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const interceptedDatabase =
      database === null
        ? null
        : new Proxy(database, {
            get(target, property) {
              if (property === "exec")
                return (sql: string) => {
                  target.exec(sql);
                  hooks.afterStatement?.(sql);
                };
              if (property === "prepare")
                return (sql: string) =>
                  new Proxy(target.prepare(sql), {
                    get(statement, method) {
                      const value = Reflect.get(statement, method, statement);
                      if (typeof value !== "function") return value;
                      return (...args: unknown[]) => {
                        const result = Reflect.apply(value, statement, args);
                        hooks.afterStatement?.(sql);
                        return result;
                      };
                    },
                  });
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
    const interceptedPool =
      pool === null
        ? null
        : new Proxy(pool, {
            get(target, property) {
              if (property === "connect")
                return async () =>
                  new Proxy(await target.connect(), {
                    get(client, method) {
                      if (method === "query")
                        return async (...args: unknown[]) => {
                          const result = await Reflect.apply(
                            client.query,
                            client,
                            args,
                          );
                          const sql =
                            typeof args[0] === "string" ? args[0] : "";
                          hooks.afterStatement?.(sql);
                          return result;
                        };
                      const value = Reflect.get(client, method, client);
                      return typeof value === "function"
                        ? value.bind(client)
                        : value;
                    },
                  });
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
    const projects =
      interceptedDatabase !== null
        ? new SqliteCreativeProjectStore({
            database: interceptedDatabase,
            assertOpen,
          })
        : new PostgresCreativeProjectStore({
            pool: interceptedPool!,
            schema,
            assertOpen,
          });
    const foundation =
      interceptedDatabase !== null
        ? new SqliteProjectFoundationStore({
            database: interceptedDatabase,
            assertOpen,
            sourceAdmission: "trusted-internal-recipe",
          })
        : new PostgresProjectFoundationStore({
            pool: interceptedPool!,
            schema,
            assertOpen,
            sourceAdmission: "trusted-internal-recipe",
          });
    const handle = {
      projects,
      foundation,
      hooks,
      withdraw() {
        inactive = true;
      },
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
  async function query(sql: string) {
    return observer !== null
      ? observer.prepare(sql).all()
      : (await admin!.query(sql)).rows;
  }
  async function execute(sql: string) {
    if (observer !== null) observer.exec(sql);
    else await admin!.query(sql);
  }
  async function count(table: string) {
    const rows = await query(`SELECT COUNT(*) AS count FROM ${prefix}${table}`);
    return Number(rows[0]!.count);
  }
  async function counts() {
    return Object.fromEntries(
      await Promise.all(
        foundationTables.map(async (table) => [table, await count(table)]),
      ),
    );
  }
  async function tableNames() {
    const rows = await query(
      backend === "sqlite"
        ? "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        : `SELECT table_name AS name FROM information_schema.tables WHERE table_schema='${schema}' ORDER BY table_name`,
    );
    return rows.map((row) => String(row.name));
  }
  if (admin !== null) await admin.query(`CREATE SCHEMA "${schema}"`);
  const first = await open();
  await first.projects.migrate();
  if (options.migrate !== false) await first.foundation.migrate();
  return {
    backend,
    path,
    schema,
    prefix,
    first,
    open,
    query,
    execute,
    count,
    counts,
    tableNames,
  };
}
