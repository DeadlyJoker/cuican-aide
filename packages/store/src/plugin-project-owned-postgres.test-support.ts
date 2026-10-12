import { randomUUID, createHash } from "node:crypto";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import { CreativeProjectApplicationService } from "@crewon/application";
import { PostgresCreativeProjectStore } from "./postgres-creative-project-store.ts";
import { PostgresPluginInstallationStore } from "./postgres-plugin-installation-store.ts";
import { migratePostgresPluginProjectMetadataOwners } from "./plugin-project-metadata-owner-schema.ts";
import {
  creativeActionFixture,
  creativeActionDescriptor,
} from "../../application/src/plugin-creative-project-action.test-support.ts";
import {
  uiTestActor,
  uiTestAt,
} from "../../application/src/plugin-ui.test-support.ts";
export async function ownedProjectPostgresFixture(t: TestContext) {
  const pool = new Pool({
    connectionString: process.env.CREWON_TEST_POSTGRES_URL,
    max: 4,
  });
  const schema = `owned_creation_${randomUUID().replaceAll("-", "")}`;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const store = new PostgresCreativeProjectStore({
    pool,
    schema,
    assertOpen() {},
  });
  const installations = new PostgresPluginInstallationStore({
    pool,
    schema,
    assertOpen() {},
  });
  await store.migrate();
  await installations.migrate();
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await migratePostgresPluginProjectMetadataOwners(c, schema);
    await c.query("COMMIT");
  } finally {
    c.release();
  }
  let next = 0;
  const ids = { nextId: () => `owned-project-${++next}` },
    policy = { allowed: true };
  const sha = (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`;
  const makeService = (store: PostgresCreativeProjectStore) =>
    new CreativeProjectApplicationService({
      store,
      ids,
      clock: { now: () => uiTestAt },
      digester: { sha256: sha },
      authorization: {
        authorize: async () =>
          policy.allowed
            ? { outcome: "allow" }
            : { outcome: "deny", reasonCode: "named_project_create_denied" },
      },
    });
  const service = makeService(store);
  const owners: { close(): Promise<void> }[] = [];
  t.after(async () => {
    for (const owner of owners) await owner.close();
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  });
  const ui = async (pluginId = "example.story", cold = false) => {
    const f = creativeActionFixture({
      projectService: cold
        ? makeService(
            new PostgresCreativeProjectStore({ pool, schema, assertOpen() {} }),
          )
        : service,
      creationOwnership: "plugin-project-v1",
      descriptor: creativeActionDescriptor({ pluginId }),
      ...(pluginId === "example.story" ? {} : { packageDigest: sha(pluginId) }),
    });
    owners.push(f.owner);
    const receipt = (key: string) => ({
      idempotencyKey: key,
      requestDigest: sha(key),
    });
    if (
      await installations.loadSelection({ scope: f.ui.state.scope, pluginId })
    )
      return f;
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
  const counts = async () => {
    const values = [];
    for (const table of [
      "creative_projects",
      "creative_project_briefs",
      "plugin_project_metadata_owners",
      "creative_project_mutation_receipts",
    ])
      values.push(
        Number(
          (await pool.query(`SELECT COUNT(*) AS n FROM "${schema}".${table}`))
            .rows[0].n,
        ),
      );
    return values;
  };
  return {
    pool,
    schema,
    store,
    service,
    ids,
    policy,
    ui,
    counts,
    installations,
  };
}
