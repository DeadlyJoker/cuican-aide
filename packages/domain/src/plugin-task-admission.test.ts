import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createExtensionRunBinding } from "./extension-run-binding.ts";
import {
  assertPluginTaskAdmission,
  parsePluginTaskAdmission,
  parsePluginTaskAdmissionPin,
  PluginTaskAdmissionError,
} from "./plugin-task-admission.ts";

const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const digest = `sha256:${"a".repeat(64)}`;
const pin = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  profileId: "personal-profile",
  pluginId: "crewon.comfyui-krea2",
  publisherId: "crewon",
  version: "1.0.0",
  packageDigest: digest,
  selectionRevision: 2,
  principalId: "person-1",
  actorId: "actor-1",
  contributionId: "workbench",
  action: "generate",
  authorityEpoch: "policy-2",
};
const binding = createExtensionRunBinding(
  {
    schemaVersion: "crewon.extension-run-binding.v0",
    tenantId: pin.tenantId,
    spaceId: pin.spaceId,
    pluginId: pin.pluginId,
    actorId: pin.actorId,
    runId: "run-1",
    threadId: "thread-1",
    configurationRevision: 1,
    configurationDigest: digest,
    inputDigest: digest,
    source: null,
    target: {
      executionAuthority: "crewonKernel",
      agentVersionId: "agent-1",
      agentVersionContentDigest: digest,
      materializationDigest: digest,
      authorityId: "authority-1",
      runtimeGeneration: "generation-1",
      policySnapshotId: "policy-1",
      workspaceBindingId: null,
    },
  },
  digester,
);
const receipt = {
  actorId: pin.actorId,
  idempotencyKey: "effective-task-key",
  requestDigest: digest,
};
const admission = {
  schemaVersion: "crewon.plugin-task-admission.v1" as const,
  ...pin,
  runId: binding.runId,
  threadId: binding.threadId,
  extensionBindingDigest: binding.bindingDigest,
  requestDigest: receipt.requestDigest,
  idempotencyKey: receipt.idempotencyKey,
};

test("copies and freezes exact flat host pins and provenance without changing the v0 binding", () => {
  const source = { ...pin, principalId: "用户".repeat(64) };
  const copied = parsePluginTaskAdmissionPin(source);
  assert.ok(Object.isFrozen(copied));
  source.principalId = "other";
  assert.equal(copied.principalId, "用户".repeat(64));
  const value = parsePluginTaskAdmission(admission);
  assert.ok(Object.isFrozen(value));
  assert.notEqual(value, admission);
  assert.deepEqual(
    assertPluginTaskAdmission({ admission: value, binding, receipt }, digester),
    value,
  );
  assert.equal(Object.hasOwn(binding, "profileId"), false);
  assert.equal(
    binding.bindingDigest,
    createExtensionRunBinding({ ...binding }, digester).bindingDigest,
  );
});
test("rejects unknown fields, accessors, private prototypes, non-enumerable properties and symbols without reading them", () => {
  let reads = 0;
  for (const input of [
    { ...pin, actor: "invented" },
    Object.assign(Object.create({ private: true }), pin),
    Object.defineProperty({ ...pin }, "principalId", {
      enumerable: true,
      get() {
        reads++;
        return pin.principalId;
      },
    }),
    Object.defineProperty({ ...pin }, "principalId", {
      enumerable: false,
      value: pin.principalId,
    }),
    { ...pin, [Symbol("hidden")]: true },
  ])
    assert.throws(
      () => parsePluginTaskAdmissionPin(input),
      PluginTaskAdmissionError,
    );
  assert.equal(reads, 0);
  assert.throws(
    () =>
      parsePluginTaskAdmission({ ...admission, invocationRef: "temporary" }),
    /fields_invalid/u,
  );
});
test("bounds every identifier, namespace, version, revision, action and digest", () => {
  for (const patch of [
    { profileId: "x".repeat(129) },
    { principalId: "lone\ud800" },
    { authorityEpoch: "\n" },
    { pluginId: "../plugin" },
    { publisherId: "UPPER" },
    { version: "latest" },
    { selectionRevision: 0 },
    { selectionRevision: Number.MAX_SAFE_INTEGER + 1 },
    { action: "" },
    { action: "a".repeat(129) },
    { packageDigest: "sha256:ABC" },
  ])
    assert.throws(
      () => parsePluginTaskAdmissionPin({ ...pin, ...patch }),
      PluginTaskAdmissionError,
    );
  for (const patch of [
    { schemaVersion: "v2" },
    { requestDigest: "missing" },
    { runId: "" },
    { idempotencyKey: "x".repeat(129) },
  ])
    assert.throws(
      () => parsePluginTaskAdmission({ ...admission, ...patch }),
      PluginTaskAdmissionError,
    );
});
test("requires the actual generation Run and exact binding/receipt relationship", () => {
  for (const patch of [
    { runId: "other-run" },
    { threadId: "other-thread" },
    { actorId: "other-actor" },
    { tenantId: "other-tenant" },
    { pluginId: "other.plugin" },
    { extensionBindingDigest: digest },
    { idempotencyKey: "other-key" },
    { requestDigest: digester.sha256("other") },
  ])
    assert.throws(
      () =>
        assertPluginTaskAdmission(
          { admission: { ...admission, ...patch }, binding, receipt },
          digester,
        ),
      /binding_mismatch/u,
    );
  const query = createExtensionRunBinding(
    {
      ...binding,
      source: {
        runId: "source-run",
        operationId: "operation-1",
        bindingDigest: digest,
      },
    },
    digester,
  );
  assert.throws(
    () =>
      assertPluginTaskAdmission(
        {
          admission: {
            ...admission,
            extensionBindingDigest: query.bindingDigest,
          },
          binding: query,
          receipt,
        },
        digester,
      ),
    /binding_mismatch/u,
  );
});

test("composed task admission uses the Run's exact profile and authority epoch", () => {
  const composed = createExtensionRunBinding(
    {
      ...binding,
      schemaVersion: "crewon.extension-run-binding.v1",
      composition: {
        profileId: pin.profileId,
        authorityEpoch: pin.authorityEpoch,
        revision: 1,
        lockDigest: digest,
      },
    },
    digester,
  );
  const value = parsePluginTaskAdmission({
    ...admission,
    extensionBindingDigest: composed.bindingDigest,
  });
  assert.deepEqual(
    assertPluginTaskAdmission(
      { admission: value, binding: composed, receipt },
      digester,
    ),
    value,
  );
  for (const patch of [
    { profileId: "foreign-profile" },
    { authorityEpoch: "foreign-epoch" },
  ])
    assert.throws(
      () =>
        assertPluginTaskAdmission(
          {
            admission: parsePluginTaskAdmission({ ...value, ...patch }),
            binding: composed,
            receipt,
          },
          digester,
        ),
      /plugin_task_admission_binding_mismatch/,
    );
});
