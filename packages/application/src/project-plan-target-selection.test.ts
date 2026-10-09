import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { extensionCanonicalJson } from "@crewon/domain";
import { projectModelSelectionFixture } from "./project-model-selection.test-support.ts";
import {
  preparePluginTaskModelSelection,
  preparePluginTaskTargetSelection,
} from "./plugin-task-model-selection.ts";
import { ProjectTextPlanApplicationService } from "./project-text-plan-application-service.ts";
import type {
  ProjectTextPlanCommitAuthority,
  ProjectTextPlanStore,
} from "./project-text-plan-store-port.ts";
import {
  target as defaultTarget,
  timestamp,
} from "../../store/src/extension-store.test-support.ts";

/** Real original plan and Run writers. Readiness/model ownership are named offline boundaries. */
async function fixture(
  t: Parameters<typeof projectModelSelectionFixture>[0],
  backend: "sqlite" | "postgres",
  selectedAtCreation = false,
) {
  const f = await projectModelSelectionFixture(t, backend),
    plans = f.parent.projectTextPlanStore();
  await plans.migrate();
  const binding = (await f.store.loadBinding({
    actor: f.actor,
    profileId: f.installation.profileId,
    threadId: f.input.threadId,
  }))!;
  const q = (
    delegation: ProjectTextPlanCommitAuthority["delegation"],
  ): ProjectTextPlanCommitAuthority => ({
    version: "crewon.project-text-plan-commit.v1",
    actor: f.actor,
    binding,
    selection: f.authority.selection,
    package: f.authority.package,
    delegation,
    backgroundAuthorization: "available",
    prepareModelSelection: (input) =>
      input.selection.kind === "model"
        ? preparePluginTaskModelSelection(
            f.modelPort,
            {
              actor: f.actor,
              pin: f.authority.pin,
              configuration: input.configuration,
              modelId: input.selection.modelId,
            },
            f.digester,
          )
        : preparePluginTaskTargetSelection(
            f.modelPort,
            {
              actor: f.actor,
              pin: f.authority.pin,
              configuration: input.configuration,
              target: input.selection.target,
            },
            f.digester,
          ),
    assertCurrent: f.authority.assertCurrent,
    assertTransactionCurrent: f.authority.assertTransactionCurrent,
    assertActive: f.authority.assertActive,
  });
  const changeDefault = async (target: typeof defaultTarget) => {
    const previous = (await f.first.store.loadExtensionActivation({
      tenantId: f.actor.tenantId,
      spaceId: f.actor.spaceId,
      pluginId: f.pin.pluginId,
    }))!;
    const key = randomUUID();
    await f.first.store.saveExtensionActivation({
      activation: { ...previous, revision: previous.revision + 1, target },
      expectedRevision: previous.revision,
      receipt: {
        actorId: f.actor.actorId,
        idempotencyKey: key,
        requestDigest: f.digester.sha256(key),
      },
    });
  };
  // Capture a genuine plan while this model was the default, then change only the default.
  if (!selectedAtCreation) await changeDefault(f.modelTarget);
  const appDependencies = {
    plans,
    conversations: f.store,
    projects: f.metadata,
    texts: f.parent.projectTextStore(),
    extensions: f.first.store,
    authorization: {
      async authorize() {
        return { outcome: "allow" as const };
      },
    },
    clock: { now: () => timestamp },
    ids: { nextId: () => randomUUID() },
    digester: f.digester,
  };
  const app = new ProjectTextPlanApplicationService(appDependencies);
  const request = {
    ...(selectedAtCreation ? { modelId: "gpt-5.6-sol" } : {}),
    projectId: f.input.projectId,
    threadId: f.input.threadId,
    expectedBindingRevision: 1,
    expectedBriefRevision: 1,
    instruction: "整理一集大纲",
    start: "outline" as const,
    target: "outline" as const,
    episodes: { kind: "newOutline" as const, episodeCount: 1 },
    adoption: "manual" as const,
    idempotencyKey: "saved-model-plan",
  };
  const delegation = {
    kind: "pluginUi",
    contributionId: "workbench",
    actionId: "crewon.project-text-plans.v1.start",
    invocationId: "named-plan-start",
    idempotencyKey: request.idempotencyKey,
    inputDigest: f.digester.sha256(
      extensionCanonicalJson({
        action: "crewon.project-text-plans.v1.start",
        input: request,
      }),
    ),
  } as const;
  const creationAuthority = q(delegation);
  const started = await app.start(f.actor, request, creationAuthority);
  const locator = {
    actor: f.actor,
    profileId: f.installation.profileId,
    planId: started.view.plan.planId,
  };
  const plan = (await plans.loadPlan(locator))!,
    definition = (await plans.loadRevision({ ...locator, planRevision: 1 }))!,
    step = (await plans.listSteps({ ...locator, planRevision: 1 }))[0]!;
  assert.deepEqual(definition.target, f.modelTarget);
  await changeDefault(defaultTarget);
  const content = definition.instruction;
  const command = {
    pluginId: f.pin.pluginId,
    threadId: f.input.threadId,
    expectedThreadRevision: 1,
    idempotencyKey: "saved-model-plan-step",
    intent: { kind: "generate" as const, input: { prompt: content } },
  };
  const task = {
    binding,
    stage: { kind: "outline" as const, briefRevision: 1 },
    sources: definition.sources,
    content,
    authority: f.authority,
    conversations: f.store,
  };
  const planAuthority = {
    version: "crewon.project-text-plan-turn-commit.v1" as const,
    plan,
    planRevision: definition,
    step,
    authority: q(null),
  };
  return {
    ...f,
    appDependencies,
    app,
    request,
    creationAuthority,
    q,
    binding,
    plans,
    locator,
    command,
    task,
    planAuthority,
    definition,
  };
}
for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: saved plan keeps its exact model when the default changes and cold receipt replay never resolves a replacement`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const first = await f
        .createTasks()
        .createProjectTextPlanTurnFromHost(
          f.actor,
          f.command,
          f.task,
          f.planAuthority,
        );
      assert.deepEqual(first.result.binding.target, f.definition.target);
      assert.equal(
        first.result.run.state.agentVersionId,
        f.modelTarget.agentVersionId,
      );
      assert.equal(f.model.preparations, 1);
      assert.deepEqual(
        (await f.first.store.loadExtensionActivation(first.result.binding))!
          .target,
        defaultTarget,
      );
      assert.equal((await f.plans.loadPlan(f.locator))!.state, "running");
      const cold = f.second.parent.projectTextPlanStore();
      assert.deepEqual(
        await cold.loadRevision({ ...f.locator, planRevision: 1 }),
        f.definition,
      );
      f.model.live = false;
      const replay = await f
        .createTasks({ unavailable: true })
        .createProjectTextPlanTurnFromHost(
          f.actor,
          f.command,
          f.task,
          f.planAuthority,
        );
      assert.equal(replay.result.run.disposition, "replayed");
      assert.equal(replay.result.run.state.runId, first.result.run.state.runId);
      assert.deepEqual(replay.planAdmission, first.planAdmission);
      assert.equal(f.model.preparations, 1);
    },
  );
  test(
    `${backend}: an explicit plan model is persisted by the real plan transaction, replays cold, and resumes without switching to the default`,
    options,
    async (t) => {
      const f = await fixture(t, backend, true);
      assert.equal(f.model.preparations, 1);
      const { prepareModelSelection: _prepare, ...coldAuthority } =
        f.creationAuthority;
      const replay = await f.app.start(f.actor, f.request, coldAuthority);
      assert.equal(replay.disposition, "replayed");
      assert.equal(f.model.preparations, 1);
      await assert.rejects(
        f.app.start(
          f.actor,
          { ...f.request, modelId: "gpt-5.6-luna" },
          coldAuthority,
        ),
      );
      const control = {
        projectId: f.request.projectId,
        planId: f.locator.planId,
        expectedRevision: 1,
        idempotencyKey: "pause-selected-plan",
      };
      const paused = await f.app.pause(f.actor, control, f.q(null));
      assert.equal(paused.view.plan.state, "paused");
      const resume = {
        ...control,
        expectedRevision: paused.view.plan.revision,
        idempotencyKey: "resume-selected-plan",
      };
      const resumed = await f.app.resume(
        f.actor,
        resume,
        f.q({
          kind: "pluginUi",
          contributionId: "workbench",
          actionId: "crewon.project-text-plans.v1.resume",
          invocationId: "named-resume",
          idempotencyKey: resume.idempotencyKey,
          inputDigest: f.digester.sha256(
            extensionCanonicalJson({
              action: "crewon.project-text-plans.v1.resume",
              input: resume,
            }),
          ),
        }),
      );
      assert.equal(resumed.view.plan.state, "ready");
      assert.deepEqual(
        (await f.plans.loadRevision({ ...f.locator, planRevision: 2 }))!.target,
        f.modelTarget,
      );
      assert.equal(f.model.preparations, 2);
    },
  );
  for (const failure of ["copyGrant", "omitGrant", "withdraw"] as const)
    test(
      `${backend}: plan creation ${failure} rolls back without another plan or receipt`,
      options,
      async (t) => {
        const f = await fixture(t, backend, true);
        const methods = [
          "migrate",
          "loadPlan",
          "loadRevision",
          "loadStep",
          "listSteps",
          "listPlans",
          "loadMutationReceipt",
          "commitObservation",
          "commitSystemPause",
          "scanRecoverable",
          "readRequiredPlanDigest",
          "loadRunAdmission",
        ] as const;
        const plans = {
          version: f.plans.version,
          ...Object.fromEntries(
            methods.map((key) => [key, f.plans[key].bind(f.plans)]),
          ),
          commitControl(
            input: Parameters<ProjectTextPlanStore["commitControl"]>[0],
            options: Parameters<ProjectTextPlanStore["commitControl"]>[1],
          ) {
            const { pluginModelSelection, ...rest } = options;
            return f.plans.commitControl(
              input,
              failure === "omitGrant"
                ? rest
                : failure === "copyGrant"
                  ? {
                      ...rest,
                      pluginModelSelection: { ...pluginModelSelection! },
                    }
                  : options,
            );
          },
        } as ProjectTextPlanStore;
        if (failure === "withdraw")
          f.state.beforeTransaction = () => {
            f.model.live = false;
          };
        const app = new ProjectTextPlanApplicationService({
          ...f.appDependencies,
          plans,
        });
        const request = { ...f.request, idempotencyKey: `invalid-${failure}` };
        await assert.rejects(
          app.start(
            f.actor,
            request,
            f.q({
              kind: "pluginUi",
              contributionId: "workbench",
              actionId: "crewon.project-text-plans.v1.start",
              invocationId: "named-invalid-start",
              idempotencyKey: request.idempotencyKey,
              inputDigest: f.digester.sha256(
                extensionCanonicalJson({
                  action: "crewon.project-text-plans.v1.start",
                  input: request,
                }),
              ),
            }),
          ),
          failure === "withdraw"
            ? (error: unknown) =>
                error instanceof Error &&
                error.cause instanceof Error &&
                error.cause.message === "named_model_owner_withdrawn"
            : failure === "omitGrant"
              ? /configuration_changed/
              : /model_selection_invalid/,
        );
        assert.equal((await f.plans.loadPlan(f.locator))!.revision, 1);
        const page = await f.plans.listPlans({
          actor: f.actor,
          profileId: f.installation.profileId,
          projectId: request.projectId,
          afterPlanId: null,
          limit: 16,
        });
        assert.equal(page.plans.length, 1);
      },
    );
  for (const failure of [
    "unavailable",
    "copyGrant",
    "omitGrant",
    "withdraw",
  ] as const)
    test(
      `${backend}: ${failure} cannot substitute the default for a saved plan or leave a partial Run`,
      options,
      async (t) => {
        const f = await fixture(t, backend);
        if (failure === "withdraw")
          f.state.beforeTransaction = () => {
            f.model.live = false;
          };
        const tasks = f.createTasks(
          failure === "withdraw" ? {} : { [failure]: true },
        );
        await assert.rejects(
          tasks.createProjectTextPlanTurnFromHost(
            f.actor,
            f.command,
            f.task,
            f.planAuthority,
          ),
        );
        assert.equal(
          (await f.parent.loadThreadInSpace({
            ...f.actor,
            threadId: f.input.threadId,
          }))!.revision,
          1,
        );
        assert.equal((await f.plans.loadPlan(f.locator))!.state, "ready");
        assert.equal(
          (await f.plans.listSteps({ ...f.locator, planRevision: 1 }))[0]!.run,
          null,
        );
      },
    );
}
