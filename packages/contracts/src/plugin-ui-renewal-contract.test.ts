import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PLUGIN_UI_RENEWAL_MS,
  parseRenewPluginUiMountRequest,
  parseRenewPluginUiMountResponse,
} from "./plugin-ui-renewal-contract.ts";
import { parsePluginUiLease } from "./plugin-ui-lease.ts";
import { lease, rejected } from "./plugin-control-contract.test-support.ts";

test("renewal accepts only an exact old expiry CAS and detaches immutable data", () => {
  const original = parsePluginUiLease(lease());
  const request = { expectedExpiresAt: original.expiresAt };
  assert.deepEqual(parseRenewPluginUiMountRequest(request), request);
  assert.ok(Object.isFrozen(parseRenewPluginUiMountRequest(request)));
  for (const invalid of [
    null,
    {},
    { ...request, tenantId: "foreign" },
    { expectedExpiresAt: "2026-10-03T00:00:00Z" },
    { expectedExpiresAt: "2026-02-30T00:00:00.000Z" },
    { expectedExpiresAt: 1 },
    Object.defineProperty({}, "expectedExpiresAt", {
      enumerable: true,
      get: () => {
        throw new Error("must_not_run");
      },
    }),
  ])
    rejected(() => parseRenewPluginUiMountRequest(invalid));
  const renewed = {
    ...lease(),
    expiresAt: new Date(
      Date.parse(original.expiresAt) + MAX_PLUGIN_UI_RENEWAL_MS,
    ).toISOString(),
  };
  const parsed = parseRenewPluginUiMountResponse(renewed, original);
  assert.deepEqual(parsed, renewed);
  renewed.publicAssets.pop();
  assert.equal(parsed.publicAssets.length, 2);
  assert.ok(Object.isFrozen(parsed.descriptor.files));
  assert.deepEqual(
    parseRenewPluginUiMountResponse(parsed, {
      mountRef: original.mountRef,
      expectedExpiresAt: original.expiresAt,
    }),
    parsed,
  );
});

test("renewal response cannot change pins, regress expiry or exceed the finite transition bound", () => {
  const original = parsePluginUiLease(lease());
  const renewed = {
    ...original,
    expiresAt: new Date(Date.parse(original.expiresAt) + 1).toISOString(),
  };
  for (const invalid of [
    original,
    {
      ...renewed,
      expiresAt: new Date(Date.parse(original.expiresAt) - 1).toISOString(),
    },
    {
      ...renewed,
      expiresAt: new Date(
        Date.parse(original.expiresAt) + MAX_PLUGIN_UI_RENEWAL_MS + 1,
      ).toISOString(),
    },
    { ...renewed, mountRef: "x".repeat(40) },
    { ...renewed, selectionRevision: original.selectionRevision + 1 },
    { ...renewed, packageDigest: `sha256:${"f".repeat(64)}` },
    { ...renewed, descriptor: { ...original.descriptor, title: "Changed" } },
    { ...renewed, publicAssets: [original.publicAssets[0]] },
    { ...renewed, authorityEpoch: "private" },
  ])
    rejected(() => parseRenewPluginUiMountResponse(invalid, original));
  rejected(() =>
    parseRenewPluginUiMountResponse(renewed, {
      mountRef: original.mountRef,
      expectedExpiresAt: original.expiresAt,
      actorId: "foreign",
    } as never),
  );
  rejected(() =>
    parseRenewPluginUiMountResponse(
      { ...renewed, mountRef: "x".repeat(40) },
      { mountRef: original.mountRef, expectedExpiresAt: original.expiresAt },
    ),
  );
});
