import { parseSkillRunToolPermissionMode, type SkillRunToolPermissionMode } from "@crewon/domain";
import {
  createSkillVersion,
  parseSkillMethod,
  parseSkillVersionRef,
  renderSkillInvocationContext,
  skillJson,
  skillKeys,
  skillText,
  validateSkillInvocation,
  verifySkillVersion,
  type SkillInvocationSpec,
  type SkillMethod,
  type SkillRecordingSource,
  type SkillVersionRef,
  type RunState,
  type DeliveryTargetRef,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type {
  ApplicationClock,
  ContentDigester,
} from "./application-runtime-ports.ts";
import type { ActorContext } from "./authorization-port.ts";
import type {
  DemonstratedSkillRecord,
  DemonstratedSkillStore,
  SkillExecutionRecord,
  SkillLocator,
  SkillTrialReview,
} from "./demonstrated-skill-store-port.ts";
import type {
  SkillAdmissionPurpose,
  SkillExecutionAuthorizationPort,
  SkillInvocationPort,
} from "./skill-invocation-port.ts";
import type { RunRoute, RunRouteResolverPort } from "./run-commands.ts";
import type { TurnApplicationService } from "./turn-application-service.ts";

import type { SkillEvidenceUpload } from "./skill-recording-store-port.ts";

export interface SkillRecordingImportPort {
  importRecording(
    actor: ActorContext,
    recording: unknown,
    evidence?: readonly SkillEvidenceUpload[],
  ): Promise<{ method: SkillMethod; source: SkillRecordingSource }>;
}
export interface SkillRunEvidencePort {
  observe(
    actor: ActorContext,
    runId: string,
  ): Promise<{ run: RunState; verification: "real" | "simulated" | "unknown" }>;
}
export class DemonstratedSkillService implements SkillInvocationPort {
  readonly dependencies: {
    store: DemonstratedSkillStore;
    authorization: SkillExecutionAuthorizationPort;
    recording: SkillRecordingImportPort;
    turns: Pick<TurnApplicationService, "startTurn" | "replayTurn">;
    routes: RunRouteResolverPort;
    evidence: SkillRunEvidencePort;
    digester: ContentDigester;
    clock: ApplicationClock;
    nextId: () => string;
    scheduledInvocations?: {
      resolveForRun(
        actor: ActorContext,
        runId: string,
      ): Promise<{
        invocation: SkillInvocationSpec;
        threadId: string;
        agentVersionId: string;
      } | null>;
    };
    deliveryTargets?: {
      validateTarget(
        actor: ActorContext,
        target: DeliveryTargetRef,
      ): Promise<unknown>;
    };
  };
  constructor(dependencies: DemonstratedSkillService["dependencies"]) {
    this.dependencies = dependencies;
  }
  locator(actor: ActorContext, skillId: string): SkillLocator {
    for (const value of [
      actor.principalId,
      actor.tenantId,
      actor.spaceId,
      actor.actorId,
      skillId,
    ])
      skillText(value, 256);
    return {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      ownerActorId: actor.actorId,
      skillId,
    };
  }
  async authorize(
    actor: ActorContext,
    skillId: string,
    purpose: SkillAdmissionPurpose | "read" | "write",
    requiredToolRefs: readonly string[] = [],
    route: RunRoute | null = null,
  ) {
    const decision = await this.dependencies.authorization
      .authorize({ actor, skillId, purpose, requiredToolRefs, route })
      .catch(() => {
        throw new ApplicationError(
          "authorization",
          "skill_authorization_unavailable",
        );
      });
    if (decision.outcome !== "allow")
      throw new ApplicationError("authorization", decision.reasonCode);
  }
  async list(
    actor: ActorContext,
    query = { after: null as string | null, limit: 50 },
  ) {
    const scope = this.locator(actor, "catalog");
    await this.authorize(actor, "catalog", "read");
    return this.dependencies.store.listSkills(scope, query);
  }
  async get(
    actor: ActorContext,
    skillId: string,
  ): Promise<DemonstratedSkillRecord> {
    const locator = this.locator(actor, skillId);
    await this.authorize(actor, skillId, "read");
    const record = await this.dependencies.store.getSkill(locator);
    if (!record) throw new ApplicationError("notFound", "skill_not_found");
    return record;
  }
  async detail(actor: ActorContext, skillId: string) {
    const skill = await this.get(actor, skillId);
    const locator = this.locator(actor, skillId);
    const versions = await this.dependencies.store.listVersions(locator);
    const executions = await this.dependencies.store.listExecutions(locator);
    const observed = await Promise.all(
      executions.map(async (execution) => {
        if (!execution.runId)
          return { ...execution, status: "pending", verification: "unknown" };
        const evidence = await this.dependencies.evidence.observe(
          actor,
          execution.runId,
        );
        return {
          ...execution,
          status: evidence.run.status,
          verification: evidence.verification,
        };
      }),
    );
    return { skill, versions, executions: observed };
  }
  async importRecording(
    actor: ActorContext,
    recording: unknown,
    evidence: readonly SkillEvidenceUpload[] = [],
    options: Readonly<{
      importId?: string;
      provenance?: "contract-fixture";
    }> = {},
  ) {
    skillKeys(options, ["importId", "provenance"]);
    if (
      options.provenance !== undefined &&
      options.provenance !== "contract-fixture"
    )
      throw new ApplicationError(
        "validation",
        "skill_import_provenance_invalid",
      );
    const { importId } = options;
    if (importId !== undefined)
      skillText(importId, 128, "skill_import_id_invalid");
    const skillId =
      importId === undefined
        ? this.dependencies.nextId()
        : `skill-${this.dependencies.digester.sha256(skillJson({ tenantId: actor.tenantId, spaceId: actor.spaceId, ownerActorId: actor.actorId, importId })).slice(7)}`;
    await this.authorize(actor, skillId, "write");
    const { method, source: validatedSource } =
      await this.dependencies.recording.importRecording(
        actor,
        recording,
        evidence,
      );
    const source =
      options.provenance === "contract-fixture"
        ? { ...validatedSource, provenance: "contract-fixture" as const }
        : validatedSource;
    const existing = await this.dependencies.store.getSkill(
      this.locator(actor, skillId),
    );
    if (existing) {
      if (skillJson(existing.source) !== skillJson(source))
        throw new ApplicationError("conflict", "skill_import_id_conflict");
      return existing;
    }
    const now = this.dependencies.clock.now();
    const record: DemonstratedSkillRecord = {
      ...this.locator(actor, skillId),
      revision: 1,
      draft: parseSkillMethod(method),
      source,
      disabled: false,
      deleted: false,
      activatedVersionIds: [],
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.dependencies.store.saveSkill(record, 0);
    } catch (error) {
      if (importId === undefined) throw error;
      const concurrent = await this.dependencies.store.getSkill(
        this.locator(actor, skillId),
      );
      if (!concurrent || skillJson(concurrent.source) !== skillJson(source))
        throw error;
      return concurrent;
    }
    return record;
  }
  async edit(
    actor: ActorContext,
    skillId: string,
    expectedRevision: number,
    method: unknown,
  ) {
    const current = await this.get(actor, skillId);
    await this.authorize(actor, skillId, "write");
    this.assertRevision(current, expectedRevision);
    if (current.deleted)
      throw new ApplicationError("conflict", "skill_deleted");
    const record = {
      ...current,
      draft: parseSkillMethod(method),
      revision: current.revision + 1,
      updatedAt: this.dependencies.clock.now(),
    };
    await this.dependencies.store.saveSkill(record, expectedRevision);
    return record;
  }
  async seal(actor: ActorContext, skillId: string, expectedRevision: number) {
    const current = await this.get(actor, skillId);
    await this.authorize(actor, skillId, "write");
    this.assertRevision(current, expectedRevision);
    if (current.deleted)
      throw new ApplicationError("conflict", "skill_deleted");
    // Revision-derived identity makes retrying a seal deterministic and append-only.
    const version = createSkillVersion(
      {
        skillId,
        versionId: `v${current.revision}`,
        method: current.draft,
        source: current.source,
        createdAt: current.updatedAt,
      },
      this.dependencies.digester,
    );
    await this.dependencies.store.putVersion(
      this.locator(actor, skillId),
      version,
    );
    return version;
  }
  async resolveVersion(actor: ActorContext, ref: SkillVersionRef) {
    parseSkillVersionRef(ref);
    await this.get(actor, ref.skillId);
    const version = await this.dependencies.store.getVersion(
      this.locator(actor, ref.skillId),
      ref,
    );
    if (!version)
      throw new ApplicationError("notFound", "skill_version_not_found");
    verifySkillVersion(version, this.dependencies.digester);
    return version;
  }
  async admitInvocation(
    actor: ActorContext,
    spec: SkillInvocationSpec,
    options: { purpose: SkillAdmissionPurpose; route: RunRoute },
  ) {
    if (!["trial", "schedule", "execute"].includes(options.purpose))
      throw new ApplicationError("validation", "skill_purpose_invalid");
    const version = await this.resolveVersion(actor, spec.skill);
    const record = await this.get(actor, spec.skill.skillId);
    if (record.disabled || record.deleted)
      throw new ApplicationError("authorization", "skill_disabled");
    if (
      options.purpose !== "trial" &&
      !record.activatedVersionIds.includes(version.ref.versionId)
    )
      throw new ApplicationError("authorization", "skill_not_active");
    const invocation = validateSkillInvocation(version.method, spec);
    await this.authorize(
      actor,
      record.skillId,
      options.purpose,
      invocation.requiredToolRefs,
      options.route,
    );
    if (invocation.deliveryTarget) {
      const target = invocation.deliveryTarget;
      if (
        target.tenantId !== actor.tenantId ||
        target.spaceId !== actor.spaceId
      )
        throw new ApplicationError(
          "authorization",
          "skill_delivery_target_denied",
        );
      if (!this.dependencies.deliveryTargets)
        throw new ApplicationError(
          "authorization",
          "skill_delivery_target_unavailable",
        );
      await this.dependencies.deliveryTargets.validateTarget(actor, target);
    }
    const context = renderSkillInvocationContext(version, invocation);
    return {
      invocation,
      version,
      context,
      agentVersionId: options.route.agentVersionId,
    };
  }
  async startExecution(
    actor: ActorContext,
    skillId: string,
    input: {
      executionId: string;
      threadId: string;
      expectedThreadRevision: number;
      agentVersionId: string | null;
      purpose: "trial" | "execute";
      toolPermissionMode?: SkillRunToolPermissionMode;
      invocation: SkillInvocationSpec;
    },
  ) {
    const toolPermissionMode = parseSkillRunToolPermissionMode(input.toolPermissionMode === undefined ? "requestApproval" : input.toolPermissionMode);
    skillText(input.executionId, 128);
    skillText(input.threadId, 256);
    if (
      !["trial", "execute"].includes(input.purpose) ||
      input.invocation.skill.skillId !== skillId
    )
      throw new ApplicationError("validation", "skill_execution_invalid");
    const locator = this.locator(actor, skillId);
    const prior = await this.dependencies.store.getExecution(
      locator,
      input.executionId,
    );
    if (prior) {
      if (
        skillJson(prior.invocation) !== skillJson(input.invocation) ||
        prior.purpose !== input.purpose ||
        (prior.command.toolPermissionMode ?? "requestApproval") !== toolPermissionMode ||
        prior.command.threadId !== input.threadId ||
        prior.command.expectedThreadRevision !== input.expectedThreadRevision ||
        prior.command.requestedAgentVersionId !== input.agentVersionId
      )
        throw new ApplicationError("conflict", "skill_execution_id_conflict");
      await this.get(actor, skillId);
      // Read an already committed receipt before checking fresh execution permission.
      const replay = await this.dependencies.turns.replayTurn(
        actor,
        prior.command,
      );
      if (replay) {
        await this.dependencies.store.bindExecutionRun(
          locator,
          input.executionId,
          replay.runState.runId,
        );
        return { ...prior, runId: replay.runState.runId };
      }
    }
    const route =
      prior?.command.route ??
      (await this.dependencies.routes.resolveRoute({
        actor,
        threadId: input.threadId,
        agentVersionId: input.agentVersionId,
      }));
    const admission = await this.admitInvocation(actor, input.invocation, {
      purpose: input.purpose,
      route,
    });
    const command = prior?.command ?? {
      kind: "turn.start" as const,
      skillExecution: { skillId, executionId: input.executionId },
      idempotencyKey: `skill:${skillId}:${input.executionId}`,
      threadId: input.threadId,
      expectedThreadRevision: input.expectedThreadRevision,
      content: admission.context,
      requestedAgentVersionId: input.agentVersionId,
      executionIntent: "none" as const,
      toolPermissionMode,
      route,
    };
    const execution: SkillExecutionRecord = prior ?? {
      ...locator,
      executionId: input.executionId,
      invocation: admission.invocation,
      purpose: input.purpose,
      command,
      runId: null,
      review: null,
      createdAt: this.dependencies.clock.now(),
    };
    const persisted = await this.dependencies.store.putExecution(execution);
    const result = await this.dependencies.turns.startTurn(
      actor,
      persisted.command,
    );
    await this.dependencies.store.bindExecutionRun(
      locator,
      input.executionId,
      result.runState.runId,
    );
    return { ...persisted, runId: result.runState.runId };
  }
  async reviewTrial(
    actor: ActorContext,
    skillId: string,
    executionId: string,
    input: Omit<SkillTrialReview, "confirmedAt">,
  ) {
    await this.get(actor, skillId);
    await this.authorize(actor, skillId, "write");
    const locator = this.locator(actor, skillId);
    const execution = await this.dependencies.store.getExecution(
      locator,
      executionId,
    );
    if (!execution || execution.purpose !== "trial" || !execution.runId)
      throw new ApplicationError("conflict", "skill_trial_not_finished");
    const version = await this.resolveVersion(
      actor,
      execution.invocation.skill,
    );
    const evidence = await this.dependencies.evidence.observe(
      actor,
      execution.runId,
    );
    if (
      evidence.run.status !== "completed" ||
      evidence.run.threadId !== execution.command.threadId ||
      evidence.run.agentVersionId !== execution.command.route.agentVersionId
    )
      throw new ApplicationError("conflict", "skill_trial_not_completed");
    if (
      version.source.provenance !== "recording" ||
      evidence.verification !== "real"
    )
      throw new ApplicationError("conflict", "skill_real_trial_required");
    skillText(input.resultNote, 2048);
    if (
      !Array.isArray(input.criteria) ||
      skillJson([...input.criteria].sort()) !==
        skillJson([...version.method.completionCriteria].sort())
    )
      throw new ApplicationError("validation", "skill_criteria_incomplete");
    if (
      !Array.isArray(input.coverage) ||
      input.coverage.length > 3 ||
      input.coverage.some(
        (c) => !["new-date", "new-input", "handled-exception"].includes(c),
      ) ||
      !input.coverage.some((c) => c === "new-date" || c === "new-input")
    )
      throw new ApplicationError("validation", "skill_new_material_required");
    const review = {
      ...input,
      confirmedAt:
        execution.review?.confirmedAt ?? this.dependencies.clock.now(),
    };
    await this.dependencies.store.reviewExecution(locator, executionId, review);
    return review;
  }
  async activate(
    actor: ActorContext,
    skillId: string,
    expectedRevision: number,
    ref: SkillVersionRef,
  ) {
    const current = await this.get(actor, skillId);
    await this.authorize(actor, skillId, "write");
    this.assertRevision(current, expectedRevision);
    if (ref.skillId !== skillId || current.deleted || current.disabled)
      throw new ApplicationError("conflict", "skill_disabled");
    await this.resolveVersion(actor, ref);
    const candidate = await this.dependencies.store.findReviewedTrial(
      this.locator(actor, skillId),
      ref,
    );
    if (!candidate?.runId || !candidate.review)
      throw new ApplicationError("conflict", "skill_reviewed_trial_required");
    // Re-read the authoritative Run so saved review text never substitutes for success.
    await this.reviewTrial(
      actor,
      skillId,
      candidate.executionId,
      candidate.review,
    );
    const record = {
      ...current,
      activatedVersionIds: [
        ...new Set([...current.activatedVersionIds, ref.versionId]),
      ],
      revision: current.revision + 1,
      updatedAt: this.dependencies.clock.now(),
    };
    await this.dependencies.store.saveSkill(record, expectedRevision);
    return record;
  }
  async setDisabled(
    actor: ActorContext,
    skillId: string,
    expectedRevision: number,
    disabled: boolean,
  ) {
    const current = await this.get(actor, skillId);
    await this.authorize(actor, skillId, "write");
    this.assertRevision(current, expectedRevision);
    if (typeof disabled !== "boolean")
      throw new ApplicationError("validation", "skill_disabled_invalid");
    const record = {
      ...current,
      disabled,
      revision: current.revision + 1,
      updatedAt: this.dependencies.clock.now(),
    };
    await this.dependencies.store.saveSkill(record, expectedRevision);
    return record;
  }
  async getInvocationForRun(actor: ActorContext, runId: string) {
    const { run } = await this.dependencies.evidence.observe(actor, runId);
    const execution = await this.dependencies.store.findExecutionByRun(
      this.locator(actor, "lookup"),
      runId,
    );
    const result = execution
      ? {
          invocation: execution.invocation,
          threadId: execution.command.threadId,
          agentVersionId: execution.command.route.agentVersionId,
        }
      : ((await this.dependencies.scheduledInvocations?.resolveForRun(
          actor,
          runId,
        )) ?? null);
    if (
      result &&
      (result.threadId !== run.threadId ||
        result.agentVersionId !== run.agentVersionId ||
        (execution !== null && (execution.command.toolPermissionMode ?? "requestApproval") !== (run.toolPermissionMode ?? "requestApproval")))
    )
      throw new ApplicationError("authorization", "skill_run_binding_mismatch");
    if (result) await this.resolveVersion(actor, result.invocation.skill);
    return result;
  }
  async ensureRunSkillAllowed(actor: ActorContext, runId: string) {
    const binding = await this.getInvocationForRun(actor, runId);
    if (!binding) return null;
    const { run } = await this.dependencies.evidence.observe(actor, runId);
    const execution = await this.dependencies.store.findExecutionByRun(
      this.locator(actor, "lookup"),
      runId,
    );
    const route = {
      authorityId: run.authorityId,
      runtimeGeneration: run.runtimeGeneration,
      agentVersionId: run.agentVersionId,
      policySnapshotId: run.policySnapshotId,
      workspaceBindingId: run.workspaceBindingId,
    };
    const admission = await this.admitInvocation(actor, binding.invocation, {
      purpose: execution?.purpose ?? "execute",
      route,
    });
    return { ...admission, threadId: run.threadId, runId };
  }
  assertRevision(record: DemonstratedSkillRecord, expectedRevision: number) {
    if (record.revision !== expectedRevision)
      throw new ApplicationError("conflict", "skill_revision_conflict");
  }
}
