import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  PROJECT_SOURCE_UPLOAD_PLUGIN_ACTIONS as actions,
  type ProjectSourceUploadCommitAuthority,
  type ProjectSourceUploadPermission,
  type ProjectSourceUploadState,
} from "@crewon/application";
import { SqliteProjectSourceUploadStore } from "./project-source-upload-sqlite-store.ts";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import {
  actor,
  owner,
  optionsFor,
  pluginCommitFixture,
  selectionRecipe,
  type Backend,
} from "./creative-project-plugin-commit.test-support.ts";
import { installationRecipe } from "./plugin-installation-store.test-support.ts";

const at = "2026-10-08T00:00:00.000Z";
const sha = (data: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(data).digest("hex")}`;
const text = "第一章 夜雨\n林雨来到车站。😀";
const bytes = new TextEncoder().encode(text);
type Fixture = Awaited<ReturnType<typeof pluginCommitFixture>>;
type PermissionAction = Exclude<
  ProjectSourceUploadPermission["action"],
  "projectSourceUpload:adopt"
>;
const tables = [
  "project_source_uploads",
  "project_source_upload_heads",
  "project_source_upload_parts",
  "project_source_upload_part_payloads",
  "project_source_upload_seals",
  "project_source_upload_prepared",
  "project_source_upload_prepared_chunks",
  "project_source_upload_prepared_chapters",
  "project_source_upload_events",
  "project_source_upload_associations",
];
function grant(
  f: Fixture,
  action: PermissionAction = "projectSourceUpload:begin",
  uploadId: string | null = null,
) {
  const original = f.grant(actions[action]);
  // Real installation fixture callbacks only. Product grants never convert an old transaction protocol.
  const authority: ProjectSourceUploadCommitAuthority = {
    version: "crewon.project-source-upload-commit.v1",
    permission: {
      actor,
      action,
      resource: {
        kind: "projectSourceUpload",
        owner: owner(),
        uploadId,
        projectId: null,
      },
    },
    assertCurrent: original.authority.assertCurrent,
    assertActive: original.authority.assertActive,
    transaction: {
      ...original.authority.transaction!,
      version: "crewon.project-source-upload-plugin-commit.v1",
    },
  };
  return { ...original, authority };
}
async function setup(
  t: Parameters<typeof pluginCommitFixture>[0],
  backend: Backend,
) {
  const f = await pluginCommitFixture(t, backend);
  // SQLite exposes the fixture's existing native connection for SQL-trigger withdrawal evidence.
  // PostgreSQL uses the parent factory's original max=1 pool, including the actual COMMIT gate.
  const uploads = f.database
    ? new SqliteProjectSourceUploadStore({
        database: f.database,
        assertOpen() {},
      })
    : f.parent.projectSourceUploadStore();
  await uploads.migrate();
  const creation = (uploadId = "upload-1") => {
    const receipt = {
      idempotencyKey: `begin-${uploadId}`,
      requestDigest: sha(`request:${uploadId}`),
    };
    return {
      actor,
      receipt,
      initial: {
        schemaVersion: "crewon.project-source-upload.v1" as const,
        storageRealmId: uploads.storageRealmId,
        uploadId,
        owner: owner(),
        fileName: "故事.txt",
        format: "txt" as const,
        byteLength: bytes.length,
        fileDigest: sha(bytes),
        partBytes: 65_536 as const,
        partCount: 1,
        requestDigest: receipt.requestDigest,
        createdByActorId: actor.actorId,
        createdAt: at,
      },
    };
  };
  return { ...f, uploads, creation };
}
function command(state: ProjectSourceUploadState) {
  return {
    actor,
    uploadId: state.initial.uploadId,
    expectedRevision: state.revision,
    at,
  };
}
const part = {
  index: 0,
  byteOffset: 0,
  byteLength: bytes.length,
  rawDigest: sha(bytes),
};
const parsed = {
  fileName: "故事.txt",
  format: "txt" as const,
  byteLength: bytes.length,
  characterLength: [...text].length,
  digest: sha(text),
  fileDigest: sha(bytes),
  chunks: [{ index: 0, startOffset: 0, content: text, digest: sha(text) }],
  chapters: [
    {
      chapterId: "chapter-1",
      title: "第一章 夜雨",
      startOffset: 0,
      endOffset: [...text].length,
    },
  ],
};
async function counts(f: Fixture) {
  const result: Record<string, number> = {};
  for (const table of tables)
    result[table] = Number(
      (await f.query(`SELECT COUNT(*) AS n FROM ${f.prefix}${table}`))[0]!.n,
    );
  return result;
}
async function withdraw(
  f: Fixture,
  state: "disabled" | "uninstalled" | "changed-package",
) {
  let selection = f.source.selection;
  if (state === "changed-package")
    selection = (
      await f.otherInstallations.recordInstalledPackage(
        installationRecipe("upload-next-package", {
          scope: f.scope,
          actor,
          pluginId: f.source.package.pluginId,
          version: "6.0.0",
          expectedSelectionRevision: selection.revision,
        }),
      )
    ).selection;
  return f.otherInstallations.commitSelection(
    selectionRecipe(selection, `upload-${state}`, {
      actor,
      state: state === "changed-package" ? "enabled" : state,
    }),
  );
}
async function receiving(f: Awaited<ReturnType<typeof setup>>) {
  const started = await f.uploads.begin(f.creation(), grant(f).authority);
  return (
    await f.uploads.writePart(
      { ...command(started.state), part, bytes },
      grant(f, "projectSourceUpload:write", "upload-1").authority,
    )
  ).state;
}
async function preparing(f: Awaited<ReturnType<typeof setup>>) {
  const state = await receiving(f),
    a = grant(f, "projectSourceUpload:prepare", "upload-1");
  const sealed = await f.uploads.sealRaw(command(state), a.authority);
  return (
    await f.uploads.claimPreparation(
      {
        ...command(sealed.state),
        claim: {
          claimId: "claim-1",
          normalizationParserVersion: "parser-v1",
          expiresAt: "2026-10-08T00:00:30.000Z",
        },
      },
      a.authority,
    )
  ).state;
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: enabled upload installation qualifies all state writes and durable replay without paid migration`,
    optionsFor(backend),
    async (t) => {
      const f = await setup(t, backend),
        initial = f.creation(),
        g = grant(f);
      const created = await f.uploads.begin(initial, g.authority);
      assert.deepEqual(await f.uploads.begin(initial, g.authority), {
        ...created,
        disposition: "replayed",
      });
      assert.deepEqual(
        await f.uploads.loadBeginReceipt(
          { actor, receipt: initial.receipt },
          g.authority,
        ),
        { ...created, disposition: "replayed" },
      );
      const writing = grant(f, "projectSourceUpload:write", "upload-1");
      const written = await f.uploads.writePart(
        { ...command(created.state), part, bytes },
        writing.authority,
      );
      assert.deepEqual(
        await f.uploads.writePart(
          { ...command(created.state), part, bytes },
          writing.authority,
        ),
        { ...written, disposition: "replayed" },
      );
      const preparation = grant(f, "projectSourceUpload:prepare", "upload-1");
      const sealed = await f.uploads.sealRaw(
        command(written.state),
        preparation.authority,
      );
      const claimed = await f.uploads.claimPreparation(
        {
          ...command(sealed.state),
          claim: {
            claimId: "claim-1",
            normalizationParserVersion: "parser-v1",
            expiresAt: "2026-10-08T00:00:30.000Z",
          },
        },
        preparation.authority,
      );
      const completed = await f.uploads.completePreparation(
        { ...command(claimed.state), claimId: "claim-1", parsed },
        preparation.authority,
      );
      assert.equal(completed.state.phase, "ready");
      const current = await f.uploads.load(
        { owner: owner(), uploadId: "upload-1" },
        grant(f, "projectSourceUpload:status", "upload-1").authority,
      );
      assert.deepEqual(current, completed.state);
      const second = await f.uploads.begin(
        f.creation("upload-2"),
        grant(f).authority,
      );
      const cancelled = await f.uploads.cancel(
        command(second.state),
        grant(f, "projectSourceUpload:cancel", "upload-2").authority,
      );
      assert.equal(cancelled.state.phase, "cancelled");
      assert.equal((await counts(f)).project_source_upload_associations, 0);
      for (const name of [
        "plugin_task_admission_schema_version",
        "plugin_credit_schema_version",
        "extension_credit_schema_version",
        "plugin_query_task_admission_schema_version",
      ])
        assert.equal((await f.tableNames()).includes(name), false, name);
      if (backend === "postgres") {
        assert.equal(f.pool!.options.max, 1);
        assert.ok(
          f.commands.filter((sql) => sql.includes("FOR SHARE OF s,p")).length >=
            9,
        );
      }
    },
  );

  test(
    `${backend}: strict upload defaults refuse missing, old, mismatched and accessor authorities before writes`,
    optionsFor(backend),
    async (t) => {
      const f = await setup(t, backend),
        initial = f.creation(),
        original = grant(f);
      const { transaction: _transaction, ...ordinary } = original.authority;
      await assert.rejects(
        f.uploads.begin(initial, ordinary),
        /plugin_commit_authority_required/,
      );
      for (const patch of [
        { version: "crewon.creative-project-plugin-commit.v1" },
        { version: "crewon.project-foundation-plugin-commit.v1" },
        {
          pin: {
            ...original.authority.transaction!.pin,
            action: actions["projectSourceUpload:prepare"],
          },
        },
        { pin: { ...original.authority.transaction!.pin, actorId: "foreign" } },
        {
          pin: {
            ...original.authority.transaction!.pin,
            principalId: "foreign",
          },
        },
      ])
        await assert.rejects(
          f.uploads.begin(initial, {
            ...original.authority,
            transaction: { ...original.authority.transaction!, ...patch },
          } as ProjectSourceUploadCommitAuthority),
        );
      let access = 0;
      const hostile = Object.defineProperty(
        { ...original.authority },
        "transaction",
        {
          enumerable: true,
          get() {
            access++;
            return original.authority.transaction;
          },
        },
      );
      await assert.rejects(f.uploads.begin(initial, hostile));
      assert.equal(access, 0);
      assert.equal(original.state.fullCalls, 0);
      assert.ok(Object.values(await counts(f)).every((n) => n === 0));
      const parentFactory = f.parent.projectSourceUploadStore();
      await parentFactory.migrate();
      await assert.rejects(
        parentFactory.begin(initial, ordinary),
        /plugin_commit_authority_required/,
      );
    },
  );

  for (const state of ["disabled", "uninstalled", "changed-package"] as const)
    test(
      `${backend}: actual installation ${state} after upload preflight denies initial ledger atomically`,
      optionsFor(backend),
      async (t) => {
        const f = await setup(t, backend),
          g = grant(f);
        g.state.preflightHook = async () => {
          await withdraw(f, state);
        };
        await assert.rejects(
          f.uploads.begin(f.creation(), g.authority),
          /plugin_installation_pin_conflict/,
        );
        assert.ok(Object.values(await counts(f)).every((n) => n === 0));
      },
    );

  for (const stage of ["seal", "claim", "complete", "reject"] as const)
    test(
      `${backend}: ${stage} write rechecks actual installation and leaves earlier upload fact intact`,
      optionsFor(backend),
      async (t) => {
        const f = await setup(t, backend);
        let prior =
          stage === "complete" || stage === "reject"
            ? await preparing(f)
            : await receiving(f);
        if (stage === "claim")
          prior = (
            await f.uploads.sealRaw(
              command(prior),
              grant(f, "projectSourceUpload:prepare", "upload-1").authority,
            )
          ).state;
        const before = await counts(f),
          g = grant(f, "projectSourceUpload:prepare", "upload-1");
        g.state.preflightHook = async () => {
          await withdraw(f, "disabled");
        };
        const saving =
          stage === "seal"
            ? f.uploads.sealRaw(command(prior), g.authority)
            : stage === "claim"
              ? f.uploads.claimPreparation(
                  {
                    ...command(prior),
                    claim: {
                      claimId: "claim-1",
                      normalizationParserVersion: "parser-v1",
                      expiresAt: "2026-10-08T00:00:30.000Z",
                    },
                  },
                  g.authority,
                )
              : stage === "complete"
                ? f.uploads.completePreparation(
                    { ...command(prior), claimId: "claim-1", parsed },
                    g.authority,
                  )
                : f.uploads.rejectPreparation(
                    {
                      ...command(prior),
                      claimId: "claim-1",
                      failureCode: "project_source_import_encoding_invalid",
                    },
                    g.authority,
                  );
        await assert.rejects(
          saving,
          /plugin_installation_pin_conflict|metadata_source_changed/,
        );
        assert.deepEqual(await counts(f), before);
        const rows = await f.query(
          `SELECT record_json FROM ${f.prefix}project_source_upload_heads`,
        );
        assert.deepEqual(
          typeof rows[0]!.record_json === "string"
            ? JSON.parse(rows[0]!.record_json)
            : rows[0]!.record_json,
          prior,
        );
      },
    );

  test(
    `${backend}: disabled installation cannot return an old upload receipt or raw part replay`,
    optionsFor(backend),
    async (t) => {
      const f = await setup(t, backend),
        initial = f.creation(),
        prior = await receiving(f),
        before = await counts(f);
      await withdraw(f, "uninstalled");
      await assert.rejects(
        f.uploads.loadBeginReceipt(
          { actor, receipt: initial.receipt },
          grant(f).authority,
        ),
      );
      await assert.rejects(
        f.uploads.writePart(
          { ...command(prior), part, bytes },
          grant(f, "projectSourceUpload:write", "upload-1").authority,
        ),
      );
      assert.deepEqual(await counts(f), before);
    },
  );

  for (const operation of ["write", "cancel"] as const)
    test(
      `${backend}: ${operation} checks installation before changing the existing upload`,
      optionsFor(backend),
      async (t) => {
        const f = await setup(t, backend),
          started = await f.uploads.begin(f.creation(), grant(f).authority),
          before = await counts(f);
        const g = grant(
          f,
          operation === "write"
            ? "projectSourceUpload:write"
            : "projectSourceUpload:cancel",
          "upload-1",
        );
        g.state.preflightHook = async () => {
          await withdraw(f, "disabled");
        };
        await assert.rejects(
          operation === "write"
            ? f.uploads.writePart(
                { ...command(started.state), part, bytes },
                g.authority,
              )
            : f.uploads.cancel(command(started.state), g.authority),
        );
        assert.deepEqual(await counts(f), before);
      },
    );

  test(
    `${backend}: same-revision selection audit tampering cannot qualify the captured upload installation`,
    optionsFor(backend),
    async (t) => {
      const f = await setup(t, backend),
        g = grant(f);
      g.state.preflightHook = async () =>
        f.execute(
          backend === "sqlite"
            ? "UPDATE plugin_profile_selections SET record_json=json_set(record_json,'$.updatedByActorId','audit-tampered')"
            : `UPDATE ${f.prefix}plugin_profile_selections SET record_json=jsonb_set(record_json,'{updatedByActorId}','"audit-tampered"'::jsonb)`,
        );
      await assert.rejects(
        f.uploads.begin(f.creation(), g.authority),
        /project_source_upload_plugin_commit_selection_mismatch/,
      );
      assert.ok(Object.values(await counts(f)).every((n) => n === 0));
    },
  );

  test(
    `${backend}: installation namespace version is fail-closed and not silently migrated`,
    optionsFor(backend),
    async (t) => {
      const f = await setup(t, backend),
        g = grant(f);
      g.state.preflightHook = async () =>
        f.execute(
          `UPDATE ${f.prefix}plugin_installation_schema_version SET version=99 WHERE id=1`,
        );
      await assert.rejects(
        f.uploads.begin(f.creation(), g.authority),
        /plugin_installation_schema_version_unsupported/,
      );
      assert.equal(
        Number(
          (
            await f.query(
              `SELECT version FROM ${f.prefix}plugin_installation_schema_version`,
            )
          )[0]!.version,
        ),
        99,
      );
      assert.ok(Object.values(await counts(f)).every((n) => n === 0));
    },
  );

  test(
    `${backend}: final active withdrawal rolls back upload ledger and payload`,
    optionsFor(backend),
    async (t) => {
      const f = await setup(t, backend),
        g = grant(f);
      if (f.database) {
        f.database.function("withdraw_upload", () => {
          g.state.active = false;
          return 0;
        });
        await f.execute(
          "CREATE TRIGGER withdraw_upload AFTER INSERT ON project_source_upload_events BEGIN SELECT withdraw_upload(); END",
        );
      } else
        g.state.transactionHook = async () => {
          g.state.active = false;
        };
      await assert.rejects(
        f.uploads.begin(f.creation(), g.authority),
        /metadata_invocation_withdrawn/,
      );
      assert.ok(Object.values(await counts(f)).every((n) => n === 0));
    },
  );

  test(
    `${backend}: confirmed upload COMMIT remains successful after authority withdrawal`,
    optionsFor(backend),
    async (t) => {
      const f = await setup(t, backend),
        g = grant(f),
        initial = f.creation();
      if (f.database) {
        const exec = f.database.exec.bind(f.database);
        f.database.exec = (sql) => {
          exec(sql);
          if (sql === "COMMIT") {
            g.state.active = false;
            g.state.current = false;
          }
        };
        const result = await f.uploads.begin(initial, g.authority);
        assert.equal(result.disposition, "committed");
        assert.equal((await counts(f)).project_source_uploads, 1);
      } else {
        const gate = f.arm("commit"),
          saving = f.track(f.uploads.begin(initial, g.authority));
        void saving.catch(() => {});
        await gate.entered.promise;
        assert.equal((await counts(f)).project_source_uploads, 1);
        g.state.active = false;
        g.state.current = false;
        f.closeOwner();
        await withdraw(f, "uninstalled");
        await f.parent.close();
        gate.resume.resolve();
        assert.equal((await saving).disposition, "committed");
      }
    },
  );

  test(
    `${backend}: cold parent reopen keeps upload realm, records and actual installation qualification`,
    optionsFor(backend),
    async (t) => {
      const f = await setup(t, backend),
        first = f.parent.projectSourceUploadStore();
      await first.migrate();
      const initial = f.creation(),
        g = grant(f),
        created = await first.begin(initial, g.authority),
        realm = first.storageRealmId;
      const path = f.database
        ? String(f.database.prepare("PRAGMA database_list").get()!.file)
        : null;
      await f.parent.close();
      const reopened = path
        ? new SqliteRunStore(path)
        : await PostgresDomainStore.open({ pool: f.pool!, schema: f.schema });
      t.after(() => reopened.close());
      const store = reopened.projectSourceUploadStore();
      await store.migrate();
      assert.equal(store.storageRealmId, realm);
      const permission = grant(
        f,
        "projectSourceUpload:status",
        "upload-1",
      ).authority;
      // The new host policy callbacks are independent of the old closed service; the SQL tuple is unchanged.
      const offline: ProjectSourceUploadCommitAuthority = {
        ...permission,
        assertCurrent: async () => {},
        assertActive() {},
        transaction: {
          ...permission.transaction!,
          assertCurrent: async () => {},
        },
      };
      assert.deepEqual(
        await store.load({ owner: owner(), uploadId: "upload-1" }, offline),
        created.state,
      );
      await withdraw(f, "disabled");
      await assert.rejects(
        store.load({ owner: owner(), uploadId: "upload-1" }, offline),
        /plugin_installation_pin_conflict/,
      );
    },
  );
}
