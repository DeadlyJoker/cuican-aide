import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createExtensionRunBinding } from "./extension-run-binding.ts";
import {
  createExtensionCreditAdmission,
  parseExtensionCreditAdmission,
  assertExtensionCreditAdmission,
} from "./extension-credit-admission.ts";

const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const digest = `sha256:${"a".repeat(64)}`;
const binding = createExtensionRunBinding(
  {
    schemaVersion: "crewon.extension-run-binding.v0",
    tenantId: "tenant",
    spaceId: "space",
    pluginId: "crewon.comfyui-krea2",
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
  idempotencyKey: "request",
  requestDigest: digest,
};
const quote = {
  binding,
  receipt,
  principalId: "person",
  poolId: "plugin",
  priceRevision: 1,
  quotedCredits: "30",
};

test("credit admission detaches the payer and immutable quote from caller state and keeps principal distinct from actor", () => {
  const mutable = structuredClone(quote);
  const admission = createExtensionCreditAdmission(mutable, digester);
  mutable.principalId = "changed";
  mutable.quotedCredits = "999";
  mutable.receipt.idempotencyKey = "other";
  assert.equal(admission.actorId, "actor");
  assert.equal(admission.reservation.scope.principalId, "person");
  assert.equal(admission.reservation.quotedCredits, "30");
  assert.equal(admission.reservation.reservationId, binding.runId);
  assert.ok(Object.isFrozen(admission));
  assert.ok(Object.isFrozen(admission.reservation.scope));
  assert.deepEqual(
    parseExtensionCreditAdmission(admission, digester),
    admission,
  );
  assert.deepEqual(
    assertExtensionCreditAdmission({ admission, binding, receipt }, digester),
    admission,
  );
});

test("same request key in different plugins, spaces and personal accounts has a distinct ledger key", () => {
  const first = createExtensionCreditAdmission(quote, digester);
  const admissions = [
    first,
    createExtensionCreditAdmission(
      { ...quote, principalId: "second-person" },
      digester,
    ),
    createExtensionCreditAdmission(
      {
        ...quote,
        binding: createExtensionRunBinding(
          { ...binding, spaceId: "second-space" },
          digester,
        ),
      },
      digester,
    ),
    createExtensionCreditAdmission(
      {
        ...quote,
        binding: createExtensionRunBinding(
          { ...binding, pluginId: "crewon.other-plugin" },
          digester,
        ),
      },
      digester,
    ),
  ];
  assert.equal(
    new Set(admissions.map((value) => value.reservation.idempotencyKey)).size,
    admissions.length,
  );
  const repriced = createExtensionCreditAdmission(
    { ...quote, quotedCredits: "40", priceRevision: 2 },
    digester,
  );
  assert.equal(
    repriced.reservation.idempotencyKey,
    first.reservation.idempotencyKey,
  );
  assert.notEqual(
    repriced.reservation.requestDigest,
    first.reservation.requestDigest,
  );
});

test("persisted quote, payer, binding and command changes cannot retain the original admission digest", () => {
  const admission = createExtensionCreditAdmission(quote, digester);
  for (const patch of [
    { bindingDigest: `sha256:${"b".repeat(64)}` },
    { commandIdempotencyKey: "changed" },
    { commandRequestDigest: `sha256:${"b".repeat(64)}` },
    { reservation: { ...admission.reservation, quotedCredits: "31" } },
    { reservation: { ...admission.reservation, priceRevision: 2 } },
    {
      reservation: {
        ...admission.reservation,
        scope: { ...admission.reservation.scope, principalId: "other" },
      },
    },
  ])
    assert.throws(
      () => parseExtensionCreditAdmission({ ...admission, ...patch }, digester),
      /extension_credit_admission_digest_mismatch/,
    );
  assert.throws(
    () =>
      parseExtensionCreditAdmission(
        { ...admission, runId: "another" },
        digester,
      ),
    /identity_mismatch/,
  );
  assert.throws(
    () =>
      parseExtensionCreditAdmission(
        { ...admission, schemaVersion: "future" },
        digester,
      ),
    /version_unsupported/,
  );
});

test("admission rejects queries and another valid Run binding or command receipt", () => {
  const admission = createExtensionCreditAdmission(quote, digester);
  const otherRun = createExtensionRunBinding(
    { ...binding, runId: "second-run" },
    digester,
  );
  assert.throws(
    () =>
      assertExtensionCreditAdmission(
        { admission, binding: otherRun, receipt },
        digester,
      ),
    /identity_mismatch/,
  );
  assert.throws(
    () =>
      assertExtensionCreditAdmission(
        {
          admission,
          binding,
          receipt: { ...receipt, requestDigest: `sha256:${"b".repeat(64)}` },
        },
        digester,
      ),
    /identity_mismatch/,
  );
  const query = createExtensionRunBinding(
    {
      ...binding,
      runId: "query-run",
      source: {
        runId: binding.runId,
        bindingDigest: binding.bindingDigest,
        operationId: "operation",
      },
    },
    digester,
  );
  assert.throws(
    () =>
      createExtensionCreditAdmission({ ...quote, binding: query }, digester),
    /generation_required/,
  );
  assert.throws(
    () =>
      createExtensionCreditAdmission(
        { ...quote, receipt: { ...receipt, actorId: "other" } },
        digester,
      ),
    /identity_mismatch/,
  );
});

test("bounded admission parsing rejects accessors, extra fields and invalid amounts without executing caller code", () => {
  const admission = createExtensionCreditAdmission(quote, digester);
  let reads = 0;
  const accessor = { ...admission };
  Object.defineProperty(accessor, "reservation", {
    enumerable: true,
    get() {
      reads++;
      return admission.reservation;
    },
  });
  assert.throws(() => parseExtensionCreditAdmission(accessor, digester));
  assert.equal(reads, 0);
  assert.throws(() =>
    parseExtensionCreditAdmission(
      { ...admission, arbitrary: "extra" },
      digester,
    ),
  );
  for (const quotedCredits of ["0", "-1", "01", "1.5", "9".repeat(49)])
    assert.throws(
      () =>
        createExtensionCreditAdmission({ ...quote, quotedCredits }, digester),
      /plugin_credit_amount_invalid/,
    );
  const chinesePrincipal = "人".repeat(128);
  assert.equal(
    createExtensionCreditAdmission(
      { ...quote, principalId: chinesePrincipal },
      digester,
    ).reservation.scope.principalId,
    chinesePrincipal,
  );
});
