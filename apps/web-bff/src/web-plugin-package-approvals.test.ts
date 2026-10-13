import assert from "node:assert/strict";
import test from "node:test";
import { readWebPluginPackageApprovals } from "./web-plugin-package-approvals.ts";
const pluginId = "crewon.short-drama",
  old = `sha256:${"a".repeat(64)}`,
  next = `sha256:${"b".repeat(64)}`;
test("old and new exact byte approvals coexist for one plugin during an upgrade", () => {
  const approved = readWebPluginPackageApprovals(
    JSON.stringify([
      { pluginId, packageDigest: old },
      { pluginId, packageDigest: next },
    ]),
  );
  assert.deepEqual(approved.get(pluginId), [old, next]);
  assert.ok(Object.isFrozen(approved.get(pluginId)));
});
test("duplicate tuples, malformed identities and unbounded approvals remain rejected", () => {
  for (const input of [
    [
      { pluginId, packageDigest: old },
      { pluginId, packageDigest: old },
    ],
    [{ pluginId, packageDigest: "latest" }],
    [{ pluginId: "../other", packageDigest: old }],
    Array.from({ length: 33 }, (_, i) => ({
      pluginId: "plugin-" + i,
      packageDigest: old,
    })),
  ])
    assert.throws(
      () => readWebPluginPackageApprovals(JSON.stringify(input)),
      /web_identity_packages_invalid/,
    );
});
