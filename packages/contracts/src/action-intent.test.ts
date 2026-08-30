import assert from "node:assert/strict";
import test from "node:test";

import { actionIntentJsonSchema } from "./action-intent-schema.ts";
import { parseActionIntent } from "./action-intent.ts";
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
