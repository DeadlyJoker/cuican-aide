import assert from "node:assert/strict";
import test from "node:test";

import { actionIntentJsonSchema } from "./action-intent-schema.ts";
import { canonicalActionIntent, parseActionIntent } from "./action-intent.ts";
import { ContractValidationError } from "./contract-validation-error.ts";

const intent = {
  schemaVersion: "crewon.action-intent.v0",
  runId: "run-1",
  segmentId: "segment-1",
  callId: "call-1",
  tool: {
    kind: "function",
    name: "workspace_read",
    inputDigest: `sha256:${"a".repeat(64)}`,
  },
  effect: "readOnly",
  recovery: "replaySafe",
  policySnapshotId: "policy-1",
  workspaceBindingId: "workspace-opaque-1",
  resourceBindingId: null,
  credentialBindingId: null,
  executionTarget: { kind: "device", bindingId: "device-1" },
  capability: "workspace.read",
  approvalRequirement: "none",
  limits: {
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
    maxArtifactBytes: 16 * 1024 * 1024,
  },
} as const;

test("accepts a bounded ActionIntent with every security binding explicit", () => {
  assert.deepEqual(parseActionIntent(intent), intent);
  assert.deepEqual(
    [...actionIntentJsonSchema.required].sort(),
    Object.keys(intent).sort(),
  );
});

test("preserves historical 32-byte base64url Run IDs in parsed and canonical intents", () => {
  const runIdPattern = new RegExp(
    actionIntentJsonSchema.properties.runId.pattern,
    "u",
  );
  for (const runId of [
    `-${"A".repeat(42)}`,
    `_${"A".repeat(42)}`,
    "run-1",
    `plugin-${"A".repeat(43)}`,
    "a".repeat(512),
  ]) {
    const candidate = { ...intent, runId };
    assert.equal(parseActionIntent(candidate).runId, runId);
    assert.equal(JSON.parse(canonicalActionIntent(candidate)).runId, runId);
    assert.equal(runIdPattern.test(runId), true, runId);
  }
});

test("rejects malformed historical Run IDs consistently in parser and schema", () => {
  const runIdPattern = new RegExp(
    actionIntentJsonSchema.properties.runId.pattern,
    "u",
  );
  for (const runId of [
    "",
    "-",
    "_",
    `-${"A".repeat(41)}`,
    `_${"A".repeat(43)}`,
    `-${"A".repeat(41)}.`,
    `_${"A".repeat(41)}:`,
    `-${"A".repeat(41)}/`,
    `_${"A".repeat(41)} `,
    "/run-1",
    "a".repeat(513),
  ]) {
    assert.throws(
      () => parseActionIntent({ ...intent, runId }),
      hasCode("action_run_id_invalid"),
      runId,
    );
    assert.equal(runIdPattern.test(runId), false, runId);
  }
  for (const runId of [null, 1, {}, []]) {
    assert.throws(
      () => parseActionIntent({ ...intent, runId }),
      hasCode("action_run_id_invalid"),
    );
  }
});

test("keeps historical Run ID compatibility out of all other opaque bindings", () => {
  const historicalId = `_${"A".repeat(42)}`;
  for (const [field, code] of [
    ["segmentId", "action_segment_id_invalid"],
    ["callId", "action_call_id_invalid"],
    ["policySnapshotId", "action_policy_snapshot_invalid"],
    ["workspaceBindingId", "action_workspace_binding_invalid"],
    ["resourceBindingId", "action_resource_binding_invalid"],
    ["credentialBindingId", "action_credential_binding_invalid"],
  ] as const) {
    assert.throws(
      () => parseActionIntent({ ...intent, [field]: historicalId }),
      hasCode(code),
    );
    const schema = actionIntentJsonSchema.properties[field];
    const opaque = "pattern" in schema ? schema : schema.oneOf[0];
    assert.equal(new RegExp(opaque.pattern, "u").test(historicalId), false);
  }
  assert.throws(
    () =>
      parseActionIntent({
        ...intent,
        executionTarget: { kind: "remote", bindingId: historicalId },
      }),
    hasCode("action_execution_binding_invalid"),
  );
  assert.equal(
    new RegExp(
      actionIntentJsonSchema.properties.executionTarget.properties.bindingId.pattern,
      "u",
    ).test(historicalId),
    false,
  );
});

test("requires mutations to use a reconcilable recovery path", () => {
  assert.deepEqual(
    parseActionIntent({
      ...intent,
      effect: "mutation",
      recovery: "reconcilable",
      approvalRequirement: "perAction",
      capability: "workspace.write",
    }).effect,
    "mutation",
  );
  assert.throws(
    () =>
      parseActionIntent({
        ...intent,
        effect: "mutation",
        recovery: "replaySafe",
      }),
    hasCode("action_recovery_policy_invalid"),
  );
});

test("rejects ambient paths, missing policy bindings and injected fields", () => {
  for (const [input, code] of [
    [
      { ...intent, workspaceBindingId: "/Users/private" },
      "action_workspace_binding_invalid",
    ],
    [{ ...intent, policySnapshotId: "" }, "action_policy_snapshot_invalid"],
    [{ ...intent, capability: "SHELL EXEC" }, "action_capability_invalid"],
    [
      { ...intent, providerSecret: "must-not-enter-intent" },
      "action_intent_fields_invalid",
    ],
  ] as const) {
    assert.throws(() => parseActionIntent(input), hasCode(code));
  }
});

test("keeps policy, workspace, credential and target changes visible to the digest caller", () => {
  const changed = [
    { ...intent, policySnapshotId: "policy-2" },
    { ...intent, workspaceBindingId: "workspace-opaque-2" },
    { ...intent, credentialBindingId: "credential-1" },
    {
      ...intent,
      executionTarget: { kind: "device" as const, bindingId: "device-2" },
    },
    { ...intent, capability: "workspace.stat" },
  ];

  for (const candidate of changed) {
    assert.notEqual(
      JSON.stringify(parseActionIntent(candidate)),
      JSON.stringify(intent),
    );
  }
});

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof ContractValidationError && error.code === code;
}
