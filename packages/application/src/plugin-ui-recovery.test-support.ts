import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  parsePluginPackageDescriptor,
  parsePluginUiJsonValue,
} from "@crewon/contracts/plugins";
import {
  parsePluginUiRecoveryRequest,
  type PluginUiRecoveryRequest,
} from "@crewon/contracts";
import {
  acceptPluginUiIntent,
  assertPluginUiIntentReplay,
  createPluginUiIntent,
  dispatchPluginUiIntent,
  extensionCanonicalJson,
  pluginUiIntentIdentity,
  pluginUiIntentStablePin,
  refusePluginUiIntentFirstDispatch,
  refusePluginUiIntentUnadmittedQuery,
  type PluginUiIntentRecord,
} from "@crewon/domain";
import { PluginUiApplicationService } from "./plugin-ui-application-service.ts";
import {
  PluginUiRecoveryApplicationService,
  type PluginUiRecoveryPublicationMode,
} from "./plugin-ui-recovery-application-service.ts";
import { createPluginUiIntentPayloadVerifier } from "./plugin-ui-recovery-codec.ts";
import type { PluginUiIntentJournalStore } from "./plugin-ui-intent-journal-store.ts";
import type {
  PluginUiActionContext,
  PluginUiCommittedMetadataOutcome,
} from "./plugin-ui-ports.ts";
import { ApplicationError } from "./application-error.ts";
import {
  uiFixture,
  uiTestActor,
  uiTestMountCommand,
} from "./plugin-ui.test-support.ts";

export const recoveryDigester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
export function recoveryRequest(
  kind: "generation" | "query" | "selection" = "selection",
  key = "recovery-key-1",
): PluginUiRecoveryRequest {
  const reference = {
    projectId: "project-a",
    assetId: "concept-a",
    assetRevision: 1,
    expectedProjectRevision: 3,
    expectedAssetMetadataRevision: 1,
  };
  const operationId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  return parsePluginUiRecoveryRequest(
    kind === "selection"
      ? {
          action: "crewon.project-generation-selections.v1.selectConceptImage",
          input: {
            reference,
            operationId,
            expectedOperationRevision: 2,
            resultIndex: 1,
            expectedSelectionRevision: 0,
            idempotencyKey: key,
          },
        }
      : kind === "generation"
        ? {
            action: "crewon.project-generations.v1.generateConcept",
            input: {
              reference,
              threadId: "thread-a",
              expectedThreadRevision: 1,
              idempotencyKey: key,
            },
          }
        : {
            action:
              "crewon.project-generation-queries.v1.queryConceptGeneration",
            input: {
              reference: {
                projectId: reference.projectId,
                assetId: reference.assetId,
                assetRevision: 1,
              },
              operationId,
              threadId: "thread-a",
              expectedThreadRevision: 1,
              idempotencyKey: key,
            },
          },
  );
}
export function recoveryReceipt(request: PluginUiRecoveryRequest) {
  return parsePluginUiJsonValue(
    request.action ===
      "crewon.project-generation-selections.v1.selectConceptImage"
      ? {
          disposition: "committed",
          selectionRevision: 1,
          selection: {
            reference: {
              projectId: request.input.reference.projectId,
              assetId: request.input.reference.assetId,
              assetRevision: request.input.reference.assetRevision,
            },
            operationId: request.input.operationId,
            operationRevision: request.input.expectedOperationRevision,
            resultIndex: request.input.resultIndex,
            filename: "original-1.png",
            url: "https://provider.example/original-1.png",
            selectedAt: "2026-10-04T00:00:00.000Z",
          },
        }
      : {
          disposition: "committed",
          threadId: request.input.threadId,
          threadRevision: request.input.expectedThreadRevision + 1,
          runId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          messageId: "message-a",
          configurationRevision: 1,
        },
  );
}

/** Application-only doubles with real Domain transitions and actual UI invocation registration; no SQL proof. */
export function recoveryFixture(
  options: {
    declared?: boolean;
    configured?: boolean;
    publicationMode?: PluginUiRecoveryPublicationMode;
    actions?: readonly PluginUiRecoveryRequest["action"][];
  } = {},
) {
  const original = uiFixture();
  const { state } = original;
  state.descriptor = parsePluginPackageDescriptor({
    ...state.descriptor,
    requires: [
      {
        service: "crewon.project-generations",
        apiVersion: "1",
        optional: true,
      },
      {
        service: "crewon.project-generation-queries",
        apiVersion: "1",
        optional: true,
      },
      {
        service: "crewon.project-generation-selections",
        apiVersion: "1",
        optional: true,
      },
      ...(options.declared === false
        ? []
        : [
            {
              service: "crewon.plugin-ui-recovery",
              apiVersion: "1",
              optional: true,
            },
          ]),
    ],
  });
  const records = new Map<string, PluginUiIntentRecord>();
  const events: string[] = [];
  const diagnostics: unknown[] = [];
  const behavior = {
    actionError: null as unknown,
    jsonOutcome: false,
    confirmFailure: false,
    refuseFailure: false,
    afterStage: null as (() => Promise<void>) | null,
    beforeDispatch: null as (() => Promise<void>) | null,
    afterBusiness: null as (() => Promise<void>) | null,
    calls: 0,
  };
  const verifier = createPluginUiIntentPayloadVerifier(recoveryDigester);
  const store: PluginUiIntentJournalStore = {
    uiIntentJournalVersion: "crewon.plugin-ui-intent-journal.v1",
    uiIntentJournalReadVersion: "crewon.plugin-ui-intent-journal-read.v1",
    uiIntentJournalRealmId: "11111111-1111-1111-1111-111111111111",
    async stageUiIntent(input, { authority }) {
      await authority.assertCurrent();
      authority.assertActive();
      events.push("stage");
      const id = pluginUiIntentIdentity(
        input.account,
        input.sourcePin,
        JSON.parse(input.requestJson).input.idempotencyKey,
        recoveryDigester,
      );
      const previous = records.get(id);
      if (previous) {
        assertPluginUiIntentReplay(
          previous,
          input.sourcePin,
          input.requestJson,
        );
        return { disposition: "replayed", intent: previous };
      }
      for (const value of records.values())
        if (
          value.sourcePin.pluginId === input.sourcePin.pluginId &&
          value.sourcePin.contributionId === input.sourcePin.contributionId &&
          value.sourcePin.action === input.sourcePin.action &&
          (value.phase === "prepared" || value.phase === "dispatched")
        )
          throw new ApplicationError(
            "conflict",
            "plugin_ui_intent_family_unresolved",
          );
      const intent = createPluginUiIntent(
        { ...input, sequence: records.size + 1 },
        recoveryDigester,
      );
      records.set(id, intent);
      await behavior.afterStage?.();
      return { disposition: "created", intent };
    },
    async listUiIntentHints({ account }) {
      events.push("read");
      return [...records.values()].filter(
        (value) =>
          extensionCanonicalJson(value.account) ===
          extensionCanonicalJson(account),
      );
    },
    async markUiIntentDispatched(input, { authority }) {
      await authority.assertCurrent();
      authority.assertActive();
      events.push("dispatch");
      await behavior.beforeDispatch?.();
      const previous = records.get(input.intentId);
      if (!previous)
        throw new ApplicationError(
          "conflict",
          "plugin_ui_intent_stage_required",
        );
      assertPluginUiIntentReplay(previous, input.sourcePin, input.requestJson);
      const intent = dispatchPluginUiIntent(
        previous,
        input.at,
        recoveryDigester,
      );
      records.set(intent.intentId, intent);
      return { intent, dispatchAttemptCount: intent.dispatchAttemptCount };
    },
    async confirmUiIntentAccepted(input) {
      events.push("confirm");
      if (behavior.confirmFailure)
        throw new Error("fixture_confirm_unavailable");
      const current = records.get(input.intentId)!;
      assert.equal(current.requestDigest, input.requestDigest);
      const proof = verifier.verifyReceipt({
        kind: current.kind,
        action: current.sourcePin.action,
        requestJson: current.requestJson,
        receiptJson: input.receiptJson,
      });
      const intent = acceptPluginUiIntent(
        current,
        input.receiptJson,
        proof.receiptIdentityDigest,
        input.at,
        recoveryDigester,
      );
      records.set(intent.intentId, intent);
      return intent;
    },
    async refuseUiIntentFirstDispatch(input) {
      events.push("refuse");
      if (behavior.refuseFailure) throw new Error("fixture_refuse_unavailable");
      const current = records.get(input.intentId)!;
      assert.equal(current.requestDigest, input.requestDigest);
      const intent = refusePluginUiIntentFirstDispatch(
        current,
        input.reasonCode,
        input.at,
        recoveryDigester,
      );
      records.set(intent.intentId, intent);
      return intent;
    },
    async refuseUiIntentUnadmittedQuery(input) {
      const current = records.get(input.intentId)!;
      assert.equal(current.requestDigest, input.requestDigest);
      const intent = refusePluginUiIntentUnadmittedQuery(
        current,
        input.expectedDispatchAttemptCount,
        input.at,
        recoveryDigester,
      );
      records.set(intent.intentId, intent);
      return intent;
    },
  };
  const recovery = new PluginUiRecoveryApplicationService({
    store,
    ...(options.publicationMode === undefined
      ? {}
      : { publicationMode: options.publicationMode }),
    publications: [
      {
        pluginId: state.package.pluginId,
        packageDigest: state.package.packageDigest,
        contributionId: "workbench",
        actions: options.actions ?? [
          recoveryRequest("generation").action,
          recoveryRequest("query").action,
          recoveryRequest("selection").action,
        ],
      },
    ],
    clock: { now: () => state.now },
    digester: recoveryDigester,
    onDiagnostic: (error) => diagnostics.push(error),
  });
  const issued = new WeakMap<
    object,
    {
      context: PluginUiActionContext;
      output: ReturnType<typeof recoveryReceipt>;
    }
  >();
  let next = 0;
  const service = new PluginUiApplicationService({
    store: original.store,
    profiles: { resolve: async () => state.scope },
    authorization: {
      authorize: async () =>
        state.allowed.has("invoke")
          ? { outcome: "allow", authorityEpoch: state.epoch }
          : { outcome: "deny", reasonCode: "withdrawn" },
    },
    packages: {
      verify: async () => ({
        descriptor: state.descriptor,
        publicAssets: state.publicAssets,
      }),
      readAsset: async () => {
        throw new Error("unused");
      },
    },
    clock: { now: () => state.now },
    ids: { nextId: () => `${++next}`.padEnd(40, "r") },
    ...(options.configured === false ? {} : { recovery }),
    actions: {
      async invoke(context) {
        events.push("business");
        behavior.calls++;
        if (behavior.actionError) throw behavior.actionError;
        const request = parsePluginUiRecoveryRequest({
          action: context.action,
          input: context.input,
        });
        const output = recoveryReceipt(request);
        await behavior.afterBusiness?.();
        if (behavior.jsonOutcome) return output;
        const outcome = Object.freeze({});
        issued.set(outcome, { context, output });
        return outcome as PluginUiCommittedMetadataOutcome;
      },
    },
    committedMetadata: {
      isOutcome: (input): input is PluginUiCommittedMetadataOutcome =>
        input !== null && typeof input === "object" && issued.has(input),
      verify(context, outcome) {
        const result = issued.get(outcome);
        assert.equal(result?.context, context);
        issued.delete(outcome);
        return result!.output;
      },
    },
  });
  const mount = () =>
    service.openMount(uiTestActor, {
      ...uiTestMountCommand,
      expectedSelectionRevision: state.selection!.revision,
    });
  return {
    service,
    recovery,
    store,
    state,
    events,
    records,
    behavior,
    diagnostics,
    mount,
    actor: uiTestActor,
    stablePin: pluginUiIntentStablePin,
  };
}
