import assert from "node:assert/strict";
import test from "node:test";

import {
  reduceRunLifecycleEvent,
  type ModelHistoryItem,
  type RunLifecycleEvent,
  type RunState,
  type ThreadState,
} from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import { ThreadTaskChangeQueryService } from "./thread-task-change-query-service.ts";

const actor: ActorContext = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
};

test("aggregates more than fifty effective terminal Turn ledgers exactly and repeatably", async () => {
  const fixture = new LedgerFixture();
  for (let index = 1; index <= 60; index += 1) {
    const runId = `run-${String(index).padStart(3, "0")}`;
    fixture.addHistory(assistantHistory(index, runId));
    fixture.addRun(
      workspaceRun(runId, {
        paths: [`src/task-${String(index).padStart(3, "0")}.ts`],
        additions: index,
        deletions: 1,
      }),
    );
  }

  const first = await fixture.service().getThreadTaskChanges(actor, "thread-1");
  const replay = await fixture
    .service()
    .getThreadTaskChanges(actor, "thread-1");

  assert.deepEqual(replay, first);
  assert.equal(first.complete, true);
  assert.equal(first.historySequence, 60);
  assert.equal(first.includedRunIds.length, 60);
  assert.equal(first.eventCount, 120);
  assert.equal(first.summary.paths.length, 60);
  assert.equal(first.summary.additions, (60 * 61) / 2);
  assert.equal(first.summary.deletions, 60);
});

test("accepts the canonical completion segment sequence after its request", async () => {
  const fixture = new LedgerFixture();
  fixture.addHistory(assistantHistory(1, "run-segment-sequence"));
  fixture.addRun(
    workspaceRun("run-segment-sequence", {
      paths: ["src/sequence.ts"],
      additions: 2,
      deletions: 1,
    }),
  );

  const result = await fixture
    .service()
    .getThreadTaskChanges(actor, "thread-1");

  assert.equal(result.complete, true);
  assert.deepEqual(result.summary, {
    schemaVersion: "crewon.workspace-change-summary.v0",
    paths: ["src/sequence.ts"],
    additions: 2,
    deletions: 1,
    statsComplete: true,
  });
});

test("pairs interleaved mutation completions with their own earlier requests", async () => {
  const fixture = new LedgerFixture();
  fixture.addHistory(assistantHistory(1, "run-interleaved-mutations"));
  fixture.addRun(interleavedMutationRun("run-interleaved-mutations"));

  const result = await fixture
    .service()
    .getThreadTaskChanges(actor, "thread-1");

  assert.equal(result.complete, true);
  assert.equal(result.eventCount, 4);
  assert.deepEqual(result.summary, {
    schemaVersion: "crewon.workspace-change-summary.v0",
    paths: ["src/a.ts", "src/b.ts"],
    additions: 5,
    deletions: 3,
    statsComplete: true,
  });
});

test("projects only post-rollback effective Run ids", async () => {
  const fixture = new LedgerFixture();
  fixture.addHistory(userHistory(1, "first"));
  fixture.addHistory(assistantHistory(2, "run-kept"));
  fixture.addHistory(userHistory(3, "rolled back"));
  fixture.addHistory(assistantHistory(4, "run-removed"));
  fixture.addHistory({
    schemaVersion: "crewon.model-history-item.v0",
    itemId: "history-5",
    tenantId: actor.tenantId,
    threadId: "thread-1",
    sequence: 5,
    runId: null,
    segmentId: null,
    createdAt: timestamp(5),
    type: "rollback",
    rollbackId: "rollback-1",
    threadEventId: "thread-event-rollback-1",
    requestedTurns: 1,
    removedTurns: 1,
    historyFromSequence: 3,
    historyThroughSequence: 4,
  });
  fixture.addRun(
    workspaceRun("run-kept", {
      paths: ["src/kept.ts"],
      additions: 3,
      deletions: 1,
    }),
  );
  fixture.addRun(
    workspaceRun("run-removed", {
      paths: ["src/removed.ts"],
      additions: 99,
      deletions: 99,
    }),
  );

  const result = await fixture
    .service()
    .getThreadTaskChanges(actor, "thread-1");

  assert.equal(result.complete, true);
  assert.deepEqual(result.includedRunIds, ["run-kept"]);
  assert.deepEqual(result.summary, {
    schemaVersion: "crewon.workspace-change-summary.v0",
    paths: ["src/kept.ts"],
    additions: 3,
    deletions: 1,
    statsComplete: true,
  });
});

test("excludes active Turns and custom Tools with the native Tool name", async () => {
  const fixture = new LedgerFixture();
  fixture.addHistory(assistantHistory(1, "run-terminal-custom"));
  fixture.addHistory(assistantHistory(2, "run-active"));
  fixture.addRun(customWorkspaceNamedRun("run-terminal-custom"));
  fixture.addRun(
    workspaceRun(
      "run-active",
      { paths: ["src/active.ts"], additions: 8, deletions: 2 },
      false,
    ),
  );

  const result = await fixture
    .service()
    .getThreadTaskChanges(actor, "thread-1");

  assert.equal(result.complete, true);
  assert.deepEqual(result.includedRunIds, ["run-terminal-custom"]);
  assert.equal(result.eventCount, 0);
  assert.deepEqual(result.summary.paths, []);
});

test("fails closed when an observed active Turn becomes terminal without a Thread head change", async () => {
  const fixture = new LedgerFixture();
  fixture.addHistory(assistantHistory(1, "run-racing-terminal"));
  const active = workspaceRun(
    "run-racing-terminal",
    { paths: ["src/race.ts"], additions: 2, deletions: 0 },
    false,
  );
  const terminal = failedWorkspaceRun("run-racing-terminal", {
    paths: ["src/race.ts"],
    additions: 2,
    deletions: 0,
  });
  fixture.addRun(terminal);
  let loadCount = 0;
  const service = new ThreadTaskChangeQueryService({
    store: {
      ...fixture.store,
      loadRunInSpace: async (locator: { runId: string }) => {
        loadCount += 1;
        return loadCount === 1
          ? active.state
          : (fixture.runs.get(locator.runId)?.state ?? null);
      },
    },
    threads: { getThread: async () => thread() },
  });

  assertCanonicalIncomplete(
    await service.getThreadTaskChanges(actor, "thread-1"),
  );
  assert.equal(loadCount, 2);
});

test("treats a legacy terminal Run without purpose as a Turn", async () => {
  const fixture = new LedgerFixture();
  fixture.addHistory(assistantHistory(1, "run-legacy"));
  const legacy = workspaceRun("run-legacy", {
    paths: ["src/legacy.ts"],
    additions: 2,
    deletions: 1,
  });
  fixture.addRun({
    state: { ...legacy.state, purpose: undefined },
    events: legacy.events,
  });

  const result = await fixture
    .service()
    .getThreadTaskChanges(actor, "thread-1");

  assert.equal(result.complete, true);
  assert.deepEqual(result.includedRunIds, ["run-legacy"]);
  assert.deepEqual(result.summary.paths, ["src/legacy.ts"]);
});

test("ignores inherited source Run ids in a forked Thread", async () => {
  const fixture = new LedgerFixture();
  fixture.addHistory(assistantHistory(1, "run-from-source-thread"));
  fixture.addHistory(assistantHistory(2, "run-local"));
  fixture.addRun(
    workspaceRun("run-local", {
      paths: ["src/local.ts"],
      additions: 5,
      deletions: 2,
    }),
  );
  const service = new ThreadTaskChangeQueryService({
    store: fixture.store,
    threads: {
      getThread: async () => ({
        ...thread(),
        forkedFromThreadId: "thread-source",
        forkedThroughHistorySequence: 1,
      }),
    },
  });

  const result = await service.getThreadTaskChanges(actor, "thread-1");

  assert.equal(result.complete, true);
  assert.deepEqual(result.includedRunIds, ["run-local"]);
  assert.deepEqual(result.summary, {
    schemaVersion: "crewon.workspace-change-summary.v0",
    paths: ["src/local.ts"],
    additions: 5,
    deletions: 2,
    statsComplete: true,
  });
});

test("fails closed when the history head races or aggregate path budgets overflow", async () => {
  const racing = new LedgerFixture();
  racing.addHistory(assistantHistory(1, "run-stable"));
  racing.addRun(
    workspaceRun("run-stable", {
      paths: ["src/stable.ts"],
      additions: 1,
      deletions: 0,
    }),
  );
  racing.historyHeadSequenceOverrides.push(1, 2);
  assertCanonicalIncomplete(
    await racing.service().getThreadTaskChanges(actor, "thread-1"),
  );

  const oversized = new LedgerFixture();
  oversized.addHistory(assistantHistory(1, "run-paths-a"));
  oversized.addHistory(assistantHistory(2, "run-paths-b"));
  oversized.addRun(
    workspaceRun("run-paths-a", {
      paths: Array.from(
        { length: 130 },
        (_, index) => `a/${String(index).padStart(3, "0")}.ts`,
      ),
      additions: 1,
      deletions: 0,
    }),
  );
  oversized.addRun(
    workspaceRun("run-paths-b", {
      paths: Array.from(
        { length: 130 },
        (_, index) => `b/${String(index).padStart(3, "0")}.ts`,
      ),
      additions: 1,
      deletions: 0,
    }),
  );
  assertCanonicalIncomplete(
    await oversized.service().getThreadTaskChanges(actor, "thread-1"),
  );
});

test("fails closed beyond the one-thousand effective Run budget", async () => {
  const fixture = new LedgerFixture();
  for (let sequence = 1; sequence <= 1_001; sequence += 1) {
    fixture.addHistory(assistantHistory(sequence, `run-${sequence}`));
  }
  assertCanonicalIncomplete(
    await fixture.service().getThreadTaskChanges(actor, "thread-1"),
  );
});

test("fails closed beyond 256 native mutations in one Run", async () => {
  const fixture = new LedgerFixture();
  fixture.addHistory(assistantHistory(1, "run-too-many-mutations"));
  fixture.addRun(manyMutationRun("run-too-many-mutations", 257));
  assertCanonicalIncomplete(
    await fixture.service().getThreadTaskChanges(actor, "thread-1"),
  );
});

test("fails closed on a missing effective Run or incomplete event sequence", async () => {
  const missing = new LedgerFixture();
  missing.addHistory(assistantHistory(1, "run-missing"));
  assertCanonicalIncomplete(
    await missing.service().getThreadTaskChanges(actor, "thread-1"),
  );

  const gap = new LedgerFixture();
  gap.addHistory(assistantHistory(1, "run-gap"));
  gap.addRun(
    workspaceRun("run-gap", {
      paths: ["src/gap.ts"],
      additions: 1,
      deletions: 0,
    }),
  );
  gap.omitEventSequence("run-gap", 4);
  assertCanonicalIncomplete(
    await gap.service().getThreadTaskChanges(actor, "thread-1"),
  );

  const metadata = new LedgerFixture();
  metadata.addHistory(assistantHistory(1, "run-metadata"));
  metadata.addRun(incompleteMetadataRun("run-metadata"));
  assertCanonicalIncomplete(
    await metadata.service().getThreadTaskChanges(actor, "thread-1"),
  );
});

test("uses the authorized Thread read fence before touching any ledger", async () => {
  const fixture = new LedgerFixture();
  const service = new ThreadTaskChangeQueryService({
    store: fixture.store,
    threads: {
      getThread: async () => {
        throw new ApplicationError("notFound", "thread_not_found");
      },
    },
  });

  await assert.rejects(
    service.getThreadTaskChanges(
      { ...actor, tenantId: "tenant-other" },
      "thread-1",
    ),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === "thread_not_found",
  );
  assert.equal(fixture.ledgerReads, 0);
});

class LedgerFixture {
  readonly history: ModelHistoryItem[] = [];
  readonly runs = new Map<
    string,
    { state: RunState; events: RunLifecycleEvent[] }
  >();
  readonly omittedEvents = new Map<string, Set<number>>();
  readonly historyHeadSequenceOverrides: number[] = [];
  ledgerReads = 0;

  readonly store = {
    loadModelHistoryHead: async () => {
      this.ledgerReads += 1;
      return {
        tenantId: actor.tenantId,
        threadId: "thread-1",
        lastSequence:
          this.historyHeadSequenceOverrides.shift() ?? this.history.length,
      };
    },
    listModelHistoryItems: async (
      _locator: unknown,
      afterSequence: number,
      limit: number,
    ) => {
      this.ledgerReads += 1;
      return this.history.slice(afterSequence, afterSequence + limit);
    },
    loadRunInSpace: async (locator: { runId: string }) => {
      this.ledgerReads += 1;
      return this.runs.get(locator.runId)?.state ?? null;
    },
    listRunEvents: async (
      locator: { runId: string },
      afterSequence: number,
      limit: number,
    ) => {
      this.ledgerReads += 1;
      const omitted = this.omittedEvents.get(locator.runId) ?? new Set();
      return (this.runs.get(locator.runId)?.events ?? [])
        .filter(
          (event) =>
            event.sequence > afterSequence && !omitted.has(event.sequence),
        )
        .slice(0, limit);
    },
  };

  addHistory(item: ModelHistoryItem): void {
    this.history.push(item);
  }

  addRun(run: { state: RunState; events: RunLifecycleEvent[] }): void {
    this.runs.set(run.state.runId, run);
  }

  omitEventSequence(runId: string, sequence: number): void {
    this.omittedEvents.set(runId, new Set([sequence]));
  }

  service(): ThreadTaskChangeQueryService {
    return new ThreadTaskChangeQueryService({
      store: this.store,
      threads: { getThread: async () => thread() },
    });
  }
}

function workspaceRun(
  runId: string,
  changes: { paths: string[]; additions: number; deletions: number },
  terminal = true,
): { state: RunState; events: RunLifecycleEvent[] } {
  return runWithTool(runId, "function", changes, terminal);
}

function customWorkspaceNamedRun(runId: string): {
  state: RunState;
  events: RunLifecycleEvent[];
} {
  return runWithTool(
    runId,
    "custom",
    { paths: ["src/custom.ts"], additions: 7, deletions: 4 },
    true,
  );
}

function failedWorkspaceRun(
  runId: string,
  changes: { paths: string[]; additions: number; deletions: number },
): { state: RunState; events: RunLifecycleEvent[] } {
  const active = workspaceRun(runId, changes, false);
  const failed: RunLifecycleEvent = {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId },
    eventId: `${runId}-event-6`,
    sequence: 6,
    occurredAt: timestamp(6),
    type: "run.failed",
    data: { code: "provider_unavailable", retryable: false },
  };
  const events = [...active.events, failed];
  let state: RunState | null = null;
  for (const event of events) state = reduceRunLifecycleEvent(state, event);
  assert.notEqual(state, null);
  return { state: state!, events };
}

function runWithTool(
  runId: string,
  kind: "function" | "custom",
  changes: { paths: string[]; additions: number; deletions: number },
  terminal: boolean,
): { state: RunState; events: RunLifecycleEvent[] } {
  const base = {
    schemaVersion: "crewon.run-event.v0" as const,
    identity: { runId },
  };
  const events: RunLifecycleEvent[] = [
    {
      ...base,
      eventId: `${runId}-event-1`,
      sequence: 1,
      occurredAt: timestamp(1),
      type: "run.created",
      data: {
        threadId: "thread-1",
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        createdByActorId: actor.actorId,
        authorityId: "authority-1",
        runtimeGeneration: "generation-1",
        agentVersionId: "agent-version-1",
        policySnapshotId: "policy-1",
        workspaceBindingId: "workspace-1",
        collaborationMode: "default",
        goalBinding: null,
        purpose: "turn",
        origin: null,
      },
    },
    {
      ...base,
      eventId: `${runId}-event-2`,
      sequence: 2,
      occurredAt: timestamp(2),
      type: "run.started",
      data: {},
    },
    {
      ...base,
      eventId: `${runId}-event-3`,
      sequence: 3,
      occurredAt: timestamp(3),
      type: "segment.started",
      data: { segmentId: `${runId}-segment`, segmentSequence: 1, attempt: 1 },
    },
    {
      ...base,
      eventId: `${runId}-event-4`,
      sequence: 4,
      occurredAt: timestamp(4),
      type: "tool.requested",
      data: {
        segmentId: `${runId}-segment`,
        segmentSequence: 1,
        callId: `${runId}-call`,
        kind,
        name: "workspace_run_command",
        input: "{}",
      },
    },
    {
      ...base,
      eventId: `${runId}-event-5`,
      sequence: 5,
      occurredAt: timestamp(5),
      type: "tool.completed",
      data: {
        segmentId: `${runId}-segment`,
        segmentSequence: 2,
        callId: `${runId}-call`,
        kind,
        name: "workspace_run_command",
        output: "ok",
        isError: false,
        artifactRef: null,
        outputTruncated: false,
        workspaceChanges: {
          schemaVersion: "crewon.workspace-change-summary.v0",
          ...changes,
          statsComplete: true,
        },
      },
    },
  ];
  if (terminal) {
    events.push({
      ...base,
      eventId: `${runId}-event-6`,
      sequence: 6,
      occurredAt: timestamp(6),
      type: "run.completed",
      data: { outputRef: null },
    });
  }
  let state: RunState | null = null;
  for (const event of events) state = reduceRunLifecycleEvent(state, event);
  assert.notEqual(state, null);
  return { state: state!, events };
}

function manyMutationRun(
  runId: string,
  count: number,
): { state: RunState; events: RunLifecycleEvent[] } {
  const first = workspaceRun(runId, {
    paths: ["src/repeated.ts"],
    additions: 1,
    deletions: 0,
  });
  const events = first.events.slice(0, 3);
  let sequence = 4;
  for (let index = 0; index < count; index += 1) {
    const callId = `${runId}-call-${index}`;
    events.push({
      schemaVersion: "crewon.run-event.v0",
      identity: { runId },
      eventId: `${runId}-event-${sequence}`,
      sequence,
      occurredAt: timestamp(sequence),
      type: "tool.requested",
      data: {
        segmentId: `${runId}-segment`,
        segmentSequence: index * 2 + 1,
        callId,
        kind: "function",
        name: "workspace_run_command",
        input: "{}",
      },
    });
    sequence += 1;
    events.push({
      schemaVersion: "crewon.run-event.v0",
      identity: { runId },
      eventId: `${runId}-event-${sequence}`,
      sequence,
      occurredAt: timestamp(sequence),
      type: "tool.completed",
      data: {
        segmentId: `${runId}-segment`,
        segmentSequence: index * 2 + 2,
        callId,
        kind: "function",
        name: "workspace_run_command",
        output: "ok",
        isError: false,
        artifactRef: null,
        outputTruncated: false,
        workspaceChanges: {
          schemaVersion: "crewon.workspace-change-summary.v0",
          paths: ["src/repeated.ts"],
          additions: 1,
          deletions: 0,
          statsComplete: true,
        },
      },
    });
    sequence += 1;
  }
  events.push({
    schemaVersion: "crewon.run-event.v0",
    identity: { runId },
    eventId: `${runId}-event-${sequence}`,
    sequence,
    occurredAt: timestamp(sequence),
    type: "run.completed",
    data: { outputRef: null },
  });
  let state: RunState | null = null;
  for (const event of events) state = reduceRunLifecycleEvent(state, event);
  assert.notEqual(state, null);
  return { state: state!, events };
}

function interleavedMutationRun(runId: string): {
  state: RunState;
  events: RunLifecycleEvent[];
} {
  const first = workspaceRun(runId, {
    paths: ["src/a.ts"],
    additions: 2,
    deletions: 1,
  });
  const events = first.events.slice(0, 3);
  const calls = [
    {
      callId: `${runId}-call-a`,
      segmentSequence: 1,
      changes: {
        paths: ["src/a.ts"],
        additions: 2,
        deletions: 1,
      },
    },
    {
      callId: `${runId}-call-b`,
      segmentSequence: 2,
      changes: {
        paths: ["src/b.ts"],
        additions: 3,
        deletions: 2,
      },
    },
  ];
  for (const [index, call] of calls.entries()) {
    events.push({
      schemaVersion: "crewon.run-event.v0",
      identity: { runId },
      eventId: `${runId}-event-${index + 4}`,
      sequence: index + 4,
      occurredAt: timestamp(index + 4),
      type: "tool.requested",
      data: {
        segmentId: `${runId}-segment`,
        segmentSequence: call.segmentSequence,
        callId: call.callId,
        kind: "function",
        name: "workspace_run_command",
        input: "{}",
      },
    });
  }
  for (const [index, call] of calls.entries()) {
    events.push({
      schemaVersion: "crewon.run-event.v0",
      identity: { runId },
      eventId: `${runId}-event-${index + 6}`,
      sequence: index + 6,
      occurredAt: timestamp(index + 6),
      type: "tool.completed",
      data: {
        segmentId: `${runId}-segment`,
        // A completes two segment events after its request. This is valid for
        // an interleaved batch and must not be narrowed to request + 1.
        segmentSequence: index + 3,
        callId: call.callId,
        kind: "function",
        name: "workspace_run_command",
        output: "ok",
        isError: false,
        artifactRef: null,
        outputTruncated: false,
        workspaceChanges: {
          schemaVersion: "crewon.workspace-change-summary.v0",
          ...call.changes,
          statsComplete: true,
        },
      },
    });
  }
  events.push({
    schemaVersion: "crewon.run-event.v0",
    identity: { runId },
    eventId: `${runId}-event-8`,
    sequence: 8,
    occurredAt: timestamp(8),
    type: "run.completed",
    data: { outputRef: null },
  });
  let state: RunState | null = null;
  for (const event of events) state = reduceRunLifecycleEvent(state, event);
  assert.notEqual(state, null);
  return { state: state!, events };
}

function incompleteMetadataRun(runId: string): {
  state: RunState;
  events: RunLifecycleEvent[];
} {
  const source = workspaceRun(runId, {
    paths: ["src/incomplete.ts"],
    additions: 1,
    deletions: 0,
  });
  const events = source.events.map(
    (event): RunLifecycleEvent =>
      event.type === "tool.completed"
        ? {
            ...event,
            data: {
              ...event.data,
              workspaceChanges: {
                schemaVersion: "crewon.workspace-change-summary.v0",
                paths: [],
                additions: 0,
                deletions: 0,
                statsComplete: false,
              },
            },
          }
        : event,
  );
  let state: RunState | null = null;
  for (const event of events) state = reduceRunLifecycleEvent(state, event);
  assert.notEqual(state, null);
  return { state: state!, events };
}

function assistantHistory(sequence: number, runId: string): ModelHistoryItem {
  return {
    schemaVersion: "crewon.model-history-item.v0",
    itemId: `history-${sequence}`,
    tenantId: actor.tenantId,
    threadId: "thread-1",
    sequence,
    runId,
    segmentId: `${runId}-segment`,
    createdAt: timestamp(sequence),
    type: "message",
    role: "assistant",
    source: "assistant_completion",
    content: `done ${runId}`,
    contentDigest: digest(sequence),
  };
}

function userHistory(sequence: number, content: string): ModelHistoryItem {
  return {
    schemaVersion: "crewon.model-history-item.v0",
    itemId: `history-${sequence}`,
    tenantId: actor.tenantId,
    threadId: "thread-1",
    sequence,
    runId: null,
    segmentId: null,
    createdAt: timestamp(sequence),
    type: "message",
    role: "user",
    source: "thread_message",
    content,
    contentDigest: digest(sequence),
  };
}

function thread(): ThreadState {
  return {
    threadId: "thread-1",
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    createdByActorId: actor.actorId,
    title: null,
    status: "active",
    revision: 1,
    lastEventSequence: 1,
    lastMessageSequence: 0,
    createdAt: timestamp(0),
    updatedAt: timestamp(0),
    archivedAt: null,
    deletedAt: null,
    deletedByActorId: null,
    forkedFromThreadId: null,
    forkedThroughHistorySequence: null,
  };
}

function assertCanonicalIncomplete(value: {
  complete: boolean;
  eventCount: number;
  includedRunIds: string[];
  summary: {
    paths: string[];
    additions: number;
    deletions: number;
    statsComplete: boolean;
  };
}): void {
  assert.equal(value.complete, false);
  assert.equal(value.eventCount, 0);
  assert.deepEqual(value.includedRunIds, []);
  assert.deepEqual(value.summary, {
    schemaVersion: "crewon.workspace-change-summary.v0",
    paths: [],
    additions: 0,
    deletions: 0,
    statsComplete: false,
  });
}

function timestamp(index: number): string {
  return new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString();
}

function digest(index: number): string {
  return `sha256:${index.toString(16).padStart(64, "0")}`;
}
