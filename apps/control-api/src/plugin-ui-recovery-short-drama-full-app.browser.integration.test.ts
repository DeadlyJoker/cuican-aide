import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import test from "node:test";
import {
  parsePluginUiIntentRecord,
  type PluginUiIntentRecord,
} from "@crewon/domain";
import {
  parseGetConceptSelectionResponse,
  parseSelectConceptImageResponse,
  type PluginUiRecoveryHint,
  type PluginUiRecoveryRequest,
} from "@crewon/contracts";
import { extensionStoreDigester } from "../../../packages/store/src/extension-store-records.ts";
import { mainRecoveryActions } from "./plugin-ui-recovery-main.integration.test-support.ts";
import {
  browserBusinessWrites,
  shortDramaRecoveryFullAppFixture,
  shortDramaRecoveryIdentity,
  type RecoveryBrowserProof,
} from "./plugin-ui-recovery-short-drama-full-app.test-support.ts";

function exactUnresolved(
  proof: RecoveryBrowserProof,
  requests: readonly PluginUiRecoveryRequest[],
  sourcePin: PluginUiRecoveryHint["sourcePin"],
  selectionAttempts: number,
) {
  assert.equal(proof.recovery.version, "crewon.plugin-ui-recovery.v1");
  assert.equal(proof.recovery.intents.length, 3);
  for (const request of requests) {
    const hint = proof.recovery.intents.find(
      (value) => value.request.action === request.action,
    );
    assert.ok(hint);
    assert.deepEqual(hint.request, request);
    assert.deepEqual(hint.sourcePin, sourcePin);
    assert.equal(hint.receipt, null);
    assert.equal(hint.retryable, true);
    const attempts =
      request.action === mainRecoveryActions.selection ? selectionAttempts : 0;
    assert.equal(hint.phase, attempts === 0 ? "prepared" : "dispatched");
    assert.equal(hint.dispatchAttemptCount, attempts);
    assert.equal(hint.dispatchMayHaveOccurred, attempts > 0);
  }
  assert.ok(proof.recoveryResponseAt <= proof.moduleReadyObservedAt);
}
function assertDurableOriginal(
  records: readonly PluginUiIntentRecord[],
  original: readonly PluginUiIntentRecord[],
  requests: readonly PluginUiRecoveryRequest[],
) {
  assert.equal(records.length, 3);
  for (const before of original) {
    const current = records.find(
      (record) => record.intentId === before.intentId,
    );
    assert.ok(current);
    const immutable = (record: PluginUiIntentRecord) => ({
      intentId: record.intentId,
      account: record.account,
      sequence: record.sequence,
      kind: record.kind,
      sourcePin: record.sourcePin,
      rawIdempotencyKey: record.rawIdempotencyKey,
      requestJson: record.requestJson,
      requestDigest: record.requestDigest,
      createdAt: record.createdAt,
    });
    assert.deepEqual(immutable(current), immutable(before));
    const request = requests.find(
      (value) => value.action === current.sourcePin.action,
    );
    assert.ok(request);
    assert.deepEqual(JSON.parse(current.requestJson), request);
    assert.equal(current.rawIdempotencyKey, request.input.idempotencyKey);
    if (current.kind !== "selection") assert.deepEqual(current, before);
  }
}
function selectionRecord(records: readonly PluginUiIntentRecord[]) {
  const selected = records.find((record) => record.kind === "selection");
  assert.ok(selected);
  return selected;
}
function assertExplicitSelection(
  proof: RecoveryBrowserProof,
  request: PluginUiRecoveryRequest,
) {
  const writes = browserBusinessWrites(proof);
  assert.equal(
    writes.length,
    1,
    "only the explicit selection business action was posted",
  );
  assert.equal(writes[0].action, mainRecoveryActions.selection);
  assert.deepEqual(writes[0].input, request.input);
  assert.equal(writes[0].status, 200);
  const stages = proof.requests.filter(
    (entry) =>
      entry.method === "POST" &&
      entry.path.endsWith("/recovery") &&
      entry.kind === "stage",
  );
  assert.equal(stages.length, 1);
  assert.equal(stages[0].action, mainRecoveryActions.selection);
  assert.deepEqual(stages[0].input, request.input);
  assert.ok(stages[0].status === 200 || stages[0].status === 201);
  assert.ok(stages[0].headersAt !== null);
  assert.ok(stages[0].headersAt <= writes[0].startedAt);
  assert.equal(proof.selectionStageResponseAt, stages[0].headersAt);
  assert.equal(proof.selectionActionStartedAt, writes[0].startedAt);
  assert.ok(proof.stageAck);
  assert.equal(proof.stageAck.disposition, "replayed");
  assert.deepEqual(proof.stageAck.intent.request, request);
  assert.ok(
    proof.requests.some(
      (entry) =>
        entry.kind === "read" &&
        entry.action ===
          "crewon.project-generation-selections.v1.getConceptSelection" &&
        entry.status === 200,
    ),
    "the current pointer was read through its separate authenticated action",
  );
}
async function assertOriginalApp(
  proof: RecoveryBrowserProof,
  evidenceDirectory: string,
) {
  assert.equal(proof.nativeBridge, false);
  assert.equal(proof.authGateLogin, true);
  assert.equal(proof.originalAccountMenu, true);
  for (const label of ["常规", "账号", "工具与扩展", "外观", "安全与权限"])
    assert.ok(proof.settings.navigation.includes(label));
  assert.equal(proof.settings.styles.windowDisplay, "grid");
  assert.match(proof.settings.styles.styleArtifacts, /\/assets\/.+\.css/u);
  assert.ok(proof.screenshots.length >= 3);
  for (const path of proof.screenshots) {
    const child = relative(evidenceDirectory, path);
    assert.ok(!isAbsolute(child) && !child.startsWith(".."));
    assert.ok((await readFile(path)).length > 0);
  }
  assert.equal(
    proof.requests.filter(
      (request) =>
        request.method === "POST" && request.path === "/api/v1/threads",
    ).length,
    0,
    "mount and recovery never create a conversation",
  );
  assert.ok(
    proof.requests.some(
      (request) =>
        request.method === "GET" &&
        request.path.endsWith("/recovery") &&
        request.status === 200,
    ),
  );
}

test(
  "original full Web App and separately installed short-drama 9 hydrate three exact staged commands without mutation; explicit opaque selection survives Main/BFF/browser restart and confirmation failure while an old receipt preserves a newer current pointer",
  {
    skip:
      !process.env.CREWON_TEST_POSTGRES_URL ||
      !process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ||
      !process.env.CREWON_RECOVERY_BROWSER_DRIVER_PATH,
    timeout: 360_000,
  },
  async (t) => {
    const f = await shortDramaRecoveryFullAppFixture(t);
    const main = f.main;
    const baseline = await main.effects();
    const durable = async () =>
      (await main.rawRecords()).map((row) =>
        parsePluginUiIntentRecord(row.record_json, extensionStoreDigester),
      );
    try {
      const first = await f.start();
      const lease = await first.mount();
      assert.deepEqual(
        (await first.client.plugins.getRecovery(lease.mountRef)).intents,
        [],
      );
      // The stage's SQL ACK is deliberately lost. No caller invokes the business action.
      main.state.dropStageAck = true;
      await assert.rejects(() =>
        first.client.plugins.stageRecovery(lease.mountRef, main.requests[0]!),
      );
      for (const request of main.requests.slice(1)) {
        const staged = await first.client.plugins.stageRecovery(
          lease.mountRef,
          request,
        );
        assert.equal(staged.intent.phase, "prepared");
        assert.equal(staged.intent.dispatchAttemptCount, 0);
        assert.deepEqual(staged.intent.request, request);
      }
      const staged = await first.client.plugins.getRecovery(lease.mountRef);
      assert.equal(staged.intents.length, 3);
      const originalPin = staged.intents[0]!.sourcePin;
      assert.deepEqual(originalPin, {
        ...shortDramaRecoveryIdentity,
        selectionRevision: lease.selectionRevision,
        contributionId: main.contribution.id,
      });
      const originalRecords = await durable();
      assert.equal(
        new Set(originalRecords.map((intent) => intent.account.controlRealmId))
          .size,
        1,
      );
      for (const intent of originalRecords) {
        assert.equal(intent.account.tenantId, main.actor.tenantId);
        assert.equal(intent.account.spaceId, main.actor.spaceId);
        assert.equal(intent.account.principalId, main.actor.principalId);
        assert.equal(intent.sourcePin.actorId, main.actor.actorId);
        assert.equal(intent.sourcePin.profileId, "named-main-profile");
        assert.equal(intent.sourcePin.authorityEpoch, "named-main-ui-epoch");
        assert.equal(intent.phase, "prepared");
        assert.equal(intent.dispatchAttemptCount, 0);
      }
      assertDurableOriginal(originalRecords, originalRecords, main.requests);
      assert.equal(
        first.physicalRequests.filter((entry) =>
          entry.path.endsWith("/actions"),
        ).length,
        0,
      );
      await first.client.plugins.closeMount(lease.mountRef);
      const cold = await f.runBrowser("cold", {
        expectedSelection: null,
        async checkpoint(stage) {
          assert.equal(stage, "module-ready");
          assert.deepEqual(await durable(), originalRecords);
          assert.deepEqual(await main.effects(), baseline);
          assert.equal(
            parseGetConceptSelectionResponse(await main.publicSelection(first))
              .selectionRevision,
            0,
          );
        },
      });
      exactUnresolved(cold, main.requests, originalPin, 0);
      await assertOriginalApp(cold, f.evidenceDirectory);
      assert.equal(browserBusinessWrites(cold).length, 0);
      assert.equal(
        cold.requests.filter((entry) => entry.kind === "stage").length,
        0,
      );
      assert.equal(cold.selectionReceipt, null);
      assert.equal(cold.currentSelection, null);
      assert.deepEqual(await main.effects(), baseline);

      const submit = await f.runBrowser("selection-submit", {
        expectedSelection: {
          selectionRevision: 1,
          resultIndex: 0,
          filename: "named-first.png",
        },
        async checkpoint(stage) {
          if (stage === "module-ready") {
            assert.deepEqual(await durable(), originalRecords);
            assert.deepEqual(await main.effects(), baseline);
            main.state.armConfirmationFault = true;
          } else {
            assert.equal(main.state.faultInstalled, true);
            const records = await durable();
            assertDurableOriginal(records, originalRecords, main.requests);
            const record = selectionRecord(records);
            assert.equal(record.phase, "dispatched");
            assert.equal(record.dispatchAttemptCount, 1);
            assert.equal(record.dispatchMayHaveOccurred, true);
            assert.equal(record.receiptJson, null);
            const current = parseGetConceptSelectionResponse(
              await main.publicSelection(first),
            );
            assert.equal(current.selectionRevision, 1);
            assert.equal(current.current?.resultIndex, 0);
            assert.equal(current.current?.filename, "named-first.png");
            assert.deepEqual(await main.effects(), baseline);
            main.state.armConfirmationFault = false;
            await main.confirmationFault(false);
            main.state.faultInstalled = false;
          }
        },
      });
      exactUnresolved(submit, main.requests, originalPin, 0);
      await assertOriginalApp(submit, f.evidenceDirectory);
      assertExplicitSelection(submit, main.selectionRequest);
      assert.ok(submit.selectionReceipt);
      assert.equal(submit.selectionReceipt.disposition, "committed");
      assert.equal(submit.selectionReceipt.selectionRevision, 1);
      assert.equal(submit.selectionReceipt.selection.resultIndex, 0);
      assert.equal(
        submit.selectionReceipt.selection.filename,
        "named-first.png",
      );
      assert.ok(submit.currentSelection);
      assert.equal(submit.currentSelection?.selectionRevision, 1);
      assert.equal(submit.currentSelection.current?.resultIndex, 0);
      assert.ok(main.selectionRequest.action === mainRecoveryActions.selection);
      const { idempotencyKey: _key, ...selectionBody } =
        main.selectionRequest.input;
      const originalReceipt = parseSelectConceptImageResponse(
        submit.selectionReceipt,
        selectionBody,
      );
      const newer = parseSelectConceptImageResponse(
        await main.publicSelection(
          first,
          "PUT",
          { ...selectionBody, resultIndex: 1, expectedSelectionRevision: 1 },
          "named-full-app-explicit-newer-current-selection",
        ),
      );
      assert.equal(newer.selectionRevision, 2);
      assert.equal(newer.selection.filename, "named-second.png");
      const newerCurrent = parseGetConceptSelectionResponse(
        await main.publicSelection(first),
      );
      assert.equal(newerCurrent.selectionRevision, 2);
      assert.equal(newerCurrent.current?.resultIndex, 1);
      const unresolvedRecords = await durable();
      await first.stop();
      assert.equal(first.child.finished(), true);
      assert.equal(first.bff.finished(), true);
      assert.ok(
        first.child.stderr().includes("plugin_ui_recovery_persistence_failed"),
        first.child.stderr(),
      );

      const second = await f.start();
      assert.notEqual(second.child.child.pid, first.child.child.pid);
      assert.notEqual(second.bff.child.pid, first.bff.child.pid);
      assert.deepEqual(await durable(), unresolvedRecords);
      const retry = await f.runBrowser("cold-retry", {
        expectedSelection: {
          selectionRevision: 2,
          resultIndex: 1,
          filename: "named-second.png",
        },
        async checkpoint(stage) {
          if (stage === "module-ready") {
            assert.deepEqual(await durable(), unresolvedRecords);
            assert.deepEqual(
              parseGetConceptSelectionResponse(
                await main.publicSelection(second),
              ),
              newerCurrent,
            );
            assert.deepEqual(await main.effects(), baseline);
          } else {
            const records = await durable();
            assertDurableOriginal(records, originalRecords, main.requests);
            const record = selectionRecord(records);
            assert.equal(record.phase, "accepted");
            assert.equal(record.dispatchAttemptCount, 2);
            assert.equal(record.dispatchMayHaveOccurred, true);
            assert.ok(record.receiptJson);
            const confirmed = parseSelectConceptImageResponse(
              JSON.parse(record.receiptJson),
              selectionBody,
            );
            assert.equal(confirmed.selectionRevision, 1);
            assert.deepEqual(confirmed.selection, originalReceipt.selection);
            assert.deepEqual(
              parseGetConceptSelectionResponse(
                await main.publicSelection(second),
              ),
              newerCurrent,
            );
            assert.deepEqual(await main.effects(), baseline);
          }
        },
      });
      exactUnresolved(retry, main.requests, originalPin, 1);
      await assertOriginalApp(retry, f.evidenceDirectory);
      assertExplicitSelection(retry, main.selectionRequest);
      assert.ok(retry.selectionReceipt);
      const replay = parseSelectConceptImageResponse(
        retry.selectionReceipt,
        selectionBody,
      );
      assert.equal(replay.disposition, "replayed");
      assert.equal(replay.selectionRevision, 1);
      assert.deepEqual(replay.selection, originalReceipt.selection);
      assert.ok(retry.currentSelection);
      assert.deepEqual(retry.currentSelection, newerCurrent);
      assert.equal(retry.currentSelection?.selectionRevision, 2);
      assert.equal(retry.currentSelection.current?.resultIndex, 1);
      assert.deepEqual(await main.effects(), baseline);
      const acceptedRecords = await durable();
      await second.stop();

      const observations = await main.poolObservations();
      for (const pid of [first.child.child.pid, second.child.child.pid]) {
        const physical = observations.children.filter(
          (entry) => entry.pid === pid,
        );
        assert.ok(
          physical.length > 0,
          `original Main ${pid} has actual pool observation`,
        );
        assert.ok(
          physical.every((entry) => entry.max === 1 && entry.total <= 1),
        );
        assert.ok(
          physical.some(
            (entry) => entry.phase === "acquired" && entry.total === 1,
          ),
        );
      }
      assert.ok(observations.parent.length > 0);
      assert.ok(
        observations.parent.every(
          (entry) => entry.max === 1 && entry.total <= 1,
        ),
      );
      assert.ok(
        observations.parent.some(
          (entry) => entry.phase === "acquired" && entry.total === 1,
        ),
      );
      assert.ok(main.state.tlsConnections > 0);
      assert.ok(main.state.sessionCalls >= 3);
      assert.equal(main.state.peerCalls, 0);
      assert.equal(main.state.quoteCalls, 0);
      assert.deepEqual(main.state.failures, []);
      assert.deepEqual(f.edgeFailures(), []);
      assert.equal(f.staticProof.mutated, false);
      const evidence = {
        acceptance: "original-Web-App-short-drama-9-durable-recovery",
        packageIdentity: shortDramaRecoveryIdentity,
        formalUi: f.staticProof,
        originalRequests: main.requests,
        originalSourcePin: originalPin,
        originalRecords,
        unresolvedRecords,
        acceptedRecords,
        baselineEffects: baseline,
        finalEffects: await main.effects(),
        originalSelectionReceipt: originalReceipt,
        replaySelectionReceipt: replay,
        newerCurrentSelection: newerCurrent,
        phases: { cold, submit, retry },
        physicalPools: observations,
        excludedClaims: [
          "Generation/query owners were staged and hydrated only; neither business action was invoked.",
          "The zero-tool App catalog is a named fixture for read-only connection, not proof of Worker deployment or generation/query execution readiness.",
          "Paid history, image outputs and wallet funding are named SQL fixtures; no live Worker, model, provider or production funds.",
        ],
      };
      await f.close();
      const cleanup = f.cleanupProof();
      assert.equal(cleanup.closed, true);
      assert.equal(cleanup.activeBrowsers, 0);
      assert.ok(cleanup.mainProcesses.every((child) => child.finished));
      assert.ok(cleanup.bffProcesses.every((child) => child.finished));
      await writeFile(
        join(f.evidenceDirectory, "full-app-parent-proof.json"),
        JSON.stringify({ ...evidence, cleanup }, null, 2) + "\n",
        { mode: 0o600 },
      );
      t.diagnostic(
        "Original Main/BFF processes and three fresh Chromium profiles physically retired. Formal App/AuthGate/account/settings preserved; generation/query are stage-only, selection uses the real opaque owner and independent current read against named paid history.",
      );
    } finally {
      main.state.armConfirmationFault = false;
      try {
        if (main.state.faultInstalled) {
          await main.confirmationFault(false);
          main.state.faultInstalled = false;
        }
      } finally {
        await f.close();
      }
    }
  },
);
