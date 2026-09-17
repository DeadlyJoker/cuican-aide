import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import { InMemoryToolBroker } from "@crewon/tool-broker";
import {
  activateStandaloneRuntimeAgentVersionRelease,
  activatePostgresRuntimeAgentVersionRelease,
} from "./agent-version-release-composition.ts";
import {
  createStandaloneRuntimeWorker,
  createPostgresRuntimeWorker,
  type RuntimeWorkerCompositionConfig,
} from "./standalone-composition.ts";

export function compositionConfig(): RuntimeWorkerCompositionConfig {
  return {
    runtimeTenantId: "tenant-1",
    route: {
      authorityId: "authority-1",
      runtimeGeneration: "ts-v0",
      agentVersionId: "agent-version-1",
      policySnapshotId: "policy-1",
      workspaceBindingId: null,
    },
    transport: {
      adapterName: "fixture",
      adapterVersion: "1",
      modelId: "fixture-model",
      async *stream(): AsyncGenerator<never> {
        throw new Error("unexpected model call");
      },
    },
    toolRuntime: new InMemoryToolBroker(),
    agentInstructions: "stable instructions",
    streamMaxRetries: 3,
    maxToolRounds: 12,
    autoCompactAtTokens: 96000,
    modelContextWindowTokens: 128000,
    scanIntervalMs: null,
  };
}

export function compositionFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  options: {
    toolClose?: () => void | Promise<void>;
    modelClose?: () => void | Promise<void>;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "crewon-composition-"));
  const databasePath = join(root, "control.sqlite");
  const schema = `crewon_composition_${randomUUID().replaceAll("-", "_")}`;
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
  if (backend === "postgres")
    assert.ok(connectionString, "PostgreSQL test URL missing");
  const counts = { tools: 0, models: 0, stores: 0 };
  const config = compositionConfig();
  const ownedConfig = {
    ...config,
    transport: {
      ...config.transport,
      close: async () => {
        counts.models++;
        await options.modelClose?.();
      },
    },
    toolRuntime: Object.assign(config.toolRuntime!, {
      close: () => {
        counts.tools++;
        return Promise.resolve(options.toolClose?.());
      },
    }),
  };
  const authority = {
    actor: {
      principalId: "release-principal",
      actorId: "release-actor",
      tenantId: config.runtimeTenantId,
      spaceId: "release-space",
    },
    authorization: { authorize: async () => ({ outcome: "allow" as const }) },
    clock: { now: () => "2026-08-09T00:00:00Z" },
    activationId: "activation-test",
  };
  t.after(async () => {
    if (backend === "postgres") {
      const admin = new Pool({ connectionString, max: 1 });
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  function observeStoreClose() {
    if (backend === "sqlite") {
      const original = SqliteRunStore.prototype.close;
      t.mock.method(
        SqliteRunStore.prototype,
        "close",
        function (this: SqliteRunStore) {
          counts.stores++;
          return original.call(this);
        },
      );
    } else {
      const original = PostgresDomainStore.prototype.close;
      t.mock.method(
        PostgresDomainStore.prototype,
        "close",
        function (this: PostgresDomainStore) {
          counts.stores++;
          return original.call(this);
        },
      );
    }
  }
  return {
    root,
    config: ownedConfig,
    counts,
    observeStoreClose,
    activate: async (
      overrides: Partial<RuntimeWorkerCompositionConfig> = {},
    ) => {
      const release = { ...ownedConfig, ...overrides, ...authority };
      if (backend === "sqlite")
        await activateStandaloneRuntimeAgentVersionRelease({
          ...release,
          databasePath,
        });
      else
        await activatePostgresRuntimeAgentVersionRelease({
          ...release,
          connectionString: connectionString!,
          schema,
          maxPoolSize: 2,
        });
    },
    create: (
      overrides: Partial<RuntimeWorkerCompositionConfig> = {},
      storage: { failOpen?: boolean } = {},
    ) =>
      backend === "sqlite"
        ? createStandaloneRuntimeWorker({
            ...ownedConfig,
            ...overrides,
            databasePath: storage.failOpen ? root : databasePath,
          })
        : createPostgresRuntimeWorker({
            ...ownedConfig,
            ...overrides,
            connectionString: connectionString!,
            schema: storage.failOpen ? "invalid-schema" : schema,
            maxPoolSize: 2,
          }),
  };
}
