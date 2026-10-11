import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { derivePluginProjectCreationReceipt } from "./plugin-project-creation-receipt.ts";

const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const input = {
  scope: {
    tenantId: "tenant",
    spaceId: "space",
    principalId: "principal",
    actorId: "actor",
    profileId: "profile",
    pluginId: "test.plugin",
    publisherId: "test.publisher",
  },
  entryPoint: "creative-project" as const,
  externalReceipt: {
    idempotencyKey: "same-user-key",
    requestDigest: digester.sha256("original command"),
  },
};

test("creation receipt isolates every stable owner field and the two original creation entry points", () => {
  const original = derivePluginProjectCreationReceipt(input, digester);
  assert.deepEqual(
    derivePluginProjectCreationReceipt(structuredClone(input), digester),
    original,
  );
  for (const field of Object.keys(
    input.scope,
  ) as (keyof typeof input.scope)[]) {
    const other = derivePluginProjectCreationReceipt(
      {
        ...input,
        scope: { ...input.scope, [field]: `other-${input.scope[field]}` },
      },
      digester,
    );
    assert.notEqual(
      other.receipt.idempotencyKey,
      original.receipt.idempotencyKey,
      field,
    );
  }
  assert.notEqual(
    derivePluginProjectCreationReceipt(
      { ...input, entryPoint: "project-foundation" },
      digester,
    ).receipt.idempotencyKey,
    original.receipt.idempotencyKey,
  );
  assert.equal(original.externalKey, input.externalReceipt.idempotencyKey);
  assert.equal(
    original.receipt.requestDigest,
    input.externalReceipt.requestDigest,
  );
  assert.ok(original.receipt.idempotencyKey.length <= 128);
});

test("different content with the same scoped key preserves the original Store idempotency conflict", () => {
  const original = derivePluginProjectCreationReceipt(input, digester);
  const changed = derivePluginProjectCreationReceipt(
    {
      ...input,
      externalReceipt: {
        ...input.externalReceipt,
        requestDigest: digester.sha256("changed command"),
      },
    },
    digester,
  );
  assert.equal(changed.receipt.idempotencyKey, original.receipt.idempotencyKey);
  assert.notEqual(
    changed.receipt.requestDigest,
    original.receipt.requestDigest,
  );
});

test("creation derivation refuses caller project IDs, extra fields and accessors without evaluating them", () => {
  assert.throws(() =>
    derivePluginProjectCreationReceipt(
      {
        ...input,
        scope: { ...input.scope, projectId: "new-id-on-retry" },
      } as never,
      digester,
    ),
  );
  assert.throws(() =>
    derivePluginProjectCreationReceipt(
      { ...input, entryPoint: "legacy" } as never,
      digester,
    ),
  );
  let reads = 0;
  const accessor = {
    ...input,
    get scope() {
      reads++;
      return input.scope;
    },
  };
  assert.throws(() => derivePluginProjectCreationReceipt(accessor, digester));
  assert.equal(reads, 0);
  assert.throws(() =>
    derivePluginProjectCreationReceipt(input, { sha256: () => "invalid" }),
  );
});
