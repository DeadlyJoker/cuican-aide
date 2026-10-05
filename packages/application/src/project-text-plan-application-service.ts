import {
  PROJECT_TEXT_PLANS_METHOD_ACTIONS,
  parseProjectTextPlansActionRequest,
  parseProjectTextPlansActionResponse,
  type ProjectTextPlansActionRequest,
  type ProjectTextPlansRequests,
  type ProjectTextPlansResponses,
  type ProjectTextPlansMethod,
  type ProjectTextPlanDefinitionInput,
} from "@crewon/contracts/project-text-plans";
import {
  extensionCanonicalJson,
  validateCreativeProject,
  parseProjectBriefRevision,
  parseProjectTextArtifact,
  parseProjectTextArtifactRevision,
  parseProjectConversationBinding,
  parseExtensionConfiguration,
  parseExtensionActivation,
  createProjectTextPlanRevision,
  parseProjectTextPlan,
  parseProjectTextPlanRevision,
  parseProjectTextPlanStep,
  applyProjectTextPlanControl,
  projectTextPlanStepKinds,
  type ProjectTextPlan,
  type ProjectTextPlanRevision,
  type ProjectTextPlanStep,
  type ProjectTextPlanHeadBaseline,
  type ProjectStageSources,
} from "@crewon/domain";
import type {
  ProjectTextPlanStore,
  ProjectTextPlanCommitAuthority,
  ProjectTextPlanMutation,
  ProjectTextPlanReceipt,
} from "./project-text-plan-store-port.ts";
import type {
  ProjectConversationStore,
  ProjectConversationCommitAuthority,
} from "./project-conversation-store-port.ts";
import type { CreativeProjectStore } from "./creative-project-store-port.ts";
import type { ProjectTextStore } from "./project-text-store-port.ts";
import type { ExtensionStore } from "./extension-store-port.ts";
import type { CreativeProjectAuthorizationPort } from "./creative-project-authorization-port.ts";
import type {
  ApplicationClock,
  ApplicationIdGenerator,
  ContentDigester,
} from "./application-runtime-ports.ts";
import type { ActorContext } from "./authorization-port.ts";
import { captureProjectTextPlanCommitAuthority } from "./project-text-plan-authority.ts";
import {
  captureProjectConversationAuthority,
  assertProjectConversationActor,
} from "./project-conversation-authority.ts";
import { captureProjectTextPlanDependencies } from "./project-text-plan-dependencies.ts";
import {
  projectTextPlanSummary,
  projectTextPlanView,
} from "./project-text-plan-projection.ts";
import { ApplicationError } from "./application-error.ts";
import { assertProjectTextPlanResumeSources } from "./project-text-plan-resume-sources.ts";

export type ProjectTextPlanApplicationDependencies = Readonly<{
  plans: ProjectTextPlanStore;
  conversations: Pick<ProjectConversationStore, "loadBinding">;
  projects: Pick<CreativeProjectStore, "loadProject" | "loadBrief">;
  texts: Pick<ProjectTextStore, "loadOutline" | "loadScript" | "loadRevision">;
  extensions: Pick<
    ExtensionStore,
    "loadLatestExtensionConfiguration" | "loadExtensionActivation"
  >;
  authorization: CreativeProjectAuthorizationPort;
  clock: ApplicationClock;
  ids: ApplicationIdGenerator;
  digester: ContentDigester;
}>;
const actualPlanServices = new WeakSet<object>();
export function isProjectTextPlanApplicationService(
  input: unknown,
): input is ProjectTextPlanApplicationService {
  return (
    input !== null && typeof input === "object" && actualPlanServices.has(input)
  );
}
/** Fixed bounded text plans. This service never calls a model, supplier or Node setup. */
export class ProjectTextPlanApplicationService {
  readonly #d: ProjectTextPlanApplicationDependencies;
  constructor(d: ProjectTextPlanApplicationDependencies) {
    this.#d = captureProjectTextPlanDependencies(d);
    actualPlanServices.add(this);
    Object.freeze(this);
  }
  async get(
    actor: ActorContext,
    input: ProjectTextPlansRequests["get"],
    authority: ProjectConversationCommitAuthority,
  ): Promise<ProjectTextPlansResponses["get"]> {
    return this.#call(async () => {
      const request = this.#request("get", input),
        q = await this.#readAuthority(actor, authority);
      await this.#project(q.actor, request.projectId, "creativeProject:read");
      const plan = await this.#load(
        q.actor,
        q.installation.profileId,
        request.planId,
      );
      if (plan !== null && plan.projectId !== request.projectId) missing();
      const view = plan === null ? null : await this.#view(plan);
      await q.assertCurrent();
      q.assertActive();
      return this.#output("get", request, { view });
    });
  }
  async list(
    actor: ActorContext,
    input: ProjectTextPlansRequests["list"],
    authority: ProjectConversationCommitAuthority,
  ): Promise<ProjectTextPlansResponses["list"]> {
    return this.#call(async () => {
      const request = this.#request("list", input),
        q = await this.#readAuthority(actor, authority);
      await this.#project(q.actor, request.projectId, "creativeProject:read");
      const page = await this.#d.plans.listPlans({
        actor: q.actor,
        profileId: q.installation.profileId,
        ...request,
      });
      if (page.plans.length > request.limit) invalid();
      let plans = page.plans.map((p) => {
          const parsed = parseProjectTextPlan(p, this.#d.digester);
          if (
            parsed.projectId !== request.projectId ||
            extensionCanonicalJson(parsed.owner) !==
              extensionCanonicalJson(q.actor) ||
            parsed.profileId !== q.installation.profileId
          )
            invalid();
          return projectTextPlanSummary(parsed);
        }),
        nextPlanId = page.nextPlanId;
      while (
        plans.length > 0 &&
        Buffer.byteLength(JSON.stringify({ plans, nextPlanId }), "utf8") >
          24 * 1024
      ) {
        plans.pop();
        nextPlanId = plans.at(-1)?.planId ?? null;
      }
      if (page.plans.length > 0 && plans.length === 0) invalid();
      await q.assertCurrent();
      q.assertActive();
      return this.#output("list", request, { plans, nextPlanId });
    });
  }
  start(
    actor: ActorContext,
    input: ProjectTextPlansRequests["start"],
    authority: ProjectTextPlanCommitAuthority,
  ): Promise<ProjectTextPlansResponses["start"]> {
    return this.#mutate("start", actor, input, authority);
  }
  pause(
    actor: ActorContext,
    input: ProjectTextPlansRequests["pause"],
    authority: ProjectTextPlanCommitAuthority,
  ): Promise<ProjectTextPlansResponses["pause"]> {
    return this.#mutate("pause", actor, input, authority);
  }
  revoke(
    actor: ActorContext,
    input: ProjectTextPlansRequests["revoke"],
    authority: ProjectTextPlanCommitAuthority,
  ): Promise<ProjectTextPlansResponses["revoke"]> {
    return this.#mutate("revoke", actor, input, authority);
  }
  resume(
    actor: ActorContext,
    input: ProjectTextPlansRequests["resume"],
    authority: ProjectTextPlanCommitAuthority,
  ): Promise<ProjectTextPlansResponses["resume"]> {
    return this.#mutate("resume", actor, input, authority);
  }
  reviseRemaining(
    actor: ActorContext,
    input: ProjectTextPlansRequests["reviseRemaining"],
    authority: ProjectTextPlanCommitAuthority,
  ): Promise<ProjectTextPlansResponses["reviseRemaining"]> {
    return this.#mutate("reviseRemaining", actor, input, authority);
  }
  continue(
    actor: ActorContext,
    input: ProjectTextPlansRequests["continue"],
    authority: ProjectTextPlanCommitAuthority,
  ): Promise<ProjectTextPlansResponses["continue"]> {
    return this.#mutate("continue", actor, input, authority);
  }
  #mutate<M extends Exclude<ProjectTextPlansMethod, "get" | "list">>(
    method: M,
    actor: ActorContext,
    input: ProjectTextPlansRequests[M],
    authority: ProjectTextPlanCommitAuthority,
  ): Promise<ProjectTextPlansResponses[M]> {
    return this.#call(async () => {
      const request = this.#request(method, input),
        q = captureProjectTextPlanCommitAuthority(authority);
      if (extensionCanonicalJson(actor) !== extensionCanonicalJson(q.actor))
        denied();
      await q.assertCurrent();
      q.assertActive();
      await this.#project(q.actor, request.projectId, "creativeProject:write");
      const receipt: ProjectTextPlanReceipt = Object.freeze({
        actor: q.actor,
        idempotencyKey: request.idempotencyKey,
        requestDigest: this.#d.digester.sha256(
          extensionCanonicalJson({
            version: "crewon.project-text-plan-command.v1",
            actor: q.actor,
            profileId: q.binding.profileId,
            method,
            input: request,
          }),
        ),
      });
      const prior = await this.#d.plans.loadMutationReceipt({
        actor: q.actor,
        profileId: q.binding.profileId,
        receipt,
      });
      if (prior !== null) {
        await q.assertCurrent();
        q.assertActive();
        return this.#mutation(method, request, prior);
      }
      if (["start", "resume", "reviseRemaining"].includes(method))
        this.#delegation(method, request, q);
      let previous: ProjectTextPlan | null = null,
        previousRevision: ProjectTextPlanRevision | null = null,
        previousSteps: readonly ProjectTextPlanStep[] = [],
        definition: ProjectTextPlanRevision;
      const at = this.#d.clock.now();
      if (method === "start") {
        const value = request as ProjectTextPlansRequests["start"];
        if (
          q.binding.projectId !== value.projectId ||
          q.binding.threadId !== value.threadId ||
          q.binding.revision !== value.expectedBindingRevision
        )
          conflict("project_conversation_revision_conflict");
        definition = await this.#definition(
          q,
          value,
          `plan-${this.#d.ids.nextId("artifact")}`,
          1,
          at,
        );
      } else {
        const value = request as ProjectTextPlansRequests["pause"];
        previous = await this.#load(q.actor, q.binding.profileId, value.planId);
        if (previous === null || previous.projectId !== value.projectId)
          missing();
        if (previous.revision !== value.expectedRevision)
          conflict("project_text_plan_revision_conflict");
        if (
          previous.bindingId !== q.binding.bindingId ||
          previous.threadId !== q.binding.threadId
        )
          denied();
        const record = await this.#records(previous);
        previousRevision = record.definition;
        previousSteps = record.steps;
        if (method === "reviseRemaining")
          definition = await this.#definition(
            q,
            request as ProjectTextPlansRequests["reviseRemaining"],
            previous.planId,
            previous.currentPlanRevision + 1,
            at,
          );
        else if (method === "resume") {
          const project = await this.#project(
              q.actor,
              previous.projectId,
              "creativeProject:write",
            ),
            old = previousRevision;
          const remaining = previousSteps.filter(
              (x) => x.state !== "succeeded",
            ),
            start = remaining[0]?.kind;
          if (start === undefined)
            conflict("project_text_plan_remaining_scope_invalid");
          const ids =
              start === "script"
                ? remaining
                    .filter((x) => x.kind === "script")
                    .map((x) => x.episodeId!)
                : old.episodeIds,
            episodeMode =
              old.targetStage === "brief"
                ? "none"
                : start === "script"
                  ? old.episodeMode === "independentScripts"
                    ? "independentScripts"
                    : "selectedOutline"
                  : "newOutline";
          definition = await this.#definition(
            q,
            {
              expectedBriefRevision: project.latestBriefRevision,
              instruction: old.instruction,
              start,
              target: old.targetStage,
              episodes:
                episodeMode === "none"
                  ? null
                  : episodeMode === "newOutline"
                    ? { kind: "newOutline", episodeCount: ids.length }
                    : { kind: episodeMode, episodeIds: ids },
              adoption: old.adoption,
            },
            previous.planId,
            previous.currentPlanRevision + 1,
            at,
            ids,
          );
          assertProjectTextPlanResumeSources(old, previousSteps, definition);
        } else definition = previousRevision;
      }
      const newKinds = projectTextPlanStepKinds(definition).filter(
          (item) =>
            !previousSteps.some(
              (s) =>
                s.kind === item.kind &&
                s.episodeId === item.episodeId &&
                s.state === "succeeded",
            ),
        ),
        stepIds = ["start", "resume", "reviseRemaining"].includes(method)
          ? newKinds.map(() => `step-${this.#d.ids.nextId("artifact")}`)
          : [];
      const prepared = applyProjectTextPlanControl(
        {
          kind: method,
          previous,
          previousRevision,
          previousSteps,
          definition,
          stepIds,
          at,
          authorizationUnavailable: q.backgroundAuthorization === "unavailable",
        },
        this.#d.digester,
      );
      const result = await this.#d.plans.commitControl(
        {
          kind: method,
          plan: prepared.plan,
          expectedRevision: previous?.revision ?? 0,
          planRevision: definition,
          steps: prepared.steps,
          receipt,
        },
        { authority: q },
      );
      return this.#mutation(method, request, result);
    });
  }
  async #definition(
    q: ProjectTextPlanCommitAuthority,
    input: ProjectTextPlanDefinitionInput,
    planId: string,
    planRevision: number,
    at: string,
    preservedIds?: readonly string[],
  ): Promise<ProjectTextPlanRevision> {
    const project = await this.#project(
      q.actor,
      q.binding.projectId,
      "creativeProject:write",
    );
    if (project.latestBriefRevision !== input.expectedBriefRevision)
      conflict("project_text_plan_source_changed");
    const owner = {
        tenantId: q.actor.tenantId,
        spaceId: q.actor.spaceId,
        principalId: q.actor.principalId,
      },
      scope = { owner, projectId: project.projectId },
      rawBrief = await this.#d.projects.loadBrief({
        ...scope,
        briefRevision: input.expectedBriefRevision,
      });
    if (rawBrief === null) missing();
    const brief = parseProjectBriefRevision(rawBrief, this.#d.digester);
    let sources: ProjectStageSources = {
        brief: {
          briefRevision: brief.briefRevision,
          contentDigest: brief.contentDigest,
        },
        outline: null,
      },
      episodeIds: readonly string[] = [],
      episodeMode: ProjectTextPlanRevision["episodeMode"] = "none";
    const episodes = input.episodes;
    if (episodes?.kind === "newOutline") {
      episodeMode = episodes.kind;
      episodeIds =
        preservedIds ??
        Array.from(
          { length: episodes.episodeCount },
          () => `episode-${this.#d.ids.nextId("artifact")}`,
        );
    } else if (episodes !== null) {
      episodeMode = episodes.kind;
      episodeIds = episodes.episodeIds;
      if (episodes.kind === "selectedOutline") {
        const raw = await this.#d.texts.loadOutline(scope);
        if (raw === null) conflict("project_text_plan_outline_required");
        const head = parseProjectTextArtifact(raw);
        if (head.selectedContentRevision === null)
          conflict("project_text_plan_outline_required");
        const content = await this.#d.texts.loadRevision({
          ...scope,
          artifactId: head.artifactId,
          contentRevision: head.selectedContentRevision,
        });
        if (content === null) invalid();
        const revision = parseProjectTextArtifactRevision(
          content,
          this.#d.digester,
        );
        if (
          revision.kind !== "outline" ||
          revision.brief.briefRevision !== brief.briefRevision ||
          revision.brief.contentDigest !== brief.contentDigest ||
          episodeIds.some(
            (id) => !revision.content.episodes.some((e) => e.episodeId === id),
          )
        )
          conflict("project_text_plan_source_changed");
        sources = {
          ...sources,
          outline: {
            artifactId: revision.artifactId,
            contentRevision: revision.contentRevision,
            contentDigest: revision.contentDigest,
          },
        };
      }
    }
    const baselines: ProjectTextPlanHeadBaseline[] = [];
    const add = async (
      kind: "outline" | "script",
      episodeId: string | null,
    ) => {
      const raw =
        kind === "outline"
          ? await this.#d.texts.loadOutline(scope)
          : await this.#d.texts.loadScript({ ...scope, episodeId: episodeId! });
      if (raw === null)
        baselines.push({
          kind,
          episodeId,
          artifactId: null,
          artifactRevision: 0,
          selectedContentRevision: null,
          locked: false,
        });
      else {
        const h = parseProjectTextArtifact(raw);
        baselines.push({
          kind,
          episodeId,
          artifactId: h.artifactId,
          artifactRevision: h.revision,
          selectedContentRevision: h.selectedContentRevision,
          locked: h.locked,
        });
      }
    };
    if (input.start !== "script" && input.target !== "brief")
      await add("outline", null);
    if (input.target === "script")
      for (const episodeId of episodeIds) await add("script", episodeId);
    const extensionScope = {
        tenantId: q.actor.tenantId,
        spaceId: q.actor.spaceId,
        pluginId: q.binding.currentInstallation.pluginId,
      },
      rawConfiguration =
        await this.#d.extensions.loadLatestExtensionConfiguration(
          extensionScope,
        ),
      rawActivation =
        await this.#d.extensions.loadExtensionActivation(extensionScope);
    if (rawConfiguration === null || rawActivation === null)
      conflict("project_text_plan_execution_unavailable");
    const configuration = parseExtensionConfiguration(
        rawConfiguration,
        this.#d.digester,
      ),
      activation = parseExtensionActivation(rawActivation);
    if (
      activation.state !== "enabled" ||
      activation.target === null ||
      configuration.pluginVersion !== q.binding.currentInstallation.version ||
      activation.configurationRevision !== configuration.revision ||
      activation.configurationDigest !== configuration.contentDigest
    )
      conflict("project_text_plan_execution_unavailable");
    if (q.delegation === null) denied();
    await q.assertCurrent();
    q.assertActive();
    return createProjectTextPlanRevision(
      {
        planId,
        planRevision,
        actor: q.actor,
        installation: q.binding.currentInstallation,
        projectId: project.projectId,
        threadId: q.binding.threadId,
        bindingId: q.binding.bindingId,
        bindingRevision: q.binding.revision,
        workspaceId: q.binding.workspaceId,
        configurationRevision: configuration.revision,
        configurationDigest: configuration.contentDigest,
        target: activation.target,
        start: input.start,
        targetStage: input.target,
        episodeMode,
        episodeIds,
        adoption: input.adoption,
        concurrency: 1,
        maximumResultsPerStep: 1,
        instruction: input.instruction,
        instructionDigest: this.#d.digester.sha256(input.instruction),
        delegation: q.delegation,
        sources,
        baselines,
        createdAt: at,
      },
      this.#d.digester,
    );
  }
  #delegation(
    method: string,
    input: unknown,
    q: ProjectTextPlanCommitAuthority,
  ): void {
    const request = input as { idempotencyKey: string };
    if (
      q.delegation === null ||
      q.delegation.actionId !== `crewon.project-text-plans.v1.${method}` ||
      q.delegation.idempotencyKey !== request.idempotencyKey ||
      q.delegation.inputDigest !==
        this.#d.digester.sha256(
          extensionCanonicalJson({
            action: `crewon.project-text-plans.v1.${method}`,
            input,
          }),
        )
    )
      denied();
  }
  async #readAuthority(
    actor: ActorContext,
    input: ProjectConversationCommitAuthority,
  ) {
    const q = captureProjectConversationAuthority(input);
    assertProjectConversationActor(actor, q);
    await q.assertCurrent();
    q.assertActive();
    return q;
  }
  async #project(
    actor: ActorContext,
    projectId: string,
    action: "creativeProject:read" | "creativeProject:write",
  ) {
    const decision = await this.#d.authorization.authorize({
      actor,
      action,
      resource: {
        kind: "creativeProject",
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        projectId,
      },
    });
    if (decision.outcome !== "allow") denied();
    const raw = await this.#d.projects.loadProject({
      owner: {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        principalId: actor.principalId,
      },
      projectId,
    });
    if (raw === null) missing();
    const p = validateCreativeProject(raw);
    if (
      p.ownerPrincipalId !== actor.principalId ||
      p.tenantId !== actor.tenantId ||
      p.spaceId !== actor.spaceId ||
      p.projectId !== projectId
    )
      denied();
    if (p.state !== "active") conflict("creative_project_archived");
    return p;
  }
  async #load(actor: ActorContext, profileId: string, planId: string) {
    const raw = await this.#d.plans.loadPlan({ actor, profileId, planId });
    if (raw === null) return null;
    const p = parseProjectTextPlan(raw, this.#d.digester);
    if (
      p.planId !== planId ||
      p.profileId !== profileId ||
      extensionCanonicalJson(p.owner) !== extensionCanonicalJson(actor)
    )
      invalid();
    return p;
  }
  async #records(plan: ProjectTextPlan) {
    const owner = {
        actor: plan.owner,
        profileId: plan.profileId,
        planId: plan.planId,
      },
      raw = await this.#d.plans.loadRevision({
        ...owner,
        planRevision: plan.currentPlanRevision,
      });
    if (raw === null) invalid();
    const definition = parseProjectTextPlanRevision(raw, this.#d.digester),
      steps = (
        await this.#d.plans.listSteps({
          ...owner,
          planRevision: plan.currentPlanRevision,
        })
      ).map((s) => parseProjectTextPlanStep(s, this.#d.digester));
    projectTextPlanView(plan, definition, steps);
    return { definition, steps };
  }
  async #view(plan: ProjectTextPlan) {
    const { definition, steps } = await this.#records(plan);
    return projectTextPlanView(plan, definition, steps);
  }
  #mutation<M extends Exclude<ProjectTextPlansMethod, "get" | "list">>(
    method: M,
    input: ProjectTextPlansRequests[M],
    result: ProjectTextPlanMutation,
  ): ProjectTextPlansResponses[M] {
    if (
      result.kind !== method ||
      !["committed", "replayed"].includes(result.disposition)
    )
      invalid();
    const plan = parseProjectTextPlan(result.plan, this.#d.digester),
      definition = parseProjectTextPlanRevision(
        result.planRevision,
        this.#d.digester,
      ),
      steps = result.steps.map((s) =>
        parseProjectTextPlanStep(s, this.#d.digester),
      );
    return this.#output(method, input, {
      disposition: result.disposition,
      view: projectTextPlanView(plan, definition, steps),
    });
  }
  #request<M extends ProjectTextPlansMethod>(
    method: M,
    input: ProjectTextPlansRequests[M],
  ): ProjectTextPlansRequests[M] {
    try {
      return parseProjectTextPlansActionRequest({
        action: PROJECT_TEXT_PLANS_METHOD_ACTIONS[method],
        input,
      }).input as ProjectTextPlansRequests[M];
    } catch (cause) {
      throw new ApplicationError(
        "validation",
        "project_text_plan_request_invalid",
        { cause },
      );
    }
  }
  #output<M extends ProjectTextPlansMethod>(
    method: M,
    input: ProjectTextPlansRequests[M],
    output: unknown,
  ): ProjectTextPlansResponses[M] {
    try {
      return parseProjectTextPlansActionResponse(
        {
          action: PROJECT_TEXT_PLANS_METHOD_ACTIONS[method],
          input,
        } as ProjectTextPlansActionRequest,
        output,
      ) as ProjectTextPlansResponses[M];
    } catch (cause) {
      throw new ApplicationError(
        "internal",
        "project_text_plan_response_invalid",
        { cause },
      );
    }
  }
  async #call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (cause) {
      if (cause instanceof ApplicationError) throw cause;
      const code =
        cause instanceof Error
          ? cause.message
          : "project_text_plan_unavailable";
      if (
        [
          "project_text_plan_revision_conflict",
          "project_text_plan_active_conflict",
          "project_text_plan_idempotency_conflict",
          "project_text_plan_selection_changed",
          "project_text_plan_binding_changed",
          "project_text_plan_resume_scope_changed",
          "project_text_plan_remaining_scope_invalid",
          "project_text_plan_configuration_changed",
          "project_text_plan_step_unavailable",
          "project_text_plan_run_still_active",
          "project_text_plan_selection_required",
          "project_text_plan_source_changed",
          "project_text_plan_transition_invalid",
        ].includes(code)
      )
        throw new ApplicationError("conflict", code, { cause });
      throw new ApplicationError("internal", "project_text_plan_unavailable", {
        cause,
      });
    }
  }
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "project_text_plan_access_denied",
  );
}
function missing(): never {
  throw new ApplicationError("notFound", "project_text_plan_not_found");
}
function conflict(code: string): never {
  throw new ApplicationError("conflict", code);
}
function invalid(): never {
  throw new ApplicationError(
    "internal",
    "project_text_plan_store_result_invalid",
  );
}
