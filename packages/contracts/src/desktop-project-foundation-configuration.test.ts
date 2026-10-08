import assert from "node:assert/strict";
import test from "node:test";
import { parseDesktopProjectFoundationConfiguration as parse } from "./desktop-project-foundation-configuration.ts";
const publication = {
  pluginId: "crewon.short-drama",
  packageDigest: `sha256:${"a".repeat(64)}`,
  contributionId: "workbench",
};
const options = {
  publications: [
    {
      pluginId: publication.pluginId,
      packageDigest: publication.packageDigest,
    },
  ],
  metadataPublications: [publication],
};
const value = {
  version: "crewon.project-foundation.v1",
  pluginUi: { publications: [publication] },
  uploads: {
    version: "crewon.project-source-uploads.v1",
    pluginUi: { publications: [publication] },
  },
};
test("Native UI startup declarations preserve independently omitted publications and refuse authority or unknown fields", () => {
  assert.deepEqual(parse(value, options), value);
  assert.deepEqual(
    parse(
      { version: value.version, uploads: { version: value.uploads.version } },
      options,
    ),
    { version: value.version, uploads: { version: value.uploads.version } },
  );
  for (const input of [
    { ...value, pluginUi: undefined },
    { ...value, version: "crewon.project-foundation.v2" },
    { ...value, authority: {} },
    { ...value, uploads: { ...value.uploads, authorization: {} } },
    { ...value, pluginUi: { publications: [publication, publication] } },
    {
      ...value,
      pluginUi: {
        publications: [{ ...publication, contributionId: "foreign" }],
      },
    },
    {
      ...value,
      uploads: {
        ...value.uploads,
        pluginUi: {
          publications: [
            { ...publication, packageDigest: `sha256:${"b".repeat(64)}` },
          ],
        },
      },
    },
  ])
    assert.throws(() => parse(input, options), /configuration_invalid/u);
});
test("Native UI configuration capture refuses getters and proxies without executing caller code", () => {
  let calls = 0;
  assert.throws(() =>
    parse(
      {
        ...value,
        get pluginUi() {
          calls++;
          return value.pluginUi;
        },
      },
      options,
    ),
  );
  assert.equal(calls, 0);
  const proxy = Proxy.revocable(value, {});
  proxy.revoke();
  assert.throws(() => parse(proxy.proxy, options));
});
