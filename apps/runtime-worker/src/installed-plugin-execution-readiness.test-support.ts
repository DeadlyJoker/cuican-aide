import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { createExtensionConfiguration } from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import { installedPluginAgentRuntimeTarget } from "./plugins/installed-plugin-agent-runtime-factory.ts";
import { InstalledPluginExecutionReadinessOwner } from "./plugins/installed-plugin-execution-readiness.ts";
import type { InstalledPluginExecutionIoConfig } from "./plugins/installed-plugin-execution-io-config.ts";
import type { InstalledPluginExecutionReadinessInput } from "./plugins/installed-plugin-execution-readiness-types.ts";
import {
  factoryFixture,
  digester,
  scope,
} from "./installed-plugin-agent-runtime-factory.test-support.ts";
export { gate } from "./installed-plugin-extension-host.test-support.ts";

export const approval = {
  baseUrlParameter: "baseUrl",
  paths: [
    { method: "POST" as const, path: "/prompt" },
    { method: "GET" as const, operationPathPrefix: "/history/" },
  ],
};
/** Independent metadata-validation tests: no synthetic Run is created and no input grants execution authority. */
export async function readinessFixture(t: TestContext) {
  const f = await factoryFixture(t);
  const directory = await mkdtemp(join(tmpdir(), "crewon-io-readiness-"));
  const store = new SqliteRunStore(join(directory, "control.sqlite"));
  const operations = store.externalOperationStore();
  await operations.migrate();
  const configuration = createExtensionConfiguration(
    {
      ...f.entry.configuration,
      parameters: { baseUrl: "https://readiness-fixture.example/" },
    },
    digester,
  );
  const target = installedPluginAgentRuntimeTarget({
    defaultAgentVersionId: f.entry.base.version.agentVersionId,
    entry: f.entry,
  });
  const input: InstalledPluginExecutionReadinessInput = {
    metadata: {
      identity: f.entry.registration.identity,
      scope,
      configuration,
      target,
      purpose: "submit",
    },
    requiredServices: ["externalOperations", "jsonHttp"],
  };
  const state = {
    preflights: 0,
    dns: 0,
    http: 0,
    dispatchResolution: 0,
    allowed: true,
    address: "8.8.8.8",
  };
  const config: InstalledPluginExecutionIoConfig = {
    async resolveNetwork() {
      state.dispatchResolution++;
      throw new Error("no_run_dispatch_during_readiness");
    },
    async resolveReadinessNetwork(metadata, signal) {
      signal.throwIfAborted();
      state.preflights++;
      assert.deepEqual(metadata, input.metadata);
      assert.equal(Object.hasOwn(metadata, "run"), false);
      assert.equal(Object.hasOwn(metadata, "command"), false);
      return state.allowed ? approval : null;
    },
    dns: {
      async resolveAll(hostname) {
        assert.equal(hostname, "readiness-fixture.example");
        state.dns++;
        return [{ address: state.address, family: 4 }];
      },
    },
    transport: {
      async request() {
        state.http++;
        throw new Error("readiness_must_not_dispatch");
      },
    },
  };
  const owners: InstalledPluginExecutionReadinessOwner[] = [];
  function owner(
    overrides: Partial<
      ConstructorParameters<typeof InstalledPluginExecutionReadinessOwner>[0]
    > = {},
  ) {
    const value = new InstalledPluginExecutionReadinessOwner({
      configuration: config,
      operations,
      ...overrides,
    });
    owners.push(value);
    return value;
  }
  t.after(async () => {
    for (const value of owners) await value.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { ...f, input, store, operations, config, state, owner };
}
