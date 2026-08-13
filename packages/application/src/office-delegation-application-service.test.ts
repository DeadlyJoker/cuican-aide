import assert from "node:assert/strict";
import test from "node:test";

import type { OfficeDefinition, ThreadState } from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import { OfficeDelegationApplicationService } from "./office-delegation-application-service.ts";
import type {
  CommitOfficeDelegationStartInput,
  OfficeDelegationPreparation,
  OfficeDelegationStore,
} from "./office-delegation-store-port.ts";

const actor = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
} as const;
const command = {
  kind: "officeDelegation.start",
  idempotencyKey: "request-1",
  officeVersionId: "office-version-1",
  workflowVersionId: "workflow-version-1",
  threadId: "thread-1",
  input: { topic: "safe" },
} as const;
const digest =
  "sha256:7b226465736372697074696f6e223a2246697874757265222c22656e7472794e";
const definitionJson =
  '{"contentDigest":"sha256:7b226465736372697074696f6e223a2246697874757265222c22656e7472794e","description":"Fixture","entryNodeIds":["node-1"],"executionOrder":["node-1","verify-1"],"inputSchema":{"additionalProperties":false,"properties":{"topic":{"enum":null,"maxLength":32,"type":"string"}},"required":["topic"],"type":"object"},"name":"Workflow","nodes":[{"agentVersionId":"worker-version","dependsOn":[],"inputSchema":{"additionalProperties":false,"properties":{"topic":{"enum":null,"maxLength":32,"type":"string"}},"required":["topic"],"type":"object"},"instruction":"Work","kind":"agent","nodeId":"node-1","outputSchema":{"additionalProperties":false,"properties":{"topic":{"enum":null,"maxLength":32,"type":"string"}},"required":["topic"],"type":"object"},"title":"Work"},{"dependsOn":["node-1"],"inputSchema":{"additionalProperties":false,"properties":{"topic":{"enum":null,"maxLength":32,"type":"string"}},"required":["topic"],"type":"object"},"instruction":"Verify","kind":"verification","nodeId":"verify-1","outputSchema":{"additionalProperties":false,"properties":{"topic":{"enum":null,"maxLength":32,"type":"string"}},"required":["topic"],"type":"object"},"title":"Verify","verifierAgentVersionId":"verifier-version"}],"outputNodeIds":["verify-1"],"outputSchema":{"additionalProperties":false,"properties":{"topic":{"enum":null,"maxLength":32,"type":"string"}},"required":["topic"],"type":"object"},"schemaVersion":"crewon.workflow-version.v0","workflowId":"workflow-1","workflowVersionId":"workflow-version-1"}';
const office = JSON.parse(
  '{"schemaVersion":"crewon.office-definition.v0","tenantId":"tenant-1","spaceId":"space-1","officeId":"office-1","officeVersionId":"office-version-1","revision":1,"title":"Office","members":[{"memberId":"member-worker","displayName":"Worker","agentVersionId":"worker-version"},{"memberId":"member-verifier","displayName":"Verifier","agentVersionId":"verifier-version"}],"executionTargets":[{"targetId":"target-1","agentVersionId":"worker-version"}],"createdByActorId":"actor-1","createdAt":"2026-08-14T00:00:00.000Z"}',
) as OfficeDefinition;
const thread = JSON.parse(
  '{"threadId":"thread-1","tenantId":"tenant-1","spaceId":"space-1","createdByActorId":"actor-1","title":null,"status":"active","revision":1,"lastEventSequence":1,"lastMessageSequence":0,"createdAt":"2026-08-14T00:00:00.000Z","updatedAt":"2026-08-14T00:00:00.000Z","archivedAt":null,"deletedAt":null,"deletedByActorId":null,"forkedFromThreadId":null,"forkedThroughHistorySequence":null}',
) as ThreadState;

test("prepares a canonical Workflow Run after both scoped authorizations", async () => {
  const store = new RecordingStore(["worker-version", "verifier-version"]);
  const { service, actions } = harness(store);
  const result = await service.start(actor, command);
  assert.deepEqual(actions, ["office:run", "run:create"]);
  assert.deepEqual(result.delegation, store.preparation?.delegation);
  assert.deepEqual(store.preparation?.delegation.workflowVersionBinding, {
    workflowId: "workflow-1",
    workflowVersionId: "workflow-version-1",
    contentDigest: digest,
  });
  assert.equal(store.preparation?.runCommit.events[0]?.type, "run.created");
  assert.deepEqual(store.preparation?.workflowInputValue.value, {
    topic: "safe",
  });
});

test("rolls back when any Workflow AgentVersion is outside Office membership", async () => {
  const store = new RecordingStore(["worker-version"]);
  await assert.rejects(
    harness(store).service.start(actor, command),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "office_workflow_agent_not_member",
  );
  assert.equal(store.writes, 0);
});

class RecordingStore implements OfficeDelegationStore {
  preparation: OfficeDelegationPreparation | null = null;
  writes = 0;
  readonly members: readonly string[];
  constructor(members: readonly string[]) {
    this.members = members;
  }
  async commitOfficeDelegationStart(input: CommitOfficeDelegationStartInput) {
    this.preparation = input.prepare({
      ...authority(this.members),
      route: await input.resolveCandidateRoute(),
    });
    this.writes += 1;
    return {
      disposition: "committed" as const,
      delegation: this.preparation.delegation,
      run: {} as never,
    };
  }
  async listOfficeDelegations() {
    return { items: [], next: null };
  }
}

function harness(store: RecordingStore) {
  const actions: string[] = [];
  const ids = [
    "value-1",
    "scheduler-1",
    "run-1",
    "delegation-1",
    "event-1",
    "outbox-1",
    "work-1",
  ];
  return {
    actions,
    service: new OfficeDelegationApplicationService({
      store,
      authorization: {
        async authorize(request) {
          actions.push(request.action);
          return { outcome: "allow" };
        },
      },
      clock: { now: () => "2026-08-14T00:00:00.000Z" },
      ids: { nextId: () => ids.shift()! },
      digester: { sha256 },
      routeResolver: {
        async resolveRoute() {
          return authority([]).route;
        },
      },
    }),
  };
}

function authority(members: readonly string[]) {
  return {
    office: {
      ...office,
      members: office.members.filter((member) =>
        members.includes(member.agentVersionId),
      ),
    },
    workflowVersion: {
      schemaVersion: "crewon.workflow-version-asset.v0" as const,
      tenantId: actor.tenantId,
      workflowId: "workflow-1",
      workflowVersionId: command.workflowVersionId,
      contentDigest: digest,
      definitionJson,
      createdAt: "2026-08-14T00:00:00.000Z",
    },
    thread,
    route: {
      authorityId: "authority-1",
      runtimeGeneration: "ts-v0",
      agentVersionId: "root-version",
      policySnapshotId: "policy-1",
      workspaceBindingId: "workspace-1",
    },
  };
}

function sha256(value: string) {
  return `sha256:${Buffer.from(value).toString("hex").slice(0, 64).padEnd(64, "0")}`;
}
