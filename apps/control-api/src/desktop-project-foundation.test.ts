import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { TestContext } from "node:test";
import { PluginNodeHost } from "@crewon/plugin-host";
import type { ProjectFoundationMutationResponse } from "@crewon/contracts/project-foundation";
import {
  PROJECT_SOURCE_UPLOAD_PART_BYTES,
  projectSourceUploadPartPath,
} from "@crewon/contracts/project-source-uploads";
import { parseDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import { composeDesktopProjectStartup } from "./desktop-project-startup.ts";
import { createStandaloneControlApiWithPlugins } from "./standalone-composition.ts";
import { importParameters } from "./project-foundation-import.test-support.ts";
import {
  desktopFoundationActor as actor,
  desktopFoundationFixture,
  desktopFoundationHash as hash,
} from "./desktop-project-foundation.test-support.ts";

function creative(key: string) {
  return {
    title: "雨夜来信",
    briefText: "修复师收到来自未来的信。",
    origin: "creative" as const,
    parameters: importParameters("creative"),
    creativeStartMode: "confirm-plan" as const,
    sourceUpload: null,
    idempotencyKey: key,
  };
}

/** Observe the genuine owner database's write, then withdraw only after its actual SQL COMMIT succeeds. */
function withdrawAtSqlBoundary(
  t: TestContext,
  table: string,
  boundary: "after-write" | "after-commit",
  withdraw: () => void,
) {
  const writing = new WeakSet<DatabaseSync>();
  const prepare = DatabaseSync.prototype.prepare;
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(
    DatabaseSync.prototype,
    "prepare",
    function (this: DatabaseSync, ...args: Parameters<typeof prepare>) {
      const statement = Reflect.apply(prepare, this, args) as ReturnType<
        typeof prepare
      >;
      if (new RegExp(`INSERT\\s+INTO\\s+${table}\\b`, "iu").test(args[0])) {
        const database = this,
          run = statement.run;
        statement.run = (...values) => {
          const result = Reflect.apply(run, statement, values) as ReturnType<
            typeof run
          >;
          if (boundary === "after-write") withdraw();
          else writing.add(database);
          return result;
        };
      }
      return statement;
    },
  );
  t.mock.method(
    DatabaseSync.prototype,
    "exec",
    function (this: DatabaseSync, sql: string) {
      Reflect.apply(exec, this, [sql]);
      if (sql === "COMMIT" && writing.delete(this)) withdraw();
    },
  );
}

test("Native optional Foundation declaration preserves exact old v1/v2/v3 DTOs and does not migrate new schemas", async (t) => {
  const f = await desktopFoundationFixture(t);
  const {
    projectFoundation: _foundation,
    projects: _projects,
    ...base
  } = f.declaration;
  const legacy = [
    { ...base, schemaVersion: "crewon.desktop-plugin-bootstrap.v1" },
    {
      ...base,
      schemaVersion: "crewon.desktop-plugin-bootstrap.v2",
      projects: {
        ...f.declaration.projects,
        version: "crewon.desktop-project-history.v1",
      },
    },
    { ...base, projects: f.declaration.projects },
  ];
  for (const raw of legacy) {
    const parsed = parseDesktopPluginConfiguration(raw);
    assert.deepEqual(parsed, raw);
    assert.equal(Object.hasOwn(parsed, "projectFoundation"), false);
    await writeFile(f.bootstrapPath, JSON.stringify(raw), { mode: 0o600 });
    const config = await f.load();
    const startup = composeDesktopProjectStartup({
      configuration: config,
      actor,
    });
    assert.equal(startup.creativeProjects?.foundation, undefined);
    await f.open(config);
    assert.equal(
      f.query(
        "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'project_source_upload_%' OR name='project_foundations'",
      )[0]!.n,
      0,
    );
    await f.close();
  }
});

test("Native Foundation startup rejects malformed or foreign opt-ins without executing accessors", async (t) => {
  const f = await desktopFoundationFixture(t),
    raw = f.declaration,
    foundation = raw.projectFoundation;
  const attempts = [
    { ...raw, extra: true },
    { ...raw, projectFoundation: undefined },
    {
      ...raw,
      projectFoundation: {
        ...foundation,
        version: "crewon.project-foundation.v2",
      },
    },
    { ...raw, projectFoundation: { ...foundation, extra: true } },
    {
      ...raw,
      projectFoundation: {
        ...foundation,
        uploads: {
          ...foundation.uploads,
          version: "crewon.project-source-uploads.v2",
        },
      },
    },
    {
      ...raw,
      projectFoundation: {
        ...foundation,
        uploads: { ...foundation.uploads, authorization: { authorize() {} } },
      },
    },
    {
      ...raw,
      projectFoundation: {
        ...foundation,
        pluginUi: {
          publications: [
            { ...f.module, packageDigest: `sha256:${"f".repeat(64)}` },
          ],
        },
      },
    },
    {
      ...raw,
      projectFoundation: {
        ...foundation,
        uploads: {
          ...foundation.uploads,
          pluginUi: {
            publications: [{ ...f.module, pluginId: "test.foreign" }],
          },
        },
      },
    },
    {
      ...raw,
      schemaVersion: "crewon.desktop-plugin-bootstrap.v1",
      projects: undefined,
    },
    {
      ...raw,
      schemaVersion: "crewon.desktop-plugin-bootstrap.v2",
      projects: {
        ...raw.projects,
        version: "crewon.desktop-project-history.v1",
      },
    },
  ];
  for (const input of attempts)
    assert.throws(
      () => parseDesktopPluginConfiguration(input),
      /desktop_plugin_configuration_invalid/u,
    );
  let getters = 0;
  const accessor = { ...raw };
  Object.defineProperty(accessor, "projectFoundation", {
    enumerable: true,
    get() {
      getters++;
      return foundation;
    },
  });
  assert.throws(() => parseDesktopPluginConfiguration(accessor));
  assert.equal(getters, 0);
  await assert.rejects(access(f.databasePath), { code: "ENOENT" });
});

test("Native independent source policy binds the real local actor, owner and six explicit permissions to the current private file", async (t) => {
  const f = await desktopFoundationFixture(t);
  const startup = composeDesktopProjectStartup({
    configuration: f.configuration,
    actor,
  });
  const policy = startup.creativeProjects!.foundation!.uploads.authorization;
  const owner = {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    principalId: actor.principalId,
  };
  const resource = {
    kind: "projectSourceUpload" as const,
    owner,
    uploadId: "named-upload",
    projectId: null,
  };
  for (const action of [
    "projectSourceUpload:begin",
    "projectSourceUpload:write",
    "projectSourceUpload:status",
    "projectSourceUpload:prepare",
    "projectSourceUpload:cancel",
    "projectSourceUpload:adopt",
  ] as const) {
    assert.deepEqual(
      await policy.authorize({
        actor,
        action,
        resource: {
          ...resource,
          uploadId:
            action === "projectSourceUpload:begin" ? null : "named-upload",
        },
      }),
      {
        outcome: "allow",
      },
    );
  }
  for (const field of [
    "actorId",
    "principalId",
    "tenantId",
    "spaceId",
  ] as const) {
    assert.equal(
      (
        await policy.authorize({
          actor: { ...actor, [field]: "foreign" },
          action: "projectSourceUpload:status",
          resource,
        })
      ).outcome,
      "deny",
    );
    assert.throws(() =>
      policy.assertActive({
        actor: { ...actor, [field]: "foreign" },
        action: "projectSourceUpload:status",
        resource,
      }),
    );
  }
  for (const field of ["principalId", "tenantId", "spaceId"] as const)
    assert.equal(
      (
        await policy.authorize({
          actor,
          action: "projectSourceUpload:status",
          resource: { ...resource, owner: { ...owner, [field]: "foreign" } },
        })
      ).outcome,
      "deny",
    );
  await writeFile(f.bootstrapPath, `${JSON.stringify(f.declaration)}\n`, {
    mode: 0o600,
  });
  assert.equal(
    (
      await policy.authorize({
        actor,
        action: "projectSourceUpload:status",
        resource,
      })
    ).outcome,
    "deny",
  );
  assert.throws(() =>
    policy.assertActive({
      actor,
      action: "projectSourceUpload:status",
      resource,
    }),
  );
});

test("Native installed dual-entry 39 creates, confirms and replays Foundation metadata through the original authenticated HTTP route", async (t) => {
  const f = await desktopFoundationFixture(t);
  await f.open();
  await f.install();
  const lease = await f.mount(),
    command = creative("native-foundation-create");
  const created = (await f.invoke(
    lease.mountRef,
    "createProject",
    command,
  )) as ProjectFoundationMutationResponse;
  assert.equal(created.foundation.origin, "creative");
  assert.equal(created.foundation.revision, 1);
  assert.equal(f.count("creative_projects"), 1);
  assert.equal(f.count("creative_project_briefs"), 1);
  assert.equal(f.count("project_foundations"), 1);
  const draft = (await f.invoke(lease.mountRef, "saveProposal", {
    projectId: created.project.projectId,
    expectedFoundationRevision: 1,
    expectedProposalRevision: 0,
    kind: "creative-plan",
    text: "三集悬疑：来信、追索、重逢。",
    idempotencyKey: "native-foundation-proposal",
  })) as ProjectFoundationMutationResponse;
  assert.ok(draft.proposal);
  assert.equal(draft.foundation.revision, 1);
  const confirmed = (await f.invoke(lease.mountRef, "confirmProposal", {
    projectId: created.project.projectId,
    expectedFoundationRevision: 1,
    proposalRevision: 1,
    proposalDigest: draft.proposal.contentDigest,
    idempotencyKey: "native-foundation-confirm",
  })) as ProjectFoundationMutationResponse;
  assert.equal(confirmed.foundation.revision, 2);
  assert.deepEqual(confirmed.foundation.confirmedProposal, {
    revision: 1,
    digest: draft.proposal.contentDigest,
  });
  assert.deepEqual(
    await f.invoke(lease.mountRef, "getFoundation", {
      projectId: created.project.projectId,
    }),
    { foundation: confirmed.foundation },
  );
  assert.deepEqual(await f.invoke(lease.mountRef, "createProject", command), {
    ...created,
    disposition: "replayed",
  });
  const schemaBefore = f.query(
    "SELECT name,sql FROM sqlite_master WHERE name IN ('creative_projects','creative_project_briefs') ORDER BY name",
  );
  await f.close();
  await f.open(await f.load());
  const reopened = await f.mount();
  assert.deepEqual(
    await f.invoke(reopened.mountRef, "getFoundation", {
      projectId: created.project.projectId,
    }),
    { foundation: confirmed.foundation },
  );
  assert.deepEqual(
    f.query(
      "SELECT name,sql FROM sqlite_master WHERE name IN ('creative_projects','creative_project_briefs') ORDER BY name",
    ),
    schemaBefore,
  );
  assert.equal(f.count("project_foundations"), 1);
  await f.assertNoExecution();
  // Optional UI metadata dependencies do not manufacture Node services. The genuine Node
  // preparation can retain its original lifecycle with neither new service present.
  const host = new PluginNodeHost({ services: [] });
  try {
    const prepared = await host.prepare({
      installRoot: f.files.installRoot,
      expectedPluginId: f.pkg.pluginId,
      expectedPackageDigest: f.pkg.packageDigest,
      authorizeActivation: () => "allow",
    });
    assert.equal(prepared.identity.version, "39.0.0");
    await prepared.abort();
  } finally {
    await host.close();
  }
});

test("Native raw multipart upload, actual parser and durable novel adoption share the original SQLite realm across cold reopen", async (t) => {
  const f = await desktopFoundationFixture(t);
  await f.open();
  await f.install();
  const lease = await f.mount(),
    text = `# 第一章 雨夜\n${"雨😀夜。".repeat(6500)}\n# 第二章 寻人\n未来的来信。`,
    bytes = Buffer.from(text);
  const started = await f.upload(lease.mountRef, "begin", {
    fileName: "雨夜.md",
    format: "md",
    byteLength: bytes.byteLength,
    fileDigest: hash(bytes),
    idempotencyKey: "native-source-begin",
  });
  assert.ok("disposition" in started);
  const uploadId = started.upload.uploadId,
    first = bytes.subarray(0, PROJECT_SOURCE_UPLOAD_PART_BYTES);
  const locator = { uploadId, partIndex: 0, rawDigest: hash(first) };
  const written = await f.writePart(lease.mountRef, locator, first);
  assert.deepEqual(await f.writePart(lease.mountRef, locator, first), {
    ...written,
    disposition: "replayed",
  });
  const tail = bytes.subarray(PROJECT_SOURCE_UPLOAD_PART_BYTES);
  const complete = await f.writePart(
    lease.mountRef,
    { uploadId, partIndex: 1, rawDigest: hash(tail) },
    tail,
  );
  const prepared = await f.upload(lease.mountRef, "prepare", {
    uploadId,
    expectedRevision: complete.upload.revision,
  });
  assert.equal(prepared.upload.phase, "ready");
  assert.equal(prepared.upload.prepared?.digest, hash(bytes));
  const command = {
    title: "雨夜小说改编",
    briefText: "保留雨夜来信的悬疑内核。",
    origin: "novel" as const,
    parameters: importParameters("novel"),
    creativeStartMode: null,
    sourceUpload: { uploadId, fileDigest: hash(bytes) },
    idempotencyKey: "native-novel-adopt",
  };
  const created = (await f.invoke(
    lease.mountRef,
    "createProject",
    command,
  )) as ProjectFoundationMutationResponse;
  assert.ok(created.source);
  assert.equal(created.source.digest, hash(bytes));
  assert.equal(created.source.characterLength, Array.from(text).length);
  assert.equal(f.count("project_source_upload_associations"), 1);
  const query = {
    projectId: created.project.projectId,
    sourceRevision: 1,
    sourceDigest: created.source.digest,
  };
  const page = await f.invoke(lease.mountRef, "readSourcePage", {
    ...query,
    startOffset: 0,
    limit: 80,
  });
  assert.ok("page" in page);
  assert.equal(page.page.content, Array.from(text).slice(0, 80).join(""));
  const chapters = await f.invoke(lease.mountRef, "listSourceChapters", {
    ...query,
    afterStartOffset: null,
    limit: 1,
  });
  assert.ok("chapters" in chapters);
  assert.equal(chapters.chapters[0]!.title, "第一章 雨夜");
  const realm = f.query(
    "SELECT storage_realm_id FROM project_source_upload_schema_version",
  );
  await f.close();
  await f.open(await f.load());
  const reopened = await f.mount();
  assert.deepEqual(
    f.query(
      "SELECT storage_realm_id FROM project_source_upload_schema_version",
    ),
    realm,
  );
  assert.deepEqual(
    (await f.upload(reopened.mountRef, "status", { uploadId })).upload,
    prepared.upload,
  );
  assert.deepEqual(
    await f.invoke(reopened.mountRef, "createProject", command),
    { ...created, disposition: "replayed" },
  );
  assert.equal(f.count("creative_projects"), 1);
  assert.equal(f.count("project_source_upload_parts"), 2);
  assert.equal(f.count("project_source_upload_associations"), 1);
  await f.assertNoExecution();
});

test("Native disabled or uninstalled selection and a changed private file block new JSON/raw writes without fallback", async (t) => {
  const f = await desktopFoundationFixture(t);
  await f.open();
  await f.install();
  let lease = await f.mount();
  const bytes = Buffer.from("# 雨夜\n未来的信。"),
    begin = {
      fileName: "雨夜.md",
      format: "md" as const,
      byteLength: bytes.byteLength,
      fileDigest: hash(bytes),
      idempotencyKey: "native-withdraw-upload",
    };
  const started = await f.upload(lease.mountRef, "begin", begin),
    locator = {
      uploadId: started.upload.uploadId,
      partIndex: 0,
      rawDigest: hash(bytes),
    };
  const part = () =>
    f.request(
      "PUT",
      projectSourceUploadPartPath(lease.mountRef, locator),
      bytes,
      undefined,
      { "content-type": "application/octet-stream" },
    );
  for (const action of [
    "crewon.project-foundation.v2.createProject",
    "crewon.project-source-uploads.v1.writePart",
    "crewon.project-source-uploads",
  ]) {
    assert.notEqual(
      (await f.invokeRaw(lease.mountRef, action, creative("namespace-denied")))
        .statusCode,
      200,
    );
  }
  assert.notEqual(
    (
      await f.request(
        "PUT",
        projectSourceUploadPartPath(lease.mountRef, locator),
        bytes,
        undefined,
        {
          "content-type": "application/octet-stream",
          "x-csrf-token": "foreign",
        },
      )
    ).statusCode,
    200,
  );
  await f.select(2, "disabled", "native-disable");
  assert.notEqual((await part()).statusCode, 200);
  assert.notEqual(
    (
      await f.invokeRaw(
        lease.mountRef,
        "crewon.project-foundation.v1.createProject",
        creative("disabled-create"),
      )
    ).statusCode,
    200,
  );
  assert.notEqual(
    (
      await f.invokeRaw(
        lease.mountRef,
        "crewon.project-source-uploads.v1.begin",
        begin,
      )
    ).statusCode,
    200,
  );
  await f.select(3, "enabled", "native-enable-again");
  lease = await f.mount(4);
  await f.select(4, "uninstalled", "native-uninstall");
  assert.notEqual((await part()).statusCode, 200);
  await f.select(5, "enabled", "native-reinstall-selection");
  lease = await f.mount(6);
  await writeFile(f.bootstrapPath, `${JSON.stringify(f.declaration)}\n`, {
    mode: 0o600,
  });
  assert.notEqual((await part()).statusCode, 200);
  assert.notEqual(
    (
      await f.invokeRaw(
        lease.mountRef,
        "crewon.project-foundation.v1.createProject",
        creative("changed-file-create"),
      )
    ).statusCode,
    200,
  );
  assert.equal(f.count("project_source_upload_parts"), 0);
  assert.equal(f.count("project_source_uploads"), 1);
  assert.equal(f.count("creative_projects"), 0);
  await f.assertNoExecution();
});

test("Native copied startup policy or bootstrap cannot acquire Foundation composition before any database access", async (t) => {
  const f = await desktopFoundationFixture(t);
  const startup = composeDesktopProjectStartup({
    configuration: f.configuration,
    actor,
  });
  const path = join(f.files.root, "must-not-exist.sqlite");
  let databaseReads = 0;
  for (const [configuration, projects] of [
    [f.configuration, { ...startup.creativeProjects! }],
    [
      f.configuration,
      {
        ...startup.creativeProjects!,
        foundation: {
          ...startup.creativeProjects!.foundation!,
          uploads: {
            ...startup.creativeProjects!.foundation!.uploads,
            authorization: {
              authorize: async () => ({ outcome: "allow" as const }),
              assertActive() {},
            },
          },
        },
      },
    ],
    [
      parseDesktopPluginConfiguration(
        JSON.parse(JSON.stringify(f.configuration)),
      ),
      startup.creativeProjects!,
    ],
  ] as const) {
    const input = {
      ...f.base(),
      desktopPlugins: configuration,
      creativeProjects: projects,
    };
    Object.defineProperty(input, "databasePath", {
      enumerable: true,
      get() {
        databaseReads++;
        return path;
      },
    });
    await assert.rejects(
      createStandaloneControlApiWithPlugins(input),
      /desktop_project_foundation_startup_authority_required/u,
    );
  }
  assert.equal(databaseReads, 0);
  await assert.rejects(access(path), { code: "ENOENT" });
  await assert.rejects(access(f.databasePath), { code: "ENOENT" });
});

test("Native confirmed Foundation COMMIT remains successful when the current private file is withdrawn immediately afterwards", async (t) => {
  const f = await desktopFoundationFixture(t);
  await f.open();
  await f.install();
  const lease = await f.mount();
  let withdrawals = 0;
  withdrawAtSqlBoundary(t, "project_foundations", "after-commit", () => {
    withdrawals++;
    writeFileSync(f.bootstrapPath, `${JSON.stringify(f.declaration)}\n`, {
      mode: 0o600,
    });
  });
  const result = (await f.invoke(
    lease.mountRef,
    "createProject",
    creative("native-commit-before-withdraw"),
  )) as ProjectFoundationMutationResponse;
  assert.equal(withdrawals, 1);
  assert.equal(result.disposition, "committed");
  assert.equal(f.count("creative_projects"), 1);
  assert.equal(f.count("project_foundations"), 1);
  assert.equal(f.count("project_foundation_mutation_receipts"), 1);
});

test("Native last synchronous Foundation authorization rolls back genuine project, brief and receipt writes after private-file withdrawal", async (t) => {
  const f = await desktopFoundationFixture(t);
  await f.open();
  await f.install();
  const lease = await f.mount();
  let withdrawals = 0;
  withdrawAtSqlBoundary(t, "project_foundations", "after-write", () => {
    withdrawals++;
    writeFileSync(f.bootstrapPath, `${JSON.stringify(f.declaration)}\n`, {
      mode: 0o600,
    });
  });
  const result = await f.invokeRaw(
    lease.mountRef,
    "crewon.project-foundation.v1.createProject",
    creative("native-last-sync-withdraw"),
  );
  assert.notEqual(result.statusCode, 200, result.body);
  assert.equal(withdrawals, 1);
  for (const table of [
    "creative_projects",
    "creative_project_briefs",
    "project_foundations",
    "project_foundation_mutation_receipts",
  ])
    assert.equal(f.count(table), 0, table);
});

test("Native confirmed raw part COMMIT returns its actual ACK after private-file withdrawal without a late authorization failure", async (t) => {
  const f = await desktopFoundationFixture(t);
  await f.open();
  await f.install();
  const lease = await f.mount(),
    bytes = Buffer.from("# 雨夜\n未来的信。");
  const started = await f.upload(lease.mountRef, "begin", {
    fileName: "雨夜.md",
    format: "md",
    byteLength: bytes.byteLength,
    fileDigest: hash(bytes),
    idempotencyKey: "native-part-commit-before-withdraw",
  });
  let withdrawals = 0;
  withdrawAtSqlBoundary(
    t,
    "project_source_upload_parts",
    "after-commit",
    () => {
      withdrawals++;
      writeFileSync(f.bootstrapPath, `${JSON.stringify(f.declaration)}\n`, {
        mode: 0o600,
      });
    },
  );
  const result = await f.writePart(
    lease.mountRef,
    { uploadId: started.upload.uploadId, partIndex: 0, rawDigest: hash(bytes) },
    bytes,
  );
  assert.equal(withdrawals, 1);
  assert.equal(result.disposition, "committed");
  assert.equal(result.upload.receivedParts.length, 1);
  assert.equal(f.count("project_source_upload_parts"), 1);
  assert.equal(f.count("project_source_upload_part_payloads"), 1);
});
