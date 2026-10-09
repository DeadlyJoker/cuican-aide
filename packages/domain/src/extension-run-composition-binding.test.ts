import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createExtensionRunBinding,
  parseExtensionRunBinding,
} from "./extension-run-binding.ts";
const digester = {
  sha256: (body: string) =>
    `sha256:${createHash("sha256").update(body).digest("hex")}`,
};
const digest = `sha256:${"a".repeat(64)}`;
const base = {
  schemaVersion: "crewon.extension-run-binding.v0" as const,
  tenantId: "tenant-1",
  spaceId: "space-1",
  pluginId: "example.plugin",
  runId: "run-1",
  threadId: "thread-1",
  actorId: "actor-1",
  configurationRevision: 1,
  configurationDigest: digest,
  inputDigest: digest,
  source: null,
  target: {
    executionAuthority: "crewonKernel" as const,
    agentVersionId: "agent-1",
    agentVersionContentDigest: digest,
    materializationDigest: digest,
    authorityId: "authority-1",
    runtimeGeneration: "ts-v0",
    policySnapshotId: "policy-1",
    workspaceBindingId: null,
  },
};
const reference = {
  profileId: "profile-1",
  authorityEpoch: "epoch-1",
  revision: 1,
  lockDigest: digest,
};
test("Run v1 digest binds the original composition identity and stays bounded, copied and frozen", () => {
  const input = {
    ...base,
    schemaVersion: "crewon.extension-run-binding.v1" as const,
    composition: { ...reference },
  };
  const value = createExtensionRunBinding(input, digester);
  assert.deepEqual(parseExtensionRunBinding(value, digester), value);
  assert.equal(value.schemaVersion, "crewon.extension-run-binding.v1");
  if (value.schemaVersion !== "crewon.extension-run-binding.v1") throw Error();
  input.composition.profileId = "mutated";
  assert.equal(value.composition.profileId, "profile-1");
  assert.ok(Object.isFrozen(value.composition));
  for (const patch of [
    { profileId: "other" },
    { authorityEpoch: "other" },
    { revision: 2 },
    { lockDigest: `sha256:${"b".repeat(64)}` },
  ])
    assert.throws(
      () =>
        parseExtensionRunBinding(
          { ...value, composition: { ...reference, ...patch } },
          digester,
        ),
      /digest_mismatch/,
    );
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 8192);
});
test("Run v0 has its original field set; downgrade, missing references and extra graph injection fail closed", () => {
  const zero = createExtensionRunBinding(base, digester);
  assert.equal(Object.hasOwn(zero, "composition"), false);
  assert.deepEqual(parseExtensionRunBinding(zero, digester), zero);
  assert.throws(
    () =>
      parseExtensionRunBinding({ ...zero, composition: reference }, digester),
    /fields_invalid/,
  );
  assert.throws(
    () =>
      parseExtensionRunBinding(
        { ...zero, schemaVersion: "crewon.extension-run-binding.v1" },
        digester,
      ),
    /fields_invalid/,
  );
  const one = createExtensionRunBinding(
    {
      ...base,
      schemaVersion: "crewon.extension-run-binding.v1",
      composition: reference,
    },
    digester,
  );
  assert.throws(
    () =>
      parseExtensionRunBinding(
        { ...one, schemaVersion: "crewon.extension-run-binding.v0" },
        digester,
      ),
    /fields_invalid/,
  );
  assert.throws(
    () =>
      parseExtensionRunBinding(
        { ...one, composition: { ...reference, nodes: [] } },
        digester,
      ),
    /fields_invalid/,
  );
  let called = false;
  assert.throws(
    () =>
      parseExtensionRunBinding(
        {
          ...one,
          composition: {
            ...reference,
            get lockDigest() {
              called = true;
              return digest;
            },
          },
        },
        digester,
      ),
    /json_invalid/,
  );
  assert.equal(called, false);
});
