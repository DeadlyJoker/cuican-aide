import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createPluginCompositionLock,
  parsePluginCompositionLock,
  pluginCompositionActivationOrder,
  planPluginCompositionTransition,
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

test("compiled SDK exposes precise transition planning without access to host internals", () => {
  const specification = {
    schemaVersion: PLUGIN_COMPOSITION_LOCK_SCHEMA,
    scope: {
      tenantId: "tenant-1",
      spaceId: "space-1",
      profileId: "profile-1",
      authorityEpoch: "epoch-1",
    },
    revision: 1,
    hostServices: [],
    nodes: [
      {
        pluginId: "example.provider",
        publisherId: "example",
        version: "1.0.0",
        packageDigest: `sha256:${"a".repeat(64)}`,
        hostApi: "crewon.plugin-host.v1",
        selectionRevision: 1,
        requires: [],
        provides: [{ service: "example.source", apiVersion: "1" }],
      },
      {
        pluginId: "example.consumer",
        publisherId: "example",
        version: "1.0.0",
        packageDigest: `sha256:${"b".repeat(64)}`,
        hostApi: "crewon.plugin-host.v1",
        selectionRevision: 1,
        requires: [
          { service: "example.source", apiVersion: "1", optional: false },
        ],
        provides: [],
      },
    ],
  };
  const original = createPluginCompositionLock(specification, digester);
  specification.revision++;
  specification.nodes[0].selectionRevision++;
  const plan = planPluginCompositionTransition(
    original,
    createPluginCompositionLock(specification, digester),
    digester,
  );
  assert.deepEqual(plan.withdrawOrder, [
    "example.consumer",
    "example.provider",
  ]);
  assert.deepEqual(plan.prepareOrder, ["example.provider", "example.consumer"]);
  assert.ok(Object.isFrozen(plan.prepareOrder));
});
