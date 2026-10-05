import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProjectAssetUiIntent,
  parseProjectAssetUiIntentScope,
  assertProjectAssetUiIntentScope,
  PROJECT_ASSET_UI_INTENT_REFUSAL_CODES,
  type ProjectAssetUiIntentReceipt,
} from "./project-asset-ui-intent.ts";
import {
  acceptProjectAssetUiIntent,
  refuseProjectAssetUiIntent,
  acknowledgeProjectAssetUiIntent,
} from "./project-asset-ui-intent-transitions.ts";
const digest = `sha256:${"a".repeat(64)}`,
  at = "2026-10-06T00:00:00.000Z";
const scope = {
  actor: {
    tenantId: "tenant",
    spaceId: "space",
    principalId: "person",
    actorId: "actor",
  },
  installation: {
    tenantId: "tenant",
    spaceId: "space",
    profileId: "profile",
    pluginId: "crewon.short-drama",
    publisherId: "example.publisher",
    version: "19.0.0",
    packageDigest: digest,
    selectionRevision: 3,
  },
  contributionId: "workbench",
};
function pending() {
  return {
    schemaVersion: "crewon.project-asset-ui-intent.v1",
    scope,
    projectId: "project",
    intentId: "intent",
    revision: 1,
    phase: "pending",
    actionId: "crewon.project-assets.v1.saveCandidate",
    input: {
      projectId: "project",
      assetId: null,
      request: {
        kind: "character",
        expectedAssetRevision: 0,
        briefRevision: 1,
        script: null,
        content: {
          name: "角色",
          setting: "雨夜\n侦探",
          visualPrompt: "A detective",
        },
      },
      idempotencyKey: "original-key",
    },
    requestDigest: digest,
    createdAt: at,
    updatedAt: at,
    acknowledgedAt: null,
    receipt: null,
    refusalCode: null,
  };
}
const receipt: ProjectAssetUiIntentReceipt = {
  kind: "save-content",
  idempotencyKey: "original-key",
  requestDigest: digest,
  resultDigest: digest,
  assetId: "character",
  assetRevision: 1,
  contentRevision: 1,
  referenceRevision: null,
};
test("asset intent has a cross-project slot and freezes the exact five-action request without caller authority", () => {
  const raw = pending(),
    parsed = parseProjectAssetUiIntent(raw);
  raw.input.request.content.name = "changed";
  assert.equal(
    (parsed.input.request as typeof raw.input.request).content.name,
    "角色",
  );
  assert.ok(
    Object.isFrozen((parsed.input.request as typeof raw.input.request).content),
  );
  assert.equal("projectId" in parsed.scope, false);
  assert.equal(parsed.projectId, "project");
  assert.throws(() =>
    parseProjectAssetUiIntentScope({ ...scope, projectId: "other" }),
  );
  assert.throws(() =>
    parseProjectAssetUiIntent({ ...pending(), projectId: "other" }),
  );
  assert.throws(() =>
    parseProjectAssetUiIntent({
      ...pending(),
      input: { ...pending().input, actor: scope.actor },
    }),
  );
  assert.throws(() =>
    parseProjectAssetUiIntent({
      ...pending(),
      actionId: "crewon.project-texts.v1.saveOutlineCandidate",
    }),
  );
});
test("full actor, installation, selection and contribution identity cannot be copied across recovery slots", () => {
  const parsed = parseProjectAssetUiIntentScope(scope);
  assertProjectAssetUiIntentScope(parsed, scope);
  for (const candidate of [
    { ...scope, actor: { ...scope.actor, principalId: "other" } },
    { ...scope, actor: { ...scope.actor, actorId: "other" } },
    { ...scope, installation: { ...scope.installation, profileId: "other" } },
    {
      ...scope,
      installation: {
        ...scope.installation,
        packageDigest: `sha256:${"b".repeat(64)}`,
      },
    },
    { ...scope, installation: { ...scope.installation, selectionRevision: 4 } },
    { ...scope, contributionId: "other" },
  ])
    assert.throws(() => assertProjectAssetUiIntentScope(parsed, candidate));
  assert.throws(() =>
    parseProjectAssetUiIntentScope({
      ...scope,
      installation: { ...scope.installation, tenantId: "other" },
    }),
  );
  let calls = 0;
  const getter = Object.defineProperty({ ...scope }, "actor", {
    enumerable: true,
    get() {
      calls++;
      return scope.actor;
    },
  });
  assert.throws(() => parseProjectAssetUiIntentScope(getter));
  assert.equal(calls, 0);
});
test("acceptance binds exact actual receipt key, action, CAS and result pointers while preserving original input", () => {
  const p = parseProjectAssetUiIntent(pending()),
    accepted = acceptProjectAssetUiIntent(p, receipt, at);
  assert.equal(accepted.phase, "accepted");
  assert.equal(accepted.revision, 2);
  assert.equal(accepted.acknowledgedAt, null);
  assert.deepEqual(accepted.input, p.input);
  assert.deepEqual(accepted.receipt, receipt);
  assert.deepEqual(acceptProjectAssetUiIntent(accepted, receipt, at), accepted);
  for (const value of [
    { ...receipt, idempotencyKey: "different" },
    { ...receipt, requestDigest: `sha256:${"b".repeat(64)}` },
    { ...receipt, assetRevision: 2 },
    { ...receipt, referenceRevision: 1 },
    { ...receipt, kind: "set-lock" },
    { ...receipt, contentRevision: null },
  ])
    assert.throws(() =>
      acceptProjectAssetUiIntent(p, value as ProjectAssetUiIntentReceipt, at),
    );
  assert.throws(() =>
    acceptProjectAssetUiIntent(
      accepted,
      { ...receipt, resultDigest: `sha256:${"b".repeat(64)}` },
      at,
    ),
  );
});
test("unknown cannot be ACKed and an accepted ACK tombstone only replays its original CAS", () => {
  const p = parseProjectAssetUiIntent(pending());
  assert.throws(
    () => acknowledgeProjectAssetUiIntent(p, 1, at),
    /intent_pending/,
  );
  const accepted = acceptProjectAssetUiIntent(p, receipt, at),
    ack = acknowledgeProjectAssetUiIntent(accepted, 2, at);
  assert.equal(ack.disposition, "acknowledged");
  assert.equal(ack.intent.revision, 3);
  assert.equal(ack.intent.acknowledgedAt, at);
  assert.equal(
    acknowledgeProjectAssetUiIntent(ack.intent, 2, at).disposition,
    "replayed",
  );
  assert.throws(
    () => acknowledgeProjectAssetUiIntent(ack.intent, 3, at),
    /revision_conflict/,
  );
  assert.deepEqual(
    acceptProjectAssetUiIntent(ack.intent, receipt, at),
    ack.intent,
  );
  assert.throws(() =>
    parseProjectAssetUiIntent({ ...pending(), acknowledgedAt: at }),
  );
});
test("only serialized deterministic refusal facts can become terminal, never unavailable or generic invalid", () => {
  const p = parseProjectAssetUiIntent(pending());
  for (const code of PROJECT_ASSET_UI_INTENT_REFUSAL_CODES) {
    const refused = refuseProjectAssetUiIntent(p, code, at);
    assert.equal(refused.phase, "refused");
    assert.equal(refused.receipt, null);
    assert.equal(
      acknowledgeProjectAssetUiIntent(refused, refused.revision, at).intent
        .acknowledgedAt,
      at,
    );
    assert.throws(() => acceptProjectAssetUiIntent(refused, receipt, at));
  }
  for (const code of [
    "project_asset_store_unavailable",
    "project_asset_record_invalid",
    "AbortError",
    "project_asset_not_found",
  ])
    assert.throws(() => refuseProjectAssetUiIntent(p, code as never, at));
  assert.throws(() =>
    refuseProjectAssetUiIntent(
      acceptProjectAssetUiIntent(p, receipt, at),
      "project_asset_locked",
      at,
    ),
  );
});
test("intent records fail closed for accessors, timestamp rollback, tampered action bodies and untrusted image provenance", () => {
  let reads = 0;
  const raw = pending(),
    getter = Object.defineProperty({ ...raw }, "input", {
      enumerable: true,
      get() {
        reads++;
        return raw.input;
      },
    });
  assert.throws(() => parseProjectAssetUiIntent(getter));
  assert.equal(reads, 0);
  assert.throws(() =>
    parseProjectAssetUiIntent({
      ...raw,
      updatedAt: "2025-01-01T00:00:00.000Z",
    }),
  );
  assert.throws(() => parseProjectAssetUiIntent({ ...raw, intentId: ".." }));
  const reference = {
    ...raw,
    actionId: "crewon.project-assets.v1.saveReferenceCandidate",
    input: {
      projectId: "project",
      assetId: "character",
      request: {
        expectedAssetRevision: 1,
        assetContentRevision: 1,
        conceptAssetId: "concept",
        selectionRevision: 1,
      },
      idempotencyKey: "ref-key",
    },
  };
  assert.equal(parseProjectAssetUiIntent(reference).phase, "pending");
  assert.throws(() =>
    parseProjectAssetUiIntent({
      ...reference,
      input: {
        ...reference.input,
        request: { ...reference.input.request, url: "https://image.example" },
      },
    }),
  );
});
