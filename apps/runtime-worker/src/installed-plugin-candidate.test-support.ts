import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { inspect } from "node:util";
import { createExtensionConfiguration } from "@crewon/domain";
import { InstalledPluginExtensionHost } from "./plugins/installed-plugin-extension-host.ts";
import {
  actor,
  digester,
  hostFixture,
  pluginId,
  scope,
} from "./installed-plugin-extension-host.test-support.ts";

export {
  gate,
  digester,
  scope,
} from "./installed-plugin-extension-host.test-support.ts";

/** First-installed disabled bytes, actual saved configuration and same SQLite/runtime parent. */
export async function candidateFixture(
  t: TestContext,
  options: Parameters<typeof hostFixture>[1] & {
    saveConfiguration?: boolean;
  } = {},
) {
  let host: InstalledPluginExtensionHost | null = null;
  // Dispose the candidate's Node owner before the fixture closes its parent resolver/store.
  t.after(async () => {
    await host?.close().catch((error) => {
      if (!options.disposeFails) throw error;
    });
  });
  const f = await hostFixture(t, { ...options, selectionState: "disabled" });
  const configurations = f.store.extensionStore();
  await configurations.migrate();
  const configurationScope = {
    tenantId: scope.tenantId,
    spaceId: scope.spaceId,
    pluginId,
  };
  async function saveConfiguration() {
    const latest =
      await configurations.loadLatestExtensionConfiguration(configurationScope);
    const configuration = createExtensionConfiguration(
      {
        ...f.entry.configuration,
        revision: (latest?.revision ?? 0) + 1,
      },
      digester,
    );
    await configurations.saveExtensionConfiguration({
      configuration,
      expectedRevision: latest?.revision ?? 0,
      receipt: {
        actorId: actor.actorId,
        idempotencyKey: `candidate-configuration-${configuration.revision}`,
        requestDigest: digester.sha256(
          `candidate-configuration-${configuration.revision}`,
        ),
      },
    });
    return configuration;
  }
  if (options.saveConfiguration !== false) await saveConfiguration();
  host = new InstalledPluginExtensionHost({
    ...f.dependencies,
    configurations,
  });
  const selection = await f.installations.loadSelection({ scope, pluginId });
  assert.ok(selection);
  assert.equal(selection.state, "disabled");
  assert.equal(selection.revision, 1);
  const request = {
    ...f.request,
    expectedSelectionRevision: selection.revision,
  };
  const databasePath = join(f.directory, "control.sqlite");
  const rows = () => candidateSideEffectCounts(databasePath);
  async function withdrawDeployment() {
    const locator = {
      tenantId: scope.tenantId,
      agentVersionId: f.entry.version.agentVersionId,
    };
    assert.ok(await f.store.loadAgentVersionDeployment(locator));
    // Public releases preserve immutable historical deployments. This owned
    // fixture instead models actual durable row loss, as recovery tests do.
    const database = new DatabaseSync(databasePath);
    try {
      assert.equal(
        database
          .prepare(
            "DELETE FROM agent_version_deployments WHERE tenant_id=? AND agent_version_id=?",
          )
          .run(locator.tenantId, locator.agentVersionId).changes,
        1,
      );
    } finally {
      database.close();
    }
    assert.equal(await f.store.loadAgentVersionDeployment(locator), null);
  }
  return {
    ...f,
    legacyHost: f.host,
    host,
    configurations,
    configurationScope,
    request,
    selection,
    rows,
    saveConfiguration,
    withdrawDeployment,
  };
}

/** A rejected/early operation must fail the test instead of leaving its gate unresolved. */
export async function awaitCandidateGate(
  entered: Readonly<{ promise: Promise<void> }>,
  observed: Promise<unknown>,
): Promise<void> {
  await Promise.race([
    entered.promise,
    observed.then((outcome) => {
      assert.fail(
        `candidate settled before its actual resource gate: ${inspect(outcome, { depth: 2 })}`,
      );
    }),
  ]);
}

export function candidateSideEffectCounts(
  databasePath: string,
): Record<string, number> {
  const tables = [
    "run_snapshots",
    "extension_activations",
    "extension_run_bindings",
    "extension_external_operations",
    "extension_credit_admissions",
    "plugin_credit_accounts",
    "plugin_credit_entries",
    "plugin_credit_reservations",
  ];
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Object.fromEntries(
      tables.map((name) => {
        const exists = database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
          )
          .get(name);
        return [
          name,
          exists === undefined
            ? 0
            : Number(
                database.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get()!
                  .count,
              ),
        ];
      }),
    );
  } finally {
    database.close();
  }
}
