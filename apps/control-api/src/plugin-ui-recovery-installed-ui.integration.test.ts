import assert from "node:assert/strict";
import test from "node:test";
import { ControlApiClientError } from "@crewon/control-client";
import { parseSelectConceptImageResponse } from "@crewon/contracts";
import { selectionRecipe } from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import {
  selectionRecoveryHttpFixture,
  type SelectionRecoveryRequest,
} from "./plugin-ui-recovery-installed-ui.integration.test-support.ts";
function selectionReceipt(request: SelectionRecoveryRequest, output: unknown) {
  const { idempotencyKey: _key, ...body } = request.input;
  return parseSelectConceptImageResponse(output, body);
}
const conflict = (code: string) => (error: unknown) =>
  error instanceof ControlApiClientError &&
  error.status === 409 &&
  error.category === "conflict" &&
  error.code === code;
for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 20000,
  };
  test(
    `${backend} actual registered selection owner stages before original SQL COMMIT and exposes accepted recovery via ControlClient; GET creates no Run or charge`,
    options,
    async (t) => {
      const f = await selectionRecoveryHttpFixture(t, backend),
        session = await f.open(),
        lease = await session.mount(),
        request = f.request(),
        baseline = await f.taskEffects();
      await assert.rejects(() =>
        session.client.plugins.invoke(lease.mountRef, request),
      );
      assert.equal(f.state.selectionInvocations, 0);
      assert.equal(await f.selectionReceiptCount(), 0);
      assert.deepEqual(
        (await session.client.plugins.getRecovery(lease.mountRef)).intents,
        [],
      );
      const stage = await session.client.plugins.stageRecovery(
        lease.mountRef,
        request,
      );
      assert.equal(stage.intent.phase, "prepared");
      assert.equal(stage.intent.dispatchAttemptCount, 0);
      assert.deepEqual(stage.intent.request, request);
      assert.equal(f.state.selectionInvocations, 0);
      const beforeGet = await f.taskEffects();
      const pending = await session.client.plugins.getRecovery(lease.mountRef);
      assert.equal(pending.intents[0]?.phase, "prepared");
      assert.deepEqual(await f.taskEffects(), beforeGet);
      assert.equal(await f.selectionReceiptCount(), 0);
      const response = await session.client.plugins.invoke(
          lease.mountRef,
          request,
        ),
        receipt = selectionReceipt(request, response.output);
      assert.equal(receipt.disposition, "committed");
      assert.equal(receipt.selection.filename, "first.png");
      assert.equal(f.state.selectionInvocations, 1);
      const confirmed = await session.client.plugins.getRecovery(
        lease.mountRef,
      );
      assert.equal(confirmed.intents[0]?.phase, "accepted");
      assert.deepEqual(confirmed.intents[0]?.receipt, receipt);
      assert.equal(confirmed.intents[0]?.retryable, false);
      const read = await session.client.plugins.invoke(lease.mountRef, {
        action: "crewon.project-generation-selections.v1.getConceptSelection",
        input: {
          projectId: f.reference.projectId,
          assetId: f.reference.assetId,
        },
      });
      assert.equal(
        (read.output as { selectionRevision: number }).selectionRevision,
        1,
      );
      assert.equal(await f.selectionReceiptCount(), 1);
      assert.deepEqual(await f.taskEffects(), baseline);
      assert.equal(f.state.context?.lease.descriptor.entrypoints.node, null);
    },
  );
  test(
    `${backend} lost durable stage ACK never reaches the real selection owner; fresh UI/owner/journal recovers exact prepared input without automatic POST`,
    options,
    async (t) => {
      const f = await selectionRecoveryHttpFixture(t, backend),
        first = await f.open(),
        lease = await first.mount(),
        request = f.request("lost-stage-ack"),
        baseline = await f.taskEffects();
      f.state.dropStageAck = true;
      const stageThenInvoke = async () => {
        await first.client.plugins.stageRecovery(lease.mountRef, request);
        return first.client.plugins.invoke(lease.mountRef, request);
      };
      await assert.rejects(stageThenInvoke);
      assert.equal(f.state.selectionInvocations, 0);
      assert.equal(await f.selectionReceiptCount(), 0);
      assert.equal(
        f.state.physical.filter((x) => x.path.endsWith("/actions")).length,
        0,
      );
      await first.close();
      const fresh = await f.open(),
        newLease = await fresh.mount(),
        beforeRead = f.state.physical.length,
        hints = await fresh.client.plugins.getRecovery(newLease.mountRef);
      assert.notEqual(newLease.mountRef, lease.mountRef);
      assert.equal(hints.intents[0]?.phase, "prepared");
      assert.equal(hints.intents[0]?.dispatchMayHaveOccurred, false);
      assert.deepEqual(hints.intents[0]?.request, request);
      assert.deepEqual(hints.intents[0]?.sourcePin, {
        pluginId: f.descriptor.pluginId,
        publisherId: f.descriptor.publisherId,
        version: f.descriptor.version,
        packageDigest: f.publication.packageDigest,
        selectionRevision: lease.selectionRevision,
        contributionId: "workbench",
      });
      assert.equal(hints.intents[0]?.retryable, true);
      assert.deepEqual(
        f.state.physical.slice(beforeRead).map((x) => x.method),
        ["GET"],
      );
      assert.equal(await f.selectionReceiptCount(), 0);
      assert.deepEqual(await f.taskEffects(), baseline);
      await assert.rejects(() =>
        fresh.client.plugins.stageRecovery(
          newLease.mountRef,
          f.request("new-key-before-old-confirm"),
        ),
      );
      assert.equal(f.state.selectionInvocations, 0);
      const replay = await fresh.client.plugins.stageRecovery(
        newLease.mountRef,
        request,
      );
      assert.equal(replay.disposition, "replayed");
      const result = await fresh.client.plugins.invoke(
        newLease.mountRef,
        request,
      );
      assert.equal(
        selectionReceipt(request, result.output).disposition,
        "committed",
      );
      assert.equal(
        (await fresh.client.plugins.getRecovery(newLease.mountRef)).intents[0]
          ?.phase,
        "accepted",
      );
      assert.deepEqual(await f.taskEffects(), baseline);
    },
  );
  test(
    `${backend} independently failed journal confirmation preserves the real opaque selection success; cold UNKNOWN retries only original key and immutable receipt never replaces newer current pointer`,
    options,
    async (t) => {
      const f = await selectionRecoveryHttpFixture(t, backend),
        first = await f.open(),
        lease = await first.mount(),
        request = f.request("confirm-storage-failed"),
        baseline = await f.taskEffects();
      await first.client.plugins.stageRecovery(lease.mountRef, request);
      f.state.afterOutcome = () => f.failConfirmationStorage(true);
      let original;
      try {
        original = selectionReceipt(
          request,
          (await first.client.plugins.invoke(lease.mountRef, request)).output,
        );
        assert.equal(original.disposition, "committed");
        assert.equal(f.state.diagnostics.length, 1);
      } finally {
        await f.failConfirmationStorage(false);
      }
      assert.equal((await f.current()).selectionRevision, 1);
      const unconfirmed = await first.client.plugins.getRecovery(
        lease.mountRef,
      );
      assert.equal(unconfirmed.intents[0]?.phase, "dispatched");
      assert.equal(unconfirmed.intents[0]?.receipt, null);
      assert.equal(unconfirmed.intents[0]?.dispatchAttemptCount, 1);
      await first.close();
      const nativeNewer = await f.app.inject({
        method: "PUT",
        url: f.selectionUrl,
        headers: f.selectionHeaders("authenticated-newer-selection"),
        payload: f.selectionBody(1, 1),
      });
      assert.equal(nativeNewer.statusCode, 200, nativeNewer.body);
      assert.equal((await f.current()).current.filename, "second.png");
      const fresh = await f.open(),
        newLease = await fresh.mount(),
        beforeGet = f.state.selectionInvocations,
        recovery = await fresh.client.plugins.getRecovery(newLease.mountRef);
      assert.equal(recovery.intents[0]?.phase, "dispatched");
      assert.deepEqual(recovery.intents[0]?.request, request);
      assert.equal(f.state.selectionInvocations, beforeGet);
      assert.equal(recovery.intents[0]?.retryable, true);
      await fresh.client.plugins.stageRecovery(newLease.mountRef, request);
      const replay = selectionReceipt(
        request,
        (await fresh.client.plugins.invoke(newLease.mountRef, request)).output,
      );
      assert.equal(replay.disposition, "replayed");
      assert.deepEqual(replay.selection, original!.selection);
      const accepted = await fresh.client.plugins.getRecovery(
        newLease.mountRef,
      );
      assert.equal(accepted.intents[0]?.phase, "accepted");
      assert.equal(accepted.intents[0]?.dispatchAttemptCount, 2);
      assert.equal((await f.current()).selectionRevision, 2);
      assert.equal((await f.current()).current.filename, "second.png");
      assert.equal(await f.selectionReceiptCount(), 2);
      assert.deepEqual(await f.taskEffects(), baseline);
    },
  );
  test(
    `${backend} a real first selection CAS conflict becomes durable refused and permits a refreshed explicit new key`,
    options,
    async (t) => {
      const f = await selectionRecoveryHttpFixture(t, backend),
        session = await f.open(),
        lease = await session.mount(),
        bad = f.request("first-conflict", 0, 1),
        baseline = await f.taskEffects();
      await session.client.plugins.stageRecovery(lease.mountRef, bad);
      await assert.rejects(
        () => session.client.plugins.invoke(lease.mountRef, bad),
        conflict("concept_selection_revision_conflict"),
      );
      const hint = (await session.client.plugins.getRecovery(lease.mountRef))
        .intents[0]!;
      assert.equal(hint.phase, "refused");
      assert.equal(hint.dispatchAttemptCount, 1);
      assert.equal(hint.reasonCode, "concept_selection_revision_conflict");
      assert.equal(hint.retryable, false);
      assert.equal(await f.selectionReceiptCount(), 0);
      assert.deepEqual(await f.current(), {
        selectionRevision: 0,
        current: null,
      });
      const refreshed = f.request(
        "fresh-explicit-after-conflict",
        0,
        (await f.current()).selectionRevision,
      );
      await session.client.plugins.stageRecovery(lease.mountRef, refreshed);
      assert.equal(
        selectionReceipt(
          refreshed,
          (await session.client.plugins.invoke(lease.mountRef, refreshed))
            .output,
        ).disposition,
        "committed",
      );
      assert.equal(
        (await session.client.plugins.getRecovery(lease.mountRef)).intents[0]
          ?.phase,
        "accepted",
      );
      assert.deepEqual(await f.taskEffects(), baseline);
    },
  );
  test(
    `${backend} a lost first owner-policy failure remains UNKNOWN after a real second typed selection 409, including a fresh UI service`,
    options,
    async (t) => {
      const f = await selectionRecoveryHttpFixture(t, backend),
        first = await f.open(),
        lease = await first.mount(),
        bad = f.request("unknown-before-conflict", 0, 1),
        baseline = await f.taskEffects();
      await first.client.plugins.stageRecovery(lease.mountRef, bad);
      f.state.beforeOwnerAuthorize = async () => {
        throw new Error("selection-owner-policy-temporarily-unavailable");
      };
      f.state.dropInvokeAck = true;
      await assert.rejects(() =>
        first.client.plugins.invoke(lease.mountRef, bad),
      );
      f.state.beforeOwnerAuthorize = null;
      assert.equal(
        (await first.client.plugins.getRecovery(lease.mountRef)).intents[0]
          ?.phase,
        "dispatched",
      );
      await first.close();
      const fresh = await f.open(),
        newLease = await fresh.mount();
      const cold = (await fresh.client.plugins.getRecovery(newLease.mountRef))
        .intents[0]!;
      assert.equal(cold.dispatchAttemptCount, 1);
      assert.deepEqual(cold.request, bad);
      await fresh.client.plugins.stageRecovery(newLease.mountRef, bad);
      await assert.rejects(
        () => fresh.client.plugins.invoke(newLease.mountRef, bad),
        conflict("concept_selection_revision_conflict"),
      );
      const twice = (await fresh.client.plugins.getRecovery(newLease.mountRef))
        .intents[0]!;
      assert.equal(twice.phase, "dispatched");
      assert.equal(twice.dispatchAttemptCount, 2);
      assert.equal(twice.retryable, true);
      assert.equal(twice.reasonCode, null);
      assert.equal(await f.selectionReceiptCount(), 0);
      await assert.rejects(() =>
        fresh.client.plugins.stageRecovery(
          newLease.mountRef,
          f.request("cannot-escape-old-unknown"),
        ),
      );
      assert.deepEqual(await f.taskEffects(), baseline);
    },
  );
  test(
    `${backend} actual selection disable/regrant changes the live lease while durable original pin/key stay immutable`,
    options,
    async (t) => {
      const f = await selectionRecoveryHttpFixture(t, backend),
        session = await f.open(),
        lease = await session.mount(),
        request = f.request("same-key-regrant"),
        baseline = await f.taskEffects(),
        staged = await session.client.plugins.stageRecovery(
          lease.mountRef,
          request,
        );
      const disabled = await f.ledger.commitSelection(
        selectionRecipe(f.selected.selection, "recovery-real-disable", {
          actor: f.actor,
          state: "disabled",
        }),
      );
      await assert.rejects(() =>
        session.client.plugins.invoke(lease.mountRef, request),
      );
      assert.equal(f.state.selectionInvocations, 0);
      await f.ledger.commitSelection(
        selectionRecipe(disabled.selection, "recovery-real-reenable", {
          actor: f.actor,
        }),
      );
      f.state.epoch = "recovery-fixture-epoch-2";
      const live = await session.mount();
      assert.ok(live.selectionRevision > lease.selectionRevision);
      const hint = (await session.client.plugins.getRecovery(live.mountRef))
        .intents[0]!;
      assert.equal(hint.retryable, true);
      assert.deepEqual(hint.sourcePin, staged.intent.sourcePin);
      const replay = await session.client.plugins.stageRecovery(
        live.mountRef,
        request,
      );
      assert.equal(replay.disposition, "replayed");
      assert.deepEqual(replay.intent.sourcePin, staged.intent.sourcePin);
      const outcome = selectionReceipt(
        request,
        (await session.client.plugins.invoke(live.mountRef, request)).output,
      );
      assert.equal(outcome.disposition, "committed");
      assert.deepEqual(
        (await session.client.plugins.getRecovery(live.mountRef)).intents[0]
          ?.sourcePin,
        staged.intent.sourcePin,
      );
      assert.deepEqual(await f.taskEffects(), baseline);
    },
  );
  test(
    `${backend} current actor/profile and account isolation block borrowing a durable original namespace rather than rekeying or granting from hints`,
    options,
    async (t) => {
      const f = await selectionRecoveryHttpFixture(t, backend),
        session = await f.open(),
        lease = await session.mount(),
        request = f.request("original-scope-unknown"),
        baseline = await f.taskEffects();
      await session.client.plugins.stageRecovery(lease.mountRef, request);
      f.state.actor = { ...f.actor, actorId: "different-current-actor" };
      await assert.rejects(() =>
        session.client.plugins.getRecovery(lease.mountRef),
      );
      const actorLease = await session.mount(),
        actorHint = (
          await session.client.plugins.getRecovery(actorLease.mountRef)
        ).intents[0]!;
      assert.equal(actorHint.retryable, false);
      assert.equal(actorHint.reasonCode, "plugin_ui_recovery_source_changed");
      assert.deepEqual(actorHint.request, request);
      await assert.rejects(() =>
        session.client.plugins.stageRecovery(actorLease.mountRef, request),
      );
      await assert.rejects(() =>
        session.client.plugins.invoke(actorLease.mountRef, request),
      );
      assert.equal(f.state.selectionInvocations, 0);
      f.state.actor = { ...f.actor };
      f.state.profile = {
        ...f.state.profile,
        profileId: "recovery-other-profile",
      };
      await f.installProfile(f.state.profile);
      const profileLease = await session.mount(),
        profileHint = (
          await session.client.plugins.getRecovery(profileLease.mountRef)
        ).intents[0]!;
      assert.equal(profileHint.retryable, false);
      assert.deepEqual(profileHint.request, request);
      await assert.rejects(() =>
        session.client.plugins.stageRecovery(profileLease.mountRef, request),
      );
      await assert.rejects(() =>
        session.client.plugins.invoke(profileLease.mountRef, request),
      );
      f.state.actor = {
        ...f.actor,
        principalId: "different-current-principal",
        actorId: "different-current-principal-actor",
      };
      await assert.rejects(() =>
        session.client.plugins.getRecovery(profileLease.mountRef),
      );
      const accountLease = await session.mount();
      assert.deepEqual(
        (await session.client.plugins.getRecovery(accountLease.mountRef))
          .intents,
        [],
      );
      assert.equal(await f.selectionReceiptCount(), 0);
      assert.deepEqual(await f.taskEffects(), baseline);
    },
  );
}
