import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  AutomationApplicationService,
  type AutomationStore,
  type AutomationDefinitionRecord,
  type AutomationListCursor,
} from "@crewon/application";
import { stableJson } from "./store-invariants.ts";
import { automationCreateCommand } from "./automation-store-conformance.test-support.ts";

export function scheduleRecord(
  base: AutomationDefinitionRecord,
  index: number,
): AutomationDefinitionRecord {
  const occurredAt = new Date(
    Date.parse("2026-08-10T00:00:00Z") + Math.floor(index / 10) * 1000,
  ).toISOString();
  const definition = {
    ...base.definition,
    automationId: `schedule-${String(index).padStart(6, "0")}`,
    executionMode:
      index % 3 === 0 ? ("manualOnly" as const) : ("scheduled" as const),
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
  return {
    definition,
    definitionDigest: `sha256:${createHash("sha256").update(stableJson(definition)).digest("hex")}`,
  };
}

export function scheduleCursor(
  record: AutomationDefinitionRecord,
): AutomationListCursor {
  return {
    automationId: record.definition.automationId,
    updatedAt: record.definition.updatedAt,
  };
}

export function expectedScheduledPage(
  records: readonly AutomationDefinitionRecord[],
  before: AutomationListCursor | null,
  limit: number,
): readonly AutomationDefinitionRecord[] {
  return records
    .filter(
      ({ definition: item }) =>
        item.executionMode === "scheduled" &&
        (before === null ||
          item.updatedAt < before.updatedAt ||
          (item.updatedAt === before.updatedAt &&
            item.automationId < before.automationId)),
    )
    .sort((a, b) => {
      const left = a.definition;
      const right = b.definition;
      if (left.updatedAt !== right.updatedAt)
        return left.updatedAt < right.updatedAt ? 1 : -1;
      return left.automationId < right.automationId
        ? 1
        : left.automationId === right.automationId
          ? 0
          : -1;
    })
    .slice(0, limit);
}

export const automationActor = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  principalId: "principal-1",
  actorId: "actor-1",
};

export const invalidScheduleQueries = [
  { before: null, limit: 0 },
  { before: null, limit: 101 },
  { before: { updatedAt: "invalid", automationId: "schedule-1" }, limit: 1 },
  { before: { updatedAt: "2026-08-10T00:00:00Z", automationId: "" }, limit: 1 },
  { before: null, limit: 1, tenantId: "injected" },
] as const;

export async function assertScheduledInsertionOrder(
  store: AutomationStore,
): Promise<void> {
  const identifiers = [
    "jobZ",
    "jobz",
    "job_a",
    "job-a",
    "jobA",
    "joba",
    "job_zzz",
  ];
  let index = 0;
  const service = new AutomationApplicationService({
    store,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-08-09T00:00:00Z" },
    ids: {
      nextId: (kind) => {
        assert.equal(kind, "automation");
        return identifiers[index++]!;
      },
    },
    digester: {
      sha256: (value) =>
        `sha256:${createHash("sha256").update(value).digest("hex")}`,
    },
    routeResolver: {
      resolveRoute: async () => ({
        authorityId: "authority-1",
        runtimeGeneration: "generation-1",
        agentVersionId: "agent-version-1",
        policySnapshotId: "policy-1",
        workspaceBindingId: null,
      }),
    },
  });
  const create = async (number: number) => {
    const command = {
      ...automationCreateCommand(),
      idempotencyKey: `create-${number}`,
      executionMode: "scheduled" as const,
    };
    const result = await service.createAutomation(automationActor, command);
    assert.deepEqual(await service.createAutomation(automationActor, command), {
      ...result,
      disposition: "replayed",
    });
  };
  for (let number = 0; number < 6; number += 1) await create(number);
  const first = await store.listScheduledAutomations({
    before: null,
    limit: 2,
  });
  const cursor = scheduleCursor(first.at(-1)!);
  await create(6);
  const remaining = await store.listScheduledAutomations({
    before: cursor,
    limit: 100,
  });
  assert.deepEqual(
    remaining.map(({ definition }) => definition.automationId),
    identifiers
      .filter((id) => id < cursor.automationId)
      .sort()
      .reverse(),
  );
  assert.deepEqual(
    (await store.listScheduledAutomations({ before: null, limit: 100 })).map(
      ({ definition }) => definition.automationId,
    ),
    [...identifiers].sort().reverse(),
  );
  assert.equal(index, 7);
}
