import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createProjectTextPlanRevision,
  parseProjectTextPlan,
  parseProjectTextPlanRevision,
} from "./project-text-plan.ts";
import {
  createProjectTextPlanRunAdmission,
  parseProjectTextPlanRunAdmission,
} from "./project-text-plan-run-admission.ts";
import { parseProjectTextPlanStep } from "./project-text-plan-step.ts";
import {
  applyProjectTextPlanControl,
  checkpointProjectTextPlanAdmission,
  checkpointProjectTextPlanResult,
  checkpointProjectTextPlanTerminal,
  checkpointProjectTextPlanSelection,
  advanceProjectTextPlanSelection,
  assertProjectTextPlanOutlineEpisodes,
  createProjectTextPlanRemainingSteps,
} from "./project-text-plan-mutations.ts";
import type {
  ProjectTextPlanRevision,
  ProjectTextPlanResultReference,
} from "./project-text-plan-types.ts";
const digest = (text: string) =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;
const digester = { sha256: digest },
  at = "2026-10-06T00:00:00.000Z",
  hash = digest("fixture");
function definition(
  patch: Partial<
    Omit<ProjectTextPlanRevision, "schemaVersion" | "contentDigest">
  > = {},
) {
  return createProjectTextPlanRevision(
    {
      planId: "plan-1",
      planRevision: 1,
      actor: {
        tenantId: "tenant",
        spaceId: "space",
        principalId: "principal",
        actorId: "actor",
      },
      installation: {
        tenantId: "tenant",
        spaceId: "space",
        profileId: "profile",
        pluginId: "crewon.short-drama",
        publisherId: "crewon",
        version: "17.0.0",
        packageDigest: hash,
        selectionRevision: 2,
      },
      projectId: "project",
      threadId: "thread",
      bindingId: "binding",
      bindingRevision: 1,
      workspaceId: "workspace",
      configurationRevision: 1,
      configurationDigest: hash,
      target: {
        executionAuthority: "crewonKernel",
        agentVersionId: "agent-version",
        agentVersionContentDigest: hash,
        materializationDigest: hash,
        authorityId: "authority",
        runtimeGeneration: "generation",
        policySnapshotId: "policy",
        workspaceBindingId: null,
      },
      start: "outline",
      targetStage: "script",
      episodeMode: "newOutline",
      episodeIds: ["episode-1", "episode-2"],
      adoption: "manual",
      concurrency: 1,
      maximumResultsPerStep: 1,
      instruction: "写一部悬疑短剧\n保持人物设定。",
      instructionDigest: digest("写一部悬疑短剧\n保持人物设定。"),
      delegation: {
        kind: "pluginUi",
        contributionId: "workbench",
        actionId: "crewon.project-text-plans.v1.start",
        invocationId: "invocation",
        idempotencyKey: "start-key",
        inputDigest: hash,
      },
      sources: {
        brief: { briefRevision: 1, contentDigest: hash },
        outline: null,
      },
      baselines: [
        {
          kind: "outline",
          episodeId: null,
          artifactId: null,
          artifactRevision: 0,
          selectedContentRevision: null,
          locked: false,
        },
      ],
      createdAt: at,
      ...patch,
    },
    digester,
  );
}
function fixture() {
  const d = definition(),
    c = applyProjectTextPlanControl(
      {
        kind: "start",
        previous: null,
        previousRevision: null,
        previousSteps: [],
        definition: d,
        stepIds: ["outline-step", "script-1", "script-2"],
        at,
      },
      digester,
    ),
    step = c.steps[0]!;
  const admission = createProjectTextPlanRunAdmission(
    {
      planId: d.planId,
      planRevision: 1,
      planRevisionDigest: d.contentDigest,
      stepId: step.stepId,
      stepRevision: 1,
      attempt: 1,
      actor: d.actor,
      installation: d.installation,
      projectId: d.projectId,
      threadId: d.threadId,
      bindingId: d.bindingId,
      bindingRevision: d.bindingRevision,
      workspaceId: d.workspaceId,
      configurationRevision: d.configurationRevision,
      configurationDigest: d.configurationDigest,
      runId: "run-1",
      stageAdmissionDigest: hash,
      extensionBindingDigest: hash,
      delegationDigest: digest(JSON.stringify(d.delegation)),
      inputDigest: digest("original input"),
      idempotencyKey: "step-key",
      taskIdempotencyKey: "original-command-key",
      kind: "outline",
      episodeId: null,
      expectedEpisodeIds: d.episodeIds,
      sources: d.sources,
      baseline: d.baselines[0]!,
      createdAt: at,
    },
    digester,
  );
  return { d, c, step, admission };
}
const result: ProjectTextPlanResultReference = {
  kind: "outline",
  idempotencyKey: "real-tool-key",
  requestDigest: hash,
  runId: "run-1",
  toolReceiptId: "tool-receipt",
  toolInputDigest: hash,
  briefRevision: null,
  artifactId: "outline-artifact",
  artifactRevision: 1,
  contentRevision: 1,
  contentDigest: hash,
};
const terminal = {
  eventId: "event-completed",
  throughSequence: 5,
  runRevision: 5,
  status: "completed" as const,
};
test("fixed scope creates only bounded slots and preserves full workspace/actor/installation", () => {
  const f = fixture();
  assert.equal(f.c.steps.length, 3);
  assert.deepEqual(
    f.c.steps.map((x) => [x.kind, x.episodeId]),
    [
      ["outline", null],
      ["script", "episode-1"],
      ["script", "episode-2"],
    ],
  );
  assert.equal(f.c.plan.workspaceId, "workspace");
  assert.deepEqual(parseProjectTextPlan(f.c.plan, digester), f.c.plan);
  assert.deepEqual(parseProjectTextPlanRevision(f.d, digester), f.d);
  assert.deepEqual(parseProjectTextPlanStep(f.step, digester), f.step);
  assert.deepEqual(
    parseProjectTextPlanRunAdmission(f.admission, digester),
    f.admission,
  );
});
test("at most18steps and16exact episode IDs; malformed scope cannot enter persistence", () => {
  const ids = Array.from({ length: 16 }, (_, i) => `episode-${i}`),
    d = definition({ start: "brief", episodeIds: ids });
  const c = applyProjectTextPlanControl(
    {
      kind: "start",
      previous: null,
      previousRevision: null,
      previousSteps: [],
      definition: d,
      stepIds: Array.from({ length: 18 }, (_, i) => `step-${i}`),
      at,
    },
    digester,
  );
  assert.equal(c.steps.length, 18);
  assert.throws(() => definition({ episodeIds: [...ids, "extra"] }));
  assert.throws(() => definition({ episodeIds: ["same", "same"] }));
  assert.throws(() => definition({ start: "script", targetStage: "brief" }));
  assert.throws(() => definition({ concurrency: 2 as 1 }));
  assert.throws(() => definition({ maximumResultsPerStep: 2 as 1 }));
});
test("strict codecs reject altered digests, foreign fields, getters, invalid Unicode and unsafe integers", () => {
  const f = fixture();
  assert.throws(() =>
    parseProjectTextPlan({ ...f.c.plan, revision: 2 }, digester),
  );
  assert.throws(() =>
    parseProjectTextPlan({ ...f.c.plan, extra: true }, digester),
  );
  let getterCalls = 0;
  const copy = { ...f.d };
  Object.defineProperty(copy, "instruction", {
    enumerable: true,
    get() {
      getterCalls++;
      return "unsafe";
    },
  });
  assert.throws(() => parseProjectTextPlanRevision(copy, digester));
  assert.equal(getterCalls, 0);
  assert.throws(() =>
    definition({ instruction: "\ud800", instructionDigest: digest("\ud800") }),
  );
  assert.throws(() =>
    definition({ configurationRevision: Number.MAX_SAFE_INTEGER + 1 }),
  );
  assert.throws(() =>
    definition({
      instruction: "💬".repeat(1025),
      instructionDigest: digest("💬".repeat(1025)),
    }),
  );
  assert.doesNotThrow(() =>
    definition({
      instruction: "💬".repeat(1024),
      instructionDigest: digest("💬".repeat(1024)),
    }),
  );
});
test("manual default records exact candidate, waits after terminal, and advances only explicit Continue", () => {
  const f = fixture(),
    a = checkpointProjectTextPlanAdmission(
      f.c.plan,
      f.step,
      f.admission,
      "original input",
      3,
      at,
      digester,
    ),
    r = checkpointProjectTextPlanResult(a.plan, a.step, result, at, digester),
    t = checkpointProjectTextPlanTerminal(
      r.plan,
      r.step,
      terminal,
      f.c.steps,
      at,
      digester,
    );
  assert.equal(t.plan.state, "waitingSelection");
  assert.equal(t.plan.activeStepId, f.step.stepId);
  assert.throws(() =>
    applyProjectTextPlanControl(
      {
        kind: "continue",
        previous: t.plan,
        previousRevision: f.d,
        previousSteps: [t.step, ...f.c.steps.slice(1)],
        definition: f.d,
        stepIds: [],
        at,
      },
      digester,
    ),
  );
  const s = checkpointProjectTextPlanSelection(
    t.plan,
    t.step,
    {
      mode: "manual",
      idempotencyKey: "actual-manual-select",
      requestDigest: hash,
      artifactId: "outline-artifact",
      artifactRevision: 2,
      contentRevision: 1,
      contentDigest: hash,
    },
    at,
    digester,
  );
  assert.equal(s.plan.state, "waitingSelection");
  const next = applyProjectTextPlanControl(
    {
      kind: "continue",
      previous: s.plan,
      previousRevision: f.d,
      previousSteps: [s.step, ...f.c.steps.slice(1)],
      definition: f.d,
      stepIds: [],
      at,
    },
    digester,
  );
  assert.equal(next.plan.state, "ready");
  assert.equal(next.plan.activeStepId, "script-1");
  assert.equal(next.plan.wakeRevision, f.c.plan.wakeRevision + 1);
  assert.equal(next.steps[0]!.state, "succeeded");
});
test("one exact result per step permits original replay and refuses a second candidate", () => {
  const f = fixture(),
    a = checkpointProjectTextPlanAdmission(
      f.c.plan,
      f.step,
      f.admission,
      "original input",
      3,
      at,
      digester,
    ),
    r = checkpointProjectTextPlanResult(a.plan, a.step, result, at, digester);
  assert.equal(
    checkpointProjectTextPlanResult(r.plan, r.step, result, at, digester).step,
    r.step,
  );
  assert.throws(() =>
    checkpointProjectTextPlanResult(
      r.plan,
      r.step,
      { ...result, contentRevision: 2 },
      at,
      digester,
    ),
  );
  assert.throws(() =>
    assertProjectTextPlanOutlineEpisodes(f.admission, [
      "episode-2",
      "episode-1",
    ]),
  );
  assert.doesNotThrow(() =>
    assertProjectTextPlanOutlineEpisodes(f.admission, f.d.episodeIds),
  );
});
test("terminal with no business result pauses; assistant completion is insufficient", () => {
  const f = fixture(),
    a = checkpointProjectTextPlanAdmission(
      f.c.plan,
      f.step,
      f.admission,
      "original input",
      3,
      at,
      digester,
    ),
    t = checkpointProjectTextPlanTerminal(
      a.plan,
      a.step,
      terminal,
      f.c.steps,
      at,
      digester,
    );
  assert.equal(t.plan.state, "paused");
  assert.equal(t.plan.pauseReason, "result_missing");
  assert.equal(t.step.state, "failed");
});
test("pause retains admitted identity and result; revoke rejects later candidate and cannot resume", () => {
  const f = fixture(),
    a = checkpointProjectTextPlanAdmission(
      f.c.plan,
      f.step,
      f.admission,
      "original input",
      3,
      at,
      digester,
    ),
    p = applyProjectTextPlanControl(
      {
        kind: "pause",
        previous: a.plan,
        previousRevision: f.d,
        previousSteps: [a.step, ...f.c.steps.slice(1)],
        definition: f.d,
        stepIds: [],
        at,
      },
      digester,
    ),
    r = checkpointProjectTextPlanResult(p.plan, a.step, result, at, digester),
    t = checkpointProjectTextPlanTerminal(
      r.plan,
      r.step,
      terminal,
      f.c.steps,
      at,
      digester,
    );
  assert.equal(t.plan.state, "paused");
  assert.equal(t.step.result?.idempotencyKey, result.idempotencyKey);
  assert.deepEqual(t.step.run, a.step.run);
  const v = applyProjectTextPlanControl(
    {
      kind: "revoke",
      previous: t.plan,
      previousRevision: f.d,
      previousSteps: [t.step, ...f.c.steps.slice(1)],
      definition: f.d,
      stepIds: [],
      at,
    },
    digester,
  );
  assert.equal(v.plan.state, "revoked");
  assert.throws(() =>
    checkpointProjectTextPlanResult(v.plan, a.step, result, at, digester),
  );
  assert.throws(() =>
    applyProjectTextPlanControl(
      {
        kind: "pause",
        previous: v.plan,
        previousRevision: f.d,
        previousSteps: v.steps,
        definition: f.d,
        stepIds: [],
        at,
      },
      digester,
    ),
  );
});
test("independent script source is explicit and never pretends an outline exists", () => {
  const d = definition({
    start: "script",
    targetStage: "script",
    episodeMode: "independentScripts",
    sources: {
      brief: { briefRevision: 1, contentDigest: hash },
      outline: null,
    },
  });
  assert.equal(d.sources.outline, null);
  assert.throws(() =>
    definition({ start: "script", episodeMode: "selectedOutline" }),
  );
  assert.throws(() => definition({ episodeMode: "independentScripts" }));
});
test("whenUnchanged selection advances the exact result and publishes durable next readiness", () => {
  const f = fixture(),
    a = checkpointProjectTextPlanAdmission(
      f.c.plan,
      f.step,
      f.admission,
      "original input",
      3,
      at,
      digester,
    ),
    r = checkpointProjectTextPlanResult(a.plan, a.step, result, at, digester),
    t = checkpointProjectTextPlanTerminal(
      r.plan,
      r.step,
      terminal,
      f.c.steps,
      at,
      digester,
    ),
    s = advanceProjectTextPlanSelection(
      t.plan,
      t.step,
      {
        mode: "whenUnchanged",
        idempotencyKey: "delegated-select",
        requestDigest: hash,
        artifactId: "outline-artifact",
        artifactRevision: 2,
        contentRevision: 1,
        contentDigest: hash,
      },
      f.c.steps,
      at,
      digester,
    );
  assert.equal(s.step.state, "succeeded");
  assert.equal(s.step.revision, t.step.revision + 1);
  assert.equal(s.plan.activeStepId, "script-1");
  assert.equal(s.plan.wakeRevision, t.plan.wakeRevision + 1);
  assert.throws(() =>
    advanceProjectTextPlanSelection(
      t.plan,
      t.step,
      { ...s.step.selection!, mode: "manual" },
      f.c.steps,
      at,
      digester,
    ),
  );
});
test("new remaining slots preserve completed history rather than replaying accepted Run", () => {
  const f = fixture(),
    a = checkpointProjectTextPlanAdmission(
      f.c.plan,
      f.step,
      f.admission,
      "original input",
      3,
      at,
      digester,
    ),
    r = checkpointProjectTextPlanResult(a.plan, a.step, result, at, digester),
    t = checkpointProjectTextPlanTerminal(
      r.plan,
      r.step,
      terminal,
      f.c.steps,
      at,
      digester,
    ),
    s = advanceProjectTextPlanSelection(
      t.plan,
      t.step,
      {
        mode: "whenUnchanged",
        idempotencyKey: "delegated-select",
        requestDigest: hash,
        artifactId: "outline-artifact",
        artifactRevision: 2,
        contentRevision: 1,
        contentDigest: hash,
      },
      f.c.steps,
      at,
      digester,
    );
  const next = definition({
      planRevision: 2,
      delegation: {
        ...f.d.delegation,
        actionId: "crewon.project-text-plans.v1.resume",
      },
    }),
    remaining = createProjectTextPlanRemainingSteps(
      next,
      [s.step, ...f.c.steps.slice(1)],
      ["new-script-1", "new-script-2"],
      at,
      digester,
    );
  assert.deepEqual(
    remaining.map((x) => x.kind),
    ["script", "script"],
  );
  assert.equal(s.step.run?.runId, "run-1");
  assert.throws(() =>
    createProjectTextPlanRemainingSteps(
      next,
      [s.step, ...f.c.steps.slice(1)],
      ["script-1", "new-script-2"],
      at,
      digester,
    ),
  );
});

test("unavailable live background authority is persisted with original control receipt view; metadata is not execution", () => {
  const d = definition(),
    x = applyProjectTextPlanControl(
      {
        kind: "start",
        previous: null,
        previousRevision: null,
        previousSteps: [],
        definition: d,
        stepIds: ["outline", "script-1", "script-2"],
        at,
        authorizationUnavailable: true,
      },
      digester,
    );
  assert.equal(x.plan.state, "paused");
  assert.equal(x.plan.pauseReason, "authorization_unavailable");
  assert.equal(x.steps[0]!.run, null);
});
