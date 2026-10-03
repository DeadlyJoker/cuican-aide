import assert from "node:assert/strict";
import test from "node:test";

import {
  createProductionPostgresControlApi,
  type ProductionPostgresControlApiConfig,
} from "./production-composition.ts";
import { parseProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import { parseProductionPluginInstallationConfiguration } from "./production-plugin-installation-environment.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import { pluginUiProductionIdentity } from "./production-plugin-ui.test-support.ts";
import { PostgresDomainStore } from "@crewon/store";

test("production composition rejects missing security authorities before opening PostgreSQL", async () => {
  const base = {
    connectionString: "not-a-postgres-connection",
    artifactStore: { close() {} },
    artifactEncryptionKeyId: "key-1",
  };
  await assert.rejects(
    createProductionPostgresControlApi({
      ...base,
      identity: null,
      authorization: {
        async authorize() {
          return { outcome: "allow" };
        },
      },
    } as unknown as ProductionPostgresControlApiConfig),
    /production_identity_required/u,
  );
  await assert.rejects(
    createProductionPostgresControlApi({
      ...base,
      identity: {
        async resolveActor() {
          throw new Error("unused");
        },
      },
      authorization: null,
    } as unknown as ProductionPostgresControlApiConfig),
    /production_authorization_required/u,
  );
  await assert.rejects(
    createProductionPostgresControlApi({
      ...base,
      identity: {
        async resolveActor() {
          throw new Error("unused");
        },
      },
      authorization: {
        async authorize() {
          return { outcome: "allow" };
        },
      },
      providerProbeWorkers: {},
    } as unknown as ProductionPostgresControlApiConfig),
    /production_provider_probe_registry_invalid/u,
  );
});

test("production UI requires the actual production identity before PostgreSQL can open", async () => {
  const configuration = parseProductionPluginUiConfiguration({
    installRoot: "/private/plugins",
    profileAuthority: {
      url: "https://authority.example/profile",
      serviceToken: "p".repeat(32),
    },
    policyAuthority: {
      url: "https://authority.example/policy",
      serviceToken: "s".repeat(32),
    },
    publications: [],
    timeoutMs: 2000,
  });
  await assert.rejects(
    createProductionPostgresControlApi({
      connectionString: "not-a-postgres-connection",
      artifactStore: { close() {} },
      artifactEncryptionKeyId: "key-1",
      identity: {
        resolveActor: async () => ({
          tenantId: "invented",
          spaceId: "invented",
          principalId: "invented",
          actorId: "invented",
        }),
      },
      authorization: { authorize: async () => ({ outcome: "allow" }) },
      pluginUi: { configuration },
    } as unknown as ProductionPostgresControlApiConfig),
    /production_plugin_ui_identity_required/u,
  );
});

test("production installation requires verified request identity and exact private source bytes before PostgreSQL can open", async (t) => {
  const f = await productionSourceFixture(t);
  const source = await f.source();
  const configuration = parseProductionPluginInstallationConfiguration(
    f.configuration([source]),
  );
  let opened = 0;
  t.mock.method(PostgresDomainStore, "open", async () => {
    opened++;
    throw new Error("unexpected_database_open");
  });
  const base = {
    connectionString: "not-a-postgres-connection",
    artifactStore: { close() {} },
    artifactEncryptionKeyId: "key-1",
    authorization: { authorize: async () => ({ outcome: "allow" as const }) },
  };
  await assert.rejects(
    createProductionPostgresControlApi({
      ...base,
      identity: {
        resolveActor: async () => ({
          tenantId: "invented",
          spaceId: "invented",
          principalId: "invented",
          actorId: "invented",
        }),
      },
      pluginInstallation: { configuration },
    } as unknown as ProductionPostgresControlApiConfig),
    /production_plugin_installation_identity_required/u,
  );
  const identity = pluginUiProductionIdentity().identity;
  await assert.rejects(
    createProductionPostgresControlApi({
      ...base,
      identity,
      pluginInstallation: {
        configuration: {
          ...configuration,
          sources: [
            {
              ...configuration.sources[0]!,
              packageDigest: `sha256:${"f".repeat(64)}`,
            },
          ],
        },
      },
    } as unknown as ProductionPostgresControlApiConfig),
    /production_plugin_source_identity_mismatch/u,
  );
  await assert.rejects(
    createProductionPostgresControlApi({
      ...base,
      identity,
      pluginInstallation: { configuration },
      pluginUi: {
        configuration: parseProductionPluginUiConfiguration({
          installRoot: "/private/other-installed",
          profileAuthority: configuration.profileAuthority,
          policyAuthority: configuration.policyAuthority,
          timeoutMs: configuration.timeoutMs,
          publications: [],
        }),
      },
    } as unknown as ProductionPostgresControlApiConfig),
    /production_plugin_install_root_mismatch/u,
  );
  assert.equal(opened, 0);
});
