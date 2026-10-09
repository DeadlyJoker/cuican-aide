import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createPluginCompositionLock,
  parsePluginCompositionLock,
  pluginCompositionActivationOrder,
  PLUGIN_COMPOSITION_LOCK_SCHEMA,
} from "../dist/contracts.js";

const digester = {
  sha256: (value) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};

test("compiled public SDK composition protocol creates and parses a bounded zero-plugin lock", () => {
  const lock = createPluginCompositionLock(
    {
      schemaVersion: PLUGIN_COMPOSITION_LOCK_SCHEMA,
      scope: {
        tenantId: "tenant-1",
        spaceId: "space-1",
        profileId: "profile-1",
        authorityEpoch: "epoch-1",
      },
      revision: 1,
      nodes: [],
      hostServices: [],
    },
    digester,
  );
  assert.deepEqual(parsePluginCompositionLock(lock, digester), lock);
  assert.deepEqual(pluginCompositionActivationOrder(lock, digester), []);
  assert.ok(Object.isFrozen(lock));
  assert.throws(
    () =>
      parsePluginCompositionLock(
        { ...lock, scope: { ...lock.scope, tenantId: "other-tenant" } },
        digester,
      ),
    /plugin_composition_digest_mismatch/,
  );
  assert.throws(() =>
    parsePluginCompositionLock(
      { ...lock, apiKey: "not-a-protocol-field" },
      digester,
    ),
  );
});
