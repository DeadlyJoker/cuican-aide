import assert from "node:assert/strict";
import test from "node:test";
import { parseDesktopProjectHistoryConfiguration as history } from "./desktop-project-history-contract.ts";
import { parseDesktopProjectExecutionConfiguration as execution } from "./desktop-project-execution-contract.ts";
const pin = {
  pluginId: "crewon.short-drama",
  packageDigest: `sha256:${"1".repeat(64)}`,
  contributionId: "workbench",
};
const options = { publications: [pin] };
const metadata = {
  pluginUi: { publications: [pin] },
  textArtifacts: { version: "crewon.project-text.v1" },
  textUi: { publications: [pin] },
  conversations: { publications: [pin] },
  textPlans: { publications: [pin] },
};
for (const [version, parse] of [
  ["crewon.desktop-project-history.v1", history],
  ["crewon.desktop-project-execution.v1", execution],
] as const) {
  test(`${version} publishes exact plan UI membership without a delegation or execution mapping`, () => {
    const v = { version, ...metadata },
      result = parse(v, options);
    assert.deepEqual(result, v);
    assert.equal(Object.hasOwn(result, "delegation"), false);
    assert.equal(Object.hasOwn(result, "pluginGenerations"), false);
    assert.ok(Object.isFrozen(result.textPlans!.publications));
  });
  test(`${version} requires the plan publication in all three exact prerequisite memberships`, () => {
    for (const missing of ["pluginUi", "textUi", "conversations"]) {
      const v: Record<string, unknown> = { version, ...metadata };
      delete v[missing];
      assert.throws(() => parse(v, options));
    }
    for (const field of ["packageDigest", "contributionId"] as const)
      assert.throws(() =>
        parse(
          {
            version,
            ...metadata,
            textPlans: {
              publications: [
                {
                  ...pin,
                  [field]:
                    field === "packageDigest"
                      ? `sha256:${"2".repeat(64)}`
                      : "other-module",
                },
              ],
            },
          },
          options,
        ),
      );
  });
  test(`${version} refuses copied capabilities, duplicate tuples and unapproved package bytes`, () => {
    assert.throws(() => parse({ version, ...metadata }, { publications: [] }));
    assert.throws(() =>
      parse(
        { version, ...metadata, textPlans: { publications: [pin, pin] } },
        options,
      ),
    );
    assert.throws(() =>
      parse(
        {
          version,
          ...metadata,
          textPlans: { publications: [pin], delegation: true },
        },
        options,
      ),
    );
  });
  test(`${version} leaves old approvals without textPlans unchanged`, () => {
    const v = { version, pluginUi: { publications: [pin] } };
    assert.deepEqual(parse(v, options), v);
  });
}
