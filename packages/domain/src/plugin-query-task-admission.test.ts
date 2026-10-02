import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createExtensionRunBinding } from "./extension-run-binding.ts";
import {
  parsePluginTaskAdmission,
  assertPluginTaskAdmission,
} from "./plugin-task-admission.ts";
import {
  parsePluginQueryTaskAdmission,
  assertPluginQueryTaskAdmission,
  effectivePluginQueryTaskAdmission,
} from "./plugin-query-task-admission.ts";
const digester = {
    sha256: (value: string) =>
      `sha256:${createHash("sha256").update(value).digest("hex")}`,
  },
  digest = digester.sha256("fixture");
const pin = {
  tenantId: "tenant",
  spaceId: "space",
  profileId: "profile",
  pluginId: "example.report",
  publisherId: "example",
  version: "1.0.0",
  packageDigest: digest,
  selectionRevision: 2,
  principalId: "original-principal",
  actorId: "original-actor",
  contributionId: "studio",
  action: "report.generate",
  authorityEpoch: "old-epoch",
};
const original = createExtensionRunBinding(
  {
    schemaVersion: "crewon.extension-run-binding.v0",
    tenantId: pin.tenantId,
    spaceId: pin.spaceId,
    pluginId: pin.pluginId,
    actorId: pin.actorId,
    runId: "original",
    threadId: "original-thread",
    configurationRevision: 1,
    configurationDigest: digest,
    inputDigest: digest,
    source: null,
    target: {
      executionAuthority: "crewonKernel",
      agentVersionId: "agent-original",
      agentVersionContentDigest: digest,
      materializationDigest: digest,
      authorityId: "authority",
      runtimeGeneration: "generation",
      policySnapshotId: "policy",
      workspaceBindingId: null,
    },
  },
  digester,
);
const source = parsePluginTaskAdmission({
    schemaVersion: "crewon.plugin-task-admission.v1",
    ...pin,
    runId: original.runId,
    threadId: original.threadId,
    extensionBindingDigest: original.bindingDigest,
    idempotencyKey: "original-key",
    requestDigest: digest,
  }),
  operationId = "00000000-0000-0000-0000-000000000001";
const binding = createExtensionRunBinding(
  {
    ...original,
    actorId: "query-actor",
    runId: "query-run",
    threadId: "query-thread",
    source: {
      runId: original.runId,
      bindingDigest: original.bindingDigest,
      operationId,
    },
  },
  digester,
);
const input = {
  schemaVersion: "crewon.plugin-query-task-admission.v1",
  ...pin,
  principalId: "query-principal",
  actorId: "query-actor",
  version: "2.0.0",
  packageDigest: digester.sha256("current"),
  selectionRevision: 4,
  authorityEpoch: "current-epoch",
  action: "report.query",
  runId: binding.runId,
  threadId: binding.threadId,
  extensionBindingDigest: binding.bindingDigest,
  idempotencyKey: "query-key",
  requestDigest: digest,
  source,
  operationId,
};
const receipt = {
  actorId: input.actorId,
  idempotencyKey: input.idempotencyKey,
  requestDigest: input.requestDigest,
};
test("query provenance copies two distinct authorities and never becomes an original generation admission", () => {
  const mutable = structuredClone(input),
    query = parsePluginQueryTaskAdmission(mutable);
  mutable.source = {
    ...mutable.source,
    packageDigest: digester.sha256("mutated"),
  };
  assert.equal(query.source.packageDigest, source.packageDigest);
  assert.ok(Object.isFrozen(query));
  assert.ok(Object.isFrozen(query.source));
  assert.deepEqual(
    assertPluginQueryTaskAdmission(
      { admission: query, binding, sourceBinding: original, receipt },
      digester,
    ),
    query,
  );
  const effective = effectivePluginQueryTaskAdmission(query);
  assert.equal(effective.packageDigest, source.packageDigest);
  assert.equal(effective.version, source.version);
  assert.equal(effective.selectionRevision, source.selectionRevision);
  assert.equal(effective.principalId, query.principalId);
  assert.equal(effective.actorId, query.actorId);
  assert.throws(
    () =>
      assertPluginTaskAdmission(
        { admission: effective, binding, receipt },
        digester,
      ),
    /binding_mismatch/u,
  );
});
test("query exact fields, nested source, operation and descriptors are fail closed without accessor reads", () => {
  let reads = 0;
  for (const value of [
    { ...input, unexpected: true },
    { ...input, [Symbol("hidden")]: true },
    Object.assign(Object.create({ hidden: true }), input),
    Object.defineProperty({ ...input }, "source", {
      enumerable: true,
      get() {
        reads++;
        return source;
      },
    }),
    { ...input, source: { ...source, extra: true } },
    { ...input, operationId: "not-a-uuid" },
    { ...input, schemaVersion: "crewon.plugin-task-admission.v1" },
  ])
    assert.throws(() => parsePluginQueryTaskAdmission(value));
  assert.equal(reads, 0);
});
test("query matches exact original scope, pointer, configuration, complete target and current receipt", () => {
  const query = parsePluginQueryTaskAdmission(input);
  for (const patch of [
    { tenantId: "other" },
    { profileId: "other" },
    { publisherId: "other" },
    { runId: "other" },
    { threadId: "other" },
    { extensionBindingDigest: digester.sha256("other") },
    { idempotencyKey: "other" },
    { operationId: "00000000-0000-0000-0000-000000000002" },
  ])
    assert.throws(() =>
      assertPluginQueryTaskAdmission(
        {
          admission: { ...query, ...patch },
          binding,
          sourceBinding: original,
          receipt,
        },
        digester,
      ),
    );
  for (const patch of [
    { configurationRevision: 2 },
    { configurationDigest: digester.sha256("other") },
    { target: { ...binding.target, workspaceBindingId: "other" } },
    { source: null },
  ]) {
    const changed = createExtensionRunBinding(
      { ...binding, ...patch },
      digester,
    );
    assert.throws(() =>
      assertPluginQueryTaskAdmission(
        {
          admission: {
            ...query,
            extensionBindingDigest: changed.bindingDigest,
          },
          binding: changed,
          sourceBinding: original,
          receipt,
        },
        digester,
      ),
    );
  }
});
