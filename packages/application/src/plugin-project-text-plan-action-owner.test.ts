import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_TEXT_PLANS_METHOD_ACTIONS as A,
  type ProjectTextPlansResponses,
} from "@crewon/contracts/project-text-plans";
import { extensionCanonicalJson } from "@crewon/domain";
import {
  PluginProjectTextPlanActionOwner,
  isPluginProjectTextPlanActionOwner,
} from "./plugin-project-text-plan-action-owner.ts";
import { projectTextPlanActionFixture } from "./plugin-project-text-plan-action.test-support.ts";
import {
  capturePluginProjectTextPlanInvocationCommitAuthority,
  capturePluginProjectTextUiInvocationCommitAuthority,
  capturePluginProjectTextRecoveryInvocationCommitAuthority,
} from "./plugin-ui-invocation-authority.ts";
import { uiDeferred } from "./plugin-ui.test-support.ts";
import type { PluginProjectTextPlanInvocationAuthority } from "./plugin-project-text-plan-action-context.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";

test("actual mounted start/read/pause/resume/revise/continue/revoke use real Plan Service and SQLite receipts without launching Runs", async (t) => {
  const f = await projectTextPlanActionFixture(t);
  const delegation =
    (): PluginProjectTextPlanInvocationAuthority["delegation"] =>
      f.state.invocation?.delegation ?? null;
  assert.equal(isPluginProjectTextPlanActionOwner(f.owner), true);
  for (const a of Object.values(A))
    assert.equal(f.owner.supportsAction(a), true);
  assert.equal(
    f.owner.supportsAction("crewon.project-text-plans.v1.notReal"),
    false,
  );
  const start = (await f.invoke(
    "start",
    f.request,
  )) as unknown as ProjectTextPlansResponses["start"];
  assert.equal(start.disposition, "committed");
  const planId = start.view.plan.planId;
  assert.equal(delegation()?.actionId, A.start);
  assert.equal(
    f.state.invocation?.delegation?.inputDigest,
    f.digester.sha256(
      extensionCanonicalJson({ action: A.start, input: f.request }),
    ),
  );
  assert.match(f.state.invocation!.invocationId, /^plan-ui-[a-f0-9]{64}$/);
  const id = f.state.invocation!.invocationId;
  assert.equal(
    (
      (await f.invoke(
        "start",
        f.request,
      )) as unknown as ProjectTextPlansResponses["start"]
    ).disposition,
    "replayed",
  );
  assert.notEqual(f.state.invocation?.invocationId, id);
  const get = (await f.invoke("get", {
    projectId: f.request.projectId,
    planId,
  })) as unknown as ProjectTextPlansResponses["get"];
  assert.equal(get.view?.plan.planId, planId);
  assert.equal(f.state.invocation?.delegation, null);
  const list = (await f.invoke("list", {
    projectId: f.request.projectId,
    afterPlanId: null,
    limit: 16,
  })) as unknown as ProjectTextPlansResponses["list"];
  assert.equal(list.plans.length, 1);
  const control = {
    projectId: f.request.projectId,
    planId,
    expectedRevision: start.view.plan.revision,
    idempotencyKey: "pause-plan",
  };
  const paused = (await f.invoke(
    "pause",
    control,
  )) as unknown as ProjectTextPlansResponses["pause"];
  assert.equal(paused.view.plan.state, "paused");
  assert.equal(f.state.invocation?.delegation, null);
  const resumed = (await f.invoke("resume", {
    ...control,
    expectedRevision: paused.view.plan.revision,
    idempotencyKey: "resume-plan",
  })) as unknown as ProjectTextPlansResponses["resume"];
  assert.equal(resumed.view.plan.state, "ready");
  assert.equal(delegation()?.actionId, A.resume);
  const paused2 = (await f.invoke("pause", {
    ...control,
    expectedRevision: resumed.view.plan.revision,
    idempotencyKey: "pause-plan-again",
  })) as unknown as ProjectTextPlansResponses["pause"];
  const {
    threadId: _thread,
    expectedBindingRevision: _binding,
    ...definition
  } = f.request;
  const revised = (await f.invoke("reviseRemaining", {
    ...definition,
    planId,
    expectedRevision: paused2.view.plan.revision,
    idempotencyKey: "revise-plan",
    instruction: "Draft the same story with revised notes",
  })) as unknown as ProjectTextPlansResponses["reviseRemaining"];
  assert.equal(delegation()?.actionId, A.reviseRemaining);
  await assert.rejects(
    f.invoke("continue", {
      ...control,
      expectedRevision: revised.view.plan.revision,
      idempotencyKey: "cannot-continue-ready",
    }),
  );
  assert.equal(f.state.invocation?.delegation, null);
  const revoked = (await f.invoke("revoke", {
    ...control,
    expectedRevision: revised.view.plan.revision,
    idempotencyKey: "revoke-plan",
  })) as unknown as ProjectTextPlansResponses["revoke"];
  assert.equal(revoked.view.plan.state, "revoked");
  assert.equal(
    await f.parent.loadRunInSpace({
      tenantId: f.actor.tenantId,
      spaceId: f.actor.spaceId,
      runId: "nonexistent-run",
    }),
    null,
  );
  for (const forbidden of [
    "actorId",
    "principalId",
    "packageDigest",
    "authorityEpoch",
    "delegation",
    "invocationId",
  ])
    assert.equal(JSON.stringify(start).includes(`"${forbidden}"`), false);
});
test("only actual plan registration qualifies; copies, getter lookalikes and other UI qualifications cannot issue delegation", async (t) => {
  const f = await projectTextPlanActionFixture(t);
  let captured = false;
  f.state.onContext = (context) => {
    const q = capturePluginProjectTextPlanInvocationCommitAuthority(context);
    captured = true;
    assert.equal(q.actionId, A.get);
    assert.equal(q.delegation, null);
    assert.throws(
      () =>
        capturePluginProjectTextPlanInvocationCommitAuthority({ ...context }),
      { code: "plugin_project_text_plan_invocation_required" },
    );
    assert.throws(
      () => capturePluginProjectTextUiInvocationCommitAuthority(context),
      { code: "plugin_ui_invocation_unavailable" },
    );
    assert.throws(
      () => capturePluginProjectTextRecoveryInvocationCommitAuthority(context),
      { code: "plugin_project_text_recovery_transaction_required" },
    );
  };
  await f.invoke("get", {
    projectId: f.request.projectId,
    planId: "absent-plan",
  });
  assert.equal(captured, true);
  await assert.rejects(f.owner.actions.invoke(f.state.context!), {
    code: "plugin_project_text_plan_invocation_required",
  });
  let getterCalls = 0;
  const fake = Object.defineProperty({}, "actor", {
    get() {
      getterCalls++;
      throw Error("getter");
    },
  }) as PluginUiActionContext;
  await assert.rejects(f.owner.actions.invoke(fake), {
    code: "plugin_project_text_plan_invocation_required",
  });
  assert.equal(getterCalls, 0);
  assert.throws(
    () =>
      new PluginProjectTextPlanActionOwner({
        plans: Object.create(Object.getPrototypeOf(f.plans)),
        publications: f.publications,
        authorization: f.authorization,
      }),
    { code: "plugin_project_text_plan_config_invalid" },
  );
});
test("same actor/full tuple/project and independent project PDP are required even for valid mounted plan actions", async (t) => {
  const f = await projectTextPlanActionFixture(t);
  f.state.foreign = true;
  await assert.rejects(f.invoke("start", f.request));
  f.state.foreign = false;
  f.state.projectAllowed = false;
  await assert.rejects(f.invoke("start", f.request), {
    code: "project_text_plan_access_denied",
  });
  f.state.projectAllowed = true;
  await assert.rejects(
    f.invoke("start", { ...f.request, projectId: "foreign-project" }),
    { code: "plugin_project_text_plan_action_denied" },
  );
  const page = await f.plans.list(
    f.actor,
    { projectId: f.request.projectId, afterPlanId: null, limit: 16 },
    f.authority,
  );
  assert.equal(page.plans.length, 0);
});
test("owner captures methods, synchronously withdraws and physically joins in-flight issuer before closing", async (t) => {
  const f = await projectTextPlanActionFixture(t),
    entered = uiDeferred(),
    release = uiDeferred();
  f.state.beforeIssue = async () => {
    entered.resolve();
    await release.promise;
  };
  const call = f.invoke("get", {
    projectId: f.request.projectId,
    planId: "absent-plan",
  });
  const rejected = assert.rejects(call, {
    code: "plugin_project_text_plan_actions_unavailable",
  });
  await entered.promise;
  let joined = false;
  const closed = f.owner.close().then(() => {
    joined = true;
  });
  await Promise.resolve();
  assert.equal(joined, false);
  assert.throws(() => f.owner.assertAvailable(), {
    code: "plugin_project_text_plan_actions_unavailable",
  });
  release.resolve();
  await rejected;
  await closed;
  assert.equal(joined, true);
});
test("confirmed physical COMMIT remains a one-use actual metadata acknowledgement after late owner/epoch withdrawal", async (t) => {
  const f = await projectTextPlanActionFixture(t);
  f.state.afterAction = async () => {
    f.ui.state.epoch = "new-epoch";
    await f.owner.close();
  };
  const accepted = (await f.invoke(
    "start",
    f.request,
  )) as unknown as ProjectTextPlansResponses["start"];
  assert.equal(accepted.disposition, "committed");
  assert.equal(f.owner.committedMetadata.isOutcome(f.state.raw), false);
  assert.throws(
    () =>
      f.owner.committedMetadata.verify(f.state.context!, f.state.raw as never),
    { code: "plugin_ui_committed_metadata_invalid" },
  );
});
