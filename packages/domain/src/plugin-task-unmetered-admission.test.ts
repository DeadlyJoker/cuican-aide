import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createExtensionRunBinding } from "./extension-run-binding.ts";
import { createExtensionCreditAdmission } from "./extension-credit-admission.ts";
import { parsePluginTaskAdmission } from "./plugin-task-admission.ts";
import {
  assertPluginTaskFunding,
  assertPluginTaskUnmeteredAdmission,
  createPluginTaskUnmeteredAdmission,
  parsePluginTaskUnmeteredAdmission,
  parsePluginTaskUnmeteredAuthorization,
} from "./plugin-task-unmetered-admission.ts";
const digester = {
    sha256: (value: string) =>
      `sha256:${createHash("sha256").update(value).digest("hex")}`,
  },
  digest = digester.sha256("test");
const binding = createExtensionRunBinding(
  {
    schemaVersion: "crewon.extension-run-binding.v0",
    tenantId: "tenant",
    spaceId: "space",
    pluginId: "example.image",
    actorId: "actor",
    runId: "run",
    threadId: "thread",
    configurationRevision: 1,
    configurationDigest: digest,
    inputDigest: digest,
    source: null,
    target: {
      executionAuthority: "crewonKernel",
      agentVersionId: "agent",
      agentVersionContentDigest: digest,
      materializationDigest: digest,
      authorityId: "authority",
      runtimeGeneration: "ts-v0",
      policySnapshotId: "policy",
      workspaceBindingId: null,
    },
  },
  digester,
);
const receipt = {
  actorId: binding.actorId,
  idempotencyKey: "intent",
  requestDigest: digest,
};
const task = parsePluginTaskAdmission({
  schemaVersion: "crewon.plugin-task-admission.v1",
  tenantId: binding.tenantId,
  spaceId: binding.spaceId,
  profileId: "profile",
  pluginId: binding.pluginId,
  publisherId: "example",
  version: "1.0.0",
  packageDigest: digest,
  selectionRevision: 2,
  principalId: "person",
  contributionId: "studio",
  action: "image.generate",
  authorityEpoch: "epoch",
  runId: binding.runId,
  threadId: binding.threadId,
  extensionBindingDigest: binding.bindingDigest,
  ...receipt,
});
const authorization = { authorityId: "host-local-policy", policyRevision: 1 };
const admission = createPluginTaskUnmeteredAdmission(
  { task, authorization },
  digester,
);
test("unmetered evidence detaches complete original provenance without changing v1 pin or v0 binding", () => {
  const input = structuredClone({ task, authorization });
  const proof = createPluginTaskUnmeteredAdmission(input, digester);
  input.authorization.policyRevision = 99;
  Object.assign(input.task, { principalId: "foreign" });
  assert.deepEqual(proof, admission);
  assert.ok(Object.isFrozen(proof.task));
  assert.ok(Object.isFrozen(proof.authorization));
  assert.equal(proof.task.schemaVersion, "crewon.plugin-task-admission.v1");
  assert.equal(Object.hasOwn(binding, "unmeteredAdmission"), false);
  assert.deepEqual(
    assertPluginTaskUnmeteredAdmission(
      { admission: proof, task, binding, receipt },
      digester,
    ),
    proof,
  );
});
test("missing, dual and foreign principal modes are refused while genuine paid admission remains valid", () => {
  const credit = createExtensionCreditAdmission(
    {
      binding,
      receipt,
      principalId: "person",
      poolId: "test-only",
      priceRevision: 1,
      quotedCredits: "3",
    },
    digester,
  );
  const source = { binding, receipt, principalId: "person", task };
  assert.doesNotThrow(() =>
    assertPluginTaskFunding(
      { ...source, unmeteredAdmission: admission },
      digester,
    ),
  );
  assert.doesNotThrow(() =>
    assertPluginTaskFunding({ ...source, creditAdmission: credit }, digester),
  );
  for (const patch of [
    {},
    { creditAdmission: credit, unmeteredAdmission: admission },
    { unmeteredAdmission: admission, principalId: "foreign" },
  ])
    assert.throws(() =>
      assertPluginTaskFunding({ ...source, ...patch }, digester),
    );
});
test("authority or full pin mutation requires new evidence and cannot validate the original digest or source binding", () => {
  for (const proof of [
    { ...admission, authorization: { ...authorization, policyRevision: 2 } },
    { ...admission, task: { ...task, profileId: "other" } },
    {
      ...admission,
      task: { ...task, packageDigest: digester.sha256("other") },
    },
  ])
    assert.throws(
      () => parsePluginTaskUnmeteredAdmission(proof, digester),
      /plugin_task_unmetered_digest_mismatch/,
    );
  assert.throws(
    () =>
      assertPluginTaskUnmeteredAdmission(
        {
          admission,
          task: { ...task, authorityEpoch: "changed" },
          binding,
          receipt,
        },
        digester,
      ),
    /plugin_task_unmetered_task_mismatch/,
  );
  assert.throws(() =>
    assertPluginTaskUnmeteredAdmission(
      {
        admission,
        binding,
        receipt: { ...receipt, idempotencyKey: "different" },
      },
      digester,
    ),
  );
});
test("strict internal evidence and authorization reject accessors, extra fields, symbols and noncanonical revisions", () => {
  let getters = 0;
  const accessor = Object.defineProperty(
    { ...authorization },
    "policyRevision",
    {
      enumerable: true,
      get() {
        getters++;
        return 1;
      },
    },
  );
  for (const value of [
    accessor,
    { ...authorization, poolId: "invented" },
    { ...authorization, [Symbol("hidden")]: 1 },
    { ...authorization, policyRevision: 0 },
    { ...authorization, policyRevision: "1" },
    { ...authorization, authorityId: "" },
  ])
    assert.throws(() => parsePluginTaskUnmeteredAuthorization(value));
  assert.equal(getters, 0);
  assert.throws(() =>
    parsePluginTaskUnmeteredAdmission(
      { ...admission, creditAdmission: {} },
      digester,
    ),
  );
});
