import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DemonstratedSkillService,
  RunApplicationService,
  ThreadApplicationService,
  TurnApplicationService,
  type SkillExecutionAuthorizationPort,
} from "@crewon/application";
import type { SkillInvocationSpec, SkillMethod } from "@crewon/domain";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { SqliteDemonstratedSkillStore } from "./demonstrated-skill-store.ts";
const actor = {
  principalId: "p",
  actorId: "owner",
  tenantId: "tenant",
  spaceId: "space",
};
const clock = { now: () => "2026-09-14T00:00:00.000Z" };
const digester = {
  sha256: (v: string) =>
    `sha256:${createHash("sha256").update(v).digest("hex")}`,
};
const method: SkillMethod = {
  name: "Export date",
  purpose: "Export a new date",
  steps: ["Select date then verify file"],
  parameters: [
    { name: "date", label: "New date", type: "string", required: true },
  ],
  requiredToolRefs: ["browser"],
  completionCriteria: ["Rows match source"],
  knownExceptions: ["Request help on missing controls"],
  runtimeRequirements: ["Authenticated browser session"],
};
const route = {
  authorityId: "authority",
  runtimeGeneration: "gen",
  agentVersionId: "agent",
  policySnapshotId: "policy",
  workspaceBindingId: "workspace",
};
async function fixture(
  t: import("node:test").TestContext,
  provenance: "recording" | "contract-fixture" = "recording",
) {
  const dir = mkdtempSync(join(tmpdir(), "crewon-skill-integration-"));
  const path = join(dir, "store.sqlite");
  const runs = new SqliteRunStore(path);
  const skills = new SqliteDemonstratedSkillStore(path, digester);
  t.after(async () => {
    await skills.close();
    await runs.close();
    rmSync(dir, { recursive: true, force: true });
  });
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
  let denied = false;
  let verification: "real" | "simulated" | "unknown" = "simulated";
  let crash = false;
  const policy: SkillExecutionAuthorizationPort = {
    authorize: async ({ actor: a, route: r }) =>
      a.actorId !== actor.actorId ||
      denied ||
      (r !== null && r.agentVersionId !== route.agentVersionId)
        ? { outcome: "deny", reasonCode: "skill_revoked" }
        : { outcome: "allow" },
  };
  const service = new DemonstratedSkillService({
    store: skills,
    authorization: policy,
    recording: {
      importRecording: async () => ({
        method,
        source: {
          recordingId: "recording",
          revision: 1,
          contentDigest: digester.sha256("recording"),
          provenance: "recording" as const,
        },
      }),
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
    evidence: {
      observe: async (a, id) => ({
        run: await runService.getRun(a, id),
        verification,
      }),
    },
    digester,
    clock,
    nextId: () => randomUUID(),
  });
  const thread = (
    await threads.createThread(actor, {
      kind: "thread.create",
      idempotencyKey: randomUUID(),
      title: null,
    })
  ).state;
  const skill = await service.importRecording(
    actor,
    {},
    [],
    provenance === "contract-fixture" ? { provenance } : {},
  );
  const version = await service.seal(actor, skill.skillId, 1);
  const invocation: SkillInvocationSpec = {
    schemaVersion: "crewon.skill-invocation.v1",
    skill: version.ref,
    parameters: { date: "2026-10-01" },
    requiredToolRefs: ["browser"],
  };
  const input = {
    executionId: "trial-1",
    threadId: thread.threadId,
    expectedThreadRevision: thread.revision,
    agentVersionId: "agent",
    purpose: "trial" as const,
    invocation,
  };
  async function complete(runId: string) {
    let run = await runService.getRun(actor, runId);
    await runService.transitionRun(actor, {
      kind: "run.start",
      runId,
      idempotencyKey: randomUUID(),
      expectedRevision: run.revision,
    });
    run = await runService.getRun(actor, runId);
    await runService.transitionRun(actor, {
      kind: "run.complete",
      runId,
      idempotencyKey: randomUUID(),
      expectedRevision: run.revision,
      outputRef: null,
    });
  }
  return {
    service,
    skills,
    runs,
    runService,
    skill,
    version,
    invocation,
    input,
    complete,
    path,
    setDenied: (v: boolean) => {
      denied = v;
    },
    setVerification: (v: typeof verification) => {
      verification = v;
    },
    crashNext: () => {
      crash = true;
    },
  };
}
test("F03-R04 real Turn/SQLite crash receipt recovery preserves one Run and immutable invocation", async (t) => {
  const f = await fixture(t);
  f.crashNext();
  await assert.rejects(
    f.service.startExecution(actor, f.skill.skillId, f.input),
    /crash_after_turn_commit/,
  );
  const pending = await f.skills.getExecution(f.skill, f.input.executionId);
  assert.ok(pending?.runId);
  assert.equal(
    (await f.service.getInvocationForRun(actor, pending!.runId!))?.invocation
      .skill.versionId,
    f.version.ref.versionId,
  );
  const replay = await f.service.startExecution(
    actor,
    f.skill.skillId,
    f.input,
  );
  assert.ok(replay.runId);
  const again = await f.service.startExecution(actor, f.skill.skillId, f.input);
  assert.equal(again.runId, replay.runId);
  const messages = await f.runs.listMessages(
    { tenantId: actor.tenantId, threadId: f.input.threadId },
    0,
    100,
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0]!.content, /2026-10-01/);
  const reopened = new SqliteDemonstratedSkillStore(f.path, digester);
  try {
    assert.equal(
      (await reopened.getExecution(f.skill, f.input.executionId))?.runId,
      replay.runId,
    );
  } finally {
    await reopened.close();
  }
  await assert.rejects(
    f.service.startExecution(actor, f.skill.skillId, {
      ...f.input,
      invocation: { ...f.invocation, parameters: { date: "2026-11-01" } },
    }),
    /skill_execution_id_conflict/,
  );
});
test("F03-R05 simulated or unfinished trials cannot activate; real-evidence port requires reviewed new material", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.service.activate(actor, f.skill.skillId, 1, f.version.ref),
    /skill_reviewed_trial_required/,
  );
  const trial = await f.service.startExecution(actor, f.skill.skillId, f.input);
  assert.ok(trial.runId);
  const review = {
    criteria: [...method.completionCriteria],
    coverage: ["new-input" as const],
    resultNote: "Compared downloaded rows with source",
  };
  await assert.rejects(
    f.service.reviewTrial(actor, f.skill.skillId, f.input.executionId, review),
    /skill_trial_not_completed/,
  );
  await f.complete(trial.runId);
  await assert.rejects(
    f.service.reviewTrial(actor, f.skill.skillId, f.input.executionId, review),
    /skill_real_trial_required/,
  );
  // This is a declared evidence-port fixture, not a real provider/browser acceptance run.
  f.setVerification("real");
  await assert.rejects(
    f.service.reviewTrial(actor, f.skill.skillId, f.input.executionId, {
      ...review,
      criteria: [],
    }),
    /skill_criteria_incomplete/,
  );
  await assert.rejects(
    f.service.reviewTrial(actor, f.skill.skillId, f.input.executionId, {
      ...review,
      coverage: [],
    }),
    /skill_new_material_required/,
  );
  await f.service.reviewTrial(
    actor,
    f.skill.skillId,
    f.input.executionId,
    review,
  );
  const active = await f.service.activate(
    actor,
    f.skill.skillId,
    1,
    f.version.ref,
  );
  assert.deepEqual(active.activatedVersionIds, [f.version.ref.versionId]);
  assert.equal(
    (
      await f.service.admitInvocation(actor, f.invocation, {
        purpose: "schedule",
        route,
      })
    ).context,
    trial.command.content,
  );
});
test("F03-R03/R07 edited versions stay pinned, disabled/revoked skills reject fresh admission and keep history", async (t) => {
  const f = await fixture(t);
  const trial = await f.service.startExecution(actor, f.skill.skillId, f.input);
  await f.complete(trial.runId!);
  f.setVerification("real");
  await f.service.reviewTrial(actor, f.skill.skillId, f.input.executionId, {
    criteria: [...method.completionCriteria],
    coverage: ["new-date"],
    resultNote: "Output checked",
  });
  await f.service.activate(actor, f.skill.skillId, 1, f.version.ref);
  const edited = await f.service.edit(actor, f.skill.skillId, 2, {
    ...method,
    steps: ["Different process"],
  });
  const next = await f.service.seal(actor, f.skill.skillId, edited.revision);
  assert.notEqual(next.ref.contentDigest, f.version.ref.contentDigest);
  assert.deepEqual(
    (await f.service.resolveVersion(actor, f.version.ref)).method.steps,
    method.steps,
  );
  await f.service.setDisabled(actor, f.skill.skillId, 3, true);
  await assert.rejects(
    f.service.admitInvocation(actor, f.invocation, {
      purpose: "execute",
      route,
    }),
    /skill_disabled/,
  );
  assert.equal(
    (await f.service.startExecution(actor, f.skill.skillId, f.input)).runId,
    trial.runId,
  );
  await assert.rejects(
    f.service.startExecution(actor, f.skill.skillId, {
      ...f.input,
      executionId: "new-trial",
    }),
    /skill_disabled/,
  );
  await f.service.setDisabled(actor, f.skill.skillId, 4, false);
  f.setDenied(true);
  await assert.rejects(
    f.service.admitInvocation(actor, f.invocation, {
      purpose: "execute",
      route,
    }),
    /skill_revoked/,
  );
});
test("F03-R01/R05 contract fixtures never qualify for production activation", async (t) => {
  const f = await fixture(t, "contract-fixture");
  const trial = await f.service.startExecution(actor, f.skill.skillId, f.input);
  await f.complete(trial.runId!);
  f.setVerification("real");
  await assert.rejects(
    f.service.reviewTrial(actor, f.skill.skillId, f.input.executionId, {
      criteria: [...method.completionCriteria],
      coverage: ["new-input"],
      resultNote: "fixture",
    }),
    /skill_real_trial_required/,
  );
});

test("F03-R07 disable between preparation and Turn commit prevents both Run and message atomically", async (t) => {
  const f = await fixture(t);
  const original = f.service.dependencies.turns.startTurn;
  f.service.dependencies.turns.startTurn = async (a, c) => {
    await f.service.setDisabled(actor, f.skill.skillId, 1, true);
    return original(a, c);
  };
  await assert.rejects(
    f.service.startExecution(actor, f.skill.skillId, f.input),
    /skill_disabled/,
  );
  assert.equal(
    (await f.skills.getExecution(f.skill, f.input.executionId))?.runId,
    null,
  );
  assert.equal(
    (
      await f.runs.listMessages(
        { tenantId: actor.tenantId, threadId: f.input.threadId },
        0,
        100,
      )
    ).length,
    0,
  );
});
test("F03-R07 existing Run lookup is fixed and rechecks disable before a new tool action", async (t) => {
  const f = await fixture(t);
  const trial = await f.service.startExecution(actor, f.skill.skillId, f.input);
  assert.equal(
    (await f.service.ensureRunSkillAllowed(actor, trial.runId!))?.invocation
      .skill.contentDigest,
    f.version.ref.contentDigest,
  );
  await f.service.setDisabled(actor, f.skill.skillId, 1, true);
  await assert.rejects(
    f.service.ensureRunSkillAllowed(actor, trial.runId!),
    /skill_disabled/,
  );
  assert.equal(
    (await f.service.getInvocationForRun(actor, trial.runId!))?.invocation.skill
      .contentDigest,
    f.version.ref.contentDigest,
  );
});
