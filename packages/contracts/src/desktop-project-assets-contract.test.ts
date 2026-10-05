import assert from "node:assert/strict";
import test from "node:test";
import { parseDesktopProjectHistoryConfiguration } from "./desktop-project-history-contract.ts";
import { parseDesktopProjectExecutionConfiguration } from "./desktop-project-execution-contract.ts";
const source = {
  pluginId: "test.assets",
  packageDigest: `sha256:${"a".repeat(64)}`,
  contributionId: "workbench",
};
const grant = { publications: [source] },
  options = { publications: [source] };
const fields = {
  textArtifacts: { version: "crewon.project-text.v1" },
  assetArtifacts: { version: "crewon.project-asset.v1" },
  assetUi: grant,
  assetRecovery: grant,
  conversations: grant,
  assetStages: { version: "crewon.project-asset-stages.v1", ...grant },
};
for (const [version, parse] of [
  [
    "crewon.desktop-project-history.v1",
    parseDesktopProjectHistoryConfiguration,
  ],
  [
    "crewon.desktop-project-execution.v1",
    parseDesktopProjectExecutionConfiguration,
  ],
] as const) {
  test(`${version} keeps older approvals exact and independently captures asset archive/recovery/stage`, () => {
    const old = { version, pluginUi: grant };
    assert.deepEqual(parse(old, options), old);
    const raw = structuredClone({ version, ...fields }),
      value = parse(raw, options);
    assert.deepEqual(value, raw);
    assert.equal(Object.hasOwn(value, "textUi"), false);
    assert.equal(Object.hasOwn(value, "pluginGenerations"), false);
    raw.assetUi.publications[0]!.contributionId = "changed";
    assert.equal(value.assetUi!.publications[0]!.contributionId, "workbench");
    assert.ok(Object.isFrozen(value.assetStages!.publications[0]));
  });
  test(`${version} fails closed for missing prerequisites, foreign source, wrong version and accessor`, () => {
    const original = { version, ...fields };
    for (const patch of [
      { textArtifacts: undefined },
      { assetArtifacts: undefined },
      { assetUi: undefined },
      { conversations: undefined },
      { assetArtifacts: { version: "old" } },
      { assetStages: { ...fields.assetStages, version: "old" } },
      {
        assetRecovery: {
          publications: [{ ...source, contributionId: "foreign" }],
        },
      },
      {
        assetStages: {
          ...fields.assetStages,
          publications: [
            { ...source, packageDigest: `sha256:${"b".repeat(64)}` },
          ],
        },
      },
      { assetUi: { ...grant, actorId: "client" } },
      { assetStages: { ...fields.assetStages, actorId: "client" } },
    ])
      assert.throws(() => parse({ ...original, ...patch }, options));
    let calls = 0;
    const getter = { ...original };
    Object.defineProperty(getter, "assetUi", {
      enumerable: true,
      get() {
        calls++;
        return grant;
      },
    });
    assert.throws(() => parse(getter, options));
    assert.equal(calls, 0);
  });
}
