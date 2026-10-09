import { assertPluginTaskModelSelectionPlan } from "@crewon/application";
import {
  captureSqliteProjectFoundationDownstream,
  assertSqliteProjectFoundationDownstreamUnchanged,
  type ProjectFoundationDownstreamSnapshot,
} from "./project-foundation-downstream-guard.ts";
import {
  capturePlanPause,
  checkedPlanPause,
} from "./project-text-plan-pause.ts";
import { assertSqlitePlanContinuation } from "./project-text-plan-continuation.ts";
import { assertSqlitePlanResultFacts } from "./project-text-plan-result-facts.ts";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  ProjectTextPlanStore,
  ProjectTextPlanCommitAuthority,
  ProjectTextPlanOwner,
} from "@crewon/application";
import {
  projectTextRecord,
  projectTextOpaqueId,
  creativeProjectRevision,
  type ProjectTextPlan,
  type ProjectTextPlanRevision,
  type ProjectTextPlanStep,
} from "@crewon/domain";
import {
  assertSqlitePlanSchema,
  migrateSqlitePlans,
} from "./project-text-plan-schema.ts";
import {
  capturePlanControl,
  decodePlan,
  decodePlanRevision,
  decodePlanStep,
  decodePlanReceipt,
  planRead,
  planReceipt,
  planOwner,
  planOwnerWhere,
  planOwnerValues,
  planScope,
  planColumns,
  planValues,
  planStepColumns,
  planStepValues,
  planEqual,
  planStoreFail,
} from "./project-text-plan-records.ts";
import {
  checkPlanControlRows,
  planControlQueries,
  verifyPlanControl,
  type PlanControlPrepared,
} from "./project-text-plan-control-support.ts";
import { assertSqliteProjectTextUiCommit } from "./project-text-ui-commit-support.ts";
import {
  loadSqlitePlanAdmission,
  sqliteRequiredPlanDigest,
} from "./project-text-plan-markers.ts";
import {
  capturePlanObservation,
  checkPlanObservation,
  observationQueries,
} from "./project-text-plan-observation.ts";

/** Borrows the parent's real SQLite connection. No construction-time migration or asynchronous writer. */
export class SqliteProjectTextPlanStore implements ProjectTextPlanStore {
  readonly version = "crewon.project-text-plan.v1" as const;
  readonly #db: DatabaseSync;
  readonly #open: () => void;
  constructor(input: { database: DatabaseSync; assertOpen(): void }) {
    this.#db = input.database;
    this.#open = input.assertOpen.bind(input);
  }
  async migrate() {
    this.#transaction(() => migrateSqlitePlans(this.#db));
  }
  async loadPlan(input: Parameters<ProjectTextPlanStore["loadPlan"]>[0]) {
    const { v, o } = planRead(input, ["actor", "profileId", "planId"]),
      id = projectTextOpaqueId(v.planId);
    this.#ready();
    return this.#plan(o, id);
  }
  async loadRevision(
    input: Parameters<ProjectTextPlanStore["loadRevision"]>[0],
  ) {
    const { v, o } = planRead(input, [
        "actor",
        "profileId",
        "planId",
        "planRevision",
      ]),
      id = projectTextOpaqueId(v.planId),
      revision = creativeProjectRevision(v.planRevision);
    this.#ready();
    const p = this.#plan(o, id);
    return p === null ? null : this.#revision(p, revision);
  }
  async loadStep(input: Parameters<ProjectTextPlanStore["loadStep"]>[0]) {
    const { v, o } = planRead(input, [
        "actor",
        "profileId",
        "planId",
        "stepId",
      ]),
      id = projectTextOpaqueId(v.planId),
      stepId = projectTextOpaqueId(v.stepId);
    this.#ready();
    const p = this.#plan(o, id);
    return p === null
      ? null
      : decodePlanStep(
          this.#get(
            "SELECT * FROM project_text_plan_steps WHERE tenant_id=? AND space_id=? AND plan_id=? AND step_id=?",
            [...planScope(p), stepId],
          ),
          p,
        );
  }
  async listSteps(input: Parameters<ProjectTextPlanStore["listSteps"]>[0]) {
    const { v, o } = planRead(input, [
        "actor",
        "profileId",
        "planId",
        "planRevision",
      ]),
      id = projectTextOpaqueId(v.planId),
      revision = creativeProjectRevision(v.planRevision);
    this.#ready();
    const p = this.#plan(o, id);
    return p === null ? Object.freeze([]) : this.#steps(p, revision);
  }
  async listPlans(input: Parameters<ProjectTextPlanStore["listPlans"]>[0]) {
    const { v, o } = planRead(input, [
        "actor",
        "profileId",
        "projectId",
        "afterPlanId",
        "limit",
      ]),
      projectId = projectTextOpaqueId(v.projectId),
      after =
        v.afterPlanId === null ? null : projectTextOpaqueId(v.afterPlanId),
      limit = creativeProjectRevision(v.limit);
    if (limit > 16) planStoreFail("project_text_plan_limit_invalid");
    this.#ready();
    const rows = this.#all(
        `SELECT * FROM project_text_plans WHERE ${planOwnerWhere} AND project_id=? ${after === null ? "" : "AND plan_id COLLATE BINARY>?"} ORDER BY plan_id COLLATE BINARY LIMIT ?`,
        [
          ...planOwnerValues(o),
          projectId,
          ...(after === null ? [] : [after]),
          limit + 1,
        ],
      ),
      plans = Object.freeze(rows.slice(0, limit).map((r) => decodePlan(r, o)!));
    return Object.freeze({
      plans,
      nextPlanId: rows.length > limit ? plans.at(-1)!.planId : null,
    });
  }
  async loadMutationReceipt(
    input: Parameters<ProjectTextPlanStore["loadMutationReceipt"]>[0],
  ) {
    const { v, o } = planRead(input, ["actor", "profileId", "receipt"]),
      r = planReceipt(v.receipt);
    planEqual(o.actor, r.actor);
    this.#ready();
    return this.#receipt(o, r);
  }
  async commitControl(
    input: Parameters<ProjectTextPlanStore["commitControl"]>[0],
    options: Parameters<ProjectTextPlanStore["commitControl"]>[1],
  ) {
    const p = capturePlanControl(input, options),
      o = { actor: p.plan.owner, profileId: p.plan.profileId };
    await p.q.assertCurrent();
    await p.selection?.assertCurrent();
    if (p.selection !== undefined)
      assertPluginTaskModelSelectionPlan(p.selection, p.revision);
    await p.q.assertTransactionCurrent();
    p.q.assertActive();
    let downstream: ProjectFoundationDownstreamSnapshot | undefined;
    const downstreamLocator = {
      actor: p.revision.actor,
      projectId: p.plan.projectId,
    };
    return this.#transaction(
      () => {
        this.#ready();
        assertSqliteProjectTextUiCommit(this.#db, {
          ...p.q,
          installation: p.q.binding.currentInstallation,
        });
        const replay = this.#receipt(o, p.receipt);
        this.#checkRows(
          p,
          replay === null &&
            (p.kind === "start" ||
              p.kind === "resume" ||
              p.kind === "reviseRemaining"),
        );
        if (replay !== null) {
          if (
            replay.kind !== p.kind ||
            replay.plan.projectId !== p.plan.projectId ||
            replay.plan.threadId !== p.plan.threadId
          )
            planStoreFail("project_text_plan_idempotency_conflict");
          return replay;
        }
        const previous = this.#plan(o, p.plan.planId),
          revision =
            previous === null
              ? null
              : this.#revision(previous, previous.currentPlanRevision),
          steps =
            previous === null
              ? []
              : this.#steps(previous, previous.currentPlanRevision);
        if (p.kind === "continue" && previous !== null)
          assertSqlitePlanContinuation(this.#db, previous, steps);
        verifyPlanControl(p, previous, revision, steps);
        if (
          p.kind === "start" &&
          this.#get(
            "SELECT plan_id FROM project_text_plans WHERE tenant_id=? AND space_id=? AND principal_id=? AND actor_id=? AND profile_id=? AND project_id=? AND thread_id=? AND state NOT IN ('completed','revoked') LIMIT 1",
            [...planOwnerValues(o), p.plan.projectId, p.plan.threadId],
          )
        )
          planStoreFail("project_text_plan_active_conflict");
        if (
          p.kind === "start" ||
          p.kind === "resume" ||
          p.kind === "reviseRemaining" ||
          p.kind === "continue"
        )
          downstream = captureSqliteProjectFoundationDownstream(
            this.#db,
            downstreamLocator,
          );
        this.#writePlan(p.plan, previous);
        if (
          previous === null ||
          p.revision.planRevision !== previous.currentPlanRevision
        )
          this.#db
            .prepare(
              "INSERT INTO project_text_plan_revisions VALUES(?,?,?,?,?)",
            )
            .run(
              ...planScope(p.plan),
              p.revision.planRevision,
              JSON.stringify(p.revision),
            );
        for (const step of p.steps) {
          const old = steps.find((s) => s.stepId === step.stepId);
          if (old === undefined)
            this.#db
              .prepare(
                `INSERT INTO project_text_plan_steps(${planStepColumns}) VALUES(${Array(12).fill("?").join(",")})`,
              )
              .run(...planStepValues(p.plan, step));
          else if (old.contentDigest !== step.contentDigest)
            this.#writeStep(p.plan, step, old);
        }
        const result = Object.freeze({
          kind: p.kind,
          disposition: "committed" as const,
          plan: p.plan,
          planRevision: p.revision,
          steps: p.steps,
        });
        this.#db
          .prepare(
            "INSERT INTO project_text_plan_receipts VALUES(?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            ...planOwnerValues(o),
            p.receipt.idempotencyKey,
            p.receipt.requestDigest,
            p.kind,
            p.plan.planId,
            JSON.stringify(result),
          );
        return result;
      },
      () => {
        p.q.assertActive();
        if (p.selection !== undefined)
          assertPluginTaskModelSelectionPlan(p.selection, p.revision);
      },
      () => {
        if (downstream !== undefined)
          assertSqliteProjectFoundationDownstreamUnchanged(
            this.#db,
            downstreamLocator,
            downstream,
          );
      },
    );
  }
  async commitObservation(
    input: Parameters<ProjectTextPlanStore["commitObservation"]>[0],
    options: Parameters<ProjectTextPlanStore["commitObservation"]>[1],
  ) {
    const p = capturePlanObservation(input, options);
    await p.q.assertCurrent();
    await p.q.assertTransactionCurrent();
    p.q.assertActive();
    return this.#transaction(() => {
      this.#ready();
      assertSqliteProjectTextUiCommit(this.#db, {
        ...p.q,
        installation: p.q.binding.currentInstallation,
      });
      const plan = this.#plan(p.owner, p.planId);
      if (plan === null) planStoreFail("project_text_plan_not_found");
      const step = decodePlanStep(
        this.#get(
          "SELECT * FROM project_text_plan_steps WHERE tenant_id=? AND space_id=? AND plan_id=? AND step_id=?",
          [...planScope(plan), p.stepId],
        ),
        plan,
      );
      if (step === null) planStoreFail("project_text_plan_not_found");
      assertSqlitePlanResultFacts(this.#db, plan, step);
      const queries = observationQueries(p),
        result = checkPlanObservation(
          p,
          plan,
          step,
          {
            run: this.#get(queries.run.sql, queries.run.values),
            event: this.#get(queries.event.sql, queries.event.values),
            binding: this.#get(queries.binding.sql, queries.binding.values),
          },
          loadSqlitePlanAdmission(this.#db, {
            tenantId: p.owner.actor.tenantId,
            runId: p.run.runId,
          }),
          this.#steps(plan, plan.currentPlanRevision),
        );
      if (result.plan.contentDigest !== plan.contentDigest)
        this.#writePlan(result.plan, plan);
      if (result.step.contentDigest !== step.contentDigest)
        this.#writeStep(result.plan, result.step, step);
      return result;
    }, p.q.assertActive);
  }
  async commitSystemPause(
    input: Parameters<ProjectTextPlanStore["commitSystemPause"]>[0],
    options: Parameters<ProjectTextPlanStore["commitSystemPause"]>[1],
  ) {
    const p = capturePlanPause(input, options);
    await p.q.assertCurrent();
    await p.q.assertTransactionCurrent();
    p.q.assertActive();
    return this.#transaction(() => {
      this.#ready();
      assertSqliteProjectTextUiCommit(this.#db, {
        ...p.q,
        installation: p.q.binding.currentInstallation,
      });
      const plan = this.#plan(p.owner, p.planId);
      if (plan === null) planStoreFail("project_text_plan_not_found");
      const step = decodePlanStep(
        this.#get(
          "SELECT * FROM project_text_plan_steps WHERE tenant_id=? AND space_id=? AND plan_id=? AND step_id=?",
          [...planScope(plan), p.stepId],
        ),
        plan,
      );
      if (step === null) planStoreFail("project_text_plan_not_found");
      const result = checkedPlanPause(p, plan, step, {
        binding: this.#get(
          "SELECT * FROM project_conversation_bindings WHERE tenant_id=? AND space_id=? AND binding_id=?",
          [
            p.owner.actor.tenantId,
            p.owner.actor.spaceId,
            p.q.binding.bindingId,
          ],
        ),
        project: this.#get(
          "SELECT * FROM creative_projects WHERE tenant_id=? AND space_id=? AND project_id=?",
          [p.owner.actor.tenantId, p.owner.actor.spaceId, plan.projectId],
        ),
      });
      if (result.plan.contentDigest !== plan.contentDigest)
        this.#writePlan(result.plan, plan);
      return result;
    }, p.q.assertActive);
  }
  async scanRecoverable(
    input: Parameters<ProjectTextPlanStore["scanRecoverable"]>[0],
  ) {
    const v = projectTextRecord(input, [
        "tenantId",
        "spaceId",
        "profileId",
        "afterPlanId",
        "limit",
      ]),
      tenant = projectTextOpaqueId(v.tenantId),
      space = projectTextOpaqueId(v.spaceId),
      profile = projectTextOpaqueId(v.profileId),
      after =
        v.afterPlanId === null ? null : projectTextOpaqueId(v.afterPlanId),
      limit = creativeProjectRevision(v.limit);
    if (limit > 16) planStoreFail("project_text_plan_limit_invalid");
    this.#ready();
    const rows = this.#all(
        `SELECT * FROM project_text_plans WHERE tenant_id=? AND space_id=? AND profile_id=? ${after === null ? "" : "AND plan_id COLLATE BINARY>?"} ORDER BY plan_id COLLATE BINARY LIMIT ?`,
        [tenant, space, profile, ...(after === null ? [] : [after]), limit + 1],
      ),
      checked = rows.slice(0, limit).map((r) => decodePlan(r)!);
    return Object.freeze({
      locators: Object.freeze(
        checked
          .filter(
            (p) =>
              p.state === "ready" ||
              p.state === "running" ||
              p.state === "waitingSelection",
          )
          .map((p) =>
            Object.freeze({
              actor: p.owner,
              profileId: p.profileId,
              planId: p.planId,
            }),
          ),
      ),
      nextPlanId: rows.length > limit ? checked.at(-1)!.planId : null,
    });
  }
  async readRequiredPlanDigest(
    input: Parameters<ProjectTextPlanStore["readRequiredPlanDigest"]>[0],
  ) {
    const v = projectTextRecord(input, ["tenantId", "spaceId", "runId"]);
    this.#open();
    return sqliteRequiredPlanDigest(this.#db, {
      tenantId: projectTextOpaqueId(v.tenantId),
      spaceId: projectTextOpaqueId(v.spaceId),
      runId: projectTextOpaqueId(v.runId),
    });
  }
  async loadRunAdmission(
    input: Parameters<ProjectTextPlanStore["loadRunAdmission"]>[0],
  ) {
    const v = projectTextRecord(input, ["tenantId", "spaceId", "runId"]);
    this.#open();
    return loadSqlitePlanAdmission(this.#db, {
      tenantId: projectTextOpaqueId(v.tenantId),
      spaceId: projectTextOpaqueId(v.spaceId),
      runId: projectTextOpaqueId(v.runId),
    });
  }
  #checkRows(p: PlanControlPrepared, newRevision: boolean) {
    const qs = planControlQueries(p),
      read = (
        q: { sql: string; values: readonly (string | number)[] } | null,
      ) => (q === null ? undefined : this.#get(q.sql, q.values));
    checkPlanControlRows(
      p,
      {
        binding: read(qs.binding),
        project: read(qs.project),
        configuration: read(qs.configuration),
        activation: read(qs.activation),
        brief: read(qs.brief),
        outline: read(qs.outline),
        heads: this.#all(qs.heads.sql, qs.heads.values),
      },
      newRevision,
    );
  }
  #plan(o: ProjectTextPlanOwner, id: string) {
    return decodePlan(
      this.#get(
        `SELECT * FROM project_text_plans WHERE ${planOwnerWhere} AND plan_id=?`,
        [...planOwnerValues(o), id],
      ),
      o,
    );
  }
  #revision(p: ProjectTextPlan, r: number) {
    return decodePlanRevision(
      this.#get(
        "SELECT * FROM project_text_plan_revisions WHERE tenant_id=? AND space_id=? AND plan_id=? AND plan_revision=?",
        [...planScope(p), r],
      ),
    );
  }
  #steps(p: ProjectTextPlan, r: number) {
    const rows = this.#all(
      "SELECT * FROM project_text_plan_steps WHERE tenant_id=? AND space_id=? AND plan_id=? AND plan_revision=? ORDER BY ordinal LIMIT 19",
      [...planScope(p), r],
    );
    if (rows.length > 18) planStoreFail();
    return Object.freeze(rows.map((row) => decodePlanStep(row, p)!));
  }
  #receipt(o: ProjectTextPlanOwner, r: ReturnType<typeof planReceipt>) {
    return decodePlanReceipt(
      this.#get(
        `SELECT * FROM project_text_plan_receipts WHERE ${planOwnerWhere} AND idempotency_key=?`,
        [...planOwnerValues(o), r.idempotencyKey],
      ),
      o,
      r,
    );
  }
  #writePlan(p: ProjectTextPlan, old: ProjectTextPlan | null) {
    if (old === null)
      this.#db
        .prepare(
          `INSERT INTO project_text_plans(${planColumns}) VALUES(${Array(15).fill("?").join(",")})`,
        )
        .run(...planValues(p));
    else if (
      this.#db
        .prepare(
          "UPDATE project_text_plans SET revision=?,current_plan_revision=?,state=?,active_step_id=?,wake_revision=?,record_json=? WHERE tenant_id=? AND space_id=? AND plan_id=? AND revision=?",
        )
        .run(
          p.revision,
          p.currentPlanRevision,
          p.state,
          p.activeStepId,
          p.wakeRevision,
          JSON.stringify(p),
          ...planScope(p),
          old.revision,
        ).changes !== 1
    )
      planStoreFail("project_text_plan_revision_conflict");
  }
  #writeStep(
    p: ProjectTextPlan,
    s: ProjectTextPlanStep,
    old: ProjectTextPlanStep,
  ) {
    if (
      this.#db
        .prepare(
          "UPDATE project_text_plan_steps SET revision=?,state=?,record_json=? WHERE tenant_id=? AND space_id=? AND plan_id=? AND step_id=? AND revision=?",
        )
        .run(
          s.revision,
          s.state,
          JSON.stringify(s),
          ...planScope(p),
          s.stepId,
          old.revision,
        ).changes !== 1
    )
      planStoreFail("project_text_plan_step_revision_conflict");
  }
  #ready() {
    this.#open();
    assertSqlitePlanSchema(this.#db);
  }
  #get(sql: string, values: readonly SQLInputValue[] = []) {
    return this.#db.prepare(sql).get(...values);
  }
  #all(sql: string, values: readonly SQLInputValue[] = []) {
    return this.#db.prepare(sql).all(...values);
  }
  #transaction<T>(
    work: () => T,
    active?: () => void,
    checkDownstream?: () => void,
  ): T {
    this.#open();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      checkDownstream?.();
      active?.();
      this.#open();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
}
