import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  AutomationApplicationService,
  ThreadApplicationService,
  canonicalJson,
  type ActorContext,
  type AutomationInvocationResult,
  type RunAutomationNowCommand,
} from "@crewon/application";
import {
  ContractValidationError,
  parseCreateAutomationRequest,
} from "@crewon/contracts";
import {
  parseAutomationDefinition,
  renderAutomationInstruction,
} from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";

import { projectAutomation } from "./automation-projection.ts";
import { AutomationScheduler } from "./automation-scheduler.ts";

// Frozen v0 storage fixture, deliberately without createdByPrincipalId.
// F04-R01: do not rebuild these expectations with the current definition factory.
const LEGACY_JSON = String.raw`{"agentVersionId":"agent-version-legacy","automationId":"automation-legacy","createdAt":"2026-03-06T14:00:00Z","createdByActorId":"actor-legacy","executionMode":"scheduled","prompt":"Summarize <today>.\nKeep exact spacing.","revision":1,"schedule":{"intervalSeconds":86400,"nextRunAt":"2026-03-07T14:00:00Z","scheduleType":"daily","time":"09:00","timezone":"America/New_York","weekday":0},"schemaVersion":"crewon.automation.v0","spaceId":"space-legacy","tenantId":"tenant-legacy","threadId":"thread-legacy","title":"Daily & 进度","updatedAt":"2026-03-06T14:00:00Z"}`;
const DEFINITION_DIGEST =
  "sha256:3ba77ce7810e7a9e5d7bc468023d21f917005bc25850ff18cb1b94a1b19429e7";
const INSTRUCTION = [
  '<automation_run automation_id="automation-legacy" automation_revision="1">',
  "<title>Daily &amp; 进度</title>",
  "<task>Summarize &lt;today&gt;.",
  "Keep exact spacing.</task>",
  "Record the result, next steps, and risks in this Automation result thread.",
  "</automation_run>",
].join("\n");
const INSTRUCTION_DIGEST =
  "sha256:9c9af48d8e476d962e813192f06cfbccdc68288dcda9a51874888e3ed24adf87";
const RECOVERED_OCCURRENCE_KEY =
  "scheduled:f46e699e56d620df04f4f7eea5b173b512bb08dfd30e46d42121bfb5a3a0e4d3";

test("F04-R01: persisted prompt-only v0 retains exact canonical bytes, identity and instruction digests", () => {
  const definition = parseAutomationDefinition(JSON.parse(LEGACY_JSON));

  assert.equal(canonicalJson(definition), LEGACY_JSON);
  assert.equal(sha256(canonicalJson(definition)), DEFINITION_DIGEST);
  assert.equal(renderAutomationInstruction(definition), INSTRUCTION);
  assert.equal(
    sha256(renderAutomationInstruction(definition)),
    INSTRUCTION_DIGEST,
  );
  assert.equal(Object.hasOwn(definition, "createdByPrincipalId"), false);
  assert.equal(Object.hasOwn(definition, "skillBinding"), false);
});

test("F04-R01: legacy prompt-only HTTP contracts retain request and redacted response shape", () => {
  const definition = parseAutomationDefinition(JSON.parse(LEGACY_JSON));
  const request = {
    threadId: definition.threadId,
    expectedThreadRevision: 1,
    title: definition.title,
    prompt: definition.prompt,
    agentVersionId: null,
    schedule: definition.schedule,
  };

  assert.deepEqual(parseCreateAutomationRequest(request), request);
  assert.deepEqual(
    parseCreateAutomationRequest({ ...request, schedule: null }),
    {
      ...request,
      schedule: null,
    },
  );
  assert.deepEqual(projectAutomation(definition), {
    automationId: "automation-legacy",
    threadId: "thread-legacy",
    title: "Daily & 进度",
    prompt: "Summarize <today>.\nKeep exact spacing.",
    agentVersionId: "agent-version-legacy",
    executionMode: "scheduled",
    automaticScheduling: true,
    schedule: definition.schedule,
    revision: 1,
    createdAt: "2026-03-06T14:00:00Z",
    updatedAt: "2026-03-06T14:00:00Z",
  });
  for (const field of ["instruction", "definitionDigest", "schemaVersion"]) {
    assert.throws(
      () => parseCreateAutomationRequest({ ...request, [field]: "forged" }),
      ContractValidationError,
    );
  }
});

test("F04-R01/R05/R07: SQLite v0 recovers only the latest local-time occurrence across DST and replays it after restart", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-automation-v0-"));
  const path = join(directory, "store.sqlite");
  let store = new SqliteRunStore(path);
  const sql = new DatabaseSync(path);
  const schedulers: AutomationScheduler[] = [];
  context.after(async () => {
    for (const scheduler of schedulers) await scheduler.close();
    sql.close();
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const actor: ActorContext = {
    principalId: "actor-legacy",
    actorId: "actor-legacy",
    tenantId: "tenant-legacy",
    spaceId: "space-legacy",
  };
  let sequence = 0;
  const ids = {
    nextId: (kind: string) =>
      kind === "thread" ? "thread-legacy" : `${kind}-${++sequence}`,
  };
  let now = "2026-03-06T14:00:00Z";
  const clock = { now: () => now };
  const authorization = {
    authorize: async () => ({ outcome: "allow" as const }),
  };
  const digester = { sha256 };
  const threads = () =>
    new ThreadApplicationService({
      store,
      clock,
      ids,
      authorization,
      digester,
    });
  await threads().createThread(actor, {
    kind: "thread.create",
    idempotencyKey: "legacy-thread",
    title: "Legacy results",
  });
  // Import an old persisted row, rather than creating it with today's factory.
  sql
    .prepare(
      `INSERT INTO automations (
        tenant_id, space_id, automation_id, thread_id, revision,
        definition_digest, definition_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      actor.tenantId,
      actor.spaceId,
      "automation-legacy",
      "thread-legacy",
      1,
      DEFINITION_DIGEST,
      LEGACY_JSON,
      now,
    );

  let routeCalls = 0;
  let routeAvailable = true;
  const results: AutomationInvocationResult[] = [];
  const commands: RunAutomationNowCommand[] = [];
  const startScheduler = () => {
    const service = new AutomationApplicationService({
      store,
      clock,
      ids,
      authorization,
      digester,
      routeResolver: {
        resolveRoute: async () => {
          routeCalls += 1;
          assert.equal(routeAvailable, true, "receipt replay must not reroute");
          return {
            authorityId: "authority-legacy",
            runtimeGeneration: "generation-legacy",
            agentVersionId: "agent-version-legacy",
            policySnapshotId: "policy-legacy",
            workspaceBindingId: null,
          };
        },
      },
    });
    const scheduler = new AutomationScheduler(
      {
        store,
        threads: threads(),
        now: clock.now,
        automations: {
          runAutomationNow: async (scheduledActor, command) => {
            assert.deepEqual(scheduledActor, actor);
            commands.push(command);
            const result = await service.runAutomationNow(
              scheduledActor,
              command,
            );
            results.push(result);
            return result;
          },
        },
      },
      { scanIntervalMs: null },
    );
    schedulers.push(scheduler);
    return scheduler;
  };

  // Offline on March 7/8; New York has moved from UTC-5 to UTC-4 by recovery.
  now = "2026-03-09T13:05:00Z";
  const first = startScheduler();
  await first.wake();
  assert.equal(first.lastFailureCode(), null);
  assert.equal(results.length, 1);
  const committed = results[0]!;
  assert.equal(committed.disposition, "committed");
  assert.equal(commands[0]?.idempotencyKey, RECOVERED_OCCURRENCE_KEY);
  assert.equal(committed.binding.definitionDigest, DEFINITION_DIGEST);
  assert.equal(committed.binding.instructionDigest, INSTRUCTION_DIGEST);
  assert.equal(committed.message.content, INSTRUCTION);
  assert.deepEqual(committed.runState.origin, committed.message.origin);
  assert.deepEqual(committed.historyItem.origin, committed.message.origin);
  const pending = await store.listPendingWorkItems(100);
  assert.equal(
    pending.length,
    1,
    "missed days do not produce catch-up Run bursts",
  );

  await first.close();
  await store.close();
  store = new SqliteRunStore(path);
  routeAvailable = false;
  now = "2026-03-09T13:59:00Z";
  const restarted = startScheduler();
  const overlapping = startScheduler();
  await Promise.all([restarted.wake(), overlapping.wake()]);
  assert.equal(restarted.lastFailureCode(), null);
  assert.equal(overlapping.lastFailureCode(), null);
  assert.equal(results.length, 3);
  for (const replay of results.slice(1)) {
    assert.equal(replay.disposition, "replayed");
    assert.deepEqual(replay.binding, committed.binding);
    assert.deepEqual(replay.message, committed.message);
    assert.deepEqual(replay.record, committed.record);
  }
  assert.deepEqual(
    commands.map((command) => command.idempotencyKey),
    [
      RECOVERED_OCCURRENCE_KEY,
      RECOVERED_OCCURRENCE_KEY,
      RECOVERED_OCCURRENCE_KEY,
    ],
  );
  assert.equal(routeCalls, 1);
  assert.deepEqual(await store.listPendingWorkItems(100), pending);
  const locator = { tenantId: actor.tenantId, threadId: "thread-legacy" };
  assert.equal((await store.listMessages(locator, 0, 100)).length, 1);
  assert.equal((await store.listModelHistoryItems(locator, 0, 100)).length, 1);
  assert.deepEqual(
    {
      ...sql
        .prepare("SELECT definition_json, definition_digest FROM automations")
        .get(),
    },
    { definition_json: LEGACY_JSON, definition_digest: DEFINITION_DIGEST },
  );
  assert.equal(
    sql
      .prepare("SELECT count(*) AS count FROM automation_invocation_receipts")
      .get()?.count,
    1,
  );
});

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
