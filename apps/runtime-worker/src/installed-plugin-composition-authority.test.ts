import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createPluginCompositionLock } from "@crewon/contracts/plugins";
import {
  assertInstalledPluginCompositionAuthority,
  captureInstalledPluginCompositionAuthority,
} from "./plugins/installed-plugin-composition-authority.ts";
import { captureInstalledPluginCompositionExecution } from "./plugins/installed-plugin-composition-runtime-owner.ts";
import { InstalledPluginRunContext } from "./plugins/installed-plugin-run-context.ts";
import {
  installedResolverFixture,
  signal,
} from "./installed-plugin-runtime-resolver.test-support.ts";
import { actor } from "../../../packages/store/src/extension-configuration-service.test-support.ts";

const scope = Object.freeze({
  tenantId: "authority-tenant",
  spaceId: "authority-space",
  profileId: "authority-profile",
  authorityEpoch: "authority-epoch",
});
const lock = createPluginCompositionLock(
  {
    schemaVersion: "crewon.plugin-composition-lock.v1",
    scope,
    revision: 1,
    nodes: [],
    hostServices: [],
  },
  {
    sha256: (input) =>
      `sha256:${createHash("sha256").update(input).digest("hex")}`,
  },
);

test("legacy explicit composition deployment preserves its exact metadata-only recipe", () => {
  assert.deepEqual(
    captureInstalledPluginCompositionExecution({ hostServiceMetadata: [] }),
    { hostServiceMetadata: [] },
  );
  assert.equal(captureInstalledPluginCompositionAuthority({}), undefined);
});

test("trusted authority is captured without accessors and each submit checks every original scope field", () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, "assertCurrentAuthority", {
    enumerable: true,
    get() {
      reads++;
      return () => scope;
    },
  });
  assert.throws(
    () => captureInstalledPluginCompositionAuthority(accessor),
    /installed_plugin_composition_configuration_invalid/,
  );
  assert.equal(reads, 0);
  for (const invalid of [null, "epoch", 1, {}]) {
    assert.throws(
      () =>
        captureInstalledPluginCompositionAuthority({
          assertCurrentAuthority: invalid,
        }),
      /installed_plugin_composition_configuration_invalid/,
    );
  }
  let current = scope;
  const authority = captureInstalledPluginCompositionAuthority({
    assertCurrentAuthority: () => current,
  });
  assert.ok(authority);
  assert.notEqual(authority(), scope);
  assert.ok(Object.isFrozen(authority()));
  assertInstalledPluginCompositionAuthority(authority, lock, "submit");
  for (const field of [
    "tenantId",
    "spaceId",
    "profileId",
    "authorityEpoch",
  ] as const) {
    current = { ...scope, [field]: `changed-${field}` };
    assert.throws(
      () =>
        assertInstalledPluginCompositionAuthority(authority, lock, "submit"),
      /installed_plugin_composition_authority_changed/,
    );
  }
});

test("authority callback results require exact pure data and cannot supply request identity", () => {
  let accessorReads = 0;
  for (const invalid of [
    { ...scope, actorId: "self-reported" },
    { tenantId: scope.tenantId },
    { ...scope, authorityEpoch: "" },
    Object.defineProperty({ ...scope }, "authorityEpoch", {
      enumerable: true,
      get() {
        accessorReads++;
        return scope.authorityEpoch;
      },
    }),
  ]) {
    const captured = captureInstalledPluginCompositionAuthority({
      assertCurrentAuthority: () => invalid,
    });
    assert.ok(captured);
    assert.throws(() => captured());
  }
  assert.equal(accessorReads, 0);
});

test("old graph observation does not use the new epoch to authorize mutations", () => {
  let calls = 0;
  const captured = captureInstalledPluginCompositionAuthority({
    assertCurrentAuthority: () => {
      calls++;
      return { ...scope, authorityEpoch: "fresh-authority-epoch" };
    },
  });
  assertInstalledPluginCompositionAuthority(captured, lock, "observe");
  assert.equal(calls, 1);
  assert.throws(
    () => assertInstalledPluginCompositionAuthority(captured, lock, "submit"),
    /installed_plugin_composition_authority_changed/,
  );
  assert.equal(calls, 2);
});

test("observation retains only the old epoch, while current scope changes and owner withdrawal still fail closed", () => {
  for (const field of ["tenantId", "spaceId", "profileId"] as const) {
    const captured = captureInstalledPluginCompositionAuthority({
      assertCurrentAuthority: () => ({
        ...scope,
        [field]: `changed-${field}`,
        authorityEpoch: "new-observation-epoch",
      }),
    });
    assert.throws(
      () =>
        assertInstalledPluginCompositionAuthority(captured, lock, "observe"),
      /installed_plugin_composition_authority_changed/,
    );
  }
  const withdrawn = captureInstalledPluginCompositionAuthority({
    assertCurrentAuthority: () => {
      throw new Error("actual-owner-withdrawn");
    },
  });
  assert.throws(
    () => assertInstalledPluginCompositionAuthority(withdrawn, lock, "observe"),
    /actual-owner-withdrawn/,
  );
});

test("the actual composed provider cannot consume an epoch changed during its final actor await", async (t) => {
  const f = await installedResolverFixture(t, { composition: true });
  assert.ok(f.originalComposition && f.compositions && f.providerPackage);
  let current = f.originalComposition.scope;
  let actorReads = 0;
  const reader = new InstalledPluginRunContext({
    extensions: f.first.store,
    runs: f.first.parent,
    installations: f.installations,
    compositions: f.compositions,
    compositionAuthority: () => current,
    authorization: f.dependencies.authorization,
    resolveActor: async () => {
      // Two root actor reads, one provider read, two root refresh reads, final provider read.
      if (++actorReads === 6)
        current = { ...current, authorityEpoch: "new-provider-tail-epoch" };
      return actor;
    },
  });
  const snapshot = await reader.load({
    locator: {
      tenantId: f.task.binding.tenantId,
      spaceId: f.task.binding.spaceId,
      runId: f.task.binding.runId,
    },
    expectedTarget: f.target,
    purpose: "submit",
    signal: signal(),
  });
  assert.ok(snapshot);
  actorReads = 0;
  await assert.rejects(
    reader.assertCompositionNodeCurrent(
      snapshot,
      f.providerPackage.pluginId,
      "submit",
      signal(),
    ),
    /installed_plugin_composition_authority_changed/,
  );
  assert.equal(actorReads, 6);
  assert.deepEqual(f.controls.records, []);
  assert.throws(
    () => reader.assertCompositionAuthorityCurrent({ ...snapshot }, "submit"),
    /installed_plugin_context_snapshot_invalid/,
  );
});
