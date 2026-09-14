import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import type { ControlApiClient } from "@crewon/control-client";
import type {
  AutomationView,
  CreateAutomationRequest,
} from "@crewon/contracts";
import {
  parseAutomationDefinition,
  parseAutomationInvocationBinding,
  parseSkillInvocationSpec,
  parseSkillVersionSnapshot,
  skillObject,
  type SkillInvocationSpec,
  type SkillVersionRef,
} from "@crewon/domain";

export type ScheduledSkillToolPermissionMode =
  | "requestApproval"
  | "approveForMe";

export type ScheduledSkillAcceptanceOptions = Readonly<{
  client: ControlApiClient;
  request: (
    path: string,
    body?: unknown,
    method?: string,
    key?: string,
  ) => Promise<unknown>;
  fixedVersion: SkillVersionRef;
  threadId: string;
  /** Persist this alongside dueAt and idempotencyKey before the first call. */
  expectedThreadRevision: number;
  invocation: SkillInvocationSpec;
  title: string;
  idempotencyKey: string;
  dueAt: string;
  databasePath: string;
  /** An explicit caller choice; this helper never chooses approval authority. */
  toolPermissionMode: ScheduledSkillToolPermissionMode;
  timeoutMs?: number;
  onAutomationCreated?: (automation: AutomationView) => void | Promise<void>;
}>;

/**
 * Acceptance driver for the existing Control scheduler. The caller prepares the
 * reviewed real trial, template, scoped browser authority and explicit Run mode.
 * This activates through F03 and saves through F04; it never creates a Run,
 * invokes run-now, approves a tool, grants browser access or assembles a file.
 * Model completion and independent output inspection remain the caller's job.
 */
export async function prepareScheduledSkillAcceptance(
  options: ScheduledSkillAcceptanceOptions,
) {
  const invocation = parseSkillInvocationSpec(options.invocation);
  assert.deepEqual(
    invocation.skill,
    options.fixedVersion,
    "fixed version mismatch",
  );
  assert.ok(
    invocation.deliveryTarget,
    "scheduled acceptance needs a delivery target",
  );
  assert.equal(invocation.deliveryTarget.threadId, options.threadId);
  assert.ok(
    options.toolPermissionMode === "requestApproval" ||
      options.toolPermissionMode === "approveForMe",
    "an explicit supported toolPermissionMode is required",
  );
  assert.ok(Number.isSafeInteger(options.expectedThreadRevision));
  assert.ok(options.expectedThreadRevision > 0);
  assert.ok(options.idempotencyKey.length > 0);
  const dueAt = new Date(options.dueAt).toISOString();
  const timeoutMs = options.timeoutMs ?? 120_000;
  assert.ok(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300_000,
  );
  const signal = AbortSignal.timeout(timeoutMs);
  const skillPath = `/api/v1/skills/${encodeURIComponent(options.fixedVersion.skillId)}`;
  const versionResult = object(
    await options.request(
      `${skillPath}/versions/${encodeURIComponent(options.fixedVersion.versionId)}?contentDigest=${encodeURIComponent(options.fixedVersion.contentDigest)}`,
      undefined,
      "GET",
    ),
  );
  const version = parseSkillVersionSnapshot(versionResult.version);
  assert.deepEqual(version.ref, options.fixedVersion);
  const detail = object(await options.request(skillPath, undefined, "GET"));
  const skill = object(detail.skill);
  assert.equal(skill.disabled, false, "Skill is disabled");
  assert.equal(skill.deleted, false, "Skill is deleted");
  assert.ok(Array.isArray(skill.activatedVersionIds));
  if (!skill.activatedVersionIds.includes(options.fixedVersion.versionId)) {
    // The service rechecks the actual reviewed Run and evidence. There is no
    // helper-side activation override or synthetic trial fallback.
    await options.request(`${skillPath}/activate`, {
      expectedRevision: skill.revision,
      version: options.fixedVersion,
    });
    const activated = object(
      object(await options.request(skillPath, undefined, "GET")).skill,
    );
    assert.ok(Array.isArray(activated.activatedVersionIds));
    assert.ok(
      activated.activatedVersionIds.includes(options.fixedVersion.versionId),
    );
  }
  const { thread } = await options.client.getThread(options.threadId, {
    signal,
  });
  assert.ok(thread.revision >= options.expectedThreadRevision);
  const catalog = await options.client.delivery.catalog(options.threadId, {
    signal,
  });
  assert.deepEqual(
    catalog.target,
    invocation.deliveryTarget,
    "current delivery target mismatch",
  );

  const body: CreateAutomationRequest & {
    toolPermissionMode: ScheduledSkillToolPermissionMode;
  } = {
    threadId: options.threadId,
    expectedThreadRevision: options.expectedThreadRevision,
    title: options.title,
    prompt:
      "Execute the fixed Skill with the saved parameters and delivery target.",
    agentVersionId: null,
    schedule: {
      scheduleType: "once",
      nextRunAt: dueAt,
      intervalSeconds: 0,
      time: dueAt.slice(11, 16),
      weekday: new Date(dueAt).getUTCDay(),
      timezone: "UTC",
    },
    skillInvocation: {
      ...invocation,
      requiredToolRefs: [...invocation.requiredToolRefs],
    },
    parameterBindings: {},
    toolPermissionMode: options.toolPermissionMode,
  };
  // Keeping the entire request (including the original Thread revision) stable
  // allows receipt replay after an uncertain response or a completed occurrence.
  const { automation } = await options.client.createAutomation(
    body,
    options.idempotencyKey,
    { signal },
  );
  assert.equal(automation.executionMode, "scheduled");
  assert.equal(automation.automaticScheduling, true);
  assert.deepEqual(automation.skillInvocation, invocation);
  assert.equal(
    object(automation).toolPermissionMode,
    options.toolPermissionMode,
  );
  assert.ok(
    Date.parse(automation.createdAt) < Date.parse(dueAt),
    "schedule must be saved before its due occurrence",
  );
  await options.onAutomationCreated?.(automation);

  const database = new DatabaseSync(options.databasePath, { readOnly: true });
  try {
    while (!signal.aborted) {
      // A terminal Run can finish between scans; active-run alone loses it.
      const runs = await options.client.listThreadRuns(
        options.threadId,
        { limit: 20 },
        { signal },
      );
      const evidence = readOccurrence(
        database,
        options,
        automation,
        invocation,
        dueAt,
      );
      if (evidence !== null) {
        // The scheduler may commit between the HTTP list and SQLite snapshot.
        const run =
          runs.data.find(
            (candidate) => candidate.runId === evidence.binding.runId,
          ) ??
          (await options.client.getRun(evidence.binding.runId, { signal })).run;
        assert.equal(run.threadId, options.threadId);
        const authorization = object(
          await options.request(
            `/api/v1/runs/${encodeURIComponent(run.runId)}/skill-invocation`,
            undefined,
            "GET",
          ),
        );
        assert.equal(authorization.threadId, options.threadId);
        assert.deepEqual(authorization.skillVersionRef, options.fixedVersion);
        assert.deepEqual(authorization.parameters, invocation.parameters);
        return {
          automation,
          run,
          ...evidence,
          authorization: {
            threadId: options.threadId,
            skillVersionRef: options.fixedVersion,
            parameters: invocation.parameters,
          },
        };
      }
      const current = await options.client.getAutomation(
        automation.automationId,
        { signal },
      );
      assert.notEqual(
        current.automation.skillReadiness?.state,
        "blocked",
        `scheduled admission blocked: ${current.automation.skillReadiness?.code}`,
      );
      await delay(250, undefined, { signal });
    }
    throw new Error(
      `scheduled occurrence timed out: ${automation.automationId}`,
    );
  } catch (error) {
    if (signal.aborted) {
      throw new Error(
        `scheduled occurrence timed out: ${automation.automationId}; resume with the same saved request`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    database.close();
  }
}

function readOccurrence(
  database: DatabaseSync,
  options: ScheduledSkillAcceptanceOptions,
  automation: AutomationView,
  invocation: SkillInvocationSpec,
  dueAt: string,
) {
  const target = invocation.deliveryTarget!;
  // One read snapshot keeps the definition, receipt and Run mutually consistent
  // while Control and Worker continue their normal transactions.
  database.exec("BEGIN");
  try {
    const row = database
      .prepare(
        `SELECT definition_json, definition_digest
      FROM automations WHERE tenant_id=? AND space_id=? AND automation_id=?`,
      )
      .get(target.tenantId, target.spaceId, automation.automationId);
    assert.ok(
      row,
      "created automation missing from the supplied runtime database",
    );
    const definition = parseAutomationDefinition(json(row.definition_json));
    assert.equal(definition.schemaVersion, "crewon.automation.v1");
    assert.equal(definition.threadId, options.threadId);
    assert.deepEqual(
      definition.skillBinding?.version.ref,
      options.fixedVersion,
    );
    assert.deepEqual(definition.skillBinding?.invocation, invocation);
    assert.deepEqual(definition.skillBinding?.parameterBindings, {});
    assert.equal(
      object(definition).toolPermissionMode,
      options.toolPermissionMode,
    );
    const receipts = database
      .prepare(
        `SELECT run_id, result_json
      FROM automation_invocation_receipts WHERE tenant_id=? AND automation_id=? LIMIT 2`,
      )
      .all(target.tenantId, automation.automationId);
    assert.ok(
      receipts.length <= 1,
      "one-time acceptance must have exactly one invocation receipt",
    );
    if (receipts.length === 0) return null;
    const receipt = receipts[0]!;
    assert.equal(typeof receipt.run_id, "string");
    const saved = database
      .prepare(
        `SELECT state_json FROM run_snapshots
      WHERE tenant_id=? AND space_id=? AND run_id=?`,
      )
      .get(target.tenantId, target.spaceId, receipt.run_id!);
    assert.ok(saved, "scheduler receipt has no actual Run");
    const state = object(json(saved.state_json));
    assert.equal(state.runId, receipt.run_id);
    assert.equal(state.threadId, options.threadId);
    assert.equal(state.toolPermissionMode, options.toolPermissionMode);
    assert.equal(state.agentVersionId, definition.agentVersionId);
    const origin = object(state.origin);
    assert.equal(origin.kind, "automation");
    const binding = parseAutomationInvocationBinding(origin.binding);
    assert.equal(binding.automationId, automation.automationId);
    assert.equal(binding.runId, state.runId);
    assert.equal(binding.definitionDigest, row.definition_digest);
    assert.equal(
      binding.scheduledFor,
      dueAt,
      "Run must come from the due occurrence",
    );
    assert.deepEqual(binding.skillInvocation, invocation);
    assert.equal(typeof state.createdAt, "string");
    assert.ok(
      Date.parse(state.createdAt as string) >= Date.parse(dueAt),
      "Run created before the schedule became due",
    );
    const result = object(json(receipt.result_json));
    assert.deepEqual(result.binding, binding);
    const receiptState = object(result.runState);
    assert.equal(receiptState.runId, state.runId);
    assert.equal(receiptState.toolPermissionMode, options.toolPermissionMode);
    assert.deepEqual(receiptState.origin, origin);
    return {
      binding,
      scheduledFor: dueAt,
      runCreatedAt: state.createdAt as string,
      toolPermissionMode: options.toolPermissionMode,
      invocationReceiptCount: receipts.length,
    };
  } finally {
    database.exec("ROLLBACK");
  }
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(skillObject(value), "expected an API or persisted object");
  return value;
}

function json(value: unknown): unknown {
  assert.equal(typeof value, "string", "expected persisted JSON");
  return JSON.parse(value as string);
}
