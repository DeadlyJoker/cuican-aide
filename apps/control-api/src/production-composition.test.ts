import assert from "node:assert/strict";
import test from "node:test";

import {
  createProductionPostgresControlApi,
  type ProductionPostgresControlApiConfig,
} from "./production-composition.ts";
import { parseProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";

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
