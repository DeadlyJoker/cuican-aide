import assert from "node:assert/strict";
import test from "node:test";
import { ControlApiClientError } from "@crewon/control-client";
import { parsePluginUiIntentRecord } from "@crewon/domain";
import {
  parseGetConceptSelectionResponse,
  parseSelectConceptImageResponse,
  type PluginUiRecoveryHint,
  type PluginUiRecoveryRequest,
} from "@crewon/contracts";
import {
  mainRecoveryActions,
  recoveryMainFixture,
} from "./plugin-ui-recovery-main.integration.test-support.ts";
import { extensionStoreDigester } from "../../../packages/store/src/extension-store-records.ts";

function selectionReceipt(request: PluginUiRecoveryRequest, output: unknown) {
  assert.ok(request.action === mainRecoveryActions.selection);
  const { idempotencyKey: _key, ...body } = request.input;
  return parseSelectConceptImageResponse(output, body);
}
function exactUnresolved(
  hints: readonly PluginUiRecoveryHint[],
  requests: readonly PluginUiRecoveryRequest[],
  sourcePin: PluginUiRecoveryHint["sourcePin"],
) {
  assert.equal(hints.length, 3);
  for (const request of requests) {
    const hint = hints.find((value) => value.request.action === request.action);
    assert.ok(hint);
    assert.deepEqual(hint.request, request);
    assert.deepEqual(hint.sourcePin, sourcePin);
    assert.equal(hint.receipt, null);
    assert.equal(hint.retryable, true);
    assert.ok(hint.phase === "prepared" || hint.phase === "dispatched");
  }
}
const mutations = (physical: readonly { method: string; path: string }[]) =>
  physical.filter((request) => request.path.endsWith("/actions"));

test(
  "actual original production Main uses one-connection pools, retires and restarts on the same SQL: three staged exact commands recover without automatic invocation; real opaque selection survives independent confirmation failure and original-key replay preserves a newer current pointer",
  {
    skip: !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 120_000,
  },
  async (t) => {
    const f = await recoveryMainFixture(t),
      baseline = await f.effects(),
      first = await f.start(),
      lease = await first.mount();
    assert.equal(lease.descriptor.entrypoints.node, null);
    assert.ok(
      lease.descriptor.requires.some(
        (requirement) => requirement.service === "crewon.plugin-ui-recovery",
      ),
    );
    assert.deepEqual(
      (await first.client.plugins.getRecovery(lease.mountRef)).intents,
      [],
    );
    const originalPin = {
      pluginId: f.source.descriptor.pluginId,
      publisherId: f.source.descriptor.publisherId,
      version: f.source.descriptor.version,
      packageDigest: f.source.packageDigest,
      selectionRevision: lease.selectionRevision,
      contributionId: lease.contributionId,
    };
    // SQL receives the first stage; losing its physical ACK prevents the subsequent business POST.
    f.state.dropStageAck = true;
    await assert.rejects(async () => {
      await first.client.plugins.stageRecovery(lease.mountRef, f.requests[0]!);
      await first.client.plugins.invoke(lease.mountRef, f.requests[0]!);
    });
    for (const request of f.requests.slice(1)) {
      const stage = await first.client.plugins.stageRecovery(
        lease.mountRef,
        request,
      );
      assert.equal(stage.intent.phase, "prepared");
      assert.equal(stage.intent.dispatchAttemptCount, 0);
      assert.deepEqual(stage.intent.request, request);
    }
    assert.equal(mutations(first.physicalRequests).length, 0);
    const staged = await first.client.plugins.getRecovery(lease.mountRef);
    exactUnresolved(staged.intents, f.requests, originalPin);
    assert.ok(staged.intents.every((hint) => hint.phase === "prepared"));
    assert.deepEqual(await f.effects(), baseline);
    const originalRecords = await f.rawRecords();
    const durable = originalRecords.map((row) =>
      parsePluginUiIntentRecord(row.record_json, extensionStoreDigester),
    );
    assert.equal(durable.length, 3);
    assert.equal(
      new Set(durable.map((intent) => intent.account.controlRealmId)).size,
      1,
    );
    for (const intent of durable) {
      assert.equal(intent.account.tenantId, f.actor.tenantId);
      assert.equal(intent.account.spaceId, f.actor.spaceId);
      assert.equal(intent.account.principalId, f.actor.principalId);
      assert.equal(intent.sourcePin.actorId, f.actor.actorId);
      assert.equal(intent.sourcePin.profileId, "named-main-profile");
      assert.equal(intent.sourcePin.authorityEpoch, "named-main-ui-epoch");
      const request = f.requests.find(
        (value) => value.action === intent.sourcePin.action,
      )!;
      assert.deepEqual(JSON.parse(intent.requestJson), request);
      assert.equal(intent.rawIdempotencyKey, request.input.idempotencyKey);
      assert.equal(intent.dispatchAttemptCount, 0);
    }
    await first.stop();
    assert.equal(first.child.finished(), true);

    const second = await f.start(),
      secondLease = await second.mount();
    assert.notEqual(second.child.child.pid, first.child.child.pid);
    assert.notEqual(secondLease.mountRef, lease.mountRef);
    await assert.rejects(
      () => second.client.plugins.getRecovery(lease.mountRef),
      (error: unknown) =>
        error instanceof ControlApiClientError && error.status === 404,
    );
    const beforeColdGet = second.physicalRequests.length,
      recovered = await second.client.plugins.getRecovery(secondLease.mountRef);
    exactUnresolved(recovered.intents, f.requests, originalPin);
    assert.deepEqual(recovered, staged);
    assert.deepEqual(await f.rawRecords(), originalRecords);
    assert.deepEqual(
      second.physicalRequests.slice(beforeColdGet).map((entry) => entry.method),
      ["GET"],
    );
    assert.equal(mutations(second.physicalRequests).length, 0);
    assert.deepEqual(await f.effects(), baseline);
    const stageReplay = await second.client.plugins.stageRecovery(
      secondLease.mountRef,
      f.selectionRequest,
    );
    assert.equal(stageReplay.disposition, "replayed");
    f.state.armConfirmationFault = true;
    let original;
    try {
      original = selectionReceipt(
        f.selectionRequest,
        (
          await second.client.plugins.invoke(
            secondLease.mountRef,
            f.selectionRequest,
          )
        ).output,
      );
      assert.equal(original.disposition, "committed");
      assert.equal(original.selectionRevision, 1);
      assert.equal(original.selection.filename, "named-first.png");
      assert.equal(f.state.faultInstalled, true);
    } finally {
      f.state.armConfirmationFault = false;
      if (f.state.faultInstalled) await f.confirmationFault(false);
    }
    const afterFailure = await second.client.plugins.getRecovery(
      secondLease.mountRef,
    );
    exactUnresolved(afterFailure.intents, f.requests, originalPin);
    const uncertain = afterFailure.intents.find(
      (hint) => hint.request.action === mainRecoveryActions.selection,
    )!;
    assert.equal(uncertain.phase, "dispatched");
    assert.equal(uncertain.dispatchMayHaveOccurred, true);
    assert.equal(uncertain.dispatchAttemptCount, 1);
    assert.equal(
      parseGetConceptSelectionResponse(await f.publicSelection(second))
        .selectionRevision,
      1,
    );
    assert.ok(f.selectionRequest.action === mainRecoveryActions.selection);
    const { idempotencyKey: _oldKey, ...selectionBody } =
      f.selectionRequest.input;
    const newer = parseSelectConceptImageResponse(
      await f.publicSelection(
        second,
        "PUT",
        { ...selectionBody, resultIndex: 1, expectedSelectionRevision: 1 },
        "named-main-explicit-newer-current-selection",
      ),
    );
    assert.equal(newer.selectionRevision, 2);
    assert.equal(newer.selection.filename, "named-second.png");
    const unresolvedRecords = await f.rawRecords();
    await second.stop();
    assert.equal(second.child.finished(), true);
    assert.ok(
      second.child.stderr().includes("plugin_ui_recovery_persistence_failed"),
      second.child.stderr(),
    );

    const third = await f.start(),
      thirdLease = await third.mount(),
      hints = await third.client.plugins.getRecovery(thirdLease.mountRef);
    assert.notEqual(thirdLease.mountRef, secondLease.mountRef);
    exactUnresolved(hints.intents, f.requests, originalPin);
    assert.deepEqual(hints, afterFailure);
    assert.deepEqual(await f.rawRecords(), unresolvedRecords);
    assert.equal(mutations(third.physicalRequests).length, 0);
    assert.deepEqual(await f.effects(), baseline);
    const beforeRetry = parseGetConceptSelectionResponse(
      await f.publicSelection(third),
    );
    assert.equal(beforeRetry.selectionRevision, 2);
    assert.equal(beforeRetry.current?.filename, "named-second.png");
    const restaged = await third.client.plugins.stageRecovery(
      thirdLease.mountRef,
      f.selectionRequest,
    );
    assert.equal(restaged.disposition, "replayed");
    assert.deepEqual(restaged.intent.request, f.selectionRequest);
    const replay = selectionReceipt(
      f.selectionRequest,
      (
        await third.client.plugins.invoke(
          thirdLease.mountRef,
          f.selectionRequest,
        )
      ).output,
    );
    assert.equal(replay.disposition, "replayed");
    assert.deepEqual(replay.selection, original!.selection);
    assert.equal(replay.selectionRevision, 1);
    const accepted = (
      await third.client.plugins.getRecovery(thirdLease.mountRef)
    ).intents.find(
      (hint) => hint.request.action === mainRecoveryActions.selection,
    )!;
    assert.equal(accepted.phase, "accepted");
    assert.equal(accepted.retryable, false);
    assert.equal(accepted.dispatchAttemptCount, 2);
    assert.deepEqual(accepted.request, f.selectionRequest);
    assert.deepEqual(accepted.sourcePin, originalPin);
    assert.deepEqual(accepted.receipt, replay);
    assert.deepEqual(
      parseGetConceptSelectionResponse(await f.publicSelection(third)),
      beforeRetry,
    );
    assert.deepEqual(await f.effects(), baseline);
    await third.stop();
    assert.equal(third.child.finished(), true);

    const observations = await f.poolObservations(),
      pids = [first, second, third].map((session) => session.child.child.pid);
    assert.equal(new Set(pids).size, 3);
    for (const pid of pids) {
      const observed = observations.children.filter(
        (entry) => entry.pid === pid,
      );
      assert.ok(
        observed.length > 0,
        `No physical Pool.connect for child ${pid}`,
      );
      assert.ok(observed.every((entry) => entry.max === 1 && entry.total <= 1));
      assert.ok(
        observed.some(
          (entry) => entry.phase === "acquired" && entry.total === 1,
        ),
      );
      t.diagnostic(
        `Original Main pid=${pid}: observed max=1, total<=1 and ${observed.filter((entry) => entry.phase === "acquired").length} physical acquire events; formally joined.`,
      );
    }
    assert.ok(observations.parent.length > 0);
    assert.ok(
      observations.parent.every((entry) => entry.max === 1 && entry.total <= 1),
    );
    assert.ok(
      observations.parent.some(
        (entry) => entry.phase === "acquired" && entry.total === 1,
      ),
    );
    assert.ok(f.state.tlsConnections > 0);
    assert.equal(f.state.peerCalls, 0);
    assert.equal(f.state.quoteCalls, 0);
    t.diagnostic(
      "Three original Main processes formally joined; verified TLS authorities and installed immutable Krea2 bytes. Generation/query owners stage only. Real selection owner commits and replays against seeded named paid history/results/funding; no live Worker/provider or production funds.",
    );
  },
);
