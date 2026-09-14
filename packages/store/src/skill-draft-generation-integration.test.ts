import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DemonstratedSkillService,
  RunApplicationService,
  RunExecutionService,
  ThreadApplicationService,
  TurnApplicationService,
  SkillDraftGenerationService,
  renderSkillDraftGenerationPrompt,
} from "@crewon/application";
import type { SkillMethod } from "@crewon/domain";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { SqliteDemonstratedSkillStore } from "./demonstrated-skill-store.ts";
import { SqliteSkillDraftGenerationStore } from "./sqlite-skill-draft-generation.ts";

const actor = {
  principalId: "p",
  actorId: "owner",
  tenantId: "tenant",
  spaceId: "space",
};
const clock = { now: () => new Date().toISOString() };
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const method: SkillMethod = {
  name: "Export report",
  purpose: "Export reports for new dates",
  steps: ["Open the authorized report and select the new date."],
  parameters: [
    { name: "date", label: "Report date", type: "string", required: true },
  ],
  requiredToolRefs: ["browser"],
  completionCriteria: ["Downloaded rows match the report"],
  knownExceptions: ["Stop if a control cannot be found"],
  runtimeRequirements: ["Authorized browser session"],
};
const candidate: SkillMethod = {
  ...method,
  steps: [
    "Open the authorized report.",
    "Select {{date}} and confirm the matching rows.",
    "Export the report and compare its row count.",
  ],
};
const route = {
  authorityId: "authority",
  runtimeGeneration: "gen",
  agentVersionId: "agent",
  policySnapshotId: "policy",
  workspaceBindingId: "workspace",
};

async function fixture(t: import("node:test").TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "crewon-generation-integration-"));
  const path = join(dir, "store.sqlite");
  const runs = new SqliteRunStore(path);
  const skillsStore = new SqliteDemonstratedSkillStore(path, digester);
  let generations = new SqliteSkillDraftGenerationStore(path);
  const auth = { authorize: async () => ({ outcome: "allow" as const }) };
  const ids = { nextId: () => randomUUID() };
  const threads = new ThreadApplicationService({
    store: runs,
    authorization: auth,
    clock,
    ids,
    digester,
  });
  const turns = new TurnApplicationService({
    store: runs,
    authorization: auth,
    clock,
    ids,
    digester,
  });
  const runService = new RunApplicationService({
    store: runs,
    authorization: auth,
    clock,
    ids,
  });
  const execution = new RunExecutionService({
    store: runs,
    clock,
    ids,
    digester,
  });
  let crash = false;
  let denied = false;
  let edits = 0;
  let editCrash = false;
  let verification: "real" | "simulated" | "unknown" = "simulated";
  // Evidence classification is injected as a port fixture; no external model is claimed by these tests.
  const evidence = {
    observe: async (a: typeof actor, id: string) => ({
      run: await runService.getRun(a, id),
      verification,
    }),
  };
  const skills = new DemonstratedSkillService({
    store: skillsStore,
    authorization: {
      authorize: async ({ actor: a }) =>
        a.actorId !== actor.actorId || denied
          ? { outcome: "deny", reasonCode: "skill_revoked" }
          : { outcome: "allow" },
    },
    recording: {
      importRecording: async () => ({
        method,
        source: {
          recordingId: "recording",
          revision: 1,
          contentDigest: digester.sha256("contract fixture"),
          provenance: "contract-fixture",
        },
      }),
    },
    turns,
    routes: { resolveRoute: async () => route },
    evidence,
    digester,
    clock,
    nextId: () => randomUUID(),
  });
  const skill = await skills.importRecording(actor, {});
  const thread = (
    await threads.createThread(actor, {
      kind: "thread.create",
      idempotencyKey: randomUUID(),
      title: null,
    })
  ).state;
  const input = {
    generationId: "generation-1",
    threadId: thread.threadId,
    expectedThreadRevision: thread.revision,
    agentVersionId: null,
    expectedSkillRevision: skill.revision,
  };
  function service() {
    return new SkillDraftGenerationService({
      store: generations,
      skills: {
        get: skills.get.bind(skills),
        authorize: skills.authorize.bind(skills),
        edit: async (...args) => {
          edits++;
          const result = await skills.edit(...args);
          if (editCrash) {
            editCrash = false;
            throw new Error("crash_after_skill_edit");
          }
          return result;
        },
      },
      turns: {
        replayTurn: turns.replayTurn.bind(turns),
        startTurn: async (a, c) => {
          const result = await turns.startTurn(a, c);
          if (crash) {
            crash = false;
            throw new Error("crash_after_turn_commit");
          }
          return result;
        },
      },
      routes: { resolveRoute: async () => route },
      threads: runs,
      evidence,
      digester,
      clock,
    });
  }
  t.after(async () => {
    await generations.close();
    await skillsStore.close();
    await runs.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function complete(runId: string, output: string) {
    const claim = await runs.claimNextWorkItem({
      ownerId: "fixture-worker",
      leaseId: randomUUID(),
      leaseDurationMs: 60000,
    });
    assert.ok(claim);
    assert.equal(claim.workItem.runId, runId);
    await execution.startRun(claim);
    const begun = await execution.beginModelAttempt(claim);
    const attempt = {
      stepId: begun.step.stepId,
      attemptId: begun.attempt.attemptId,
    };
    return execution.completeTextRun(claim, attempt, output, {
      identity: {
        agentVersionId: route.agentVersionId,
        adapterName: "deterministic-fake",
        adapterVersion: "1",
        modelId: "fixture",
      },
      contextRevision: "canonical",
      checkpoint: null,
      providerTurnState: null,
      segment: {
        segmentId: randomUUID(),
        checkpointSequence: null,
        completedSequence: 1,
      },
      modelPolicy: { contextWindowTokens: 128000, autoCompactAtTokens: 96000 },
      latestUsage: null,
      proposedPlan: null,
    });
  }
  return {
    service,
    generations: () => generations,
    skills,
    skillsStore,
    runs,
    runService,
    skill,
    input,
    complete,
    edits: () => edits,
    deny: () => {
      denied = true;
    },
    crash: () => {
      crash = true;
    },
    crashEdit: () => {
      editCrash = true;
    },
    verify: (value: typeof verification) => {
      verification = value;
    },
    reopen: async () => {
      await generations.close();
      generations = new SqliteSkillDraftGenerationStore(path);
    },
  };
}

test("generation uses one durable Turn across response loss, validates its exact assistant output, and applies only on confirmation", async (t) => {
  const f = await fixture(t);
  f.crash();
  await assert.rejects(
    f.service().start(actor, f.skill.skillId, f.input),
    /crash_after_turn_commit/,
  );
  const pending = await f
    .generations()
    .getGeneration(f.skill, f.input.generationId);
  assert.equal(pending?.runId, null);
  await f.reopen();
  const started = await f.service().start(actor, f.skill.skillId, f.input);
  assert.ok(started.runId);
  assert.equal(
    (await f.service().start(actor, f.skill.skillId, f.input)).runId,
    started.runId,
  );
  assert.equal(
    (
      await f.runs.listMessages(
        { tenantId: actor.tenantId, threadId: f.input.threadId },
        0,
        100,
      )
    ).length,
    1,
  );
  const record = await f
    .generations()
    .getGeneration(f.skill, f.input.generationId);
  assert.ok(record && Buffer.byteLength(record.command.content) <= 9216);
  assert.match(record.command.content, /Do not execute/u);
  assert.equal(record.command.toolPermissionMode, "requestApproval");
  await assert.rejects(
    f.service().collect(actor, f.skill.skillId, f.input.generationId),
    { code: "skill_generation_not_completed" },
  );
  const completed = await f.complete(started.runId!, JSON.stringify(candidate));
  assert.match(completed.runState.outputRef!, /^message:/u);
  f.verify("real");
  const collected = await f
    .service()
    .collect(actor, f.skill.skillId, f.input.generationId);
  assert.equal(collected.outcome, "candidate");
  assert.equal(collected.verification, "real");
  assert.deepEqual(collected.candidate, candidate);
  assert.deepEqual((await f.skills.get(actor, f.skill.skillId)).draft, method);
  await f.reopen();
  assert.deepEqual(
    (await f.service().read(actor, f.skill.skillId, f.input.generationId))
      .candidate,
    candidate,
  );
  const applied = await f
    .service()
    .apply(actor, f.skill.skillId, f.input.generationId, 1);
  assert.equal(applied.appliedRevision, 2);
  assert.deepEqual(
    (await f.skills.get(actor, f.skill.skillId)).draft,
    candidate,
  );
  assert.deepEqual(
    (await f.skills.get(actor, f.skill.skillId)).activatedVersionIds,
    [],
  );
  await f.service().apply(actor, f.skill.skillId, f.input.generationId, 1);
  assert.equal(f.edits(), 1);
});

test("generation immutable request/candidate, owner scope, capacity, and Skill CAS fail closed", async (t) => {
  const f = await fixture(t);
  const first = await f.service().start(actor, f.skill.skillId, f.input);
  await assert.rejects(
    f.service().start(actor, f.skill.skillId, {
      ...f.input,
      agentVersionId: "different",
    }),
    { code: "skill_generation_id_conflict" },
  );
  const saved = await f
    .generations()
    .getGeneration(f.skill, f.input.generationId);
  assert.ok(saved);
  await assert.rejects(
    f.generations().putGeneration({
      ...saved,
      command: { ...saved.command, content: "replace method" },
    }),
    { code: "skill_generation_id_conflict" },
  );
  await assert.rejects(
    f.generations().bindGenerationRun(f.skill, f.input.generationId, {
      runId: "other",
      startMessageId: saved.startMessageId!,
      startMessageSequence: saved.startMessageSequence!,
    }),
    { code: "skill_generation_run_conflict" },
  );
  assert.equal(
    await f
      .generations()
      .getGeneration(
        { ...f.skill, ownerActorId: "other" },
        f.input.generationId,
      ),
    null,
  );
  await f.complete(first.runId!, JSON.stringify(candidate));
  f.verify("real");
  const collected = await f
    .service()
    .collect(actor, f.skill.skillId, f.input.generationId);
  await assert.rejects(
    f.generations().finishGeneration(f.skill, f.input.generationId, {
      outcome: "candidate",
      candidate: method,
      reasonCode: null,
      verification: "simulated",
      outputMessageId: "other",
      completedAt: clock.now(),
    }),
    { code: "skill_generation_result_conflict" },
  );
  await f.skills.edit(actor, f.skill.skillId, 1, {
    ...method,
    name: "Concurrent correction",
  });
  await assert.rejects(
    f.service().apply(actor, f.skill.skillId, f.input.generationId, 1),
    { code: "skill_revision_conflict" },
  );
  assert.equal(collected.appliedRevision, null);
  for (let i = 2; i <= 20; i++)
    await f.generations().putGeneration({
      ...saved,
      generationId: `generation-${i}`,
      command: {
        ...saved.command,
        idempotencyKey: `skill-generation:${f.skill.skillId}:generation-${i}`,
      },
      runId: null,
      startMessageId: null,
      startMessageSequence: null,
    });
  await assert.rejects(
    f.generations().putGeneration({
      ...saved,
      generationId: "overflow",
      command: {
        ...saved.command,
        idempotencyKey: `skill-generation:${f.skill.skillId}:overflow`,
      },
      runId: null,
      startMessageId: null,
      startMessageSequence: null,
    }),
    { code: "skill_generation_limit" },
  );
  assert.equal((await f.service().list(actor, f.skill.skillId)).length, 20);
  f.deny();
  await assert.rejects(
    f.service().read(actor, f.skill.skillId, f.input.generationId),
    { code: "skill_revoked" },
  );
});

test("generation invalid model JSON is retained as invalid and cannot become a candidate", async (t) => {
  const f = await fixture(t);
  const started = await f.service().start(actor, f.skill.skillId, f.input);
  await f.complete(
    started.runId!,
    `Here is your Skill:\n${JSON.stringify(candidate)}`,
  );
  const result = await f
    .service()
    .collect(actor, f.skill.skillId, f.input.generationId);
  assert.equal(result.outcome, "invalid");
  assert.equal(result.reasonCode, "skill_generation_output_invalid");
  assert.equal(result.candidate, null);
  await assert.rejects(
    f.service().apply(actor, f.skill.skillId, f.input.generationId, 1),
    { code: "skill_generation_candidate_required" },
  );
});

test("generation rejects a missing authoritative output binding", async (t) => {
  const f = await fixture(t);
  const started = await f.service().start(actor, f.skill.skillId, f.input);
  let run = await f.runService.getRun(actor, started.runId!);
  await f.runService.transitionRun(actor, {
    kind: "run.start",
    runId: run.runId,
    expectedRevision: run.revision,
    idempotencyKey: randomUUID(),
  });
  run = await f.runService.getRun(actor, started.runId!);
  await f.runService.transitionRun(actor, {
    kind: "run.complete",
    runId: run.runId,
    expectedRevision: run.revision,
    idempotencyKey: randomUUID(),
    outputRef: "message:unrelated-assistant",
  });
  const result = await f
    .service()
    .collect(actor, f.skill.skillId, f.input.generationId);
  assert.equal(result.outcome, "invalid");
  assert.equal(result.reasonCode, "skill_generation_output_unavailable");
});

test("concurrent generation requests converge and confirmed apply recovers its exact CAS after a crash", async (t) => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([
    f.service().start(actor, f.skill.skillId, f.input),
    f.service().start(actor, f.skill.skillId, f.input),
  ]);
  assert.equal(a.runId, b.runId);
  await f.complete(a.runId!, JSON.stringify(candidate));
  f.verify("real");
  const [first, second] = await Promise.all([
    f.service().collect(actor, f.skill.skillId, f.input.generationId),
    f.service().collect(actor, f.skill.skillId, f.input.generationId),
  ]);
  assert.deepEqual(first.candidate, second.candidate);
  f.crashEdit();
  await assert.rejects(
    f.service().apply(actor, f.skill.skillId, f.input.generationId, 1),
    /crash_after_skill_edit/,
  );
  await f.reopen();
  assert.equal(
    (await f.service().apply(actor, f.skill.skillId, f.input.generationId, 1))
      .appliedRevision,
    2,
  );
  assert.equal(f.edits(), 1);
});

test("a later Run's valid assistant JSON cannot replace the original generation's invalid output", async (t) => {
  const f = await fixture(t);
  const first = await f.service().start(actor, f.skill.skillId, f.input);
  await f.complete(first.runId!, "Not valid JSON");
  const thread = await f.runs.loadThread({
    tenantId: actor.tenantId,
    threadId: f.input.threadId,
  });
  assert.ok(thread);
  const next = {
    ...f.input,
    generationId: "generation-2",
    expectedThreadRevision: thread.revision,
  };
  const second = await f.service().start(actor, f.skill.skillId, next);
  await f.complete(second.runId!, JSON.stringify(candidate));
  assert.equal(
    (await f.service().collect(actor, f.skill.skillId, f.input.generationId))
      .outcome,
    "invalid",
  );
  assert.deepEqual(
    (await f.service().collect(actor, f.skill.skillId, next.generationId))
      .candidate,
    candidate,
  );
});

test("generation prompt rejects oversized schema plus method instead of injecting an unbounded fragment", () => {
  assert.throws(
    () =>
      renderSkillDraftGenerationPrompt({
        ...method,
        steps: Array(8).fill("x".repeat(850)),
      }),
    { code: "skill_generation_context_too_large" },
  );
});

for (const verification of ["simulated", "unknown"] as const)
  test(`${verification} model evidence allows candidate preview but cannot apply the draft`, async (t) => {
    const f = await fixture(t);
    const started = await f.service().start(actor, f.skill.skillId, f.input);
    await f.complete(started.runId!, JSON.stringify(candidate));
    f.verify(verification);
    const collected = await f
      .service()
      .collect(actor, f.skill.skillId, f.input.generationId);
    assert.equal(collected.verification, verification);
    assert.deepEqual(collected.candidate, candidate);
    await assert.rejects(
      f.service().apply(actor, f.skill.skillId, f.input.generationId, 1),
      { code: "skill_generation_real_model_required" },
    );
    f.verify("real");
    await assert.rejects(
      f.service().apply(actor, f.skill.skillId, f.input.generationId, 1),
      { code: "skill_generation_real_model_required" },
    );
    assert.equal((await f.skills.get(actor, f.skill.skillId)).revision, 1);
  });

test("a once-real candidate cannot apply if current evidence is unavailable", async (t) => {
  const f = await fixture(t);
  const started = await f.service().start(actor, f.skill.skillId, f.input);
  await f.complete(started.runId!, JSON.stringify(candidate));
  f.verify("real");
  await f.service().collect(actor, f.skill.skillId, f.input.generationId);
  f.verify("unknown");
  await assert.rejects(
    f.service().apply(actor, f.skill.skillId, f.input.generationId, 1),
    { code: "skill_generation_real_model_required" },
  );
});
