import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { WorkflowVersionSource } from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type {
  AgentVersionAsset,
  AgentVersionStore,
} from "./agent-version-store-port.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import { RunStoreError } from "./run-store-port.ts";
import { WorkflowVersionApplicationService } from "./workflow-version-application-service.ts";
import type {
  WorkflowVersionAsset,
  WorkflowVersionStore,
} from "./workflow-version-store-port.ts";

const actor: ActorContext = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
};
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};

test("publishes after resolving referenced AgentVersions and scopes get/list", async () => {
  const agents = new FakeAgentVersions([
    agent("tenant-1", "agent-1"),
    agent("tenant-1", "agent-2"),
  ]);
  const store = new FakeWorkflowVersions();
  const requests: Parameters<AuthorizationPort["authorize"]>[0][] = [];
  const service = createService({
    agents,
    store,
    authorization: {
      authorize: async (request) => {
        requests.push(structuredClone(request));
        return { outcome: "allow" };
      },
    },
  });

  const published = await service.publish(actor, source());
  assert.equal(published.disposition, "registered");
  assert.equal(published.asset.tenantId, "tenant-1");
  assert.deepEqual(agents.loads, [
    { tenantId: "tenant-1", agentVersionId: "agent-1" },
    { tenantId: "tenant-1", agentVersionId: "agent-2" },
  ]);
  assert.deepEqual(
    await service.get(actor, "workflow-version-1"),
    published.asset,
  );
  assert.deepEqual(
    await service.list(actor, {
      workflowId: "workflow-1",
      after: null,
      limit: 10,
    }),
    [published.asset],
  );
  assert.deepEqual(
    requests.map(({ action }) => action),
    ["workflowVersion:publish", "workflowVersion:read", "workflowVersion:list"],
  );
  assert.equal(
    await store.loadWorkflowVersion({
      tenantId: "tenant-2",
      workflowVersionId: "workflow-version-1",
    }),
    null,
  );
});

test("rejects missing cross-tenant AgentVersion authority", async () => {
  const service = createService({
    agents: new FakeAgentVersions([agent("tenant-2", "agent-1")]),
  });
  await assert.rejects(
    service.publish(actor, source()),
    hasError("validation", "workflow_agent_version_not_found"),
  );
});

test("validates actor and malformed source without leaking domain errors", async () => {
  const service = createService();
  await assert.rejects(
    service.publish({ ...actor, actorId: "" }, source()),
    hasError("validation", "actor_invalid"),
  );
  await assert.rejects(
    service.publish(actor, null as never),
    hasError("validation", "workflow_source_invalid"),
  );
});

test("normalizes authorization deny and adapter failure", async () => {
  const denied = createService({
    authorization: {
      authorize: async () => ({ outcome: "deny", reasonCode: "no" }),
    },
  });
  await assert.rejects(
    denied.publish(actor, source()),
    hasError("authorization", "authorization_denied"),
  );
  const unavailable = createService({
    authorization: {
      authorize: async () => {
        throw new Error("secret adapter detail");
      },
    },
  });
  await assert.rejects(
    unavailable.get(actor, "workflow-version-1"),
    hasError("authorization", "authorization_unavailable"),
  );
});

test("maps Store conflicts, validation, corruption and operational errors", async () => {
  const store = new FakeWorkflowVersions();
  const service = createService({ store });
  store.error = new RunStoreError("workflow_version_id_conflict");
  await assert.rejects(
    service.publish(actor, source()),
    hasError("conflict", "workflow_version_id_conflict"),
  );
  store.error = new RunStoreError("workflow_version_locator_invalid");
  await assert.rejects(
    service.get(actor, "bad"),
    hasError("validation", "workflow_version_locator_invalid"),
  );
  store.error = new RunStoreError("workflow_version_store_corrupt");
  await assert.rejects(
    service.get(actor, "workflow-version-1"),
    hasError("internal", "workflow_version_store_corrupt"),
  );
  store.error = new RunStoreError("postgres_error");
  await assert.rejects(
    service.list(actor, { workflowId: "workflow-1", after: null, limit: 10 }),
    hasError("internal", "postgres_error"),
  );
});

function createService(
  input: {
    agents?: AgentVersionStore;
    store?: FakeWorkflowVersions;
    authorization?: AuthorizationPort;
  } = {},
) {
  return new WorkflowVersionApplicationService({
    agentVersions:
      input.agents ??
      new FakeAgentVersions([
        agent("tenant-1", "agent-1"),
        agent("tenant-1", "agent-2"),
      ]),
    store: input.store ?? new FakeWorkflowVersions(),
    authorization: input.authorization ?? {
      authorize: async () => ({ outcome: "allow" }),
    },
    digester,
    now: () => "2026-08-12T00:00:00.000Z",
  });
}

class FakeWorkflowVersions implements WorkflowVersionStore {
  readonly assets = new Map<string, WorkflowVersionAsset>();
  error: RunStoreError | null = null;
  async registerWorkflowVersion(asset: WorkflowVersionAsset) {
    if (this.error) throw this.error;
    this.assets.set(
      `${asset.tenantId}:${asset.workflowVersionId}`,
      structuredClone(asset),
    );
    return {
      disposition: "registered" as const,
      asset: structuredClone(asset),
    };
  }
  async loadWorkflowVersion(input: {
    tenantId: string;
    workflowVersionId: string;
  }) {
    if (this.error) throw this.error;
    return structuredClone(
      this.assets.get(`${input.tenantId}:${input.workflowVersionId}`) ?? null,
    );
  }
  async listWorkflowVersions(input: { tenantId: string; workflowId: string }) {
    if (this.error) throw this.error;
    return [...this.assets.values()]
      .filter(
        (asset) =>
          asset.tenantId === input.tenantId &&
          asset.workflowId === input.workflowId,
      )
      .map((asset) => structuredClone(asset));
  }
}

class FakeAgentVersions implements AgentVersionStore {
  readonly assets: AgentVersionAsset[];
  readonly loads: { tenantId: string; agentVersionId: string }[] = [];
  constructor(assets: AgentVersionAsset[]) {
    this.assets = assets;
  }
  async loadAgentVersion(input: { tenantId: string; agentVersionId: string }) {
    this.loads.push(structuredClone(input));
    return (
      this.assets.find(
        (asset) =>
          asset.tenantId === input.tenantId &&
          asset.agentVersionId === input.agentVersionId,
      ) ?? null
    );
  }
  async registerAgentVersion(asset: AgentVersionAsset) {
    return { disposition: "existing" as const, asset };
  }
  async listAgentVersions(): Promise<readonly AgentVersionAsset[]> {
    return [];
  }
}

function agent(tenantId: string, agentVersionId: string): AgentVersionAsset {
  return {
    schemaVersion: "crewon.agent-version-asset.v0",
    tenantId,
    agentVersionId,
    contentDigest: `sha256:${"a".repeat(64)}`,
    definitionJson: "{}",
    createdAt: "2026-08-12T00:00:00.000Z",
  };
}
function source(): WorkflowVersionSource {
  const schema = {
    type: "object" as const,
    properties: {},
    required: [],
    additionalProperties: false as const,
  };
  return {
    schemaVersion: "crewon.workflow-version-source.v0",
    workflowId: "workflow-1",
    workflowVersionId: "workflow-version-1",
    name: "workflow",
    description: "workflow",
    inputSchema: schema,
    outputSchema: schema,
    entryNodeIds: ["agent"],
    outputNodeIds: ["verify"],
    nodes: [
      {
        nodeId: "agent",
        title: "agent",
        instruction: "run",
        dependsOn: [],
        inputSchema: schema,
        outputSchema: schema,
        kind: "agent",
        agentVersionId: "agent-1",
      },
      {
        nodeId: "verify",
        title: "verify",
        instruction: "verify",
        dependsOn: ["agent"],
        inputSchema: schema,
        outputSchema: schema,
        kind: "verification",
        verifierAgentVersionId: "agent-2",
      },
    ],
  };
}
function hasError(category: ApplicationError["category"], code: string) {
  return (error: unknown) =>
    error instanceof ApplicationError &&
    error.category === category &&
    error.code === code;
}
