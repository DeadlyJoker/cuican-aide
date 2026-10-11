import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { createHash } from "node:crypto";
import { CreativeProjectApplicationService } from "@crewon/application";
import { SqliteCreativeProjectStore } from "./sqlite-creative-project-store.ts";
import { SqlitePluginInstallationStore } from "./sqlite-plugin-installation-store.ts";
import { migrateSqlitePluginProjectMetadataOwners } from "./plugin-project-metadata-owner-schema.ts";
import {
  creativeActionFixture,
  creativeActionDescriptor,
} from "../../application/src/plugin-creative-project-action.test-support.ts";
import {
  uiTestActor,
  uiTestAt,
} from "../../application/src/plugin-ui.test-support.ts";
/** Real original SQLite transactions; UI package/policy discovery is an explicit memory fixture, not Native/Web proof. */
export async function ownedProjectSqliteFixture(
  t: TestContext,
  metadataSchema: "complete" | "absent" = "complete",
) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const store = new SqliteCreativeProjectStore({
    database: db,
    assertOpen() {},
  });
  const installations = new SqlitePluginInstallationStore({
    database: db,
    assertOpen() {},
  });
  await store.migrate();
  await installations.migrate();
  if (metadataSchema === "complete") {
    db.exec("BEGIN IMMEDIATE");
    migrateSqlitePluginProjectMetadataOwners(db);
    db.exec("COMMIT");
  }
  let next = 0;
  const ids = { nextId: () => `owned-project-${++next}` };
  const policy = { allowed: true };
  const service = new CreativeProjectApplicationService({
    store,
    ids,
    clock: { now: () => uiTestAt },
    digester: {
      sha256: (value) =>
        `sha256:${createHash("sha256").update(value).digest("hex")}`,
    },
    authorization: {
      authorize: async () =>
        policy.allowed
          ? { outcome: "allow" }
          : { outcome: "deny", reasonCode: "named_project_create_denied" },
    },
  });
  const owners: { close(): Promise<void> }[] = [];
  t.after(async () => {
    for (const owner of owners) await owner.close();
    db.close();
  });
  const ui = async (pluginId = "example.story") => {
    const f = creativeActionFixture({
      projectService: service,
      creationOwnership: "plugin-project-v1",
      descriptor: creativeActionDescriptor({ pluginId }),
      ...(pluginId === "example.story"
        ? {}
        : {
            packageDigest: `sha256:${createHash("sha256").update(pluginId).digest("hex")}`,
          }),
    });
    owners.push(f.owner);
    const receipt = (key: string) => ({
      idempotencyKey: key,
      requestDigest: `sha256:${createHash("sha256").update(key).digest("hex")}`,
    });
    const installed = await installations.recordInstalledPackage({
      actor: uiTestActor,
      scope: f.ui.state.scope,
      package: f.ui.state.package,
      receipt: receipt(`install-${pluginId}`),
      expectedSelectionRevision: null,
    });
    await installations.commitSelection({
      actor: uiTestActor,
      scope: f.ui.state.scope,
      selection: f.ui.state.selection!,
      expectedSelectionRevision: installed.selection.revision,
      receipt: receipt(`enable-${pluginId}`),
    });
    return f;
  };
  const counts = () =>
    Object.fromEntries(
      [
        "creative_projects",
        "creative_project_briefs",
        "plugin_project_metadata_owners",
        "creative_project_mutation_receipts",
      ].map((table) => [
        table,
        db
          .prepare("SELECT 1 FROM sqlite_schema WHERE name=? AND type='table'")
          .get(table)
          ? Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n)
          : 0,
      ]),
    );
  return { db, store, service, ids, ui, counts, policy, installations };
}
