import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { PostgresDomainStore } from "@crewon/store";
import { installLocalPluginPackage } from "@crewon/plugin-host";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import { pluginUiProductionIdentity } from "./production-plugin-ui.test-support.ts";
import { parseInstalledPluginTaskConfiguration } from "./installed-plugin-task-environment.ts";
import { parseProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import { createInstalledPluginTaskRuntime } from "./installed-plugin-task-composition.ts";
import { assertInstalledPluginTaskRuntimeCoreBinding } from "./installed-plugin-task-runtime-core.ts";

test(
  "original production TaskCore accepts full validated UI publications without allocating media or calling authority",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 25_000 },
  async (t) => {
    const schema = `task_composition_${randomUUID().replaceAll("-", "")}`;
    let store: PostgresDomainStore | undefined;
    let runtime:
      | Awaited<ReturnType<typeof createInstalledPluginTaskRuntime>>
      | undefined;
    const observer = new Pool({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
      max: 1,
    });
    const f = await productionSourceFixture(t, {
      beforeCleanup: async () => {
        try {
          await runtime?.close();
          await store?.close();
        } finally {
          try {
            await observer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          } finally {
            await observer.end();
          }
        }
      },
    });
    // Actual installed immutable UI bytes. No Node entry or supplier execution is enabled.
    const source = await f.source("production-ui-publication", {
      uiOnly: true,
    });
    const installed = await installLocalPluginPackage({
      directory: source.directory,
      installRoot: f.installRoot,
      authorization: async () => ({ outcome: "allow" }),
    });
    const configuration = parseInstalledPluginTaskConfiguration(
      {
        schemaVersion: "crewon.installed-plugin-control-tasks.v1",
        installRoot: f.installRoot,
        peer: {
          origin: "http://127.0.0.1:3299",
          tokenEnvironmentVariable: "NAMED_TASK_PEER_TOKEN",
        },
        packageAuthority: {
          url: "https://named-authority.example/package",
          serviceTokenEnvironmentVariable: "NAMED_TASK_AUTHORITY_TOKEN",
        },
        quoteAuthority: {
          url: "https://named-authority.example/quote",
          serviceTokenEnvironmentVariable: "NAMED_TASK_AUTHORITY_TOKEN",
        },
        timeoutMs: 2_000,
        maximumPackages: 32,
      },
      {
        NAMED_TASK_PEER_TOKEN: "named-offline-peer-" + "p".repeat(32),
        NAMED_TASK_AUTHORITY_TOKEN: "named-offline-authority-" + "s".repeat(32),
      },
    );
    const publication = {
      pluginId: installed.descriptor.pluginId,
      publisherId: installed.descriptor.publisherId,
      packageDigest: installed.packageDigest,
      publicAssets: ["ui.mjs"],
    };
    const uiConfiguration = parseProductionPluginUiConfiguration({
      installRoot: f.installRoot,
      profileAuthority: {
        url: "https://named-authority.example/profile",
        serviceToken: "named-offline-profile-" + "p".repeat(32),
      },
      policyAuthority: {
        url: "https://named-authority.example/policy",
        serviceToken: "named-offline-policy-" + "p".repeat(32),
      },
      publications: [publication],
      timeoutMs: 2_000,
    });
    store = await PostgresDomainStore.open({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
      schema,
      maxPoolSize: 3,
    });
    let authorityCalls = 0;
    runtime = await createInstalledPluginTaskRuntime(
      { configuration, uiConfiguration },
      {
        store,
        identity: pluginUiProductionIdentity().identity,
        authorization: {
          authorize: async () => ({
            outcome: "deny",
            reasonCode: "named_composition_has_no_business_permission",
          }),
        },
        clock: { now: () => new Date().toISOString() },
        ids: { nextId: () => randomUUID() },
        digester: {
          sha256: (bytes) =>
            `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        },
        fetch: async () => {
          authorityCalls++;
          throw new Error("metadata_composition_must_not_request_authority");
        },
      },
    );
    assertInstalledPluginTaskRuntimeCoreBinding(runtime, {
      store,
      requests: runtime.requests,
    });
    assert.equal(runtime.projectMediaInputs, undefined);
    assert.deepEqual(uiConfiguration.publications, [publication]);
    assert.equal(authorityCalls, 0);
    await runtime.close();
    assert.throws(() =>
      assertInstalledPluginTaskRuntimeCoreBinding(runtime, {
        store: store!,
        requests: runtime!.requests,
      }),
    );
    // Runtime borrows the parent; it cannot close the ordinary production Run database.
    assert.equal(
      await store.loadThreadInSpace({
        tenantId: "named-composition-tenant",
        spaceId: "named-composition-space",
        threadId: "named-missing-thread",
      }),
      null,
    );
    assert.equal(authorityCalls, 0);
  },
);
