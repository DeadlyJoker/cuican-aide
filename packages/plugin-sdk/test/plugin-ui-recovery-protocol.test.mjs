import assert from "node:assert/strict";
import test from "node:test";
import {
  CREWON_PLUGIN_UI_RECOVERY_SERVICE,
  CREWON_PLUGIN_UI_RECOVERY_API_VERSION,
} from "../dist/ui.js";
import {
  parsePluginUiRecoveryRequest,
  parsePluginUiRecoveryHintsResponse,
} from "../dist/contracts.js";

test("compiled recovery declaration is portable and keeps all execution in the original host", () => {
  assert.equal(CREWON_PLUGIN_UI_RECOVERY_SERVICE, "crewon.plugin-ui-recovery");
  assert.equal(CREWON_PLUGIN_UI_RECOVERY_API_VERSION, "1");
  const source = {
    action: "crewon.project-generation-queries.v1.queryConceptGeneration",
    input: {
      reference: {
        projectId: "saved-project",
        assetId: "saved-concept",
        assetRevision: 2,
      },
      operationId: "00000000-0000-4000-8000-000000000123",
      threadId: "original-thread",
      expectedThreadRevision: 7,
      idempotencyKey: "original-query-key",
    },
  };
  const captured = parsePluginUiRecoveryRequest(source);
  source.input.idempotencyKey = "replacement";
  assert.equal(captured.input.idempotencyKey, "original-query-key");
  assert.ok(Object.isFrozen(captured.input.reference));
  assert.throws(() =>
    parsePluginUiRecoveryRequest({ ...captured, sourcePin: {} }),
  );
  assert.throws(() =>
    parsePluginUiRecoveryRequest({ action: "vendor.arbitrary", input: {} }),
  );
});

test("compiled recovery hints reject impossible refusals and caller authority", () => {
  const request = parsePluginUiRecoveryRequest({
    action: "crewon.project-generations.v1.generateConcept",
    input: {
      reference: {
        projectId: "saved-project",
        assetId: "saved-concept",
        assetRevision: 2,
        expectedProjectRevision: 3,
        expectedAssetMetadataRevision: 4,
      },
      threadId: "original-thread",
      expectedThreadRevision: 7,
      idempotencyKey: "original-key",
    },
  });
  const hint = {
    sourcePin: {
      pluginId: "example.workbench",
      publisherId: "example.publisher",
      version: "8.0.0",
      packageDigest: `sha256:${"a".repeat(64)}`,
      selectionRevision: 2,
      contributionId: "workbench",
    },
    request,
    revision: 2,
    phase: "dispatched",
    dispatchAttemptCount: 1,
    dispatchMayHaveOccurred: true,
    receipt: null,
    retryable: true,
    reasonCode: null,
  };
  const response = { version: "crewon.plugin-ui-recovery.v1", intents: [hint] };
  assert.deepEqual(parsePluginUiRecoveryHintsResponse(response), response);
  assert.throws(() =>
    parsePluginUiRecoveryHintsResponse({
      ...response,
      intents: [
        {
          ...hint,
          phase: "refused",
          retryable: false,
          reasonCode: "creative_project_revision_conflict",
        },
      ],
    }),
  );
  assert.throws(() =>
    parsePluginUiRecoveryHintsResponse({ ...response, principalId: "forged" }),
  );
});
