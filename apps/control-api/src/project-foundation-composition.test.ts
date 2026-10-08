import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import {
  isProjectFoundationApplicationService,
  ProjectSourceUploadApplicationService,
  type ActorContext,
  type AuthorizationDecision,
  type CreativeProjectAuthorizationPort,
  type ProjectSourceUploadAuthorizationPort,
  type ProjectSourceUploadPermission,
} from "@crewon/application";
import { ProjectSourceUploadPreparationAdapter } from "@crewon/media-runtime";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import {
  captureProjectFoundationCompositionConfig,
  captureProjectFoundationStartupConfiguration,
  prepareProjectFoundation,
  type ProjectFoundationCompositionConfig,
} from "./project-foundation-composition.ts";
import {
  captureCreativeProjectCompositionConfig,
  prepareCreativeProjects,
} from "./creative-project-composition.ts";
import {
  composeProductionProjectStartup,
  parseProductionProjectStartupConfiguration,
  PRODUCTION_PROJECT_COMPOSITION_CONFIG_SCHEMA,
} from "./production-project-environment.ts";
import { importParameters } from "./project-foundation-import.test-support.ts";
import {
  NodeSha256ContentDigester,
  SystemApplicationClock,
} from "./standalone-adapters.ts";

const actor: ActorContext = Object.freeze({
  tenantId: "foundation-composition-tenant",
  spaceId: "foundation-composition-space",
  principalId: "foundation-composition-principal",
  actorId: "foundation-composition-auditor",
});
const publication = Object.freeze({
  pluginId: "crewon.short-drama",
  contributionId: "workbench",
  packageDigest: `sha256:${"a".repeat(64)}`,
});
const uploadPublication = Object.freeze({
  pluginId: "crewon.source-import",
  contributionId: "source-import",
  packageDigest: `sha256:${"b".repeat(64)}`,
});
// Named internal host fixture only; these grants are not a mounted module or an Agent Run.
class NamedUploadPolicy implements ProjectSourceUploadAuthorizationPort {
  active = true;
  allow = true;
  readonly seen: ProjectSourceUploadPermission[] = [];
  async authorize(
    permission: ProjectSourceUploadPermission,
  ): Promise<AuthorizationDecision> {
    this.seen.push(permission);
    return this.active && this.allow
      ? { outcome: "allow" }
      : { outcome: "deny", reasonCode: "named_upload_denied" };
  }
  assertActive(): void {
    if (!this.active) throw new Error("named_upload_withdrawn");
  }
}
const creativeAuthorization: CreativeProjectAuthorizationPort = {
  async authorize() {
    return { outcome: "allow" };
  },
};
function configuration(
  policy: ProjectSourceUploadAuthorizationPort = new NamedUploadPolicy(),
): ProjectFoundationCompositionConfig {
  return {
    version: "crewon.project-foundation.v1",
    pluginUi: { publications: [publication] },
    uploads: {
      version: "crewon.project-source-uploads.v1",
      authorization: policy,
    },
  };
}

test("foundation startup data is exact, detached and cannot configure authority, bytes or admission bypass", () => {
  const json = {
    version: "crewon.project-foundation.v1",
    pluginUi: {
      publications: [
        { ...publication, contributionId: String(publication.contributionId) },
      ],
    },
    uploads: { version: "crewon.project-source-uploads.v1" },
  };
  const captured = captureProjectFoundationStartupConfiguration(json)!;
  assert.ok(Object.isFrozen(captured));
  json.pluginUi.publications[0]!.contributionId = "changed";
  assert.equal(captured.pluginUi!.publications[0]!.contributionId, "workbench");
  for (const value of [
    null,
    {},
    { version: "future", uploads: captured.uploads },
    { ...captured, sourceAdmission: "trusted-internal-recipe" },
    { ...captured, sourceUpload: { content: "book" } },
    { ...captured, uploads: { ...captured.uploads, authorization: {} } },
    { ...captured, uploads: { ...captured.uploads, parser: "alternate" } },
  ])
    assert.throws(() => captureProjectFoundationStartupConfiguration(value));
  let getters = 0;
  const getter = Object.defineProperty({}, "version", {
    enumerable: true,
    get() {
      getters++;
      return captured.version;
    },
  });
  Object.defineProperty(getter, "uploads", {
    enumerable: true,
    value: captured.uploads,
  });
  assert.throws(() => captureProjectFoundationStartupConfiguration(getter));
  assert.equal(getters, 0);
});

test("composition borrows both original upload policy methods, rejects accessor methods, and preserves live withdrawal", async () => {
  const policy = new NamedUploadPolicy();
  const captured = captureProjectFoundationCompositionConfig(
    configuration(policy),
  )!;
  const permission: ProjectSourceUploadPermission = {
    actor,
    action: "projectSourceUpload:begin",
    resource: {
      kind: "projectSourceUpload",
      owner: {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        principalId: actor.principalId,
      },
      uploadId: null,
      projectId: null,
    },
  };
  policy.authorize = async () => ({
    outcome: "deny",
    reasonCode: "replacement",
  });
  policy.assertActive = () => {
    throw new Error("replacement");
  };
  assert.deepEqual(await captured.uploads.authorization.authorize(permission), {
    outcome: "allow",
  });
  captured.uploads.authorization.assertActive(permission);
  policy.active = false;
  assert.deepEqual(await captured.uploads.authorization.authorize(permission), {
    outcome: "deny",
    reasonCode: "named_upload_denied",
  });
  assert.throws(
    () => captured.uploads.authorization.assertActive(permission),
    /named_upload_withdrawn/u,
  );
  let getters = 0;
  for (const method of ["authorize", "assertActive"] as const) {
    const malformed = {
      authorize: async () => ({ outcome: "allow" as const }),
      assertActive() {},
    };
    Object.defineProperty(malformed, method, {
      enumerable: true,
      get() {
        getters++;
        return () => undefined;
      },
    });
    assert.throws(
      () => captureProjectFoundationCompositionConfig(configuration(malformed)),
      /project_foundation_configuration_invalid/u,
    );
  }
  assert.equal(getters, 0);
});

test("upload publications are an independent optional approval and are never inherited from foundation publications", () => {
  const without = captureProjectFoundationCompositionConfig(configuration())!;
  assert.equal(without.uploads.pluginUi, undefined);
  assert.equal(Object.hasOwn(without.uploads, "pluginUi"), false);
  const input = {
    version: "crewon.project-foundation.v1",
    pluginUi: { publications: [{ ...publication }] },
    uploads: {
      version: "crewon.project-source-uploads.v1",
      pluginUi: {
        publications: [
          {
            ...uploadPublication,
            contributionId: String(uploadPublication.contributionId),
          },
        ],
      },
    },
  };
  const snapshot = parseProductionProjectStartupConfiguration({
    schemaVersion: PRODUCTION_PROJECT_COMPOSITION_CONFIG_SCHEMA,
    foundation: input,
  });
  input.uploads.pluginUi.publications[0]!.contributionId = "changed";
  const composed = composeProductionProjectStartup(
    snapshot,
    creativeAuthorization,
    new NamedUploadPolicy(),
  ).creativeProjects!.foundation!;
  assert.deepEqual(composed.pluginUi, { publications: [publication] });
  assert.deepEqual(composed.uploads.pluginUi, {
    publications: [uploadPublication],
  });
  assert.ok(Object.isFrozen(composed.uploads.pluginUi!.publications[0]));
  const uploadOnly = captureProjectFoundationStartupConfiguration({
    version: "crewon.project-foundation.v1",
    uploads: {
      version: "crewon.project-source-uploads.v1",
      pluginUi: { publications: [uploadPublication] },
    },
  })!;
  assert.equal(uploadOnly.pluginUi, undefined);
  assert.deepEqual(uploadOnly.uploads.pluginUi, {
    publications: [uploadPublication],
  });
});

test("upload publication configuration rejects unknown, empty, duplicate and accessor approvals", () => {
  for (const pluginUi of [
    {},
    { publications: [] },
    { publications: [uploadPublication, uploadPublication] },
    { publications: [{ ...uploadPublication, authority: "allow" }] },
    { publications: [uploadPublication], sourceAdmission: "trusted" },
  ]) {
    const input = {
      version: "crewon.project-foundation.v1",
      uploads: { version: "crewon.project-source-uploads.v1", pluginUi },
    };
    assert.throws(() => captureProjectFoundationStartupConfiguration(input));
    assert.throws(() =>
      captureProjectFoundationCompositionConfig({
        ...input,
        uploads: { ...input.uploads, authorization: new NamedUploadPolicy() },
      }),
    );
  }
  let accesses = 0;
  const uploads = Object.defineProperty(
    { version: "crewon.project-source-uploads.v1" },
    "pluginUi",
    {
      enumerable: true,
      get() {
        accesses++;
        return { publications: [uploadPublication] };
      },
    },
  );
  assert.throws(() =>
    captureProjectFoundationStartupConfiguration({
      version: "crewon.project-foundation.v1",
      uploads,
    }),
  );
  assert.equal(accesses, 0);
});

test("production JSON opt-in requires a separately supplied upload PDP; original two-argument startup remains unchanged", () => {
  const old = parseProductionProjectStartupConfiguration({
    schemaVersion: PRODUCTION_PROJECT_COMPOSITION_CONFIG_SCHEMA,
  });
  assert.equal(
    composeProductionProjectStartup(old, creativeAuthorization)
      .creativeProjects!.foundation,
    undefined,
  );
  const snapshot = parseProductionProjectStartupConfiguration({
    schemaVersion: PRODUCTION_PROJECT_COMPOSITION_CONFIG_SCHEMA,
    foundation: {
      version: "crewon.project-foundation.v1",
      pluginUi: { publications: [publication] },
      uploads: { version: "crewon.project-source-uploads.v1" },
    },
  });
  assert.throws(
    () => composeProductionProjectStartup(snapshot, creativeAuthorization),
    /production_project_configuration_invalid/u,
  );
  const policy = new NamedUploadPolicy();
  const composed = composeProductionProjectStartup(
    snapshot,
    creativeAuthorization,
    policy,
  );
  assert.deepEqual(
    composed.creativeProjects!.foundation!.pluginUi,
    snapshot.foundation!.pluginUi,
  );
  assert.equal(
    typeof composed.creativeProjects!.foundation!.uploads.authorization
      .assertActive,
    "function",
  );
  assert.throws(
    () =>
      parseProductionProjectStartupConfiguration({
        ...snapshot,
        foundation: configuration(),
      }),
    /production_project_configuration_invalid/u,
  );
});

test("absent foundation configuration does not inspect factories, parser or policy", async () => {
  let accesses = 0;
  const owner = {
    get projectFoundationStore(): never {
      accesses++;
      throw new Error("must_not_open");
    },
    get projectSourceUploadStore(): never {
      accesses++;
      throw new Error("must_not_open");
    },
  };
  assert.equal(
    await prepareProjectFoundation(owner, {
      configuration: undefined,
      projects: {} as never,
      authorization: {} as never,
    }),
    undefined,
  );
  assert.equal(accesses, 0);
});

async function fixture(t: TestContext, backend: "sqlite" | "postgres") {
  const directory = await mkdtemp(
    join(tmpdir(), "crewon-foundation-composition-"),
  );
  const schema = `foundation_composition_${randomUUID().replaceAll("-", "")}`;
  const url = process.env.CREWON_TEST_POSTGRES_URL;
  const pool =
    backend === "postgres" ? new Pool({ connectionString: url, max: 1 }) : null;
  const filename = join(directory, "original.sqlite");
  let owner: SqliteRunStore | PostgresDomainStore;
  const open = () => {
    owner =
      pool === null
        ? new SqliteRunStore(filename)
        : new PostgresDomainStore({ pool, schema });
    return owner;
  };
  open();
  if (pool !== null) await pool.query(`CREATE SCHEMA "${schema}"`);
  t.after(async () => {
    await owner.close();
    if (pool !== null) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
    await rm(directory, { recursive: true, force: true });
  });
  async function query(sql: string) {
    if (pool !== null)
      return (await pool.query(sql.replaceAll("$schema.", `"${schema}".`)))
        .rows;
    const database = new DatabaseSync(filename, { readOnly: true });
    try {
      return database.prepare(sql.replaceAll("$schema.", "")).all();
    } finally {
      database.close();
    }
  }
  return {
    get owner() {
      return owner;
    },
    schema,
    open,
    query,
  };
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: explicit composition rejects unqualified upload writes, adopts an internal same-DB seed and cold reopens without Run authority`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await fixture(t, backend),
        policy = new NamedUploadPolicy();
      const foundation = configuration(policy);
      const config = captureCreativeProjectCompositionConfig({
        authorization: creativeAuthorization,
        foundation: {
          ...foundation,
          uploads: {
            ...foundation.uploads,
            pluginUi: { publications: [uploadPublication] },
          },
        },
      })!;
      // An original metadata-only deployment keeps the new independently migrated tables absent.
      await prepareCreativeProjects(f.owner, {
        authorization: creativeAuthorization,
      });
      const before =
        backend === "sqlite"
          ? await f.query(
              "SELECT name FROM sqlite_master WHERE name IN ('project_foundations','project_source_uploads')",
            )
          : await f.query(
              `SELECT table_name FROM information_schema.tables WHERE table_schema='${f.schema}' AND table_name IN ('project_foundations','project_source_uploads')`,
            );
      assert.equal(before.length, 0);
      const prepared = (await prepareCreativeProjects(f.owner, config))!
        .foundation!;
      assert.ok(isProjectFoundationApplicationService(prepared.service));
      assert.deepEqual(prepared.pluginUi, { publications: [publication] });
      assert.deepEqual(prepared.uploadUi, {
        publications: [uploadPublication],
      });
      const bytes = new TextEncoder().encode(
          "第1章 雨夜\n她收到一封信😀。\n第2章 重逢\n他回来了。",
        ),
        parser = new ProjectSourceUploadPreparationAdapter();
      const metadata = {
        idempotencyKey: "composed-source",
        fileName: "story.txt",
        format: "txt" as const,
        byteLength: bytes.length,
        fileDigest: parser.sha256(bytes),
      };
      // Actual configured upload writes require installation qualification; an ordinary PDP is insufficient.
      await assert.rejects(prepared.uploads.begin(actor, metadata));
      assert.equal(
        Number(
          (
            await f.query(
              "SELECT count(*) AS n FROM $schema.project_source_uploads",
            )
          )[0]!.n,
        ),
        0,
      );
      // Explicit internal test seed shares the original parent database. This is not formal UI/Agent evidence.
      const seed = new ProjectSourceUploadApplicationService({
        store: f.owner.projectSourceUploadStore({
          installationAdmission: "trusted-internal-authority",
        }),
        authorization: policy,
        bytes: parser,
        parser,
        clock: new SystemApplicationClock(),
        digester: new NodeSha256ContentDigester(),
        ids: {
          nextUploadId: () => randomUUID(),
          nextClaimId: () => randomUUID(),
        },
        preparationClaimTtlMs: 60_000,
      });
      let upload = (await seed.begin(actor, metadata)).state;
      upload = (
        await seed.writePart(actor, {
          uploadId: upload.initial.uploadId,
          expectedRevision: upload.revision,
          index: 0,
          byteOffset: 0,
          rawDigest: parser.sha256(bytes),
          bytes,
        })
      ).state;
      const ready = await seed.prepare(actor, {
        uploadId: upload.initial.uploadId,
        expectedRevision: upload.revision,
      });
      assert.equal(ready.disposition, "ready");
      const command = {
        title: "原库短剧",
        briefText: "保持雨夜来信的内核。",
        origin: "novel" as const,
        parameters: importParameters("novel"),
        creativeStartMode: null,
        sourceUpload: {
          uploadId: upload.initial.uploadId,
          fileDigest: parser.sha256(bytes),
        },
        idempotencyKey: "composed-novel",
      };
      const created = await prepared.service.createProject(actor, command);
      assert.equal(created.foundation.parameters.episodeCount, 120);
      const source = created.source!;
      assert.equal(
        (
          await prepared.service.readSourcePage(actor, {
            projectId: created.project.projectId,
            sourceRevision: source.revision,
            sourceDigest: source.digest,
            startOffset: 0,
            limit: 1024,
          })
        ).content,
        new TextDecoder().decode(bytes),
      );
      assert.equal(
        Number(
          (
            await f.query(
              "SELECT count(*) AS n FROM $schema.project_source_upload_associations",
            )
          )[0]!.n,
        ),
        1,
      );
      assert.ok(
        policy.seen.some(
          (permission) => permission.action === "projectSourceUpload:adopt",
        ),
      );
      await f.owner.close();
      const reopened = (await prepareCreativeProjects(f.open(), config))!
        .foundation!;
      assert.deepEqual(reopened.uploadUi, {
        publications: [uploadPublication],
      });
      assert.deepEqual(
        await reopened.service.getFoundation(actor, {
          projectId: created.project.projectId,
        }),
        created.foundation,
      );
      assert.equal(
        (await reopened.service.createProject(actor, command)).disposition,
        "replayed",
      );
      assert.equal(
        Number(
          (
            await f.query(
              "SELECT count(*) AS n FROM $schema.project_source_upload_associations",
            )
          )[0]!.n,
        ),
        1,
      );
      policy.allow = false;
      await assert.rejects(
        reopened.uploads.begin(actor, {
          idempotencyKey: "denied-upload",
          fileName: "other.txt",
          format: "txt",
          byteLength: bytes.length,
          fileDigest: parser.sha256(bytes),
        }),
      );
    },
  );
}
