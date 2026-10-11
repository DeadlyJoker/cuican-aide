import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { Client } from "pg";
import { ExtensionTaskApplicationService } from "@crewon/application";
import { parsePluginTaskAdmissionPin } from "@crewon/domain";
import {
  actor,
  activateCommand,
  configurationServiceFixture,
  saveCommand,
} from "./extension-configuration-service.test-support.ts";
import { scope } from "./extension-store.test-support.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "./plugin-installation-store.test-support.ts";

export async function pluginTaskCommitFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const f = await configurationServiceFixture(t, backend, { maxPoolSize: 1 });
  await f.seedDeployment();
  await f.service.saveConfiguration(actor, saveCommand);
  await f.service.setActivation(actor, activateCommand);
  const threadId = "active-fence-thread";
  await seedThread(f.first.parent, { ...actor, threadId });
  const profile = {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    profileId: "active-fence-profile",
  };
  const installations = f.first.parent.pluginInstallationStore();
  await installations.migrate();
  const recipe = installationRecipe("active-fence-install", {
    actor,
    scope: profile,
    pluginId: scope.pluginId,
  });
  const installed = await installations.recordInstalledPackage(recipe);
  const enabled = await installations.commitSelection(
    selectionRecipe(installed.selection, "active-fence-enable", { actor }),
  );
  await f.first.store.migrateCredits();
  await f.first.store.migratePluginAdmissions();
  const creditScope = {
    tenantId: actor.tenantId,
    principalId: actor.principalId,
    poolId: "active-fence-pool",
  };
  await f.first.parent.pluginCreditStore().grant({
    scope: creditScope,
    grantId: "active-fence-funding",
    credits: "100",
  });
  const pin = parsePluginTaskAdmissionPin({
    ...profile,
    ...actor,
    pluginId: scope.pluginId,
    publisherId: recipe.package.publisherId,
    version: recipe.package.version,
    packageDigest: recipe.package.packageDigest,
    selectionRevision: enabled.selection.revision,
    contributionId: "workbench",
    action: "image.generate",
    authorityEpoch: "active-fence-epoch",
  });
  const service = new ExtensionTaskApplicationService({
    ...f.dependencies,
    store: f.first.parent,
    extensions: f.first.store,
    operations: f.operations,
    ids: { nextId: () => randomUUID() },
    creditQuotes: {
      async quoteGeneration() {
        return {
          poolId: creditScope.poolId,
          priceRevision: 1,
          quotedCredits: "7",
        };
      },
    },
  });
  const command = {
    pluginId: scope.pluginId,
    threadId,
    expectedThreadRevision: 1,
    idempotencyKey: "active-fence-generate",
    intent: {
      kind: "generate" as const,
      input: { prompt: "A real original Turn" },
    },
  };
  return { ...f, actor, pin, service, command, creditScope };
}

/** A real SQL operation completes before the Host withdraws; this is not a prepared grant. */
export function withdrawAfterActualInsert(
  backend: "sqlite" | "postgres",
  table: string,
  withdraw: () => void,
) {
  let inserted = 0;
  const matches = (sql: unknown) =>
    typeof sql === "string" &&
    new RegExp(
      `INSERT\\s+INTO\\s+(?:"[^" ]+"\\.)?"?${table}"?\\s*\\(`,
      "iu",
    ).test(sql);
  if (backend === "sqlite") {
    const original = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (sql) {
      const statement = original.call(this, sql);
      if (!matches(sql)) return statement;
      return new Proxy(statement, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (key === "run")
            return (...args: unknown[]) => {
              const result = Reflect.apply(value, target, args);
              inserted++;
              withdraw();
              return result;
            };
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    return {
      inserted: () => inserted,
      restore() {
        DatabaseSync.prototype.prepare = original;
      },
    };
  }
  const original = Client.prototype.query;
  Client.prototype.query = function (this: Client, ...args: unknown[]) {
    const result = Reflect.apply(original, this, args);
    if (!matches(args[0])) return result;
    return Promise.resolve(result).then((value) => {
      inserted++;
      withdraw();
      return value;
    });
  } as typeof Client.prototype.query;
  return {
    inserted: () => inserted,
    restore() {
      Client.prototype.query = original;
    },
  };
}

export const authorityTables = [
  "messages",
  "model_history_items",
  "run_snapshots",
  "extension_run_bindings",
  "plugin_task_admissions",
  "plugin_query_task_admissions",
  "extension_credit_admissions",
  "plugin_credit_reservations",
  "outbox",
  "work_items",
];
export async function authorityCounts(
  count: (table: string) => Promise<number>,
) {
  return Object.fromEntries(
    await Promise.all(
      authorityTables.map(async (table) => [table, await count(table)]),
    ),
  );
}
export function liveHostAuthority(
  actor: typeof import("./extension-configuration-service.test-support.ts").actor,
  pin: ReturnType<typeof parsePluginTaskAdmissionPin>,
) {
  let live = true;
  let activeCalls = 0;
  return {
    port: {
      async assertCurrent() {},
      assertActive(input: { actor: typeof actor; pin: typeof pin }) {
        activeCalls++;
        assert.deepEqual(input, { actor, pin });
        if (!live) throw new Error("fixture_host_instance_withdrawn");
      },
    },
    withdraw() {
      live = false;
    },
    activeCalls: () => activeCalls,
  };
}
export function withdrawn(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === "fixture_host_instance_withdrawn" ||
      withdrawn(error.cause))
  );
}
