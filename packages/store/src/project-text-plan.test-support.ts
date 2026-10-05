import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  createProjectTextPlanRevision,
  applyProjectTextPlanControl,
  projectTextPlanStepKinds,
  extensionCanonicalJson,
  type ProjectTextPlanRevision,
  type ProjectTextPlanDelegation,
  type ProjectStageSources,
} from "@crewon/domain";
import type {
  ProjectTextPlanCommitAuthority,
  ProjectTextPlanMutation,
} from "@crewon/application";
import { conversationFixture } from "./project-conversation-store.test-support.ts";
import { timestamp } from "./extension-store.test-support.ts";

/** Actual parent project/Thread/installation/configuration writers; policy and delegation explicitly named tests. */
export async function planFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  base?: Parameters<typeof conversationFixture>[2],
) {
  const f = await conversationFixture(t, backend, base),
    b = await f.prepare();
  // Sequential named stages use real elapsed fixture time instead of the old fixed single-Turn clock.
  f.originalTaskFixture.dependencies.clock.now = () => new Date().toISOString();
  await f.store.commitBinding(b, { authority: f.authority });
  const text = f.parent.projectTextStore();
  await text.migrate();
  const plans = f.parent.projectTextPlanStore();
  await plans.migrate();
  const scope = {
      tenantId: f.actor.tenantId,
      spaceId: f.actor.spaceId,
      pluginId: f.pin.pluginId,
    },
    configuration = await f.first.store.loadLatestExtensionConfiguration(scope),
    activation = await f.first.store.loadExtensionActivation(scope),
    brief = await f.metadata.loadBrief({
      owner: {
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        principalId: f.actor.principalId,
      },
      projectId: b.binding.projectId,
      briefRevision: 1,
    });
  assert.ok(configuration);
  assert.ok(activation?.target);
  assert.ok(brief);
  const state = {
      live: true,
      current: true,
      beforeTransaction: null as null | (() => void | Promise<void>),
      checks: 0,
      withdrawAfter: 0,
    },
    active = () => {
      if (!state.live) throw new Error("named_plan_owner_withdrawn");
    };
  const authority = (
    delegation: ProjectTextPlanDelegation | null,
    backgroundAuthorization: ProjectTextPlanCommitAuthority["backgroundAuthorization"] = "available",
  ): ProjectTextPlanCommitAuthority => ({
    version: "crewon.project-text-plan-commit.v1",
    backgroundAuthorization,
    actor: f.actor,
    binding: b.binding,
    selection: f.enabled.selection,
    package: f.installed.package,
    delegation,
    assertCurrent: async () => {
      active();
      if (!state.current) throw new Error("named_plan_pdp_withdrawn");
    },
    assertTransactionCurrent: async () => {
      state.checks++;
      await state.beforeTransaction?.();
      active();
      if (!state.current) throw new Error("named_plan_pdp_withdrawn");
      if (state.withdrawAfter === state.checks) state.live = false;
    },
    assertActive: active,
  });
  const definition = (
    patch: Partial<
      Omit<ProjectTextPlanRevision, "schemaVersion" | "contentDigest">
    > = {},
  ) => {
    const instruction = "Draft the project outline",
      key = randomUUID();
    return createProjectTextPlanRevision(
      {
        planId: randomUUID(),
        planRevision: 1,
        actor: f.actor,
        installation: f.installation,
        projectId: b.binding.projectId,
        threadId: b.binding.threadId,
        bindingId: b.binding.bindingId,
        bindingRevision: b.binding.revision,
        workspaceId: b.binding.workspaceId,
        configurationRevision: configuration.revision,
        configurationDigest: configuration.contentDigest,
        target: activation.target!,
        start: "outline",
        targetStage: "outline",
        episodeMode: "newOutline",
        episodeIds: ["episode-one"],
        adoption: "manual",
        concurrency: 1,
        maximumResultsPerStep: 1,
        instruction,
        instructionDigest: f.digester.sha256(instruction),
        delegation: {
          kind: "pluginUi",
          contributionId: "workbench",
          actionId: "crewon.project-text-plans.v1.start",
          invocationId: randomUUID(),
          idempotencyKey: key,
          inputDigest: f.digester.sha256("named_plan_start"),
        },
        sources: {
          brief: { briefRevision: 1, contentDigest: brief.contentDigest },
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
        createdAt: timestamp,
        ...patch,
      },
      f.digester,
    );
  };
  const control = (
    kind: ProjectTextPlanMutation["kind"],
    d: ProjectTextPlanRevision,
    previous: ProjectTextPlanMutation | null = null,
    key = d.delegation.idempotencyKey,
    backgroundAuthorization: ProjectTextPlanCommitAuthority["backgroundAuthorization"] = "available",
  ) => {
    const stepIds =
        kind === "start" || kind === "resume" || kind === "reviseRemaining"
          ? projectTextPlanStepKinds(d).map(() => randomUUID())
          : [],
      recipe = applyProjectTextPlanControl(
        {
          kind,
          previous: previous?.plan ?? null,
          previousRevision: previous?.planRevision ?? null,
          previousSteps: previous?.steps ?? [],
          definition: d,
          authorizationUnavailable: backgroundAuthorization === "unavailable",
          stepIds,
          at: previous === null ? timestamp : new Date().toISOString(),
        },
        f.digester,
      );
    return {
      ...recipe,
      kind,
      expectedRevision: previous?.plan.revision ?? 0,
      planRevision: d,
      receipt: {
        actor: f.actor,
        idempotencyKey: key,
        requestDigest: f.digester.sha256(
          extensionCanonicalJson({ kind, definition: d.contentDigest, key }),
        ),
      },
    };
  };
  const start = async (d = definition()) => {
    const input = control("start", d),
      q = authority(d.delegation),
      result = await plans.commitControl(input, { authority: q });
    return { input, q, result, d };
  };
  const admit = async (
    p: Awaited<ReturnType<typeof start>>,
    key = "plan-step-original",
    content = p.d.instruction,
    sources: ProjectStageSources = p.d.sources,
  ) => {
    const step = p.result.steps.find(
      (s) => s.stepId === p.result.plan.activeStepId,
    );
    assert.ok(step);
    const thread = await f.parent.loadThread({
      tenantId: f.actor.tenantId,
      threadId: b.binding.threadId,
    });
    assert.ok(thread);
    const command = {
      pluginId: f.pin.pluginId,
      threadId: b.binding.threadId,
      expectedThreadRevision: thread.revision,
      idempotencyKey: key,
      intent: { kind: "generate" as const, input: { prompt: content } },
    };
    const task = {
      binding: b.binding,
      stage:
        step.kind === "script"
          ? {
              kind: "script" as const,
              briefRevision: sources.brief!.briefRevision,
              episodeId: step.episodeId!,
              outline:
                sources.outline === null
                  ? null
                  : {
                      artifactId: sources.outline.artifactId,
                      contentRevision: sources.outline.contentRevision,
                    },
            }
          : {
              kind: step.kind,
              briefRevision: sources.brief!.briefRevision,
            },
      sources,
      content,
      authority: f.authority,
      conversations: f.store,
    };
    const planAuthority = {
      version: "crewon.project-text-plan-turn-commit.v1" as const,
      plan: p.result.plan,
      planRevision: p.d,
      step,
      authority: p.q,
    };
    return {
      command,
      task,
      planAuthority,
      result: await f.tasks.createProjectTextPlanTurnFromHost(
        f.actor,
        command,
        task,
        planAuthority,
      ),
    };
  };
  return {
    ...f,
    plans,
    text,
    binding: b.binding,
    state,
    planAuthority: authority,
    definition,
    control,
    start,
    admit,
  };
}
