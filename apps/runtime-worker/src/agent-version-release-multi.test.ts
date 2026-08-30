import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ModelTransportPort } from "@crewon/agent-kernel";
import { SqliteRunStore } from "@crewon/store";

import { activateStandaloneRuntimeAgentVersionRelease } from "./agent-version-release-composition.ts";
import { compileRuntimeAgentVersion } from "./agent-version-release.ts";
import { RuntimeReleaseAuthorization } from "./release-authority.ts";
import { SystemApplicationClock } from "./standalone-adapters.ts";

test("publishes and activates every independently runnable AgentVersion", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-release-multi-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "control.sqlite");
  const actor = {
    principalId: "principal-1",
    actorId: "actor-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
  };
  const config = {
    runtimeTenantId: actor.tenantId,
    route: {
      authorityId: "authority-1",
      runtimeGeneration: "runtime-1",
      agentVersionId: "executor-1",
      policySnapshotId: "policy-1",
      workspaceBindingId: null,
    },
    transport,
  };
  const verifier = compileRuntimeAgentVersion({
    ...config,
    route: { ...config.route, agentVersionId: "verifier-1" },
    agentInstructions: "Independently verify the evidence.",
  });

  const activated = await activateStandaloneRuntimeAgentVersionRelease({
    ...config,
    databasePath,
    actor,
    authorization: new RuntimeReleaseAuthorization(actor),
    clock: new SystemApplicationClock(),
    activationId: "activation-1",
    additionalAgentVersions: [verifier],
    agentVersionDeployments: [
      {
        schemaVersion: "crewon.agent-version-deployment.v0",
        tenantId: actor.tenantId,
        agentVersionId: verifier.agentVersionId,
        contentDigest: verifier.contentDigest,
        materializationDigest: `sha256:${"b".repeat(64)}`,
        authorityId: config.route.authorityId,
        workspaceBindingId: null,
      },
    ],
  });

  assert.deepEqual(
    activated.plan.versions.map((version) => version.agentVersionId),
    ["executor-1", "verifier-1"],
  );
  const store = new SqliteRunStore(databasePath);
  context.after(() => store.close());
  assert.ok(
    (await store.loadAgentVersion({
      tenantId: actor.tenantId,
      agentVersionId: verifier.agentVersionId,
    })) !== null,
  );
  assert.deepEqual(
    (
      await store.loadActiveAgentVersionRelease({ tenantId: actor.tenantId })
    )?.bundle.deployments.map((deployment) => deployment.agentVersionId),
    ["executor-1", "verifier-1"],
  );
});

test("compiles a model variant without changing its policy or tool contract", () => {
  const config = {
    runtimeTenantId: "tenant-1",
    route: {
      authorityId: "authority-1",
      runtimeGeneration: "runtime-1",
      agentVersionId: "executor-1:model-0123456789abcdef01234567",
      policySnapshotId: "policy-1",
      workspaceBindingId: null,
    },
    transport,
    modelId: "alternate-model",
  };

  const version = compileRuntimeAgentVersion(config);

  assert.deepEqual(
    {
      agentVersionId: version.agentVersionId,
      modelId: version.model.modelId,
      policySnapshotId: version.policySnapshotId,
      tools: version.tools,
    },
    {
      agentVersionId: "executor-1:model-0123456789abcdef01234567",
      modelId: "alternate-model",
      policySnapshotId: "policy-1",
      tools: [],
    },
  );
});

const transport: ModelTransportPort = {
  adapterName: "fake-adapter",
  adapterVersion: "1",
  modelId: "fake-model",
  async *stream() {
    throw new Error("unused");
  },
};
