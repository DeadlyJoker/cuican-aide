import assert from "node:assert/strict";
import test from "node:test";
import {
  NATIVE_INSTALLED_PLUGIN_PREPARATION_RESULT_SCHEMA as schemaVersion,
  parseNativeInstalledPluginPreparationResult as parse,
} from "./plugins.ts";

const digest = `sha256:${"a".repeat(64)}`;
function fixture() {
  return {
    schemaVersion,
    actor: {
      principalId: "principal",
      actorId: "actor",
      tenantId: "tenant",
      spaceId: "space",
    },
    scope: { tenantId: "tenant", spaceId: "space", profileId: "profile" },
    defaultAgentVersionId: "default-agent",
    plugins: [
      {
        pluginId: "sample.report",
        state: "prepared",
        packageIdentity: {
          pluginId: "sample.report",
          publisherId: "sample.publisher",
          version: "1.0.0",
          packageDigest: digest,
        },
        configuration: { revision: 1, contentDigest: digest },
        approvalRequirement: "none",
        target: {
          executionAuthority: "crewonKernel",
          agentVersionId: "plugin-agent",
          agentVersionContentDigest: digest,
          materializationDigest: digest,
          authorityId: "authority",
          runtimeGeneration: "generation",
          policySnapshotId: "policy",
          workspaceBindingId: null,
        },
      },
      {
        pluginId: "sample.missing",
        state: "blocked",
        reasonCode: "notInstalled",
      },
    ],
  };
}
test("Native candidate results copy and freeze mixed prepared/blocked data without granting readiness", () => {
  const input = fixture(),
    result = parse(input);
  assert.deepEqual(result, input);
  input.actor.actorId = "changed";
  input.plugins[0]!.configuration!.revision = 2;
  assert.equal(result.actor.actorId, "actor");
  assert.equal(result.plugins[0]!.state, "prepared");
  assert.ok(Object.isFrozen(result.plugins));
  if (result.plugins[0]!.state === "prepared") {
    assert.equal(result.plugins[0]!.configuration.revision, 1);
    assert.ok(Object.isFrozen(result.plugins[0]!.target));
  }
});
test("Native result preserves actual independent-package publisher and namespace syntax", () => {
  const input = fixture();
  const original = input.plugins[0]!;
  for (const pluginId of ["foo", "sample_under_score", "a".repeat(128)]) {
    const result = parse({
      ...input,
      plugins: [
        {
          ...original,
          pluginId,
          packageIdentity: {
            ...original.packageIdentity,
            pluginId,
            publisherId: "crewon",
          },
        },
      ],
    });
    assert.equal(result.plugins[0]!.pluginId, pluginId);
    if (result.plugins[0]!.state === "prepared")
      assert.equal(result.plugins[0]!.packageIdentity.publisherId, "crewon");
  }
});
for (const reasonCode of [
  "notInstalled",
  "notApproved",
  "configurationMissing",
  "configurationIncompatible",
  "packageUnavailable",
  "readDenied",
  "stateChanged",
]) {
  test(`Native blocked reason ${reasonCode} has no execution data`, () => {
    const input = fixture();
    assert.equal(
      parse({
        ...input,
        plugins: [{ pluginId: "sample.report", state: "blocked", reasonCode }],
      }).plugins[0]!.state,
      "blocked",
    );
  });
}
const invalid: Readonly<
  Record<string, (input: ReturnType<typeof fixture>) => unknown>
> = {
  "unknown top-level": (input) => ({ ...input, ready: true }),
  "unknown schema": (input) => ({
    ...input,
    schemaVersion: "crewon.native-result.v0",
  }),
  "duplicate plugin": (input) => ({
    ...input,
    plugins: [input.plugins[0], input.plugins[0]],
  }),
  "empty plugins": (input) => ({ ...input, plugins: [] }),
  "too many plugins": (input) => ({
    ...input,
    plugins: Array.from({ length: 33 }, (_, i) => ({
      pluginId: `sample.p${i}`,
      state: "blocked",
      reasonCode: "notInstalled",
    })),
  }),
  "hybrid prepared": (input) => ({
    ...input,
    plugins: [{ ...input.plugins[0], reasonCode: "readDenied" }],
  }),
  "hybrid blocked": (input) => ({
    ...input,
    plugins: [{ ...input.plugins[1], target: input.plugins[0]!.target }],
  }),
  "scope echo": (input) => ({
    ...input,
    scope: { ...input.scope, tenantId: "other" },
  }),
  "tuple echo": (input) => ({
    ...input,
    plugins: [
      {
        ...input.plugins[0],
        packageIdentity: {
          ...input.plugins[0]!.packageIdentity,
          pluginId: "another.report",
        },
      },
    ],
  }),
  "default override": (input) => ({
    ...input,
    defaultAgentVersionId: "plugin-agent",
  }),
  "configuration revision": (input) => ({
    ...input,
    plugins: [
      {
        ...input.plugins[0],
        configuration: { revision: 2_147_483_648, contentDigest: digest },
      },
    ],
  }),
  "invalid digest": (input) => ({
    ...input,
    plugins: [
      {
        ...input.plugins[0],
        configuration: { revision: 1, contentDigest: "a".repeat(64) },
      },
    ],
  }),
  "target field": (input) => ({
    ...input,
    plugins: [
      {
        ...input.plugins[0],
        target: { ...input.plugins[0]!.target, actorId: "actor" },
      },
    ],
  }),
  "unsupported authority": (input) => ({
    ...input,
    plugins: [
      {
        ...input.plugins[0],
        target: {
          ...input.plugins[0]!.target,
          executionAuthority: "providerAgent",
        },
      },
    ],
  }),
  "target missing pin": (input) => {
    const { policySnapshotId: _ignored, ...target } = input.plugins[0]!.target!;
    return { ...input, plugins: [{ ...input.plugins[0], target }] };
  },
  "unknown reason": (input) => ({
    ...input,
    plugins: [
      {
        pluginId: "sample.report",
        state: "blocked",
        reasonCode: "supplierOffline",
      },
    ],
  }),
  "bytes bound": (input) => ({
    ...input,
    defaultAgentVersionId: "a".repeat(128 * 1024),
  }),
};
for (const [name, mutate] of Object.entries(invalid)) {
  test(`Native result rejects ${name}`, () => {
    assert.throws(
      () => parse(mutate(fixture())),
      /native_installed_plugin_preparation_result_invalid/u,
    );
  });
}
test("Native result rejects hostile own data without reading accessors or serialization hooks", () => {
  const getter = () => {
    throw new Error("getter called");
  };
  const cases: unknown[] = [
    Object.defineProperty(fixture(), "plugins", {
      enumerable: true,
      get: getter,
    }),
    Object.defineProperty(fixture(), "hidden", { value: true }),
    { ...fixture(), [Symbol("unknown")]: true },
    { ...fixture(), toJSON: getter },
    { ...fixture(), plugins: new Array(2) },
  ];
  const cyclic: Record<string, unknown> = fixture();
  cyclic.actor = cyclic;
  cases.push(cyclic);
  for (const input of cases)
    assert.throws(
      () => parse(input),
      /native_installed_plugin_preparation_result_invalid/u,
    );
});
