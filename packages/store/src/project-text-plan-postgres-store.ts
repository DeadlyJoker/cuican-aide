import { assertPluginTaskModelSelectionPlan } from "@crewon/application";
import {
  capturePostgresProjectFoundationDownstream,
  assertPostgresProjectFoundationDownstreamUnchanged,
  type ProjectFoundationDownstreamSnapshot,
} from "./project-foundation-downstream-guard.ts";
import {
  capturePlanPause,
  checkedPlanPause,
} from "./project-text-plan-pause.ts";
import { assertPostgresPlanContinuation } from "./project-text-plan-continuation.ts";
import { assertPostgresPlanResultFacts } from "./project-text-plan-result-facts.ts";
import type { Pool, PoolClient } from "pg";
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
  type ProjectTextPlanStep,
} from "@crewon/domain";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { advisoryLock } from "./postgres-thread-lock.ts";
import {
  assertPostgresPlanSchema,
  migratePostgresPlans,
} from "./project-text-plan-schema.ts";
import {
  capturePlanControl,
  decodePlan,
  decodePlanRevision,
  decodePlanStep,
  decodePlanReceipt,
  planRead,
  planReceipt,
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
import { assertPostgresProjectTextUiCommit } from "./project-text-ui-commit-support.ts";
import {
  loadPostgresPlanAdmission,
  postgresRequiredPlanDigest,
} from "./project-text-plan-markers.ts";
import {
  capturePlanObservation,
  checkPlanObservation,
  observationQueries,
} from "./project-text-plan-observation.ts";

/** Every transaction uses one original parent connection, including the final external-only owner fence. */
export class PostgresProjectTextPlanStore implements ProjectTextPlanStore {
  readonly version = "crewon.project-text-plan.v1" as const;
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #open: () => void;
  constructor(input: { pool: Pool; schema: string; assertOpen(): void }) {
    this.#pool = input.pool;
    this.#schema = input.schema;
    creativeProjectSchemaName(input.schema);
    this.#open = input.assertOpen.bind(input);
  }
  async migrate() {
    await this.#transaction(async (c) => {
      await advisoryLock(
        c,
        JSON.stringify(["project-text-plan-schema", this.#schema]),
      );
      await migratePostgresPlans(c, this.#schema);
    });
  }
  async loadPlan(input: Parameters<ProjectTextPlanStore["loadPlan"]>[0]) {
    const { v, o } = planRead(input, ["actor", "profileId", "planId"]),
      id = projectTextOpaqueId(v.planId);
    return this.#read((c) => this.#plan(c, o, id));
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
      r = creativeProjectRevision(v.planRevision);
    return this.#read(async (c) => {
      const p = await this.#plan(c, o, id);
      return p === null ? null : this.#revision(c, p, r);
    });
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
    return this.#read(async (c) => {
      const p = await this.#plan(c, o, id);
      return p === null
        ? null
        : decodePlanStep(
            await this.#get(
              c,
              "SELECT * FROM project_text_plan_steps WHERE tenant_id=? AND space_id=? AND plan_id=? AND step_id=?",
              [...planScope(p), stepId],
            ),
            p,
          );
    });
  }
  async listSteps(input: Parameters<ProjectTextPlanStore["listSteps"]>[0]) {
    const { v, o } = planRead(input, [
        "actor",
        "profileId",
        "planId",
        "planRevision",
      ]),
      id = projectTextOpaqueId(v.planId),
      r = creativeProjectRevision(v.planRevision);
    return this.#read(async (c) => {
      const p = await this.#plan(c, o, id);
      return p === null ? Object.freeze([]) : this.#steps(c, p, r);
    });
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
    return this.#read(async (c) => {
      const rows = await this.#all(
          c,
          `SELECT * FROM project_text_plans WHERE ${planOwnerWhere} AND project_id=? ${after === null ? "" : 'AND plan_id COLLATE "C">?'} ORDER BY plan_id COLLATE "C" LIMIT ?`,
          [
            ...planOwnerValues(o),
            projectId,
            ...(after === null ? [] : [after]),
            limit + 1,
          ],
        ),
        plans = Object.freeze(
          rows.slice(0, limit).map((r) => decodePlan(r, o)!),
        );
      return Object.freeze({
        plans,
        nextPlanId: rows.length > limit ? plans.at(-1)!.planId : null,
      });
    });
  }
  async loadMutationReceipt(
    input: Parameters<ProjectTextPlanStore["loadMutationReceipt"]>[0],
  ) {
    const { v, o } = planRead(input, ["actor", "profileId", "receipt"]),
      r = planReceipt(v.receipt);
    planEqual(o.actor, r.actor);
    return this.#read((c) => this.#receipt(c, o, r));
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
    p.q.assertActive();
    let downstream: ProjectFoundationDownstreamSnapshot | undefined;
    const downstreamLocator = {
      actor: p.revision.actor,
      projectId: p.plan.projectId,
    };
    return this.#transaction(
      async (c) => {
        await this.#ready(c);
        await assertPostgresProjectTextUiCommit(c, this.#schema, {
          ...p.q,
          installation: p.q.binding.currentInstallation,
        });
        await advisoryLock(
          c,
          JSON.stringify([
            "project-text-plan-receipt",
            this.#schema,
            ...planOwnerValues(o),
            p.receipt.idempotencyKey,
          ]),
        );
        await this.#projectLock(c, p.plan);
        await this.#planLock(c, p.plan);
        const replay = await this.#receipt(c, o, p.receipt);
        await this.#checkRows(
          c,
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
        const previous = await this.#plan(c, o, p.plan.planId, true),
          revision =
            previous === null
              ? null
              : await this.#revision(c, previous, previous.currentPlanRevision),
          steps =
            previous === null
              ? []
              : await this.#steps(
                  c,
                  previous,
                  previous.currentPlanRevision,
                  true,
                );
        if (p.kind === "continue" && previous !== null)
          await assertPostgresPlanContinuation(
            c,
            this.#schema,
            previous,
            steps,
          );
        verifyPlanControl(p, previous, revision, steps);
        if (
          p.kind === "start" &&
          (await this.#get(
            c,
            "SELECT plan_id FROM project_text_plans WHERE tenant_id=? AND space_id=? AND principal_id=? AND actor_id=? AND profile_id=? AND project_id=? AND thread_id=? AND state NOT IN ('completed','revoked') LIMIT 1",
            [...planOwnerValues(o), p.plan.projectId, p.plan.threadId],
          ))
        )
          planStoreFail("project_text_plan_active_conflict");
        if (
          p.kind === "start" ||
          p.kind === "resume" ||
          p.kind === "reviseRemaining" ||
          p.kind === "continue"
        )
          downstream = await capturePostgresProjectFoundationDownstream(
            c,
            this.#schema,
            downstreamLocator,
          );
        await this.#writePlan(c, p.plan, previous);
        if (
          previous === null ||
          p.revision.planRevision !== previous.currentPlanRevision
        )
          await this.#query(
            c,
            "INSERT INTO project_text_plan_revisions VALUES(?,?,?,?,?)",
            [
              ...planScope(p.plan),
              p.revision.planRevision,
              JSON.stringify(p.revision),
            ],
          );
        for (const step of p.steps) {
          const old = steps.find((s) => s.stepId === step.stepId);
          if (old === undefined)
            await this.#query(
              c,
              `INSERT INTO project_text_plan_steps(${planStepColumns}) VALUES(${Array(12).fill("?").join(",")})`,
              planStepValues(p.plan, step),
            );
          else if (old.contentDigest !== step.contentDigest)
            await this.#writeStep(c, p.plan, step, old);
        }
        const result = Object.freeze({
          kind: p.kind,
          disposition: "committed" as const,
          plan: p.plan,
          planRevision: p.revision,
          steps: p.steps,
        });
        await this.#query(
          c,
          "INSERT INTO project_text_plan_receipts VALUES(?,?,?,?,?,?,?,?,?,?)",
          [
            ...planOwnerValues(o),
            p.receipt.idempotencyKey,
            p.receipt.requestDigest,
            p.kind,
            p.plan.planId,
            JSON.stringify(result),
          ],
        );
        return result;
      },
      {
        ...p.q,
        assertActive: () => {
          p.q.assertActive();
          if (p.selection !== undefined)
            assertPluginTaskModelSelectionPlan(p.selection, p.revision);
        },
      },
      async (c) => {
        if (downstream !== undefined)
          await assertPostgresProjectFoundationDownstreamUnchanged(
            c,
            this.#schema,
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
    p.q.assertActive();
    return this.#transaction(async (c) => {
      await this.#ready(c);
      await assertPostgresProjectTextUiCommit(c, this.#schema, {
        ...p.q,
        installation: p.q.binding.currentInstallation,
      });
      await advisoryLock(c, `run:${p.owner.actor.tenantId}:${p.run.runId}`);
      await this.#projectLock(c, {
        owner: p.owner.actor,
        projectId: p.q.binding.projectId,
      });
      await this.#planLock(c, { owner: p.owner.actor, planId: p.planId });
      const plan = await this.#plan(c, p.owner, p.planId, true);
      if (plan === null) planStoreFail("project_text_plan_not_found");
      const step = decodePlanStep(
        await this.#get(
          c,
          "SELECT * FROM project_text_plan_steps WHERE tenant_id=? AND space_id=? AND plan_id=? AND step_id=? FOR UPDATE",
          [...planScope(plan), p.stepId],
        ),
        plan,
      );
      if (step === null) planStoreFail("project_text_plan_not_found");
      await assertPostgresPlanResultFacts(c, this.#schema, plan, step);
      const qs = observationQueries(p),
        result = checkPlanObservation(
          p,
          plan,
          step,
          {
            run: await this.#get(c, qs.run.sql, qs.run.values),
            event: await this.#get(c, qs.event.sql, qs.event.values),
            binding: await this.#get(c, qs.binding.sql, qs.binding.values),
          },
          await loadPostgresPlanAdmission(c, this.#schema, {
            tenantId: p.owner.actor.tenantId,
            runId: p.run.runId,
          }),
          await this.#steps(c, plan, plan.currentPlanRevision, true),
        );
      if (result.plan.contentDigest !== plan.contentDigest)
        await this.#writePlan(c, result.plan, plan);
      if (result.step.contentDigest !== step.contentDigest)
        await this.#writeStep(c, result.plan, result.step, step);
      return result;
    }, p.q);
  }
  async commitSystemPause(
    input: Parameters<ProjectTextPlanStore["commitSystemPause"]>[0],
    options: Parameters<ProjectTextPlanStore["commitSystemPause"]>[1],
  ) {
    const p = capturePlanPause(input, options);
    await p.q.assertCurrent();
    p.q.assertActive();
    return this.#transaction(async (c) => {
      await this.#ready(c);
      await assertPostgresProjectTextUiCommit(c, this.#schema, {
        ...p.q,
        installation: p.q.binding.currentInstallation,
      });
      await this.#projectLock(c, {
        owner: p.owner.actor,
        projectId: p.q.binding.projectId,
      });
      await this.#planLock(c, { owner: p.owner.actor, planId: p.planId });
      const plan = await this.#plan(c, p.owner, p.planId, true);
      if (plan === null) planStoreFail("project_text_plan_not_found");
      const step = decodePlanStep(
        await this.#get(
          c,
          "SELECT * FROM project_text_plan_steps WHERE tenant_id=? AND space_id=? AND plan_id=? AND step_id=? FOR UPDATE",
          [...planScope(plan), p.stepId],
        ),
        plan,
      );
      if (step === null) planStoreFail("project_text_plan_not_found");
      const result = checkedPlanPause(p, plan, step, {
        binding: await this.#get(
          c,
          "SELECT * FROM project_conversation_bindings WHERE tenant_id=? AND space_id=? AND binding_id=?",
          [
            p.owner.actor.tenantId,
            p.owner.actor.spaceId,
            p.q.binding.bindingId,
          ],
        ),
        project: await this.#get(
          c,
          "SELECT * FROM creative_projects WHERE tenant_id=? AND space_id=? AND project_id=?",
          [p.owner.actor.tenantId, p.owner.actor.spaceId, plan.projectId],
        ),
      });
      if (result.plan.contentDigest !== plan.contentDigest)
        await this.#writePlan(c, result.plan, plan);
      return result;
    }, p.q);
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
    return this.#read(async (c) => {
      const rows = await this.#all(
          c,
          `SELECT * FROM project_text_plans WHERE tenant_id=? AND space_id=? AND profile_id=? ${after === null ? "" : 'AND plan_id COLLATE "C">?'} ORDER BY plan_id COLLATE "C" LIMIT ?`,
          [
            tenant,
            space,
            profile,
            ...(after === null ? [] : [after]),
            limit + 1,
          ],
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
    });
  }
  async readRequiredPlanDigest(
    input: Parameters<ProjectTextPlanStore["readRequiredPlanDigest"]>[0],
  ) {
    const v = projectTextRecord(input, ["tenantId", "spaceId", "runId"]),
      locator = {
        tenantId: projectTextOpaqueId(v.tenantId),
        spaceId: projectTextOpaqueId(v.spaceId),
        runId: projectTextOpaqueId(v.runId),
      };
    return this.#transaction((c) =>
      postgresRequiredPlanDigest(c, this.#schema, locator),
    );
  }
  async loadRunAdmission(
    input: Parameters<ProjectTextPlanStore["loadRunAdmission"]>[0],
  ) {
    const v = projectTextRecord(input, ["tenantId", "spaceId", "runId"]),
      locator = {
        tenantId: projectTextOpaqueId(v.tenantId),
        spaceId: projectTextOpaqueId(v.spaceId),
        runId: projectTextOpaqueId(v.runId),
      };
    return this.#transaction((c) =>
      loadPostgresPlanAdmission(c, this.#schema, locator),
    );
  }
  async #checkRows(
    c: PoolClient,
    p: PlanControlPrepared,
    newRevision: boolean,
  ) {
    const qs = planControlQueries(p),
      read = (
        q: { sql: string; values: readonly (string | number)[] } | null,
      ) =>
        q === null ? Promise.resolve(undefined) : this.#get(c, q.sql, q.values);
    checkPlanControlRows(
      p,
      {
        binding: await read(qs.binding),
        project: await read(qs.project),
        configuration: await read(qs.configuration),
        activation: await read(qs.activation),
        brief: await read(qs.brief),
        outline: await read(qs.outline),
        heads: await this.#all(c, qs.heads.sql, qs.heads.values),
      },
      newRevision,
    );
  }
  async #plan(
    c: PoolClient,
    o: ProjectTextPlanOwner,
    id: string,
    lock = false,
  ) {
    return decodePlan(
      await this.#get(
        c,
        `SELECT * FROM project_text_plans WHERE ${planOwnerWhere} AND plan_id=? ${lock ? "FOR UPDATE" : ""}`,
        [...planOwnerValues(o), id],
      ),
      o,
    );
  }
  async #revision(c: PoolClient, p: ProjectTextPlan, r: number) {
    return decodePlanRevision(
      await this.#get(
        c,
        "SELECT * FROM project_text_plan_revisions WHERE tenant_id=? AND space_id=? AND plan_id=? AND plan_revision=?",
        [...planScope(p), r],
      ),
    );
  }
  async #steps(c: PoolClient, p: ProjectTextPlan, r: number, lock = false) {
    const rows = await this.#all(
      c,
      `SELECT * FROM project_text_plan_steps WHERE tenant_id=? AND space_id=? AND plan_id=? AND plan_revision=? ORDER BY ordinal LIMIT 19 ${lock ? "FOR UPDATE" : ""}`,
      [...planScope(p), r],
    );
    if (rows.length > 18) planStoreFail();
    return Object.freeze(rows.map((row) => decodePlanStep(row, p)!));
  }
  async #receipt(
    c: PoolClient,
    o: ProjectTextPlanOwner,
    r: ReturnType<typeof planReceipt>,
  ) {
    return decodePlanReceipt(
      await this.#get(
        c,
        `SELECT * FROM project_text_plan_receipts WHERE ${planOwnerWhere} AND idempotency_key=?`,
        [...planOwnerValues(o), r.idempotencyKey],
      ),
      o,
      r,
    );
  }
  async #writePlan(
    c: PoolClient,
    p: ProjectTextPlan,
    old: ProjectTextPlan | null,
  ) {
    if (old === null)
      await this.#query(
        c,
        `INSERT INTO project_text_plans(${planColumns}) VALUES(${Array(15).fill("?").join(",")})`,
        planValues(p),
      );
    else if (
      (
        await this.#query(
          c,
          "UPDATE project_text_plans SET revision=?,current_plan_revision=?,state=?,active_step_id=?,wake_revision=?,record_json=? WHERE tenant_id=? AND space_id=? AND plan_id=? AND revision=?",
          [
            p.revision,
            p.currentPlanRevision,
            p.state,
            p.activeStepId,
            p.wakeRevision,
            JSON.stringify(p),
            ...planScope(p),
            old.revision,
          ],
        )
      ).rowCount !== 1
    )
      planStoreFail("project_text_plan_revision_conflict");
  }
  async #writeStep(
    c: PoolClient,
    p: ProjectTextPlan,
    s: ProjectTextPlanStep,
    old: ProjectTextPlanStep,
  ) {
    if (
      (
        await this.#query(
          c,
          "UPDATE project_text_plan_steps SET revision=?,state=?,record_json=? WHERE tenant_id=? AND space_id=? AND plan_id=? AND step_id=? AND revision=?",
          [
            s.revision,
            s.state,
            JSON.stringify(s),
            ...planScope(p),
            s.stepId,
            old.revision,
          ],
        )
      ).rowCount !== 1
    )
      planStoreFail("project_text_plan_step_revision_conflict");
  }
  async #ready(c: PoolClient) {
    this.#open();
    await assertPostgresPlanSchema(c, this.#schema);
  }
  #projectLock(c: PoolClient, p: Pick<ProjectTextPlan, "owner" | "projectId">) {
    return advisoryLock(
      c,
      JSON.stringify([
        "creative-project-project",
        this.#schema,
        p.owner.tenantId,
        p.owner.spaceId,
        p.projectId,
      ]),
    );
  }
  #planLock(c: PoolClient, p: Pick<ProjectTextPlan, "owner" | "planId">) {
    return advisoryLock(
      c,
      JSON.stringify([
        "project-text-plan",
        this.#schema,
        p.owner.tenantId,
        p.owner.spaceId,
        p.planId,
      ]),
    );
  }
  async #read<T>(work: (c: PoolClient) => Promise<T>) {
    return this.#transaction(async (c) => {
      await this.#ready(c);
      return work(c);
    });
  }
  #query(c: PoolClient, sql: string, values: readonly unknown[] = []) {
    let i = 0;
    const prefix = `${creativeProjectSchemaName(this.#schema)}.`,
      compiled = sql
        .replace(
          /\b(FROM|JOIN|UPDATE|INTO)\s+([a-z_]+)/gu,
          (_, keyword: string, table: string) => `${keyword} ${prefix}${table}`,
        )
        .replaceAll("?", () => `$${++i}`);
    return c.query<Record<string, unknown>>(compiled, [...values]);
  }
  async #get(c: PoolClient, sql: string, values: readonly unknown[] = []) {
    return (await this.#query(c, sql, values)).rows[0];
  }
  async #all(c: PoolClient, sql: string, values: readonly unknown[] = []) {
    return (await this.#query(c, sql, values)).rows;
  }
  async #transaction<T>(
    work: (c: PoolClient) => Promise<T>,
    q?: ProjectTextPlanCommitAuthority,
    checkDownstream?: (client: PoolClient) => Promise<void>,
  ): Promise<T> {
    this.#open();
    const c = await this.#pool.connect();
    try {
      this.#open();
      await c.query("BEGIN");
      try {
        const result = await work(c);
        await q?.assertTransactionCurrent();
        await checkDownstream?.(c);
        q?.assertActive();
        this.#open();
        await c.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await c.query("ROLLBACK");
        } catch {}
        throw error;
      }
    } finally {
      c.release();
    }
  }
}
