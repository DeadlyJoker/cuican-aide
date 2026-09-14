import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";

import {
  canonicalJson,
  type AutomationDefinitionRecord,
  type AutomationStore,
} from "@crewon/application";
import { createSkillVersion, parseAutomationDefinition } from "@crewon/domain";

import {
  InMemoryAutomationAuthority,
  type InMemoryAutomationState,
} from "./in-memory-automation-authority.ts";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { seedAutomationThread } from "./automation-store-conformance.test-support.ts";

type Backend = "memory" | "sqlite" | "postgres";
type Reader = Pick<
  AutomationStore,
  "listAutomations" | "listScheduledAutomations"
>;

for (const backend of ["memory", "sqlite", "postgres"] as const) {
  test(
    `F04-R01 ${backend}: legacy version filtering precedes page limit and preserves mixed-version cursor order`,
    {
      skip:
        backend === "postgres" &&
        process.env.CREWON_TEST_POSTGRES_URL === undefined,
    },
    async (context) => {
      const records = mixedDefinitions();
      const store = await fixture(context, backend, records);
      const query = {
        tenantId: "tenant-1",
        spaceId: "space-1",
        before: null,
        limit: 2,
      };
      const compatible = {
        ...query,
        definitionSchemaVersion: "crewon.automation.v0" as const,
      };
      // Both newest rows are v1: filtering after LIMIT would return an empty page.
      assert.deepEqual(
        (await store.listAutomations(query)).map(
          ({ definition }) => definition.automationId,
        ),
        ["automation-07", "automation-06"],
      );
      const first = await store.listAutomations(compatible);
      assert.deepEqual(
        first.map(({ definition }) => definition.automationId),
        ["automation-05", "automation-03"],
      );
      const last = first.at(-1)!.definition;
      const second = await store.listAutomations({
        ...compatible,
        before: { automationId: last.automationId, updatedAt: last.updatedAt },
      });
      assert.deepEqual(
        second.map(({ definition }) => definition.automationId),
        ["automation-01"],
      );
      const end = second[0]!.definition;
      assert.deepEqual(
        await store.listAutomations({
          ...compatible,
          before: { automationId: end.automationId, updatedAt: end.updatedAt },
        }),
        [],
      );
      assert.deepEqual(
        [...first, ...second],
        records
          .filter(
            ({ definition }) =>
              definition.schemaVersion === "crewon.automation.v0",
          )
          .reverse(),
      );
      assert.equal(
        (await store.listAutomations({ ...query, limit: 100 })).length,
        7,
      );
      // The scheduler still receives every scheduled schema through its own query.
      assert.equal(
        (await store.listScheduledAutomations({ before: null, limit: 100 }))
          .length,
        7,
      );
    },
  );
}

function mixedDefinitions(): AutomationDefinitionRecord[] {
  const version = createSkillVersion(
    {
      skillId: "pagination-skill",
      versionId: "v1",
      method: {
        name: "Report",
        purpose: "Summarize the selected project",
        steps: ["Read status and report progress"],
        parameters: [],
        requiredToolRefs: [],
        completionCriteria: ["Report contains current status"],
        knownExceptions: ["Missing status is reported explicitly"],
        runtimeRequirements: [],
      },
      source: {
        recordingId: "pagination-fixture",
        revision: 1,
        contentDigest: sha256("pagination contract fixture"),
        provenance: "contract-fixture",
      },
      createdAt: "2026-09-14T00:00:00Z",
    },
    { sha256 },
  );
  return Array.from({ length: 7 }, (_, offset) => {
    const index = offset + 1;
    const legacy = [1, 3, 5].includes(index);
    const definition = parseAutomationDefinition({
      schemaVersion: legacy ? "crewon.automation.v0" : "crewon.automation.v1",
      automationId: `automation-${String(index).padStart(2, "0")}`,
      tenantId: "tenant-1",
      spaceId: "space-1",
      createdByActorId: "actor-1",
      threadId: "thread-1",
      title: "Report",
      prompt: "Report project status",
      agentVersionId: "agent-version-1",
      schedule: {
        scheduleType: "once",
        nextRunAt: "2026-09-15T00:00:00Z",
        intervalSeconds: 0,
        time: "00:00",
        weekday: 2,
        timezone: "UTC",
      },
      executionMode: "scheduled",
      revision: 1,
      createdAt: "2026-09-14T00:00:00Z",
      updatedAt: "2026-09-14T00:00:00Z",
      ...(legacy
        ? {}
        : {
            skillBinding: {
              schemaVersion: "crewon.automation-skill-binding.v1",
              version,
              invocation: {
                schemaVersion: "crewon.skill-invocation.v1",
                skill: version.ref,
                parameters: {},
                requiredToolRefs: [],
              },
              parameterBindings: {},
            },
          }),
    });
    return { definition, definitionDigest: sha256(canonicalJson(definition)) };
  });
}

async function fixture(
  context: TestContext,
  backend: Backend,
  records: AutomationDefinitionRecord[],
): Promise<Reader> {
  if (backend === "memory") {
    const authority = new InMemoryAutomationAuthority(memoryState(records));
    return {
      listAutomations: (query) => authority.list(query),
      listScheduledAutomations: (query) => authority.listScheduled(query),
    };
  }
  if (backend === "sqlite") {
    const directory = mkdtempSync(join(tmpdir(), "crewon-automation-version-"));
    const path = join(directory, "store.sqlite");
    const store = new SqliteRunStore(path);
    const database = new DatabaseSync(path);
    context.after(async () => {
      database.close();
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    await seedAutomationThread(store);
    const insert = database.prepare(`INSERT INTO automations
      (tenant_id,space_id,automation_id,thread_id,revision,definition_digest,definition_json,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`);
    for (const { definition, definitionDigest } of records) {
      insert.run(
        definition.tenantId,
        definition.spaceId,
        definition.automationId,
        definition.threadId,
        definition.revision,
        definitionDigest,
        canonicalJson(definition),
        definition.updatedAt,
      );
    }
    return store;
  }
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
  assert.ok(connectionString);
  const schema = `crewon_automation_versions_${randomUUID().replaceAll("-", "_")}`;
  const pool = new Pool({ connectionString, max: 1 });
  const store = await PostgresDomainStore.open({
    connectionString,
    schema,
    maxPoolSize: 2,
  });
  context.after(async () => {
    await store.close();
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  });
  await seedAutomationThread(store);
  for (const { definition, definitionDigest } of records) {
    await pool.query(
      `INSERT INTO ${schema}.automations
      (tenant_id,space_id,automation_id,thread_id,revision,definition_digest,definition_json,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::timestamptz)`,
      [
        definition.tenantId,
        definition.spaceId,
        definition.automationId,
        definition.threadId,
        definition.revision,
        definitionDigest,
        canonicalJson(definition),
        definition.updatedAt,
      ],
    );
  }
  return store;
}

function memoryState(
  records: AutomationDefinitionRecord[],
): InMemoryAutomationState {
  return {
    automations: new Map(
      records.map((record) => [record.definition.automationId, record]),
    ),
    createReceipts: new Map(),
    invocationReceipts: new Map(),
    pendingProviderSettings: new Map(),
    runs: new Map(),
    runEvents: new Map(),
    runEventIds: new Set(),
    threads: new Map(),
    threadEvents: new Map(),
    threadEventIds: new Set(),
    messages: new Map(),
    messageIds: new Set(),
    modelHistory: new Map(),
    modelHistoryItemIds: new Set(),
    outbox: new Map(),
    retiredOutboxIds: new Set(),
    outboxReplayAuthority: new Map(),
    workItems: new Map(),
    appendModelHistory: () => {
      throw new Error("unexpected mutation in read fixture");
    },
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
