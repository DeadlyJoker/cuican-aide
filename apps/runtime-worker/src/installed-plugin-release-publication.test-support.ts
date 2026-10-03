import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import type { ModelTransportPort } from "@crewon/agent-kernel";
import type { AuthorizationPort } from "@crewon/application";
import {
  compileRuntimeAgentVersionRelease,
  type RuntimeAgentVersionReleaseConfig,
} from "./agent-version-release.ts";
import { loadInstalledPluginRelease } from "./plugins/installed-plugin-release-loader.ts";
import { createInstalledPluginReleasePublication } from "./plugins/installed-plugin-release-publication.ts";
import {
  installedReleaseFixture,
  releaseActor,
  timestamp,
} from "./installed-plugin-release-loader.test-support.ts";

/** Named metadata-only fixture transport: publication must never request a model or execute a tool. */
const transport: ModelTransportPort = {
  adapterName: "direct-responses",
  adapterVersion: "1",
  modelId: "publication-original-default-model",
  async *stream() {
    throw new Error("publication_model_must_not_run");
  },
};

export async function publicationFixture(
  t: TestContext,
  backend: "sqlite" | "postgres" = "sqlite",
) {
  const fixture = await installedReleaseFixture(t, backend);
  const document = structuredClone(fixture.document);
  Reflect.set(document, "defaultAgentVersionId", "publication-bootstrap-agent");
  const release = await loadInstalledPluginRelease({
    ...fixture.loaderInput,
    document,
  });
  fixture.own(release);
  const config: RuntimeAgentVersionReleaseConfig = {
    runtimeTenantId: releaseActor.tenantId,
    route: {
      authorityId: "publication-bootstrap-authority",
      agentVersionId: document.defaultAgentVersionId,
      runtimeGeneration: "publication-bootstrap-generation",
      policySnapshotId: "publication-bootstrap-policy",
      workspaceBindingId: null,
    },
    agentInstructions: "Keep the unchanged bootstrap independently runnable.",
    transport,
    additionalAgentVersions: release.versions,
    agentVersionDeployments: [fixture.baseDeployment, ...release.deployments],
  };
  const runtimePlan = compileRuntimeAgentVersionRelease(config);
  const state = {
    requests: [] as Parameters<AuthorizationPort["authorize"]>[0][],
    decision: "allow" as "allow" | "deny",
    onAuthorization: null as
      | null
      | ((
          request: Parameters<AuthorizationPort["authorize"]>[0],
        ) => Promise<void>),
  };
  const authorization: AuthorizationPort = {
    async authorize(request) {
      assert.deepEqual(request.actor, releaseActor);
      assert.ok(
        ["agentVersion:publish", "agentVersion:deploy"].includes(
          request.action,
        ),
      );
      state.requests.push(request);
      await state.onAuthorization?.(request);
      return state.decision === "allow"
        ? { outcome: "allow" }
        : { outcome: "deny", reasonCode: "publication_fixture_denied" };
    },
  };
  const dependencies = {
    release,
    runtimePlan,
    store: fixture.store,
    authorization,
    clock: { now: () => timestamp },
  };
  const publisher = createInstalledPluginReleasePublication(dependencies);
  fixture.own(publisher);
  return {
    ...fixture,
    release,
    config,
    runtimePlan,
    dependencies,
    publisher,
    authorization,
    publicationState: state,
    backend,
  };
}

/** Counts the actual transaction ledger through a second real connection, never a Store double. */
export async function publicationActivationCount(
  fixture: Awaited<ReturnType<typeof publicationFixture>>,
): Promise<number> {
  if (fixture.backend === "sqlite") {
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      return Number(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM agent_version_release_activations",
          )
          .get()!.count,
      );
    } finally {
      database.close();
    }
  }
  const pool = new Pool({
    connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
    max: 1,
  });
  try {
    const result = await pool.query(
      `SELECT COUNT(*) AS count FROM "${fixture.schema}".agent_version_release_activations`,
    );
    return Number(result.rows[0].count);
  } finally {
    await pool.end();
  }
}
