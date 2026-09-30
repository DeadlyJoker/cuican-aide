import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createExtensionConfiguration,
  parseExtensionConfiguration,
  parseExtensionActivation,
  parseExtensionExecutionTarget,
  type ExtensionConfiguration,
  type ExtensionExecutionTarget,
} from "./extension-configuration.ts";
import {
  createExtensionRunBinding,
  parseExtensionRunBinding,
} from "./extension-run-binding.ts";

const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const digest = `sha256:${"a".repeat(64)}`;
const configuration: Omit<ExtensionConfiguration, "contentDigest"> = {
  schemaVersion: "crewon.extension-configuration.v0",
  tenantId: "tenant-1",
  spaceId: "space-1",
  pluginId: "crewon.comfyui-krea2",
  revision: 1,
  pluginVersion: "1.0.0",
  manifestDigest: digest,
  implementationDigest: digest,
  parameters: {
    serviceUrl: "https://example.com/",
    nested: { values: [1, true, null] },
  },
  credentialBindings: [
    { slotId: "api_key", credentialBindingId: "credential-1" },
  ],
  createdByActorId: "actor-1",
  createdAt: "2026-09-30T00:00:00.000Z",
};
const target: ExtensionExecutionTarget = {
  executionAuthority: "crewonKernel",
  agentVersionId: "agent-1",
  agentVersionContentDigest: digest,
  materializationDigest: digest,
  authorityId: "authority-1",
  runtimeGeneration: "ts-v0",
  policySnapshotId: "policy-1",
  workspaceBindingId: null,
};

test("configuration snapshots canonicalize fields and deeply detach from caller state", () => {
  const input = structuredClone(configuration);
  const snapshot = createExtensionConfiguration(input, digester);
  (input.parameters.nested as { values: unknown[] }).values.push("later");
  assert.deepEqual(snapshot.parameters, configuration.parameters);
  assert.ok(Object.isFrozen(snapshot.parameters.nested));
  assert.throws(() =>
    (snapshot.parameters.nested as { values: unknown[] }).values.push("later"),
  );
  const reversed = Object.fromEntries(Object.entries(snapshot).reverse());
  assert.deepEqual(parseExtensionConfiguration(reversed, digester), snapshot);
  const changed = createExtensionConfiguration(
    { ...configuration, revision: 2 },
    digester,
  );
  assert.notEqual(changed.contentDigest, snapshot.contentDigest);
});

test("configuration integrity binds scope, code, input and credential references", () => {
  const snapshot = createExtensionConfiguration(configuration, digester);
  for (const patch of [
    { tenantId: "tenant-2" },
    { spaceId: "space-2" },
    { pluginVersion: "2.0.0" },
    { implementationDigest: `sha256:${"b".repeat(64)}` },
    { parameters: { serviceUrl: "https://changed.example/" } },
    { credentialBindings: [] },
    { createdByActorId: "actor-2" },
  ])
    assert.throws(
      () => parseExtensionConfiguration({ ...snapshot, ...patch }, digester),
      /digest_mismatch/u,
    );
  for (const patch of [
    { schemaVersion: "crewon.extension-configuration.v9" },
    { secret: "not-a-supported-field" },
    { revision: 0 },
    { revision: 1.5 },
    { pluginVersion: "latest" },
    { parameters: [] },
    { parameters: { value: "x".repeat(16_384) } },
    { createdAt: "2026-09-30" },
    {
      credentialBindings: [
        ...configuration.credentialBindings,
        ...configuration.credentialBindings,
      ],
    },
    {
      credentialBindings: [
        { slotId: "api_key", credentialBindingId: "ref", secret: "raw-key" },
      ],
    },
  ])
    assert.throws(() =>
      parseExtensionConfiguration({ ...snapshot, ...patch }, digester),
    );
  assert.throws(
    () =>
      createExtensionConfiguration(
        {
          ...configuration,
          parameters: {
            get value(): string {
              return assert.fail("must not invoke accessors");
            },
          },
        },
        digester,
      ),
    /json_invalid/u,
  );
});

test("activation requires an explicit kernel target and keeps disable separate from revocation", () => {
  const activation = {
    schemaVersion: "crewon.extension-activation.v0",
    tenantId: configuration.tenantId,
    spaceId: configuration.spaceId,
    pluginId: configuration.pluginId,
    revision: 1,
    configurationRevision: 1,
    configurationDigest: digest,
    state: "enabled",
    target,
    updatedByActorId: "actor-1",
    updatedAt: configuration.createdAt,
  };
  assert.deepEqual(parseExtensionActivation(activation).target, target);
  assert.throws(
    () => parseExtensionActivation({ ...activation, target: null }),
    /target_required/u,
  );
  for (const state of ["disabled", "revoked"])
    assert.equal(
      parseExtensionActivation({ ...activation, state, target: null }).state,
      state,
    );
  assert.throws(
    () =>
      parseExtensionExecutionTarget({
        ...target,
        executionAuthority: "providerAgent",
      }),
    /authority_unsupported/u,
  );
  assert.throws(() =>
    parseExtensionActivation({ ...activation, state: "unknown" }),
  );
});

test("Run binding verifies immutable configuration, route, input and original operation identity", () => {
  const input = {
    schemaVersion: "crewon.extension-run-binding.v0" as const,
    tenantId: "tenant-1",
    spaceId: "space-1",
    pluginId: configuration.pluginId,
    runId: "run-1",
    threadId: "thread-1",
    actorId: "actor-1",
    configurationRevision: 1,
    configurationDigest: digest,
    target,
    inputDigest: digest,
    source: null,
  };
  const bound = createExtensionRunBinding(input, digester);
  assert.deepEqual(parseExtensionRunBinding(bound, digester), bound);
  for (const patch of [
    { runId: "run-2" },
    { inputDigest: `sha256:${"b".repeat(64)}` },
    { target: { ...target, policySnapshotId: "policy-2" } },
  ])
    assert.throws(
      () => parseExtensionRunBinding({ ...bound, ...patch }, digester),
      /digest_mismatch/u,
    );
  const query = createExtensionRunBinding(
    {
      ...input,
      runId: "run-2",
      source: {
        runId: bound.runId,
        operationId: "operation-1",
        bindingDigest: bound.bindingDigest,
      },
    },
    digester,
  );
  assert.ok(Object.isFrozen(query.source));
  assert.notEqual(query.bindingDigest, bound.bindingDigest);
  assert.throws(
    () =>
      createExtensionRunBinding(
        {
          ...input,
          source: {
            runId: input.runId,
            operationId: "operation-1",
            bindingDigest: digest,
          },
        },
        digester,
      ),
    /source_invalid/u,
  );
});
