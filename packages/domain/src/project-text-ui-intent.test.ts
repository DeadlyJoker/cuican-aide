import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProjectTextUiIntent,
  parseProjectTextUiIntentScope,
  PROJECT_TEXT_UI_INTENT_REFUSAL_CODES,
} from "./project-text-ui-intent.ts";
const digest = `sha256:${"a".repeat(64)}`;
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
    version: "15.0.0",
    packageDigest: digest,
    selectionRevision: 3,
  },
  contributionId: "workbench",
  projectId: "project",
};
const at = "2026-10-06T00:00:00.000Z";
const pending = () => ({
  schemaVersion: "crewon.project-text-ui-intent.v1",
  scope,
  intentId: "intent",
  revision: 1,
  phase: "pending",
  actionId: "crewon.project-texts.v1.saveOutlineCandidate",
  input: {
    projectId: "project",
    request: {
      expectedArtifactRevision: 0,
      briefRevision: 1,
      content: { title: "原文" },
    },
    idempotencyKey: "original-key",
  },
  requestDigest: digest,
  createdAt: at,
  updatedAt: at,
  acknowledgedAt: null,
  receipt: null,
  refusalCode: null,
});
test("text journal retains detached immutable original input and full actor/installation/contribution scope", () => {
  const raw = pending(),
    record = parseProjectTextUiIntent(raw);
  raw.input.request.content.title = "changed";
  assert.equal(
    (record.input.request as typeof raw.input.request).content.title,
    "原文",
  );
  assert.ok(
    Object.isFrozen((record.input.request as typeof raw.input.request).content),
  );
  let invoked = 0;
  assert.throws(() =>
    parseProjectTextUiIntentScope({
      ...scope,
      get actor() {
        invoked++;
        return scope.actor;
      },
    }),
  );
  assert.equal(invoked, 0);
  assert.throws(() =>
    parseProjectTextUiIntentScope({
      ...scope,
      installation: { ...scope.installation, tenantId: "foreign" },
    }),
  );
});
test("text journal only accepts actual receipt summaries and terminal ACK; unknown cannot disappear", () => {
  assert.throws(() =>
    parseProjectTextUiIntent({ ...pending(), acknowledgedAt: at }),
  );
  assert.throws(() =>
    parseProjectTextUiIntent({ ...pending(), phase: "accepted" }),
  );
  const receipt = {
    kind: "save-outline",
    idempotencyKey: "original-key",
    requestDigest: digest,
    resultDigest: digest,
    artifactId: "outline",
    artifactRevision: 1,
    contentRevision: 1,
  };
  const accepted = parseProjectTextUiIntent({
    ...pending(),
    revision: 2,
    phase: "accepted",
    receipt,
  });
  assert.equal(accepted.receipt?.artifactId, "outline");
  assert.throws(() =>
    parseProjectTextUiIntent({
      ...accepted,
      receipt: { ...receipt, idempotencyKey: "new-key" },
    }),
  );
  assert.throws(() =>
    parseProjectTextUiIntent({
      ...accepted,
      receipt: { ...receipt, requestDigest: `sha256:${"b".repeat(64)}` },
    }),
  );
  assert.throws(() =>
    parseProjectTextUiIntent({
      ...accepted,
      updatedAt: "2026-10-05T00:00:00.000Z",
    }),
  );
});
test("text journal refusal whitelist excludes transport and ownership failures", () => {
  for (const code of PROJECT_TEXT_UI_INTENT_REFUSAL_CODES)
    assert.equal(
      parseProjectTextUiIntent({
        ...pending(),
        revision: 2,
        phase: "refused",
        refusalCode: code,
      }).refusalCode,
      code,
    );
  for (const code of [
    "AbortError",
    "timeout",
    "project_text_store_unavailable",
    "authorization_denied",
  ])
    assert.throws(() =>
      parseProjectTextUiIntent({
        ...pending(),
        phase: "refused",
        refusalCode: code,
      }),
    );
  assert.throws(() =>
    parseProjectTextUiIntent({
      ...pending(),
      input: { ...pending().input, projectId: "foreign" },
    }),
  );
  assert.throws(() =>
    parseProjectTextUiIntent({
      ...pending(),
      input: { ...pending().input, extra: true },
    }),
  );
});
