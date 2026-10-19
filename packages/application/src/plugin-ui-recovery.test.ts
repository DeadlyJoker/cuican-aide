import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationError } from "./application-error.ts";
import { uiRejects } from "./plugin-ui.test-support.ts";
import {
  recoveryFixture,
  recoveryRequest,
  recoveryReceipt,
  recoveryDigester,
} from "./plugin-ui-recovery.test-support.ts";
import { createPluginUiIntentPayloadVerifier } from "./plugin-ui-recovery-codec.ts";
import { capturePluginUiRecoveryPort } from "./plugin-ui-recovery-invocation.ts";
import { extensionCanonicalJson } from "@crewon/domain";
import { queryRevisionNotAdmitted } from "./project-query-nonadmission.ts";
import { projectGenerationQueryUiTaskKey } from "./project-query-task-receipt.ts";

test("only the host query non-admission proof can end a repeatedly dispatched old query", async () => {
  const f = recoveryFixture(),
    lease = await f.mount(),
    request = recoveryRequest("query");
  if (
    request.action !==
    "crewon.project-generation-queries.v1.queryConceptGeneration"
  )
    throw new Error("fixture_invalid");
  await f.service.stageRecovery(f.actor, {
    mountRef: lease.mountRef,
    ...request,
  });
  f.behavior.actionError = new ApplicationError(
    "conflict",
    "project_query_revision_not_admitted",
  );
  await assert.rejects(
    f.service.invoke(f.actor, { mountRef: lease.mountRef, ...request }),
  );
  const record = [...f.records.values()][0]!;
  assert.equal(record.phase, "dispatched");
  f.behavior.actionError = queryRevisionNotAdmitted(
    {
      threadId: request.input.threadId,
      expectedThreadRevision: request.input.expectedThreadRevision,
      taskKey: projectGenerationQueryUiTaskKey(
        {
          sourcePin: record.sourcePin,
          idempotencyKey: request.input.idempotencyKey,
        },
        recoveryDigester,
      ),
    },
    new Error("revision_conflict"),
  );
  await assert.rejects(
    f.service.invoke(f.actor, { mountRef: lease.mountRef, ...request }),
  );
  const refused = [...f.records.values()][0]!;
  assert.equal(refused.phase, "refused");
  assert.equal(refused.dispatchAttemptCount, 2);
  assert.equal(refused.requestJson, record.requestJson);
});

test("declared recovery requires durable stage before business and survives mount replacement", async () => {
  const f = recoveryFixture();
  const lease = await f.mount();
  const request = recoveryRequest();
  await uiRejects(
    () => f.service.invoke(f.actor, { mountRef: lease.mountRef, ...request }),
    "conflict",
    "plugin_ui_intent_stage_required",
  );
  assert.equal(f.behavior.calls, 0);
  const stage = await f.service.stageRecovery(f.actor, {
    mountRef: lease.mountRef,
    ...request,
  });
  assert.equal(stage.intent.phase, "prepared");
  assert.equal(stage.intent.dispatchMayHaveOccurred, false);
  assert.equal(f.behavior.calls, 0);
  await f.service.closeMount(f.actor, { mountRef: lease.mountRef });
  const current = await f.mount();
  const hints = await f.service.getRecovery(f.actor, {
    mountRef: current.mountRef,
  });
  assert.deepEqual(hints.intents[0]!.request, request);
  assert.equal(hints.intents[0]!.retryable, true);
  const output = await f.service.invoke(f.actor, {
    mountRef: current.mountRef,
    ...request,
  });
  assert.deepEqual(output, recoveryReceipt(request));
  assert.equal([...f.records.values()][0]!.phase, "accepted");
  assert.ok(
    f.events.lastIndexOf("dispatch") < f.events.lastIndexOf("business"),
  );
});

test("old declaration has zero journal IO; missing actual recovery port fails closed", async () => {
  const legacy = recoveryFixture({ declared: false });
  const lease = await legacy.mount();
  await legacy.service.invoke(legacy.actor, {
    mountRef: lease.mountRef,
    ...recoveryRequest(),
  });
  assert.deepEqual(legacy.events, ["business"]);
  const disabled = recoveryFixture({ configured: false });
  const current = await disabled.mount();
  await uiRejects(
    () =>
      disabled.service.invoke(disabled.actor, {
        mountRef: current.mountRef,
        ...recoveryRequest(),
      }),
    "conflict",
    "plugin_ui_recovery_unavailable",
  );
  assert.equal(disabled.behavior.calls, 0);
});

test("stage late ACK after close persists prepared intent but never invokes business", async () => {
  const f = recoveryFixture();
  const lease = await f.mount();
  f.behavior.afterStage = () =>
    f.service.closeMount(f.actor, { mountRef: lease.mountRef });
  await assert.rejects(() =>
    f.service.stageRecovery(f.actor, {
      mountRef: lease.mountRef,
      ...recoveryRequest(),
    }),
  );
  assert.equal([...f.records.values()][0]!.phase, "prepared");
  assert.equal(f.behavior.calls, 0);
  f.behavior.afterStage = null;
  const next = await f.mount();
  assert.equal(
    (await f.service.getRecovery(f.actor, { mountRef: next.mountRef }))
      .intents[0]!.phase,
    "prepared",
  );
});

test("withdrawal during durable dispatch leaves UNKNOWN with zero business calls", async () => {
  const f = recoveryFixture();
  const lease = await f.mount();
  const request = recoveryRequest();
  await f.service.stageRecovery(f.actor, {
    mountRef: lease.mountRef,
    ...request,
  });
  f.behavior.beforeDispatch = async () => {
    f.state.allowed.delete("invoke");
  };
  await assert.rejects(() =>
    f.service.invoke(f.actor, { mountRef: lease.mountRef, ...request }),
  );
  assert.equal([...f.records.values()][0]!.phase, "dispatched");
  assert.equal(f.behavior.calls, 0);
});

test("verified original COMMIT remains sticky after close and failed confirmation is diagnostic only", async () => {
  const f = recoveryFixture();
  const lease = await f.mount();
  const request = recoveryRequest();
  await f.service.stageRecovery(f.actor, {
    mountRef: lease.mountRef,
    ...request,
  });
  f.behavior.afterBusiness = () =>
    f.service.closeMount(f.actor, { mountRef: lease.mountRef });
  f.behavior.confirmFailure = true;
  assert.deepEqual(
    await f.service.invoke(f.actor, { mountRef: lease.mountRef, ...request }),
    recoveryReceipt(request),
  );
  assert.equal(f.diagnostics.length, 1);
  assert.equal([...f.records.values()][0]!.phase, "dispatched");
});

test("plain JSON receipt cannot produce durable accepted intent", async () => {
  const f = recoveryFixture();
  const lease = await f.mount();
  const request = recoveryRequest();
  await f.service.stageRecovery(f.actor, {
    mountRef: lease.mountRef,
    ...request,
  });
  f.behavior.jsonOutcome = true;
  await f.service.invoke(f.actor, { mountRef: lease.mountRef, ...request });
  assert.equal([...f.records.values()][0]!.phase, "dispatched");
  assert.equal(f.events.includes("confirm"), false);
});

for (const kind of ["generation", "query", "selection"] as const) {
  test(`${kind} sent exception retains original key; only first exact selection conflict may refuse`, async () => {
    const f = recoveryFixture();
    const lease = await f.mount();
    const request = recoveryRequest(kind);
    await f.service.stageRecovery(f.actor, {
      mountRef: lease.mountRef,
      ...request,
    });
    const error = new ApplicationError(
      "conflict",
      "creative_project_revision_conflict",
    );
    f.behavior.actionError = error;
    await assert.rejects(
      () => f.service.invoke(f.actor, { mountRef: lease.mountRef, ...request }),
      (actual) => actual === error,
    );
    assert.equal(
      [...f.records.values()][0]!.phase,
      kind === "selection" ? "refused" : "dispatched",
    );
  });
}

test("selection UNKNOWN followed by CAS conflict never becomes refused; concurrent attempt prevents refusal", async () => {
  const f = recoveryFixture();
  const lease = await f.mount();
  const request = recoveryRequest();
  await f.service.stageRecovery(f.actor, {
    mountRef: lease.mountRef,
    ...request,
  });
  f.behavior.actionError = new Error("unknown sent response");
  await assert.rejects(() =>
    f.service.invoke(f.actor, { mountRef: lease.mountRef, ...request }),
  );
  f.behavior.actionError = new ApplicationError(
    "conflict",
    "concept_selection_revision_conflict",
  );
  await assert.rejects(() =>
    f.service.invoke(f.actor, { mountRef: lease.mountRef, ...request }),
  );
  const intent = [...f.records.values()][0]!;
  assert.equal(intent.phase, "dispatched");
  assert.equal(intent.dispatchAttemptCount, 2);
  await assert.rejects(() =>
    f.service.stageRecovery(f.actor, {
      mountRef: lease.mountRef,
      ...recoveryRequest("selection", "new-key"),
    }),
  );
  assert.equal(f.records.size, 1);
});

test("refusal persistence failure preserves original exception and emits only diagnostic", async () => {
  const f = recoveryFixture();
  const lease = await f.mount();
  const request = recoveryRequest();
  await f.service.stageRecovery(f.actor, {
    mountRef: lease.mountRef,
    ...request,
  });
  f.behavior.refuseFailure = true;
  const error = new ApplicationError(
    "conflict",
    "concept_selection_operation_revision_conflict",
  );
  f.behavior.actionError = error;
  await assert.rejects(
    () => f.service.invoke(f.actor, { mountRef: lease.mountRef, ...request }),
    (actual) => actual === error,
  );
  assert.equal([...f.records.values()][0]!.phase, "dispatched");
  assert.equal(f.diagnostics.length, 1);
});

test("same account changed actor cannot silently retry original namespace", async () => {
  const f = recoveryFixture();
  const lease = await f.mount();
  const request = recoveryRequest();
  await f.service.stageRecovery(f.actor, {
    mountRef: lease.mountRef,
    ...request,
  });
  const changed = { ...f.actor, actorId: "actor-new" };
  const next = await f.service.openMount(changed, {
    pluginId: lease.descriptor.pluginId,
    contributionId: lease.contributionId,
    expectedPackageDigest: lease.packageDigest,
    expectedSelectionRevision: lease.selectionRevision,
  });
  const hint = (
    await f.service.getRecovery(changed, { mountRef: next.mountRef })
  ).intents[0]!;
  assert.equal(hint.retryable, false);
  assert.equal(hint.reasonCode, "plugin_ui_recovery_source_changed");
  assert.deepEqual(hint.request, request);
});

for (const kind of ["generation", "query", "selection"] as const) {
  test(`${kind} cold hint preserves original namespace and uses its existing host pin matching rule`, async () => {
    const f = recoveryFixture(),
      lease = await f.mount(),
      request = recoveryRequest(kind);
    await f.service.stageRecovery(f.actor, {
      mountRef: lease.mountRef,
      ...request,
    });
    await f.service.closeMount(f.actor, { mountRef: lease.mountRef });
    f.state.selection = {
      ...f.state.selection!,
      revision: f.state.selection!.revision + 1,
    };
    f.state.epoch = "epoch-reauthorized";
    const next = await f.mount(),
      hint = (await f.service.getRecovery(f.actor, { mountRef: next.mountRef }))
        .intents[0]!;
    assert.equal(hint.sourcePin.selectionRevision, lease.selectionRevision);
    assert.equal(hint.retryable, kind === "selection");
    assert.deepEqual(hint.request, request);
  });
}

test("unknown selection conflict code and non-conflict errors never refuse the original intent", async () => {
  for (const error of [
    new ApplicationError("conflict", "unrelated_conflict"),
    new ApplicationError("authorization", "creative_project_revision_conflict"),
  ]) {
    const f = recoveryFixture(),
      lease = await f.mount(),
      request = recoveryRequest();
    await f.service.stageRecovery(f.actor, {
      mountRef: lease.mountRef,
      ...request,
    });
    f.behavior.actionError = error;
    await assert.rejects(
      () => f.service.invoke(f.actor, { mountRef: lease.mountRef, ...request }),
      (actual) => actual === error,
    );
    assert.equal([...f.records.values()][0]!.phase, "dispatched");
    assert.equal(f.events.includes("refuse"), false);
  }
});

test("codec binds exact original request/receipt and logical replay identity", () => {
  const codec = createPluginUiIntentPayloadVerifier(recoveryDigester),
    request = recoveryRequest();
  const input = {
    kind: "selection" as const,
    action: request.action,
    requestJson: extensionCanonicalJson(request),
  };
  const receipt = recoveryReceipt(request) as Record<string, unknown>;
  const original = codec.verifyReceipt({
    ...input,
    receiptJson: extensionCanonicalJson(receipt),
  });
  const replay = codec.verifyReceipt({
    ...input,
    receiptJson: extensionCanonicalJson({
      ...receipt,
      disposition: "replayed",
    }),
  });
  assert.equal(original.receiptIdentityDigest, replay.receiptIdentityDigest);
  assert.throws(() =>
    codec.verifyReceipt({
      ...input,
      receiptJson: extensionCanonicalJson({ ...receipt, selectionRevision: 2 }),
    }),
  );
  assert.throws(() =>
    codec.verifyRequest({
      ...input,
      requestJson: JSON.stringify(request) + " ",
    }),
  );
});

test("captured recovery callbacks retain original receiver and reject getter authority", async () => {
  let reads = 0;
  const getter = Object.defineProperty({}, "get", {
    get() {
      reads++;
      return () => null;
    },
  });
  assert.throws(() => capturePluginUiRecoveryPort(getter as never));
  assert.equal(reads, 0);
  const f = recoveryFixture();
  const captured = capturePluginUiRecoveryPort(f.recovery)!;
  assert.equal(typeof captured.get, "function");
  await assert.rejects(() => f.recovery.get({} as never));
});
