import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  acceptPluginUiIntent,
  assertPluginUiIntentReplay,
  createPluginUiIntent,
  dispatchPluginUiIntent,
  parsePluginUiIntentRecord,
  refusePluginUiIntentFirstDispatch,
  refusePluginUiIntentUnadmittedQuery,
} from "./plugin-ui-intent.ts";
import { extensionCanonicalJson } from "./extension-configuration.ts";
import { parsePluginTaskAdmissionPin } from "./plugin-task-admission.ts";
const digester = {
  sha256: (s: string) =>
    `sha256:${createHash("sha256").update(s).digest("hex")}`,
};
const account = {
  controlRealmId: "realm-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
  principalId: "principal-1",
};
const pin = parsePluginTaskAdmissionPin({
  tenantId: account.tenantId,
  spaceId: account.spaceId,
  principalId: account.principalId,
  profileId: "profile-1",
  actorId: "actor-1",
  pluginId: "example.story",
  publisherId: "example.publisher",
  version: "1.0.0",
  packageDigest: digester.sha256("package"),
  selectionRevision: 2,
  contributionId: "workbench",
  action: "crewon.project-generation-selections.v1.selectConceptImage",
  authorityEpoch: "epoch-1",
});
const at = "2026-10-04T00:00:00.000Z";
const requestJson = extensionCanonicalJson({
  action: pin.action,
  input: {
    reference: {
      projectId: "project-1",
      assetId: "asset-1",
      assetRevision: 1,
      expectedProjectRevision: 3,
      expectedAssetMetadataRevision: 1,
    },
    idempotencyKey: "key-1",
  },
});
const fresh = () =>
  createPluginUiIntent(
    { account, sourcePin: pin, requestJson, sequence: 1, at },
    digester,
  );
test("verified query non-admission uses an exact dispatch CAS without rewriting old requests or accepted facts", () => {
  const sourcePin = {
    ...pin,
    action: "crewon.project-generation-queries.v1.queryConceptGeneration",
  };
  const original = createPluginUiIntent(
    {
      account,
      sourcePin,
      requestJson: extensionCanonicalJson({
        action: sourcePin.action,
        input: { idempotencyKey: "query-key" },
      }),
      sequence: 1,
      at,
    },
    digester,
  );
  const once = dispatchPluginUiIntent(original, at, digester),
    twice = dispatchPluginUiIntent(once, at, digester);
  assert.deepEqual(
    refusePluginUiIntentUnadmittedQuery(twice, 1, at, digester),
    twice,
  );
  const refused = refusePluginUiIntentUnadmittedQuery(twice, 2, at, digester);
  assert.equal(refused.phase, "refused");
  assert.equal(refused.dispatchAttemptCount, 2);
  assert.equal(refused.requestJson, original.requestJson);
  assert.deepEqual(parsePluginUiIntentRecord(refused, digester), refused);
  const accepted = acceptPluginUiIntent(
    twice,
    "{}",
    digester.sha256("receipt"),
    at,
    digester,
  );
  assert.deepEqual(
    refusePluginUiIntentUnadmittedQuery(accepted, 2, at, digester),
    accepted,
  );
  assert.throws(
    () =>
      refusePluginUiIntentUnadmittedQuery(
        dispatchPluginUiIntent(fresh(), at, digester),
        1,
        at,
        digester,
      ),
    /refusal_unsupported/,
  );
});
test("only an exact media no-admission reason can refuse its first dispatch; concurrent and accepted states are preserved", () => {
  const mediaPin = {
    ...pin,
    action: "crewon.project-media-generations.v1.generate",
  };
  const original = createPluginUiIntent(
    {
      account,
      sourcePin: mediaPin,
      requestJson: extensionCanonicalJson({
        action: mediaPin.action,
        input: { idempotencyKey: "media-key" },
      }),
      sequence: 1,
      at,
    },
    digester,
  );
  const once = dispatchPluginUiIntent(original, at, digester);
  assert.equal(
    refusePluginUiIntentFirstDispatch(
      once,
      "project_media_generation_not_admitted",
      at,
      digester,
    ).phase,
    "refused",
  );
  const twice = dispatchPluginUiIntent(once, at, digester);
  assert.equal(
    refusePluginUiIntentFirstDispatch(
      twice,
      "project_media_generation_not_admitted",
      at,
      digester,
    ).phase,
    "dispatched",
  );
  const accepted = acceptPluginUiIntent(
    once,
    "{}",
    digester.sha256("receipt"),
    at,
    digester,
  );
  assert.equal(
    refusePluginUiIntentFirstDispatch(
      accepted,
      "project_media_generation_not_admitted",
      at,
      digester,
    ).phase,
    "accepted",
  );
  assert.throws(
    () =>
      refusePluginUiIntentFirstDispatch(
        once,
        "concept_selection_revision_conflict",
        at,
        digester,
      ),
    /unsupported/,
  );
  assert.throws(
    () =>
      refusePluginUiIntentFirstDispatch(
        dispatchPluginUiIntent(fresh(), at, digester),
        "project_media_generation_not_admitted",
        at,
        digester,
      ),
    /unsupported/,
  );
});
test("intent keeps the original request/pin and accepts a stable current regrant without rekeying", () => {
  const intent = fresh();
  assert.equal(intent.phase, "prepared");
  assert.equal(intent.dispatchMayHaveOccurred, false);
  assertPluginUiIntentReplay(
    intent,
    { ...pin, selectionRevision: 4, authorityEpoch: "epoch-2" },
    requestJson,
  );
  assert.equal(intent.sourcePin.authorityEpoch, "epoch-1");
  for (const changed of [
    { actorId: "other" },
    { profileId: "other" },
    { version: "2.0.0" },
    { packageDigest: digester.sha256("other") },
  ])
    assert.throws(
      () =>
        assertPluginUiIntentReplay(intent, { ...pin, ...changed }, requestJson),
      /replay_mismatch/,
    );
  assert.throws(
    () =>
      assertPluginUiIntentReplay(
        intent,
        pin,
        requestJson.replace("key-1", "key-2"),
      ),
    /replay_mismatch/,
  );
});
test("dispatch history is sticky; only the single first proven selection conflict is definitive", () => {
  const once = dispatchPluginUiIntent(fresh(), at, digester);
  assert.equal(once.dispatchAttemptCount, 1);
  const twice = dispatchPluginUiIntent(once, at, digester);
  assert.equal(twice.dispatchAttemptCount, 2);
  assert.equal(
    refusePluginUiIntentFirstDispatch(
      twice,
      "concept_selection_revision_conflict",
      at,
      digester,
    ).phase,
    "dispatched",
  );
  const refused = refusePluginUiIntentFirstDispatch(
    once,
    "concept_selection_revision_conflict",
    at,
    digester,
  );
  assert.equal(refused.phase, "refused");
  assert.throws(
    () => dispatchPluginUiIntent(refused, at, digester),
    /already_refused/,
  );
  assert.throws(
    () =>
      refusePluginUiIntentFirstDispatch(once, "network_failure", at, digester),
    /refusal_unsupported/,
  );
});
test("confirmed acceptance is immutable across legal replay disposition and any late refusal", () => {
  const sent = dispatchPluginUiIntent(fresh(), at, digester),
    receipt = extensionCanonicalJson({
      disposition: "committed",
      logical: "one",
    }),
    identity = digester.sha256("logical-one");
  const accepted = acceptPluginUiIntent(sent, receipt, identity, at, digester);
  assert.equal(
    acceptPluginUiIntent(
      accepted,
      receipt.replace("committed", "replayed"),
      identity,
      at,
      digester,
    ).receiptJson,
    receipt,
  );
  assert.equal(
    refusePluginUiIntentFirstDispatch(
      accepted,
      "concept_selection_revision_conflict",
      at,
      digester,
    ).phase,
    "accepted",
  );
  assert.throws(
    () =>
      acceptPluginUiIntent(
        accepted,
        receipt,
        digester.sha256("other"),
        at,
        digester,
      ),
    /receipt_mismatch/,
  );
  assert.throws(
    () => acceptPluginUiIntent(fresh(), receipt, identity, at, digester),
    /not_dispatched/,
  );
});
test("bounded detached records reject unknown schema, tamper, accessor and malformed canonical JSON", () => {
  const intent = fresh();
  assert.deepEqual(parsePluginUiIntentRecord(intent, digester), intent);
  assert.throws(
    () =>
      parsePluginUiIntentRecord(
        { ...intent, schemaVersion: "unknown" },
        digester,
      ),
    /version_unsupported/,
  );
  assert.throws(
    () =>
      parsePluginUiIntentRecord(
        { ...intent, dispatchMayHaveOccurred: true },
        digester,
      ),
    /record_invalid/,
  );
  assert.throws(
    () =>
      parsePluginUiIntentRecord(
        { ...intent, requestJson: requestJson.replace("key-1", "key-2") },
        digester,
      ),
    /record_invalid/,
  );
  let touched = false;
  assert.throws(() =>
    parsePluginUiIntentRecord(
      {
        ...intent,
        get receiptJson() {
          touched = true;
          return null;
        },
      },
      digester,
    ),
  );
  assert.equal(touched, false);
  assert.throws(
    () =>
      createPluginUiIntent(
        {
          account,
          sourcePin: pin,
          requestJson: ` ${requestJson}`,
          sequence: 1,
          at,
        },
        digester,
      ),
    /noncanonical/,
  );
});
test("revision orders updates despite a server clock moving backwards", () => {
  const backwards = "2026-10-03T00:00:00.000Z";
  const sent = dispatchPluginUiIntent(fresh(), backwards, digester);
  assert.equal(sent.revision, 2);
  assert.equal(sent.updatedAt, backwards);
});
