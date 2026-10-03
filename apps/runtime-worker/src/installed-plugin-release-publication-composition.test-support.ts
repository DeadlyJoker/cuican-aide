import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import { TEST_CA_CERT } from "../../device-gateway/src/mtls-test-certificates.test-support.ts";
import {
  installedProcessActor as actor,
  installedWorkerProcessFixture,
} from "./installed-plugin-worker-process.test-support.ts";
import { prepareInstalledReleaseProcessInput } from "./installed-plugin-release-process.test-support.ts";
import { loadInstalledPluginReleaseCliInput } from "./plugins/installed-plugin-release-cli-input.ts";
import {
  createConfiguredToolRuntime,
  createModelTransport,
} from "./runtime-process-environment.ts";
import {
  resolveRuntimeBootstrapAgent,
  resolveRuntimeBootstrapRoute,
} from "./runtime-bootstrap-defaults.ts";
import { RuntimeReleaseAuthorization } from "./release-authority.ts";
import { SystemApplicationClock } from "./standalone-adapters.ts";

/** Real HTTPS metadata fixture and same on-disk/PG ledger, without model, Node setup or tool calls. */
export async function installedPublicationCompositionFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const roots = getCACertificates("default");
  setDefaultCACertificates([...roots, TEST_CA_CERT]);
  t.after(() => setDefaultCACertificates(roots));
  const fixture = await installedWorkerProcessFixture(t);
  const schema = `release_cli_lifetime_${randomUUID().replaceAll("-", "")}`;
  const admin =
    backend === "postgres"
      ? new Pool({
          connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
          max: 1,
        })
      : null;
  if (admin !== null)
    t.after(async () => {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    });
  const openStore = () =>
    backend === "postgres"
      ? PostgresDomainStore.open({
          connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
          schema,
          maxPoolSize: 2,
        })
      : Promise.resolve(new SqliteRunStore(fixture.databasePath));
  const prepared = await prepareInstalledReleaseProcessInput(
    fixture,
    undefined,
    { store: await openStore() },
  );
  const transport = createModelTransport("responses", {}, fixture.environment);
  const tools = await createConfiguredToolRuntime(fixture.environment);
  t.after(async () => {
    await tools?.close?.();
    await transport.close?.();
  });
  const bootstrap = resolveRuntimeBootstrapAgent(fixture.environment);
  const common = {
    actor,
    authorization: new RuntimeReleaseAuthorization(actor),
    clock: new SystemApplicationClock(),
    runtimeTenantId: actor.tenantId,
    route: resolveRuntimeBootstrapRoute(fixture.environment),
    transport,
    toolRuntime: tools,
    agentInstructions: bootstrap.instructions,
    streamMaxRetries: bootstrap.streamMaxRetries,
    maxToolRounds: bootstrap.maxToolRounds,
    autoCompactAtTokens: bootstrap.autoCompactAtTokens,
    modelContextWindowTokens: bootstrap.contextWindowTokens,
    nativeWorkspaceReadCatalog: "disabled" as const,
  };
  const database =
    backend === "postgres"
      ? {
          connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
          schema,
          maxPoolSize: 2,
        }
      : { databasePath: fixture.databasePath };
  const captureInput = async () => {
    const input = await loadInstalledPluginReleaseCliInput({
      environment: fixture.environment,
      actor,
      defaultAgentVersionId: common.route.agentVersionId,
    });
    assert.ok(input);
    t.after(async () => {
      await input.release.close();
      await input.authority.close();
    });
    return input;
  };
  return {
    ...fixture,
    ...prepared,
    common,
    database,
    backend,
    schema,
    openStore,
    captureInput,
  };
}
