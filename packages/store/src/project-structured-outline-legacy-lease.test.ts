import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { projectStructuredOutlineCommandReceipt } from "@crewon/application";
import {
  projectOutlineInputBinding,
  saveProjectStructuredOutlineCandidate,
} from "@crewon/domain";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { SqliteProjectTextStore } from "./project-text-sqlite-store.ts";
import {
  outlineToolFixture,
  outlineHasCause,
} from "./project-outline-run-commit.test-support.ts";
import { creativeStoreDigester as digester } from "./creative-project-store-records.ts";
import { migrateSqlitePluginProjectMetadataOwners } from "./plugin-project-metadata-owner-schema.ts";

for (const mode of ["fresh", "replay"] as const) {
  test(
    `sqlite: v2 ${mode} original physical Run lease is checked after final negative SQL`,
    { timeout: 15000 },
    async (t) => {
      const claim = SqliteRunStore.prototype.claimNextWorkItem;
      // The genuine original public queue writer issues the short lease; stored expiry and clock are not forged.
      SqliteRunStore.prototype.claimNextWorkItem = function (input) {
        return claim.call(
          this,
          input.ownerId === "outline-native-worker"
            ? { ...input, leaseDurationMs: 3000 }
            : input,
        );
      };
      let f: Awaited<ReturnType<typeof outlineToolFixture>>;
      try {
        f = await outlineToolFixture(t, "sqlite");
      } finally {
        SqliteRunStore.prototype.claimNextWorkItem = claim;
      }
      const op = await f.prepare();
      const owner = {
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        principalId: f.actor.principalId,
      };
      const project = await f.metadata.loadProject({
        owner,
        projectId: f.reference.projectId,
      });
      assert.ok(project);
      const next = saveProjectStructuredOutlineCandidate(
        {
          project,
          actor: f.actor,
          artifact: null,
          artifactId: "leased-structured-outline",
          expectedArtifactRevision: 0,
          brief: f.brief,
          inputs: projectOutlineInputBinding(f.foundation.foundation, digester),
          content: f.document,
          at: new Date().toISOString(),
        },
        digester,
      );
      const prepared = {
        ...next,
        actor: f.actor,
        kind: "save-outline" as const,
        project,
        expectedArtifactRevision: 0,
        receipt: projectStructuredOutlineCommandReceipt(
          f.actor,
          "save-outline",
          op.command,
          digester,
        ),
      };
      const db = new DatabaseSync(f.databasePath);
      t.after(() => db.close());
      db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
      migrateSqlitePluginProjectMetadataOwners(db);
      db.exec("COMMIT");
      const store = new SqliteProjectTextStore({
        database: db,
        assertOpen() {},
      });
      if (mode === "replay")
        await store.commitStructuredOutlineCandidate(prepared, op.options);
      const snapshot = () =>
        [
          "project_text_artifacts",
          "project_text_revisions",
          "project_text_mutation_receipts",
        ].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
      const before = snapshot();
      const prepare = db.prepare.bind(db);
      let consumed = false,
        expiredDuringFinalSql = false;
      db.prepare = ((sql: string) => {
        if (
          consumed &&
          !expiredDuringFinalSql &&
          /PRAGMA foreign_key_check\(plugin_project_metadata_owners\)/u.test(
            sql,
          )
        ) {
          assert.ok(
            Date.now() < Date.parse(f.claim.lease.expiresAt),
            "actual original lease is still live before final negative inspection",
          );
          Atomics.wait(
            new Int32Array(new SharedArrayBuffer(4)),
            0,
            0,
            Math.max(1, Date.parse(f.claim.lease.expiresAt) - Date.now() + 10),
          );
          assert.ok(Date.now() >= Date.parse(f.claim.lease.expiresAt));
          expiredDuringFinalSql = true;
        }
        const statement = prepare(sql);
        if (
          (mode === "fresh"
            ? /INSERT INTO project_text_mutation_receipts/u
            : /FROM project_text_mutation_receipts WHERE/u
          ).test(sql)
        )
          return new Proxy(statement, {
            get(target, key) {
              if (key === (mode === "fresh" ? "run" : "get"))
                return (...values: unknown[]) => {
                  const result = Reflect.apply(
                    mode === "fresh" ? target.run : target.get,
                    target,
                    values,
                  );
                  if (mode === "fresh" || result !== undefined) consumed = true;
                  return result;
                };
              const value: unknown = Reflect.get(target, key, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        return statement;
      }) as DatabaseSync["prepare"];
      t.after(() => {
        db.prepare = prepare;
      });
      await assert.rejects(
        store.commitStructuredOutlineCandidate(prepared, op.options),
        outlineHasCause("creative_project_run_commit_not_current"),
      );
      assert.equal(consumed, true);
      assert.equal(expiredDuringFinalSql, true);
      db.prepare = prepare;
      assert.deepEqual(snapshot(), before);
    },
  );
}
