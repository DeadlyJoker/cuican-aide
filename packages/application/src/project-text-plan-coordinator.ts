import type { ActorContext } from "./authorization-port.ts";
import type { ProjectStructuredOutlineApplicationService } from "./project-structured-outline-application-service.ts";
import { readProjectOutlineSourceRevision } from "./project-outline-source-reader.ts";
import { captureProjectTextPlanCoordinatorDependencies } from "./project-text-plan-dependencies.ts";
import {
  extensionCanonicalJson,
  validateCreativeProject,
  parseProjectTextPlan,
  parseProjectTextPlanRevision,
  parseProjectTextPlanStep,
  parseProjectTextPlanRunAdmission,
  parseProjectTextArtifact,
  parseProjectBriefRevision,
  type ProjectTextPlan,
  type ProjectTextPlanRevision,
  type ProjectTextPlanStep,
  type ProjectStageSources,
  type ProjectConversationStage,
} from "@crewon/domain";
import type {
  ProjectTextPlanStore,
  ProjectTextPlanLocator,
  ProjectTextPlanSelectionCommitAuthority,
} from "./project-text-plan-store-port.ts";
import type {
  ProjectTextPlanContinuationPort,
  ProjectTextPlanContinuationAuthority,
} from "./project-text-plan-continuation-port.ts";
import type { CreativeProjectStore } from "./creative-project-store-port.ts";
import type { ProjectTextStore } from "./project-text-store-port.ts";
import type { ProjectConversationStore } from "./project-conversation-store-port.ts";
import type { ThreadStore } from "./thread-store-port.ts";
import type { RunStore } from "./run-store-port.ts";
import type { ExtensionTaskApplicationService } from "./extension-task-application-service.ts";
import type { ProjectTextApplicationService } from "./project-text-application-service.ts";
import type {
  ApplicationClock,
  ContentDigester,
} from "./application-runtime-ports.ts";
import { captureProjectTextPlanCommitAuthority } from "./project-text-plan-authority.ts";
import { captureProjectConversationAuthority } from "./project-conversation-authority.ts";
import { ApplicationError } from "./application-error.ts";

export type ProjectTextPlanCoordinatorDependencies = Readonly<{
  plans: ProjectTextPlanStore;
  continuation: ProjectTextPlanContinuationPort;
  projects: Pick<CreativeProjectStore, "loadProject" | "loadBrief">;
  texts: Pick<
    ProjectTextStore,
    "loadOutline" | "loadScript" | "loadRevision" | "loadOutlineSourceRevision"
  >;
  conversations: Pick<
    ProjectConversationStore,
    "loadBinding" | "loadStageAdmission"
  >;
  threads: Pick<ThreadStore, "loadThreadInSpace">;
  runs: Pick<RunStore, "loadRunInSpace" | "listRunEvents">;
  tasks: Pick<
    ExtensionTaskApplicationService,
    "createProjectTextPlanTurnFromHost"
  >;
  textCommands: Pick<ProjectTextApplicationService, "selectRevision">;
  structuredOutlines?: Pick<
    ProjectStructuredOutlineApplicationService,
    "selectRevision"
  >;
  clock: ApplicationClock;
  digester: ContentDigester;
}>;
export type ProjectTextPlanProcessResult =
  | "unchanged"
  | "observing"
  | "admitted"
  | "checkpointed"
  | "waitingSelection"
  | "selected"
  | "paused";
/** One bounded real checkpoint per call. No timer, model invocation or synthetic Run is owned here. */
export class ProjectTextPlanCoordinator {
  readonly #d: ProjectTextPlanCoordinatorDependencies;
  constructor(d: ProjectTextPlanCoordinatorDependencies) {
    this.#d = captureProjectTextPlanCoordinatorDependencies(d);
  }
  process(
    locator: ProjectTextPlanLocator,
    signal: AbortSignal,
  ): Promise<ProjectTextPlanProcessResult> {
    signal.throwIfAborted();
    return this.#d.continuation.run(locator, signal, async (supplied) => {
      const q: ProjectTextPlanContinuationAuthority = {
        plan: captureProjectTextPlanCommitAuthority(supplied.plan),
        conversation: captureProjectConversationAuthority(
          supplied.conversation,
        ),
        prepareExecution: supplied.prepareExecution.bind(supplied),
      };
      await q.plan.assertCurrent();
      q.plan.assertActive();
      signal.throwIfAborted();
      const raw = await this.#d.plans.loadPlan(locator);
      if (raw === null) return "unchanged";
      const plan = parseProjectTextPlan(raw, this.#d.digester);
      if (
        plan.state === "paused" ||
        plan.state === "completed" ||
        plan.state === "revoked"
      )
        return "unchanged";
      const definitionRaw = await this.#d.plans.loadRevision({
        ...locator,
        planRevision: plan.currentPlanRevision,
      });
      if (definitionRaw === null) invalid();
      const definition = parseProjectTextPlanRevision(
          definitionRaw,
          this.#d.digester,
        ),
        steps = (
          await this.#d.plans.listSteps({
            ...locator,
            planRevision: plan.currentPlanRevision,
          })
        ).map((x) => parseProjectTextPlanStep(x, this.#d.digester)),
        step = steps.find((x) => x.stepId === plan.activeStepId);
      if (
        step === undefined ||
        steps.length > 18 ||
        definition.planId !== plan.planId ||
        definition.planRevision !== plan.currentPlanRevision ||
        extensionCanonicalJson(plan.owner) !==
          extensionCanonicalJson(q.plan.actor) ||
        extensionCanonicalJson(definition.installation) !==
          extensionCanonicalJson(q.conversation.installation) ||
        definition.bindingId !== q.plan.binding.bindingId ||
        definition.bindingRevision !== q.plan.binding.revision ||
        plan.workspaceId !== q.plan.binding.workspaceId
      )
        denied();
      try {
        if (plan.state === "running")
          return await this.#observe(locator, plan, step, q, signal);
        if (plan.state === "waitingSelection") {
          if (definition.adoption === "manual") return "waitingSelection";
          return await this.#select(plan, definition, step, q, signal);
        }
        if (
          plan.state !== "ready" ||
          step.state !== "ready" ||
          step.run !== null
        )
          invalid();
        return await this.#admit(plan, definition, step, steps, q, signal);
      } catch (error) {
        const reason = projectTextPlanDeterministicPauseReason(error);
        if (reason === null) throw error;
        signal.throwIfAborted();
        await q.plan.assertCurrent();
        q.plan.assertActive();
        await this.#d.plans.commitSystemPause(
          {
            owner: { actor: locator.actor, profileId: locator.profileId },
            planId: plan.planId,
            expectedRevision: plan.revision,
            stepId: step.stepId,
            expectedStepRevision: step.revision,
            reason,
            at: this.#d.clock.now(),
          },
          { authority: q.plan },
        );
        return "paused";
      }
    });
  }
  async #observe(
    locator: ProjectTextPlanLocator,
    plan: ProjectTextPlan,
    step: ProjectTextPlanStep,
    q: ProjectTextPlanContinuationAuthority,
    signal: AbortSignal,
  ): Promise<ProjectTextPlanProcessResult> {
    if (step.run === null) invalid();
    const run = await this.#d.runs.loadRunInSpace({
      tenantId: plan.owner.tenantId,
      spaceId: plan.owner.spaceId,
      runId: step.run.runId,
    });
    if (
      run === null ||
      run.threadId !== plan.threadId ||
      run.createdByActorId !== plan.owner.actorId
    )
      invalid();
    if (!["completed", "failed", "canceled"].includes(run.status))
      return "observing";
    const events = await this.#d.runs.listRunEvents(
        { tenantId: plan.owner.tenantId, runId: run.runId },
        Math.max(0, run.lastSequence - 32),
        32,
      ),
      event = [...events].reverse().find((x) => x.type === `run.${run.status}`);
    if (event === undefined || event.identity.runId !== run.runId) invalid();
    signal.throwIfAborted();
    await this.#d.plans.commitObservation(
      {
        owner: { actor: locator.actor, profileId: locator.profileId },
        planId: plan.planId,
        expectedRevision: plan.revision,
        stepId: step.stepId,
        expectedStepRevision: step.revision,
        run,
        terminal: {
          eventId: event.eventId,
          throughSequence: event.sequence,
          runRevision: run.revision,
          status: run.status as "completed" | "failed" | "canceled",
        },
        at: this.#d.clock.now(),
      },
      { authority: q.plan },
    );
    return "checkpointed";
  }
  async #select(
    plan: ProjectTextPlan,
    definition: ProjectTextPlanRevision,
    step: ProjectTextPlanStep,
    q: ProjectTextPlanContinuationAuthority,
    signal: AbortSignal,
  ): Promise<ProjectTextPlanProcessResult> {
    if (
      step.result === null ||
      step.result.kind === "brief" ||
      step.terminal?.status !== "completed" ||
      step.run === null
    )
      invalid();
    const raw = await this.#d.plans.loadRunAdmission({
      tenantId: plan.owner.tenantId,
      spaceId: plan.owner.spaceId,
      runId: step.run.runId,
    });
    if (raw === null) invalid();
    const admission = parseProjectTextPlanRunAdmission(raw, this.#d.digester);
    const scope = {
      owner: {
        tenantId: plan.owner.tenantId,
        spaceId: plan.owner.spaceId,
        principalId: plan.owner.principalId,
      },
      projectId: plan.projectId,
    };
    const rawHead =
      step.kind === "outline"
        ? await this.#d.texts.loadOutline(scope)
        : await this.#d.texts.loadScript({
            ...scope,
            episodeId: step.episodeId!,
          });
    if (rawHead === null) invalid();
    if (parseProjectTextArtifact(rawHead).locked)
      throw new ApplicationError("conflict", "project_text_plan_locked");
    const input = {
      projectId: plan.projectId,
      artifactId: step.result.artifactId!,
      contentRevision: step.result.contentRevision!,
      expectedArtifactRevision: step.result.artifactRevision!,
      idempotencyKey: this.#key("select", plan, step),
    };
    const tx: ProjectTextPlanSelectionCommitAuthority = {
      version: "crewon.project-text-plan-selection-commit.v1",
      plan,
      planRevision: definition,
      step,
      admission,
      result: step.result,
      input,
      authority: q.plan,
      assertCurrent: async () => {
        signal.throwIfAborted();
        await q.plan.assertTransactionCurrent();
        q.plan.assertActive();
        signal.throwIfAborted();
      },
    };
    let selectRevision: (
      actor: ActorContext,
      input: Parameters<ProjectTextApplicationService["selectRevision"]>[1],
      options?: Parameters<ProjectTextApplicationService["selectRevision"]>[2],
    ) => Promise<unknown> = this.#d.textCommands.selectRevision;
    if (step.kind === "outline") {
      const rawProject = await this.#d.projects.loadProject(scope);
      if (rawProject === null) invalid();
      const source = await readProjectOutlineSourceRevision({
        store: this.#d.texts,
        scope,
        project: validateCreativeProject(rawProject),
        artifact: parseProjectTextArtifact(rawHead),
        contentRevision: input.contentRevision,
        digester: this.#d.digester,
      });
      if (source.schemaVersion === "crewon.project-text-revision.v2") {
        if (this.#d.structuredOutlines === undefined)
          throw new ApplicationError(
            "conflict",
            "project_text_plan_execution_unavailable",
          );
        selectRevision = this.#d.structuredOutlines.selectRevision;
      }
    }
    signal.throwIfAborted();
    await selectRevision(plan.owner, input, {
      authority: {
        assertCurrent: q.plan.assertCurrent,
        assertActive: q.plan.assertActive,
        planTransaction: tx,
      },
    });
    return "selected";
  }
  async #admit(
    plan: ProjectTextPlan,
    definition: ProjectTextPlanRevision,
    step: ProjectTextPlanStep,
    steps: readonly ProjectTextPlanStep[],
    q: ProjectTextPlanContinuationAuthority,
    signal: AbortSignal,
  ): Promise<ProjectTextPlanProcessResult> {
    await this.#baseline(plan, definition, step);
    const sources = await this.#sources(plan, definition, step, steps),
      thread = await this.#d.threads.loadThreadInSpace({
        tenantId: plan.owner.tenantId,
        spaceId: plan.owner.spaceId,
        threadId: plan.threadId,
      });
    if (
      thread === null ||
      thread.status !== "active" ||
      (thread.workspaceId ?? null) !== plan.workspaceId
    )
      denied();
    const stage: ProjectConversationStage =
      step.kind === "script"
        ? {
            kind: "script",
            episodeId: step.episodeId!,
            briefRevision: sources.brief!.briefRevision,
            outline:
              sources.outline === null
                ? null
                : {
                    artifactId: sources.outline.artifactId,
                    contentRevision: sources.outline.contentRevision,
                  },
          }
        : { kind: step.kind, briefRevision: sources.brief!.briefRevision };
    const content = projectTextPlanStepInstruction(definition, step, sources),
      key = this.#key("run", plan, step);
    signal.throwIfAborted();
    const execute = captureProjectConversationAuthority(
      await q.prepareExecution(),
    );
    if (
      extensionCanonicalJson(execute.actor) !==
        extensionCanonicalJson(plan.owner) ||
      extensionCanonicalJson(execute.installation) !==
        extensionCanonicalJson(definition.installation)
    )
      denied();
    await execute.assertCurrent();
    execute.assertActive();
    await this.#d.tasks.createProjectTextPlanTurnFromHost(
      plan.owner,
      {
        pluginId: definition.installation.pluginId,
        threadId: plan.threadId,
        expectedThreadRevision: thread.revision,
        idempotencyKey: key,
        intent: { kind: "generate", input: { prompt: content } },
      },
      {
        binding: q.plan.binding,
        stage,
        sources,
        content,
        authority: execute,
        conversations: this.#d.conversations,
      },
      {
        version: "crewon.project-text-plan-turn-commit.v1",
        plan,
        planRevision: definition,
        step,
        authority: q.plan,
      },
    );
    return "admitted";
  }
  async #baseline(
    plan: ProjectTextPlan,
    definition: ProjectTextPlanRevision,
    step: ProjectTextPlanStep,
  ): Promise<void> {
    if (step.kind === "brief") return;
    const scope = {
      owner: {
        tenantId: plan.owner.tenantId,
        spaceId: plan.owner.spaceId,
        principalId: plan.owner.principalId,
      },
      projectId: plan.projectId,
    };
    const raw =
      step.kind === "outline"
        ? await this.#d.texts.loadOutline(scope)
        : await this.#d.texts.loadScript({
            ...scope,
            episodeId: step.episodeId!,
          });
    const head = raw === null ? null : parseProjectTextArtifact(raw),
      expected = definition.baselines.find(
        (x) => x.kind === step.kind && x.episodeId === step.episodeId,
      );
    if (head?.locked)
      throw new ApplicationError("conflict", "project_text_plan_locked");
    if (
      expected === undefined ||
      extensionCanonicalJson(expected) !==
        extensionCanonicalJson({
          kind: step.kind,
          episodeId: step.episodeId,
          artifactId: head?.artifactId ?? null,
          artifactRevision: head?.revision ?? 0,
          selectedContentRevision: head?.selectedContentRevision ?? null,
          locked: head?.locked ?? false,
        })
    )
      throw new ApplicationError(
        "conflict",
        "project_text_plan_selection_changed",
      );
  }
  async #sources(
    plan: ProjectTextPlan,
    definition: ProjectTextPlanRevision,
    step: ProjectTextPlanStep,
    steps: readonly ProjectTextPlanStep[],
  ): Promise<ProjectStageSources> {
    const owner = {
        tenantId: plan.owner.tenantId,
        spaceId: plan.owner.spaceId,
        principalId: plan.owner.principalId,
      },
      scope = { owner, projectId: plan.projectId },
      project = await this.#d.projects.loadProject(scope);
    if (project === null || project.state !== "active") denied();
    const ownBrief = steps.find(
        (x) => x.kind === "brief" && x.state === "succeeded",
      )?.result,
      expected =
        ownBrief?.kind === "brief"
          ? {
              briefRevision: ownBrief.briefRevision!,
              contentDigest: ownBrief.contentDigest,
            }
          : definition.sources.brief;
    if (
      expected === null ||
      project.latestBriefRevision !== expected.briefRevision
    )
      changed();
    const rawBrief = await this.#d.projects.loadBrief({
      ...scope,
      briefRevision: expected.briefRevision,
    });
    if (rawBrief === null) invalid();
    const brief = parseProjectBriefRevision(rawBrief, this.#d.digester);
    if (brief.contentDigest !== expected.contentDigest) changed();
    if (
      step.kind !== "script" ||
      definition.episodeMode === "independentScripts"
    )
      return { brief: expected, outline: null };
    const ownOutline = steps.find(
        (x) => x.kind === "outline" && x.state === "succeeded",
      )?.result,
      ref =
        ownOutline?.kind === "outline"
          ? {
              artifactId: ownOutline.artifactId!,
              contentRevision: ownOutline.contentRevision!,
              contentDigest: ownOutline.contentDigest,
            }
          : definition.sources.outline;
    if (ref === null) changed();
    const rawHead = await this.#d.texts.loadOutline(scope);
    if (rawHead === null) changed();
    const head = parseProjectTextArtifact(rawHead);
    if (
      head.artifactId !== ref.artifactId ||
      head.selectedContentRevision !== ref.contentRevision
    )
      changed();
    const revision = await readProjectOutlineSourceRevision({
      store: this.#d.texts,
      scope,
      project,
      artifact: head,
      contentRevision: ref.contentRevision,
      digester: this.#d.digester,
    });
    if (
      revision.kind !== "outline" ||
      revision.contentDigest !== ref.contentDigest ||
      revision.brief.briefRevision !== expected.briefRevision ||
      revision.brief.contentDigest !== expected.contentDigest ||
      !revision.content.episodes.some((x) => x.episodeId === step.episodeId)
    )
      changed();
    return { brief: expected, outline: ref };
  }
  #key(kind: string, plan: ProjectTextPlan, step: ProjectTextPlanStep) {
    return `plan-${kind}:${this.#d.digester.sha256(extensionCanonicalJson({ planId: plan.planId, planRevision: step.planRevision, stepId: step.stepId, attempt: step.attempt })).slice(7)}`;
  }
}
export function projectTextPlanStepInstruction(
  definition: ProjectTextPlanRevision,
  step: ProjectTextPlanStep,
  sources: ProjectStageSources,
): string {
  const instruction = `${definition.instruction}\n\nExecute only this authorized text stage: ${step.kind}. Save exactly one validated ${step.kind} result through the project tool. Do not select or lock text, create projects, or invoke media tools. Project: ${definition.projectId}. Sources: ${extensionCanonicalJson(sources)}.${step.kind === "outline" ? ` The outline episodes must use exactly these IDs in this order: ${extensionCanonicalJson(definition.episodeIds)}.` : step.kind === "script" ? ` Episode: ${step.episodeId}.` : ""}`;
  if (Buffer.byteLength(instruction, "utf8") > 9999)
    throw new ApplicationError(
      "validation",
      "project_text_plan_instruction_limit",
    );
  return instruction;
}
function invalid(): never {
  throw new ApplicationError(
    "internal",
    "project_text_plan_store_result_invalid",
  );
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "project_text_plan_continuation_denied",
  );
}
function changed(): never {
  throw new ApplicationError("conflict", "project_text_plan_source_changed");
}

function projectTextPlanDeterministicPauseReason(
  error: unknown,
): Exclude<NonNullable<ProjectTextPlan["pauseReason"]>, "user_paused"> | null {
  const code =
    error instanceof ApplicationError
      ? error.code
      : error instanceof Error
        ? error.message
        : null;
  switch (code) {
    case "project_text_plan_source_changed":
    case "project_outline_inputs_stale":
      return "source_changed";
    case "project_outline_quality_failed":
      return "result_invalid";
    case "project_text_plan_selection_changed":
      return "selection_changed";
    case "project_text_plan_locked":
      return "locked";
    case "project_text_plan_binding_changed":
      return "binding_changed";
    case "project_text_plan_installation_changed":
    case "project_text_plan_execution_unavailable":
    case "project_text_plan_configuration_changed":
      return "installation_changed";
    case "project_text_plan_authorization_unavailable":
      return "authorization_unavailable";
    default:
      // A failed committing task may wrap the same deterministic v2 source conflict.
      // Inspect bounded data properties only; never reinterpret arbitrary internal errors.
      for (
        let current = error, depth = 0;
        current instanceof Error && depth < 8;
        depth++
      ) {
        if (
          Object.getOwnPropertyDescriptor(current, "message")?.value ===
          "project_outline_inputs_stale"
        )
          return "source_changed";
        const cause = Object.getOwnPropertyDescriptor(current, "cause");
        if (cause === undefined || !Object.hasOwn(cause, "value")) break;
        current = cause.value;
      }
      return null;
  }
}
